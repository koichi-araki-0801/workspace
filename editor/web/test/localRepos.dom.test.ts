import { isErr, isOk, type PartHistoryEntry } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localFundAssetRepo } from '@/api/local/fundAssetRepo';
import { localHistoryRepo } from '@/api/local/historyRepo';
import { localPartRepo } from '@/api/local/partRepo';
import { fixtureCss, K, partCatalog } from '@/api/local/store';
import { confirmSaveLocal, localTemplateRepo } from '@/api/local/templateRepo';
import { localUserRepo } from '@/api/local/userRepo';

beforeEach(() => localStorage.clear());

describe('localAuthRepo.login', () => {
  it('returns ok for valid seed credentials', async () => {
    const r = await localAuthRepo.login({ username: 'admin', password: 'admin' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.user.username).toBe('admin');
  });

  it('returns err(unauthorized) for a wrong password', async () => {
    const r = await localAuthRepo.login({ username: 'admin', password: 'nope' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe('unauthorized');
      expect(r.error.message).toBe('ユーザーIDまたはパスワードが違います');
    }
  });

  it('returns err(unauthorized) for an unknown user', async () => {
    const r = await localAuthRepo.login({ username: 'ghost', password: 'x' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('unauthorized');
  });
});

describe('localTemplateRepo.getTemplate', () => {
  it('returns err(not_found) for a missing id', async () => {
    const r = await localTemplateRepo.getTemplate('does_not_exist');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });

  it('CSS があるテンプレは cssMissing を立てない', async () => {
    const r = await localTemplateRepo.getTemplate('AM01_510037_20240710_交付版');
    expect(isOk(r) && r.value.css).toBe(fixtureCss['AM01_510037_交付版.css']);
    expect(isOk(r) && r.value.cssMissing).toBeFalsy();
  });

  it('CSS ファイルが無いテンプレは css を空にして cssMissing を立てる', async () => {
    const saved = fixtureCss['AM01_510155_交付版.css'];
    delete fixtureCss['AM01_510155_交付版.css'];
    try {
      const r = await localTemplateRepo.getTemplate('AM01_510155_20240710_交付版');
      expect(isOk(r) && r.value.css).toBe('');
      expect(isOk(r) && r.value.cssMissing).toBe(true);
    } finally {
      fixtureCss['AM01_510155_交付版.css'] = saved;
    }
  });

  it('承認で空の CSS を保存したテンプレは、不在ではない', async () => {
    const id = 'AM01_510037_20240710_全体版';
    await confirmSaveLocal({ templateId: id, html: '<p>x</p>', css: '', origin: 'edit' });
    const r = await localTemplateRepo.getTemplate(id);
    expect(isOk(r) && r.value.css).toBe('');
    expect(isOk(r) && r.value.cssMissing).toBeFalsy();
  });

  it("origin='edit' の確定保存は filled を更新し html は据え置く", async () => {
    const id = 'AM01_510037_20240710_交付版';
    const before = await localTemplateRepo.getTemplate(id);
    await confirmSaveLocal({
      templateId: id,
      html: '<p>値入り更新</p>',
      css: '',
      origin: 'edit',
    });
    const after = await localTemplateRepo.getTemplate(id);
    expect(isOk(after) && after.value.filled).toBe('<p>値入り更新</p>');
    expect(isOk(after) && isOk(before) && after.value.html).toBe(before.value.html);
  });

  it("origin='create' の確定保存は html を更新し filled を空にする(従来どおり)", async () => {
    const id = 'AM01_510037_20240710_全体版';
    await confirmSaveLocal({
      templateId: id,
      html: '<p>{{ x }}</p>',
      css: '',
      origin: 'create',
    });
    const after = await localTemplateRepo.getTemplate(id);
    expect(isOk(after) && after.value.html).toBe('<p>{{ x }}</p>');
    expect(isOk(after) && after.value.filled).toBe('');
  });
});

describe('localTemplateRepo.getSyncStatus', () => {
  it('ペア(交付版⇄全体版)が fixtures に居れば pairExists を立てる(競合は常に空)', async () => {
    const r = await localTemplateRepo.getSyncStatus('AM01_510037_20240710_交付版');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.pairTemplateId).toBe('AM01_510037_20240710_全体版');
      expect(r.value.pairExists).toBe(true);
      expect(r.value.conflicts).toEqual([]);
    }
  });

  it('ペア実体が無いテンプレは pairExists=false', async () => {
    const r = await localTemplateRepo.getSyncStatus('AM01_510155_20240710_交付版');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.pairTemplateId).toBe('AM01_510155_20240710_全体版');
      expect(r.value.pairExists).toBe(false);
    }
  });

  it('ペア対象外の版種は pairTemplateId=null', async () => {
    const r = await localTemplateRepo.getSyncStatus('AM01_510037_20240710_kr');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.pairTemplateId).toBeNull();
  });
});

