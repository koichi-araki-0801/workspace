import { isErr, isOk, type PartHistoryEntry } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localHistoryRepo } from '@/api/local/historyRepo';
import { localPartRepo } from '@/api/local/partRepo';
import { K, partCatalog } from '@/api/local/store';
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

  it("origin='edit' の確定保存は filled を更新し html は据え置く", async () => {
    const id = 'AM01_510037_20240710_交付版';
    const before = await localTemplateRepo.getTemplate(id);
    await confirmSaveLocal({
      templateId: id,
      html: '<p>値入り更新</p>',
      css: '',
      fundCode: '510037',
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
      fundCode: '510037',
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
      fundCode: target.attributes.fundCode,
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
      fundCode: target.attributes.fundCode,
      origin: 'edit',
    });
    expect(isOk(saved) && saved.value.status).toBe('published');
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
      fundCode: target.attributes.fundCode,
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
});

describe('allMetas の localStorage 読み取り回数', () => {
  it('テンプレ件数に関わらず filledOverride / htmlOverride は 1 回ずつしか読まない', async () => {
    const { vi } = await import('vitest');
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    const res = await localTemplateRepo.listTemplates({});
    expect(isOk(res)).toBe(true);
    const keys = spy.mock.calls.map(([k]) => k);
    expect(keys.filter((k) => k === K.filledOverride)).toHaveLength(1); // 'editor:filled'
    expect(keys.filter((k) => k === K.htmlOverride)).toHaveLength(1); // 'editor:html'
    spy.mockRestore();
  });
});
