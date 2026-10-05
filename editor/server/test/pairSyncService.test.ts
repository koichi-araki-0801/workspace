// =============================================================================
// pairSyncService.test.ts — 承認後のペア同期はテンプレート側にも掛かり、状態ファイルは形ごとに別
// =============================================================================
// テンプレート(templates/。3 つ区切り)のペアのキーは `会社_ファンド`、値入り HTML(filled/。
// 4 つ区切り)は `会社_ファンド_基準日` で、状態ファイル `sync/<pairKey>.json` は自然に別になる。
// 1 つにまとめると、基準日の違う値入り HTML の同期状態とテンプレートの同期状態が混ざる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** `readTemplateCss` を権限エラー(EACCES)で失敗させる文書 ID。CSS だけを飛ばすことを確かめる。 */
const failCssReadOf = new Set<string>();
vi.mock('../src/files/templateFiles.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/files/templateFiles.js')>();
  return {
    ...mod,
    readTemplateCss: async (templateId: string) => {
      if (failCssReadOf.has(templateId)) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return mod.readTemplateCss(templateId);
    },
  };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-pair-sync-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.SYNC_DIR = path.join(tmp, 'sync');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.CSS_DIR = path.join(tmp, 'css');
// 監査ログの DB 複写へ出ないようにする(`reviews.test.ts` と同じ)。
process.env.AUDIT_DB = 'false';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

const part = (id: string, text: string): string =>
  `<section data-part-id="${id}"><p>${text}</p></section>`;
const doc = (...parts: string[]): string =>
  `<html><body><div class="page">\n${parts.join('\n')}\n</div></body></html>`;
const put = (dir: string, id: string, html: string) => {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), html, 'utf8');
};
const read = (dir: string, id: string) =>
  fs.readFileSync(path.join(tmp, dir, `${id}.html`), 'utf8');
const syncFile = (pairKey: string) => path.join(tmp, 'sync', `${pairKey}.json`);
const putCss = (name: string, text: string) => {
  fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'css', name), text, 'utf8');
};
const readCss = (name: string) => fs.readFileSync(path.join(tmp, 'css', name), 'utf8');
const syncCommits = () =>
  execFileSync('git', ['log', '--format=%s'], { cwd: tmp, encoding: 'utf8' })
    .split('\n')
    .filter((s) => s.startsWith('同期:')).length;