describe('confirmSaveLocal round-trip', () => {
  it("origin='create' の確定保存は html を残し、値入り HTML が無いので draft に戻る", async () => {
    const list = await localTemplateRepo.listTemplates({});
    expect(isOk(list)).toBe(true);
    if (!isOk(list) || list.value.length === 0) return;
    const target = list.value[0];

    const saved = await confirmSaveLocal({
      templateId: target.id,
      html: '<p>round-trip</p>',
      css: '.x{}',
      origin: 'create',
    });
    expect(isOk(saved)).toBe(true);
    // 作成タブの承認は Jinja 骨組みを差し替えるため、古い静的 filled は捨てられる
    // (`getTemplate` が空を返す)。`status` は値入り HTML の有無だけから決まるので draft。
    if (isOk(saved)) expect(saved.value.status).toBe('draft');

    const reread = await localTemplateRepo.getTemplate(target.id);
    expect(isOk(reread)).toBe(true);
    if (isOk(reread)) expect(reread.value.html).toBe('<p>round-trip</p>');
  });

  it("origin='edit' の確定保存は値入り HTML を書くので published のまま", async () => {
    const list = await localTemplateRepo.listTemplates({});
    if (!isOk(list) || list.value.length === 0) return;
    const target = list.value[0];

    const saved = await confirmSaveLocal({
      templateId: target.id,
      html: '<p>値入り</p>',
      css: '.x{}',
      origin: 'edit',
    });
    expect(isOk(saved) && saved.value.status).toBe('published');
  });

  it('CSS はテンプレ単位: fixtures はテンプレ名で引け、交付版の確定保存は全体版の CSS を変えない', async () => {
    // vitest は `.css?raw` の中身を空にするため、fixtures の CSS はキー(ファイル名)だけを確かめる。
    expect(Object.keys(fixtureCss)).toContain('AM01_510037_交付版.css');
    expect(Object.keys(fixtureCss)).toContain('AM01_510037_全体版.css');
    const kofuId = 'AM01_510037_20240710_交付版';
    const zentaiId = 'AM01_510037_20240710_全体版';
    const seeded = await confirmSaveLocal({
      templateId: zentaiId,
      html: '<p>全体版</p>',
      css: '.only-zentai{}',
      origin: 'edit',
    });
    expect(isOk(seeded)).toBe(true);
    const saved = await confirmSaveLocal({
      templateId: kofuId,
      html: '<p>x</p>',
      css: '.only-kofu{}',
      origin: 'edit',
    });
    expect(isOk(saved)).toBe(true);
    const kofu = await localTemplateRepo.getTemplate(kofuId);
    const zentai = await localTemplateRepo.getTemplate(zentaiId);
    expect(isOk(kofu) && kofu.value.css).toBe('.only-kofu{}');
    expect(isOk(zentai) && zentai.value.css).toBe('.only-zentai{}');
    // 基準日違いの同じテンプレは同じ CSS を読む(キーは基準日を含まない)。
    expect(JSON.parse(localStorage.getItem(K.cssOverride) ?? '{}')).toEqual({
      'AM01_510037_交付版.css': '.only-kofu{}',
      'AM01_510037_全体版.css': '.only-zentai{}',
    });
  });
});

describe('localUserRepo.updateUser', () => {
  it('returns err(not_found) for an unknown id', async () => {
    const r = await localUserRepo.updateUser('u-ghost', { disabled: true });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });
});

