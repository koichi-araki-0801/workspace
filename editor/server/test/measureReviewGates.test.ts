// =============================================================================
// measureReviewGates.test.ts — 本番で測る計測スクリプト(作成経路の受付の検査・不変ゲート)の中核
// =============================================================================
// 本番のテンプレートとパーツカタログは手元に無いので、fixture で「違反 0」を、わざと違反を入れた
// 入力で件数が出ることを確かめる。DB は `sprocFake.ts`、dataRoot は一時フォルダで、開発機の実データ
// (DATA_ROOT)には触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PartCatalogItem, SampleData } from '@editor/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-measure-gates-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const fixtures = path.resolve(__dirname, '../../fixtures');
const fixtureSample = JSON.parse(
  fs.readFileSync(path.join(fixtures, 'sample', '950037.json'), 'utf8'),
) as SampleData;
const fixtureParts = JSON.parse(
  fs.readFileSync(path.join(fixtures, 'parts.json'), 'utf8'),
) as PartCatalogItem[];
/** fixture のテンプレート(4 つ区切り)を、作成経路の id(会社_ファンド_版種)と原文に直す。 */
const fixtureTemplates = fs
  .readdirSync(path.join(fixtures, 'templates'))
  .filter((n) => n.endsWith('.html'))
  .map((n) => {
    const [company, fund, , edition] = n.replace(/\.html$/, '').split('_');
    return {
      id: `${company}_${fund}_${edition}`,
      html: fs.readFileSync(path.join(fixtures, 'templates', n), 'utf8'),
    };
  });