d('pairSyncService', () => {
  let svc: import('../src/sync/pairSyncService.js').PairSyncService;
  const listParts = async () => [{ id: 'a', syncDefault: '同期' }];

  beforeAll(async () => {
    const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
    // カタログは 1 パーツだけ。同期既定=同期 のパーツが転写の対象になる。
    const parts = { listParts: () => listParts(), getPartClassificationOptions: async () => ({}) };
    svc = createPairSyncService(parts as never);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('テンプレートの承認後は templates/ のペアへ転写し、状態は sync/会社_ファンド.json', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_510037_交付版', doc(part('a', '旧')));
    put('templates', 'AM01_510037_全体版', doc(part('a', '旧')));
    // 1 回目: 両版が一致しているので転写せず、前回同期の基準だけを作る。
    const first = await svc.syncPairAfterConfirm('AM01_510037_交付版', 'approver1', 'template', {
      css: { before: '', baseline: '' },
    });
    expect(first).toMatchObject({ pairTemplateId: 'AM01_510037_全体版', error: null });
    expect(fs.existsSync(syncFile('AM01_510037'))).toBe(true);
    // 2 回目: 交付版だけが変わったので全体版へ転写する。
    put('templates', 'AM01_510037_交付版', doc(part('a', '新')));
    const second = await svc.syncPairAfterConfirm('AM01_510037_交付版', 'approver1', 'template', {
      css: { before: '', baseline: '' },
    });
    expect(second?.error).toBeNull();
    expect(second?.applied).toHaveLength(1);
    expect(read('templates', 'AM01_510037_全体版')).toContain('新');
  });

  it('値入り HTML の状態は sync/会社_ファンド_基準日.json で、テンプレート側の状態を上書きしない', {
    timeout: 60_000,
  }, async () => {
    const before = fs.readFileSync(syncFile('AM01_510037'), 'utf8');
    put('filled', 'AM01_510037_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_510037_20240710_全体版', doc(part('a', 'x')));
    await svc.syncPairAfterConfirm('AM01_510037_20240710_交付版', 'approver1', 'filled', {
      css: { before: '', baseline: '' },
    });
    expect(fs.existsSync(syncFile('AM01_510037_20240710'))).toBe(true);
    expect(fs.readFileSync(syncFile('AM01_510037'), 'utf8')).toBe(before);
  });

  it('ペアのテンプレートが無ければ null、版種がペアの対象外でも null', async () => {
    put('templates', 'AM01_510155_交付版', doc(part('a', 'x')));
    expect(
      await svc.syncPairAfterConfirm('AM01_510155_交付版', 'approver1', 'template', {
        css: { before: '', baseline: '' },
      }),
    ).toBeNull();
    expect(
      await svc.syncPairAfterConfirm('AM01_510155_kr', 'approver1', 'template', {
        css: { before: '', baseline: '' },
      }),
    ).toBeNull();
  });

  it('同期の途中で失敗しても throw せず、error 付きで返す(承認は成立させる)', async () => {
    put('templates', 'AM01_510003_交付版', doc(part('a', 'x')));
    put('templates', 'AM01_510003_全体版', doc(part('a', 'x')));
    const r = await (async () => {
      const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
      const broken = {
        listParts: async () => {
          throw new Error('カタログを読めない');
        },
        getPartClassificationOptions: async () => ({}),
      };
      return createPairSyncService(broken as never).syncPairAfterConfirm(
        'AM01_510003_交付版',
        'approver1',
        'template',
        { css: { before: '', baseline: '' } },
      );
    })();
    expect(r).toMatchObject({
      pairTemplateId: 'AM01_510003_全体版',
      applied: [],
      error: 'カタログを読めない',
    });
  });

  it('同期の現況はテンプレートでは値入り HTML のペアを見ない(バナーの対象外)', async () => {
    expect(await svc.getPairSyncStatus('AM01_510037_交付版')).toEqual({
      pairTemplateId: 'AM01_510037_全体版',
      pairExists: false,
      conflicts: [],
      cssConflicts: [],
    });
    expect(await svc.getPairSyncStatus('規約外')).toEqual({
      pairTemplateId: null,
      pairExists: false,
      conflicts: [],
      cssConflicts: [],
    });
  });

  it('テンプレのペア: 承認で変わった CSS 規則をペアの CSS へ写す(本文と同じ 1 コミット)', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_530000_交付版', doc(part('a', '旧')));
    put('templates', 'AM01_530000_全体版', doc(part('a', '旧')));
    await svc.syncPairAfterConfirm('AM01_530000_交付版', 'approver1', 'template', {
      css: { before: '', baseline: '' },
    });
    // 承認: 本文と CSS の両方が変わった。
    putCss('AM01_530000_交付版.css', '.a{color:green}\n.b{color:blue}');
    putCss('AM01_530000_全体版.css', '.a{color:red}\n.b{color:navy}');
    put('templates', 'AM01_530000_交付版', doc(part('a', '新')));
    const before = syncCommits();
    const r = await svc.syncPairAfterConfirm('AM01_530000_交付版', 'approver1', 'template', {
      css: { before: '.a{color:red}\n.b{color:blue}', baseline: '.a{color:red}\n.b{color:blue}' },
    });
    expect(r?.error).toBeNull();
    expect(r?.css?.applied).toHaveLength(1);
    expect(readCss('AM01_530000_全体版.css')).toContain('.a{color:green}');
    expect(readCss('AM01_530000_全体版.css')).toContain('.b{color:navy}');
    expect(read('templates', 'AM01_530000_全体版')).toContain('新');
    // 承認 1 回につき転写は 1 回(本文と CSS を同じ確定書込で書く)。
    expect(syncCommits()).toBe(before + 1);
  });

  it('値入り HTML のペアでも同じ CSS 2 枚(…_交付版.css ⇔ …_全体版.css)が対象', {
    timeout: 60_000,
  }, async () => {
    put('filled', 'AM01_540000_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_540000_20240710_全体版', doc(part('a', 'x')));
    putCss('AM01_540000_交付版.css', '.a{color:green}');
    putCss('AM01_540000_全体版.css', '.a{color:red}');
    const r = await svc.syncPairAfterConfirm('AM01_540000_20240710_交付版', 'approver1', 'filled', {
      css: { before: '.a{color:red}', baseline: '.a{color:red}' },
    });
    expect(r?.css?.applied).toHaveLength(1);
    expect(readCss('AM01_540000_全体版.css')).toContain('.a{color:green}');
    expect(readCss('AM01_540000_全体版.css')).not.toContain('red');
  });

  it('ペア側が版種固有に直した規則は写さず、状態ファイルの css 欄と現況に競合として出す', {
    timeout: 60_000,
  }, async () => {
    put('filled', 'AM01_550000_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_550000_20240710_全体版', doc(part('a', 'x')));
    putCss('AM01_550000_交付版.css', '.a{color:green}');
    putCss('AM01_550000_全体版.css', '.a{color:black}');
    const r = await svc.syncPairAfterConfirm('AM01_550000_20240710_交付版', 'approver1', 'filled', {
      css: { before: '.a{color:red}', baseline: '.a{color:red}' },
    });
    expect(r?.css?.applied).toEqual([]);
    expect(r?.css?.conflicts).toHaveLength(1);
    expect(readCss('AM01_550000_全体版.css')).toBe('.a{color:black}');
    // 記録先はテンプレのペアキー(会社_ファンド)。基準日ごとの状態ファイルには CSS の競合を書かない。
    const state = JSON.parse(fs.readFileSync(syncFile('AM01_550000'), 'utf8'));
    expect(state.css.conflicts).toEqual([
      { ruleKey: JSON.stringify(['.a']), detectedAt: expect.any(String) },
    ]);
    if (fs.existsSync(syncFile('AM01_550000_20240710'))) {
      const dated = JSON.parse(fs.readFileSync(syncFile('AM01_550000_20240710'), 'utf8'));
      expect(dated.css).toBeUndefined();
    }
    // 本文の競合と同じ現況(編集画面のバナーの入力)に出る。ペア側から見ても同じ記録先。
    const status = await svc.getPairSyncStatus('AM01_550000_20240710_全体版');
    expect(status.cssConflicts).toHaveLength(1);
  });

  it('基準日 A の承認で起きた CSS 競合が、基準日 B の画面と作成タブの状態取得でも見える', {
    timeout: 60_000,
  }, async () => {
    put('filled', 'AM01_551000_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_551000_20240710_全体版', doc(part('a', 'x')));
    put('filled', 'AM01_551000_20250110_交付版', doc(part('a', 'y')));
    put('filled', 'AM01_551000_20250110_全体版', doc(part('a', 'y')));
    putCss('AM01_551000_交付版.css', '.a{color:green}');
    putCss('AM01_551000_全体版.css', '.a{color:black}');
    await svc.syncPairAfterConfirm('AM01_551000_20240710_交付版', 'approver1', 'filled', {
      css: { before: '.a{color:red}', baseline: '.a{color:red}' },
    });
    const otherDate = await svc.getPairSyncStatus('AM01_551000_20250110_交付版');
    expect(otherDate.cssConflicts).toEqual([
      { ruleKey: JSON.stringify(['.a']), detectedAt: expect.any(String) },
    ]);
    // 作成タブ(テンプレ id)。パーツの競合は値入り HTML のペアだけが持つので空のまま。
    const template = await svc.getPairSyncStatus('AM01_551000_交付版');
    expect(template.cssConflicts).toHaveLength(1);
    expect(template.conflicts).toEqual([]);
  });

  it('テンプレのペアの承認と値入り HTML のペアの承認は同じ記録先を使い、両版が一致すれば消える', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_552000_交付版', doc(part('a', 'x')));
    put('templates', 'AM01_552000_全体版', doc(part('a', 'x')));
    put('filled', 'AM01_552000_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_552000_20240710_全体版', doc(part('a', 'x')));
    putCss('AM01_552000_交付版.css', '.a{color:green}');
    putCss('AM01_552000_全体版.css', '.a{color:black}');
    // テンプレの承認で競合が記録される。
    await svc.syncPairAfterConfirm('AM01_552000_交付版', 'approver1', 'template', {
      css: { before: '.a{color:red}', baseline: '.a{color:red}' },
    });
    const read1 = JSON.parse(fs.readFileSync(syncFile('AM01_552000'), 'utf8'));
    expect(read1.css.conflicts).toHaveLength(1);
    // 全体版を交付版に合わせてから、値入り HTML のペアで別の規則を承認すると、同じ記録先の競合が消える。
    putCss('AM01_552000_全体版.css', '.a{color:green}');
    putCss('AM01_552000_交付版.css', '.a{color:green}\n.b{x:1}');
    await svc.syncPairAfterConfirm('AM01_552000_20240710_交付版', 'approver1', 'filled', {
      css: { before: '.a{color:green}', baseline: '.a{color:green}' },
    });
    const read2 = JSON.parse(fs.readFileSync(syncFile('AM01_552000'), 'utf8'));
    expect(read2.css.conflicts).toEqual([]);
    expect(readCss('AM01_552000_全体版.css')).toContain('.b{x:1}');
  });

  it('承認で CSS が変わらなければペアの CSS に触れず、css は null', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_560000_交付版', doc(part('a', 'x')));
    put('templates', 'AM01_560000_全体版', doc(part('a', 'x')));
    putCss('AM01_560000_交付版.css', '.a{color:green}');
    putCss('AM01_560000_全体版.css', '.a{color:red}');
    const r = await svc.syncPairAfterConfirm('AM01_560000_交付版', 'approver1', 'template', {
      css: { before: '.a{color:green}', baseline: '.a{color:green}' },
    });
    expect(r?.css).toBeNull();
    expect(readCss('AM01_560000_全体版.css')).toBe('.a{color:red}');
  });

  it('無編集の承認で CSS が GrapesJS の形に書き直されても、ペアの CSS は変えず競合も出さない', {
    timeout: 60_000,
  }, async () => {
    const raw = '.cover-title{color:#003366}\n.page{padding:10mm}\n';
    const gjs =
      '.cover-title{color:rgb(0, 51, 102);}' +
      '.page{padding-top:10mm;padding-right:10mm;padding-bottom:10mm;padding-left:10mm;}';
    const pairCss = raw.replace('#003366', '#990000');
    put('templates', 'AM01_561000_交付版', doc(part('a', 'x')));
    put('templates', 'AM01_561000_全体版', doc(part('a', 'x')));
    // 承認が書いた後の source の CSS は GrapesJS の形(承認前は外部ツールの原文)。
    putCss('AM01_561000_交付版.css', gjs);
    putCss('AM01_561000_全体版.css', pairCss);
    const r = await svc.syncPairAfterConfirm('AM01_561000_交付版', 'approver1', 'template', {
      css: { before: raw, baseline: gjs },
    });
    expect(r?.error).toBeNull();
    expect(r?.css).toBeNull();
    expect(readCss('AM01_561000_全体版.css')).toBe(pairCss);
    const status = await svc.getPairSyncStatus('AM01_561000_交付版');
    expect(status.cssConflicts).toEqual([]);
  });

  it('ペアの実体が無ければ(本文の同期が動かなければ)CSS も写さない', async () => {
    put('templates', 'AM01_570000_交付版', doc(part('a', 'x')));
    putCss('AM01_570000_交付版.css', '.a{color:green}');
    const r = await svc.syncPairAfterConfirm('AM01_570000_交付版', 'approver1', 'template', {
      css: { before: '.a{color:red}', baseline: '.a{color:red}' },
    });
    expect(r).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'css', 'AM01_570000_全体版.css'))).toBe(false);
  });

  it('BOM と CRLF を持つペアの CSS へも写し、BOM と既存の改行は保つ', {
    timeout: 60_000,
  }, async () => {
    const BOM = '﻿';
    put('filled', 'AM01_580000_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_580000_20240710_全体版', doc(part('a', 'x')));
    putCss('AM01_580000_交付版.css', '.a{color:green;}.b{color:blue;}');
    putCss(
      'AM01_580000_全体版.css',
      `${BOM}.a {\r\n  color: red;\r\n}\r\n.b {\r\n  color: navy;\r\n}\r\n`,
    );
    const r = await svc.syncPairAfterConfirm('AM01_580000_20240710_交付版', 'approver1', 'filled', {
      css: {
        before: `${BOM}.a {\r\n  color: red;\r\n}\r\n.b {\r\n  color: blue;\r\n}\r\n`,
        baseline: `${BOM}.a {\r\n  color: red;\r\n}\r\n.b {\r\n  color: blue;\r\n}\r\n`,
      },
    });
    expect(r?.css).toEqual({ applied: [JSON.stringify(['.a'])], conflicts: [] });
    expect(readCss('AM01_580000_全体版.css')).toBe(
      `${BOM}.a{color:green;}\r\n.b {\r\n  color: navy;\r\n}\r\n`,
    );
  });

  it('BOM と CRLF を持つペアの CSS でも、版種固有に直した規則は競合として記録する', {
    timeout: 60_000,
  }, async () => {
    const BOM = '﻿';
    const pairCss = `${BOM}.a {\r\n  color: black;\r\n}\r\n`;
    put('filled', 'AM01_581000_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_581000_20240710_全体版', doc(part('a', 'x')));
    putCss('AM01_581000_交付版.css', '.a{color:green;}');
    putCss('AM01_581000_全体版.css', pairCss);
    const r = await svc.syncPairAfterConfirm('AM01_581000_20240710_交付版', 'approver1', 'filled', {
      css: {
        before: `${BOM}.a {\r\n  color: red;\r\n}\r\n`,
        baseline: `${BOM}.a {\r\n  color: red;\r\n}\r\n`,
      },
    });
    expect(r?.css).toEqual({ applied: [], conflicts: [JSON.stringify(['.a'])] });
    expect(readCss('AM01_581000_全体版.css')).toBe(pairCss);
    const state = JSON.parse(fs.readFileSync(syncFile('AM01_581000'), 'utf8'));
    expect(state.css.conflicts).toHaveLength(1);
  });

  it('ペアの CSS を読めなければ CSS の転写だけを飛ばし、本文の同期は続ける', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_590000_交付版', doc(part('a', '旧')));
    put('templates', 'AM01_590000_全体版', doc(part('a', '旧')));
    await svc.syncPairAfterConfirm('AM01_590000_交付版', 'approver1', 'template', {
      css: { before: '', baseline: '' },
    });
    put('templates', 'AM01_590000_交付版', doc(part('a', '新')));
    putCss('AM01_590000_交付版.css', '.a{color:green}');
    putCss('AM01_590000_全体版.css', '.a{color:red}');
    failCssReadOf.add('AM01_590000_全体版');
    try {
      const r = await svc.syncPairAfterConfirm('AM01_590000_交付版', 'approver1', 'template', {
        css: { before: '.a{color:red}', baseline: '.a{color:red}' },
      });
      expect(r?.error).toBeNull();
      expect(r?.applied).toHaveLength(1);
      expect(r?.css).toBeNull();
    } finally {
      failCssReadOf.clear();
    }
    expect(read('templates', 'AM01_590000_全体版')).toContain('新');
    expect(readCss('AM01_590000_全体版.css')).toBe('.a{color:red}');
  });

  it('CSS の入力が無い(css=null)なら CSS を写さず、記録済みの CSS の競合も消さない', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_591000_交付版', doc(part('a', '旧')));
    put('templates', 'AM01_591000_全体版', doc(part('a', '旧')));
    putCss('AM01_591000_交付版.css', '.a{color:green}');
    putCss('AM01_591000_全体版.css', '.a{color:black}');
    // 競合を 1 件記録する(同じ状態ファイルに本文のパーツの状態も載る)。
    await svc.syncPairAfterConfirm('AM01_591000_交付版', 'approver1', 'template', {
      css: { before: '.a{color:red}', baseline: '.a{color:red}' },
    });
    expect(JSON.parse(fs.readFileSync(syncFile('AM01_591000'), 'utf8')).css.conflicts).toHaveLength(
      1,
    );
    put('templates', 'AM01_591000_交付版', doc(part('a', '新')));
    putCss('AM01_591000_交付版.css', '.a{color:green}\n.b{x:1}');
    const r = await svc.syncPairAfterConfirm('AM01_591000_交付版', 'approver1', 'template', {
      css: null,
    });
    expect(r?.error).toBeNull();
    expect(r?.applied).toHaveLength(1);
    expect(r?.css).toBeNull();
    expect(read('templates', 'AM01_591000_全体版')).toContain('新');
    expect(readCss('AM01_591000_全体版.css')).toBe('.a{color:black}');
    // 本文の状態を書いても、同じファイルの CSS の競合は残る。
    const state = JSON.parse(fs.readFileSync(syncFile('AM01_591000'), 'utf8'));
    expect(state.css.conflicts).toHaveLength(1);
    expect(Object.keys(state.parts)).not.toHaveLength(0);
  });
});