describe('confirmSaveLocal version snapshots', () => {
  it('captures a snapshot retrievable via getSnapshot and listVersions', async () => {
    const list = await localTemplateRepo.listTemplates({});
    if (!isOk(list) || list.value.length === 0) return;
    const target = list.value[0];

    const saved = await confirmSaveLocal({
      templateId: target.id,
      html: '<p>v1</p>',
      css: '.v1{}',
      origin: 'edit',
    });
    expect(isOk(saved)).toBe(true);

    // The newest edit-history entry should have a matching snapshot.
    const hist = await localHistoryRepo.getEditHistory();
    expect(isOk(hist)).toBe(true);
    if (!isOk(hist)) return;
    const entry = hist.value.find((e) => e.templateId === target.id);
    expect(entry).toBeDefined();
    if (!entry) return;

    // 行 id は一覧の :key 用で、コミット(版)を指すのは `historyId`。local と rest で
    // 同じ形を返すことを固定する(片方だけ hash のままだと画面の参照先が食い違う)。
    expect(entry.historyId).toBeTruthy();
    expect(entry.id).toBe(`${entry.historyId}:${entry.templateId}`);

    const snap = await localHistoryRepo.getSnapshot(entry.historyId);
    expect(isOk(snap)).toBe(true);
    if (isOk(snap)) {
      expect(snap.value.html).toBe('<p>v1</p>');
      expect(snap.value.css).toBe('.v1{}');
      expect(snap.value.fundCode).toBe(target.attributes.fundCode);
    }

    const versions = await localHistoryRepo.listVersions(target.id);
    expect(isOk(versions)).toBe(true);
    if (isOk(versions)) {
      expect(versions.value.some((v) => v.historyId === entry.historyId)).toBe(true);
    }
  });

  it('returns err(not_found) from getSnapshot for an unknown history id', async () => {
    const r = await localHistoryRepo.getSnapshot('eh-ghost');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });
});