const doc = (body: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const part = (id: string, content: string): PartCatalogItem => ({
  ...fixtureParts[0],
  id,
  name: `名前-${id}`,
  content,
});

type Mod = typeof import('../scripts/measure-review-gates.js');
let m: Mod;
beforeAll(async () => {
  m = await import('../scripts/measure-review-gates.js');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('measureTemplate(テンプレートごと)', () => {
  it('fixture の全テンプレートは、原文の検査も受付の描画も通る', () => {
    expect(fixtureTemplates.length).toBe(8);
    for (const t of fixtureTemplates) {
      const r = m.measureTemplate(t.id, t.html, fixtureSample);
      expect(r.issues, t.id).toEqual([]);
      expect(r.render.ok, t.id).toBe(true);
      // fixture の jinja の単位は `jinja-val`(tr の data-rank の loop.index)だけ。
      expect(Object.keys(r.jinjaUnitKinds), t.id).toEqual(['jinja-val']);
    }
  });

  it('わざと入れた違反を、種類・位置・前後の抜粋つきで数え、受付の 400 の理由を返す', () => {
    const body =
      '<p>前置き</p><!-- {{ fund.name }} -->' +
      '{% if a %}{% set n = 1 %}{% endif %}<p>{{- fund.name }}</p>';
    const html = doc(body);
    const r = m.measureTemplate('XX01_000001_交付版', html, fixtureSample);
    expect(r.issues.map((i) => i.code)).toEqual(['token-position', 'set-in-branch', 'trim-marker']);
    const first = r.issues[0];
    expect(first.at).toBe(html.indexOf('{{ fund.name }}'));
    expect(first.excerpt).toContain('{{ fund.name }}');
    expect(first.excerpt.length).toBeLessThanOrEqual(40 * 2 + 20);
    expect(r.render.ok).toBe(false);
    if (!r.render.ok) expect(r.render.reason).toContain('タグ・コメント・<style> などの途中');
  });

  it('値で描けない式は unrendered に数え、原文を先頭数件だけ返す', () => {
    const exprs = Array.from({ length: 8 }, (_, i) => `<p>{{ a${i} or "x" }}</p>`).join('');
    const r = m.measureTemplate('XX01_000002_交付版', doc(exprs), fixtureSample);
    expect(r.issues).toEqual([]);
    expect(r.render.ok).toBe(true);
    if (r.render.ok) {
      expect(r.render.unrendered).toBe(8);
      expect(r.render.unrenderedSources.length).toBe(m.MAX_SOURCES_PER_ITEM);
      expect(r.render.unrenderedSources[0]).toContain('a0 or');
    }
  });

  it('Jinja として読めない原文は、描画の理由として返す(例外で止めない)', () => {
    const r = m.measureTemplate('XX01_000003_交付版', doc('<p>{% if a %}</p>'), fixtureSample);
    expect(r.render.ok).toBe(false);
  });
});

describe('measurePart(パーツごと)', () => {
  it('fixture の全パーツは、挿入しても違反 0・jinja の単位 0', () => {
    expect(fixtureParts.length).toBe(29);
    for (const p of fixtureParts) {
      const r = m.measurePart(p, fixtureSample);
      expect(r.issues, p.id).toEqual([]);
      expect(r.jinjaUnits, p.id).toEqual([]);
      expect(r.unrendered, p.id).toBe(0);
    }
  });

  it('タグの文脈の Jinja は単位として数え、挿入で申請できない違反は位置をパーツの中で返す', () => {
    const content =
      '<p>x</p><img src="../images/{{ fund.code }}.png"><p>{%- if a %}y{% endif %}</p>';
    const r = m.measurePart(part('p1', content), fixtureSample);
    expect(r.jinjaUnits.length).toBeGreaterThan(0);
    expect(r.jinjaUnits.every((u) => u.startsWith('jinja'))).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(['trim-marker']);
    expect(r.issues[0].at).toBe(content.indexOf('{%- if'));
  });

  it('値で描けない式を数える', () => {
    const r = m.measurePart(
      part('p2', '<p>{{ x|default("—:—") }}</p><p>{{ a + 1 }}</p><p>{{ fund.name }}</p>'),
      fixtureSample,
    );
    expect(r.unrendered).toBe(2);
    expect(r.unrenderedSources.length).toBe(2);
  });

  it('Jinja として読めないパーツは error に理由を持つ', () => {
    const r = m.measurePart(part('p3', '<p>{% for x in xs %}</p>'), fixtureSample);
    expect(r.error).toBeTruthy();
  });
});

describe('excerptAt', () => {
  it('前後 40 文字に切り、改行・タブを見える記号にする', () => {
    const s = `${'a'.repeat(100)}\n{{ x }}\t${'b'.repeat(100)}`;
    const e = m.excerptAt(s, 101);
    expect(e).toBe(`…${'a'.repeat(39)}⏎{{ x }}→${'b'.repeat(32)}…`);
  });
});

describe('readOnlySproc', () => {
  it('読み取りの操作だけを通し、ほかは呼ぶ前に止める', async () => {
    const { SP } = await import('../src/db/sprocNames.js');
    const calls: string[] = [];
    const inner = {
      callSproc: async <T>(proc: string, op: string) => {
        calls.push(`${proc}/${op}`);
        return [] as T[];
      },
    };
    const ro = m.readOnlySproc(inner);
    await ro.callSproc(SP.part, '一覧');
    await ro.callSproc(SP.sample, '共通一覧');
    await ro.callSproc(SP.template, '委託会社一覧');
    await ro.callSproc(SP.template, 'ファンド一覧');
    await expect(ro.callSproc(SP.part, '更新')).rejects.toThrow('読み取り');
    await expect(ro.callSproc(SP.audit, '追加')).rejects.toThrow('読み取り');
    expect(calls.length).toBe(4);
  });
});

describe('runMeasure(リポジトリ経由の全体)と出力', () => {
  let result: Awaited<ReturnType<Mod['runMeasure']>>;

  beforeAll(async () => {
    fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true });
    for (const t of fixtureTemplates)
      fs.writeFileSync(path.join(tmp, 'templates', `${t.id}.html`), t.html, 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'templates', 'XX01_999999_交付版.html'),
      doc('<!-- {{ fund.name }} -->'),
      'utf8',
    );
    // pending/: 作成経路の生成物 2 本(1 本は templates/ と同じ id で中身が違う)と、測らない
    // 編集経路の生成物(基準日つき)1 本。
    fs.mkdirSync(path.join(tmp, 'pending'), { recursive: true });
    const pend = (id: string, html: string) =>
      fs.writeFileSync(path.join(tmp, 'pending', `${id}.html`), html, 'utf8');
    pend('XX01_888888_全体版', doc('<p>{%- if a %}x{% endif %}</p>'));
    pend('XX01_950037_交付版', doc('<p title="{% if a %}x{% endif %}">y</p>'));
    pend('XX01_950037_20240710_交付版', doc('<!-- {{ fund.name }} -->'));
    const { createFakeSproc } = await import('./fakes/sprocFake.js');
    const sproc = m.readOnlySproc(
      await createFakeSproc({
        parts: [
          ...fixtureParts.map((p) => ({
            id: p.id,
            category: p.classification.category,
            majorClass: p.classification.majorClass,
            middleClass: p.classification.middleClass,
            minorClass: p.classification.minorClass,
            name: p.name,
            content: p.content,
            syncDefault: null,
            masterReflectDefault: null,
            targetEdition: null,
            companyCode: p.companyCode,
          })),
          {
            id: 'p-bad',
            category: '本文',
            majorClass: 'x',
            middleClass: 'x',
            minorClass: 'x',
            name: '幅つきの帯',
            content: '<div style="width:{{ w }}%">x</div>',
            syncDefault: null,
            masterReflectDefault: null,
            targetEdition: null,
          },
        ],
      }),
    );
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    const { createPartRepo } = await import('../src/repositories/partRepo.js');
    const { listTemplateFiles } = await import('../src/files/templateFiles.js');
    const { listPendingIds, readPending } = await import('../src/files/pendingFiles.js');
    const snapshot = () =>
      ['templates', 'pending'].flatMap((d) =>
        fs.readdirSync(path.join(tmp, d)).map((n) => {
          const st = fs.statSync(path.join(tmp, d, n));
          return `${d}/${n}:${st.size}:${st.mtimeMs}`;
        }),
      );
    const before = snapshot();
    result = await m.runMeasure({
      listTemplateFiles,
      listPendingIds,
      readPending,
      templates: createTemplateRepo(sproc),
      parts: createPartRepo(sproc),
    });
    // 読み取りだけ: templates/・pending/ のファイルの数・大きさ・更新時刻が変わらない。
    expect(snapshot()).toEqual(before);
  });

  it('templates/ と pending/ の作成経路の物、パーツの全件を測り、違反は置き場つきの名前で挙げる', () => {
    expect(result.templates.length).toBe(11);
    expect(result.templates.filter((t) => t.source === 'pending').map((t) => t.id)).toEqual([
      'XX01_888888_全体版',
      'XX01_950037_交付版',
    ]);
    expect(result.parts.length).toBe(30);
    const s = m.summarize(result);
    expect(s.bySource.templates.total).toBe(9);
    expect(s.bySource.pending.total).toBe(2);
    expect(s.templatesWithIssues).toEqual([
      'templates/XX01_999999_交付版',
      'pending/XX01_888888_全体版',
      'pending/XX01_950037_交付版',
    ]);
    expect(Object.keys(s.bySource.pending.issues).sort()).toEqual([
      'token-position',
      'trim-marker',
    ]);
    // 同じ id の templates/ 側は fixture のままなので違反 0。pending/ 側は属性値の中の if と endif の 2 件。
    const same = result.templates.filter((t) => t.id === 'XX01_950037_交付版');
    expect(same.map((t) => [t.source, t.issues.length])).toEqual([
      ['templates', 0],
      ['pending', 2],
    ]);
    expect(s.partsWithJinjaUnits).toEqual(['幅つきの帯 (p-bad)']);
    expect(s.partsWithIssues).toEqual([]);
    expect(result.notes.some((n) => n.includes('pending/') && n.includes('1 件'))).toBe(true);
  });

  it('sample を取れないテンプレートは、描画を測らずに理由を残す', async () => {
    const r = await m.runMeasure({
      listTemplateFiles: async () => ['XX01_950037_交付版.html', 'readme.txt.html'],
      listPendingIds: async () => ['XX01_777777_交付版'],
      readPending: async () => null,
      templates: {
        getTemplate: async (id) => ({
          meta: {} as never,
          html: fixtureTemplates.find((t) => t.id === id)?.html ?? '',
          css: '',
          filled: '',
        }),
        getSampleData: async () => {
          throw new Error('DB に届かない');
        },
      },
      parts: { listParts: async () => [] },
    });
    expect(r.templates.length).toBe(1);
    expect(r.templates[0].render).toEqual({ ok: false, reason: expect.stringContaining('sample') });
    expect(r.notes.some((n) => n.includes('readme.txt'))).toBe(true);
    // 一覧の後に消えた pending/ は、測らずに置き場つきの名前で残す。
    expect(r.notes.some((n) => n.includes('pending/XX01_777777_交付版'))).toBe(true);
  });

  it('画面の要約は件数の表と先頭 20 件の名前、レポートは抜粋だけを書く', () => {
    const screen = m.formatScreen(result, 'X:/out/report.txt');
    expect(screen).toContain('テンプレート 11 本(templates/ 9・pending/ 2)');
    expect(screen).toContain('パーツ 30 件');
    // 表は置き場ごとの列を持つ: (a) は templates/ 1 本・pending/ 2 本・件数 3。
    expect(screen).toMatch(/\(a\) 原文の検査の違反.*\s+1\s+2$/m);
    expect(screen).toContain('templates/XX01_999999_交付版');
    expect(screen).toContain('pending/XX01_888888_全体版');
    expect(screen).toContain('幅つきの帯 (p-bad)');
    expect(screen).toContain('X:/out/report.txt');
    const report = m.formatReport(result);
    expect(report).toContain('token-position');
    expect(report).toContain('■ pending/XX01_950037_交付版');
    expect(report).toContain('■ templates/XX01_999999_交付版');
    expect(report).toContain('jinja-');
    // 原文の全文は書かない(fixture の本文の長い一節が丸ごとは出ない)。
    const longest = fixtureTemplates[0].html;
    expect(report.includes(longest.slice(0, 400))).toBe(false);
  });

  it('レポートは指定のフォルダへ新しく書き、dataRoot の中へは書かない', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-measure-out-'));
    const file = await m.writeReport(path.join(out, 'measure-1'), 'abc', [tmp]);
    expect(fs.readFileSync(file, 'utf8')).toBe('abc');
    await expect(m.writeReport(path.join(out, 'measure-1'), 'abc', [tmp])).rejects.toThrow();
    await expect(m.writeReport(path.join(tmp, 'bk'), 'abc', [tmp])).rejects.toThrow('dataRoot');
    expect(fs.existsSync(path.join(tmp, 'bk'))).toBe(false);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('引数: --out だけを受け、既定はリポジトリの bk/measure-<日時>', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 9, 8, 7));
    expect(m.parseArgs([], 'R:/repo')).toEqual({
      outDir: path.join('R:/repo', 'bk', 'measure-20261030-090807'),
    });
    vi.useRealTimers();
    expect(m.parseArgs(['--out', 'Y:/o'], 'R:/repo')).toEqual({ outDir: path.resolve('Y:/o') });
    expect(m.parseArgs(['--bogus'], 'R:/repo')).toBeNull();
  });
});