describe('localPartRepo', () => {
  it('lists every catalog part when unfiltered', async () => {
    const r = await localPartRepo.listParts({});
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toHaveLength(partCatalog.length);
  });

  it('filters listParts by category', async () => {
    const category = partCatalog[0].classification.category;
    const expected = partCatalog.filter((i) => i.classification.category === category);
    const r = await localPartRepo.listParts({ category });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toHaveLength(expected.length);
      expect(r.value.every((i) => i.classification.category === category)).toBe(true);
    }
  });

  describe('版種での絞り込み', () => {
    const withEdition = (edition: string) => partCatalog.filter((i) => i.targetEdition === edition);
    const idsOf = async (editionType?: string) => {
      const r = await localPartRepo.listParts(editionType === undefined ? {} : { editionType });
      return isOk(r) ? r.value.map((i) => i.id) : [];
    };

    it('版種が空なら全件を返す', async () => {
      expect(await idsOf('')).toHaveLength(partCatalog.length);
      expect(await idsOf()).toHaveLength(partCatalog.length);
    });

    it('対象版種が null のパーツは両方の版に出て、一致するパーツだけが専用で出る', async () => {
      const own = withEdition('交付版');
      const other = withEdition('全体版');
      expect(own.length).toBeGreaterThan(0);
      expect(other.length).toBeGreaterThan(0);
      const ids = await idsOf('交付版');
      for (const p of partCatalog.filter((i) => i.targetEdition == null)) {
        expect(ids).toContain(p.id);
      }
      for (const p of own) expect(ids).toContain(p.id);
      for (const p of other) expect(ids).not.toContain(p.id);
    });

    it('対象版種が空文字列のパーツも null と同じく両方の版に出る', async () => {
      const blank = { ...partCatalog[0], id: 'blank-edition', targetEdition: '' };
      partCatalog.push(blank);
      try {
        expect(await idsOf('交付版')).toContain('blank-edition');
        expect(await idsOf('全体版')).toContain('blank-edition');
      } finally {
        partCatalog.pop();
      }
    });

    it('分類候補のカテゴリ区分も同じ条件で絞る', async () => {
      const r = await localPartRepo.getPartClassificationOptions({ editionType: '交付版' });
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      const visible = partCatalog.filter(
        (i) => i.targetEdition == null || i.targetEdition === '交付版',
      );
      expect(r.value.categories).toEqual([
        ...new Set(visible.map((i) => i.classification.category)),
      ]);
    });

    it('全体版専用のパーツだけのカテゴリは、交付版の候補（カテゴリと下位）から消える', async () => {
      const seed = {
        ...partCatalog[0],
        id: 'only-whole',
        targetEdition: '全体版',
        classification: {
          category: '全体版専用',
          majorClass: '大X',
          middleClass: '中X',
          minorClass: '小X',
        },
      };
      partCatalog.push(seed);
      try {
        const q = { category: '全体版専用', majorClass: '大X', middleClass: '中X' };
        const own = await localPartRepo.getPartClassificationOptions({
          ...q,
          editionType: '交付版',
        });
        const all = await localPartRepo.getPartClassificationOptions(q);
        const whole = await localPartRepo.getPartClassificationOptions({
          ...q,
          editionType: '全体版',
        });
        if (!isOk(own) || !isOk(all) || !isOk(whole)) throw new Error('unexpected err');
        expect(own.value.categories).not.toContain('全体版専用');
        expect(own.value.majorClasses).toEqual([]);
        expect(own.value.middleClasses).toEqual([]);
        expect(own.value.minorClasses).toEqual([]);
        expect(all.value.categories).toContain('全体版専用');
        expect(all.value.minorClasses).toEqual(['小X']);
        expect(whole.value.categories).toContain('全体版専用');
        expect(whole.value.minorClasses).toEqual(['小X']);
      } finally {
        partCatalog.splice(partCatalog.indexOf(seed), 1);
      }
    });
  });

  it('cascades classification options (major classes scoped to the chosen category)', async () => {
    const category = partCatalog[0].classification.category;
    const r = await localPartRepo.getPartClassificationOptions({ category });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // categories list is always the full set; majors narrow to the category.
      // 並びは五十音ソートでなく fixtures の記載(使用)順を保つ。先頭は parts.json 先頭の
      // カテゴリ(=表紙)になる。
      expect(r.value.categories[0]).toBe(partCatalog[0].classification.category);
      const expectedMajors = [
        ...new Set(
          partCatalog
            .filter((i) => i.classification.category === category)
            .map((i) => i.classification.majorClass),
        ),
      ];
      expect(r.value.majorClasses).toEqual(expectedMajors);
    }
  });

  it('listPartHistory returns all entries for the templateId (across part keys)', async () => {
    const entries: PartHistoryEntry[] = [
      { id: 'p1', templateId: 'T1', partKey: 'A', change: 'x', timestamp: 't', user: 'u' },
      { id: 'p2', templateId: 'T1', partKey: 'B', change: 'y', timestamp: 't', user: 'u' },
      { id: 'p3', templateId: 'T2', partKey: 'A', change: 'z', timestamp: 't', user: 'u' },
    ];
    localStorage.setItem(K.partHist, JSON.stringify(entries));
    const r = await localPartRepo.listPartHistory('T1');
    expect(isOk(r)).toBe(true);
    // partKey 絞りは呼び出し側で行う設計なので、版インスタンス単位で全件返す。
    if (isOk(r)) expect(r.value.map((e) => e.id)).toEqual(['p1', 'p2']);
  });

  it('listPartHistory returns [] when nothing is stored', async () => {
    const r = await localPartRepo.listPartHistory('none');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual([]);
  });

  it('recordPartChange persists an entry that listPartHistory reads back', async () => {
    const w = await localPartRepo.recordPartChange('T1', 'A', '幅を変更');
    expect(isOk(w)).toBe(true);
    const r = await localPartRepo.listPartHistory('T1');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]).toMatchObject({ templateId: 'T1', partKey: 'A', change: '幅を変更' });
    }
    // a different templateId is unaffected
    const other = await localPartRepo.listPartHistory('T2');
    if (isOk(other)) expect(other.value).toEqual([]);
  });

  it('recordPartChange stores the given id, and falls back to a ph- id without one', async () => {
    await localPartRepo.recordPartChange('T1', 'A', '指定あり', 'entry-1');
    await localPartRepo.recordPartChange('T1', 'A', '指定なし');
    const r = await localPartRepo.listPartHistory('T1');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const byChange = Object.fromEntries(r.value.map((e) => [e.change, e.id]));
      expect(byChange['指定あり']).toBe('entry-1');
      expect(byChange['指定なし']).toMatch(/^ph-/);
    }
  });
});

describe('allMetas の localStorage 読み取り回数', () => {
  it('テンプレ件数に関わらず filledOverride / htmlOverride は 1 回ずつしか読まない', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    const res = await localTemplateRepo.listTemplates({});
    expect(isOk(res)).toBe(true);
    const keys = spy.mock.calls.map(([k]) => k);
    expect(keys.filter((k) => k === K.filledOverride)).toHaveLength(1); // 'editor:filled'
    expect(keys.filter((k) => k === K.htmlOverride)).toHaveLength(1); // 'editor:html'
    spy.mockRestore();
  });
});

describe('localFundAssetRepo.inspect', () => {
  it('サーバが無いので、どの ref も ok を返す', async () => {
    const r = await localFundAssetRepo.inspect([
      { dir: 'smtam', file: 'qr.svg' },
      { dir: null, file: 'a.png' },
    ]);
    expect(isOk(r) && r.value).toEqual([
      { dir: 'smtam', file: 'qr.svg', status: 'ok' },
      { dir: null, file: 'a.png', status: 'ok' },
    ]);
  });
});
