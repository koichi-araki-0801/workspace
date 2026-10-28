// =============================================================================
// twoSystems.guard.test.ts — editor 2系統の原則の退行ガード
// =============================================================================
// 設計正典.md「編集 2 系統」の不変条件を機械的に守る。起きやすい 2 つの退行を
// 直接落とすことが目的:
//   - ハイライト漏れ型: 素の `.jinja-chip.jinja-var` に背景を直書きし、編集タブへハイライトが
//     漏れる退行。→ ハイライト背景は `.jinja-vars-highlight` 配下のみ、を検証。
//   - 共通ダミー型: filled / サンプルを全ファンド共通ダミーに潰し、編集タブが実値を失う
//     退行。→ ファンド間で主要値(`fund.nav`)が異なる、を検証。
//   - 点灯ずれ型: タブ点灯の写像が `created` query 以外の根拠を見て、作成経路の編集画面が
//     「編集」タブに点灯する退行。→ 写像は query のみで決まる、を検証。
//   - 挿入の混線型: カタログのパーツを経路と違う値・形で描き、編集タブへチップや印が入る退行。
//     → 編集タブの挿入は地の HTML、作成タブの挿入は共通サンプルで描く、を検証。
import fs from 'node:fs';
import path from 'node:path';
import { findEditingMarkers, type SampleData, sampleCommon } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { jinjaChipCanvasCss } from '@/features/editor/jinjaComponents';
import { pagebreakCanvasCss } from '@/features/editor/pagebreakCanvas';
import { renderPartForInsert } from '@/features/editor/partRender';
import { tabOf } from '@/features/layout/tabOf';
import sample910024 from '../../fixtures/sample/910024.json';
import sample950037 from '../../fixtures/sample/950037.json';

/** CSS を `セレクタ → 宣言ブロック本文` の素朴な対に分解する(コメント除去・ネスト無し前提)。 */
function cssRules(css: string): { selector: string; body: string }[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: { selector: string; body: string }[] = [];
  for (const m of noComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

describe('editor 2系統の原則: 差し込み値ハイライトのスコープ', () => {
  const rules = cssRules(jinjaChipCanvasCss);

  it('素の `.jinja-chip.jinja-var` は背景を直書きしない(編集タブへ漏らさない)', () => {
    const bare = rules.filter((r) => r.selector === '.jinja-chip.jinja-var');
    expect(bare.length).toBeGreaterThan(0);
    for (const r of bare) {
      expect(r.body).not.toMatch(/background/);
    }
  });

  it('ハイライト背景は `.jinja-vars-highlight` 配下でのみ定義する(作成タブ専用)', () => {
    const scoped = rules.find((r) => r.selector === '.jinja-vars-highlight .jinja-chip.jinja-var');
    expect(scoped, 'スコープ付きハイライトルールが存在すること').toBeTruthy();
    expect(scoped?.body).toMatch(/background\s*:/);
  });

  it('ループの行と固めた要素の枠は `.jinja-vars-highlight` 配下でだけ定義する(作成タブ専用)', () => {
    const outlined = rules.filter((r) =>
      /data-jinja-loop-row|data-opaque-kind="frozen"|jinja-frozen-body\s*>/.test(r.selector),
    );
    expect(outlined.length).toBeGreaterThan(0);
    for (const r of outlined)
      for (const sel of r.selector.split(','))
        expect(sel.trim().startsWith('.jinja-vars-highlight '), sel).toBe(true);
  });

  it('スコープの無い固めた要素の規則は見た目を持たない(レイアウトの規則だけ)', () => {
    const bare = rules.filter(
      (r) =>
        /jinja-frozen|data-opaque|data-jinja-loop-row/.test(r.selector) &&
        !r.selector.split(',').every((s) => s.trim().startsWith('.jinja-vars-highlight ')),
    );
    for (const r of bare) expect(r.body, r.selector).not.toMatch(/background|outline|border/);
  });
});

describe('editor 2系統の原則: 改ページの帯', () => {
  // 区切りは 2 系統で意味が変わらないので、帯は作成タブ・編集タブで同じに出す。ハイライトの
  // スコープ(`.jinja-vars-highlight`)に入れると編集タブで帯が消え、区切りを選べなくなる。
  it('帯は両系統で同じ(ハイライトのスコープに入れず、canvas の CSS に常に載せる)', () => {
    expect(pagebreakCanvasCss).not.toContain('jinja-vars-highlight');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/features/editor/useGrapes.ts'),
      'utf8',
    );
    expect(src).toMatch(/canvasCss: `[^`]*\$\{pagebreakCanvasCss\}[^`]*`/);
  });
});

describe('editor 2系統の原則: 編集タブの値はファンド別実値(共通ダミー化しない)', () => {
  it('異なるファンドの `fund.nav` は異なる(全ファンド同一ダミーでない)', () => {
    const a = (sample910024 as { fund?: { nav?: string } }).fund?.nav;
    const b = (sample950037 as { fund?: { nav?: string } }).fund?.nav;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe('editor 2系統の原則: タブ点灯の写像', () => {
  // 編集・プレビュー画面がタブの下に展開されるため、点灯するタブも経路から決まる。
  // 根拠は `route.query.created === '1'` だけ(設計正典「中核原則」)で、写像はそれを表示へ
  // 写すだけ。ここが別の根拠(パスや state)を見始めると経路判定が 2 本になる。
  it('編集経路(query なし)は「編集」、作成経路(?created=1)は「テンプレート作成」に点灯する', () => {
    expect(tabOf({ name: 'editor', query: {} })).toBe('edit');
    expect(tabOf({ name: 'editor', query: { created: '1' } })).toBe('create');
    expect(tabOf({ name: 'preview', query: {} })).toBe('edit');
    expect(tabOf({ name: 'preview', query: { created: '1' } })).toBe('create');
  });
});

describe('editor 2系統の原則: カタログのパーツの挿入', () => {
  const part = '<div class="part"><p>{{ fund.name }}</p></div>';
  const editorSrc = () =>
    fs.readFileSync(path.resolve(__dirname, '../src/features/editor/useTemplateEditor.ts'), 'utf8');

  it('編集タブで挿入したパーツはハイライトの対象にならない', () => {
    const r = renderPartForInsert(part, {
      route: 'edit',
      values: sample950037 as SampleData,
      valuesFound: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain(String((sample950037 as { fund: { name: string } }).fund.name));
    expect(r.html).not.toMatch(/jinja-chip|jinja-var|data-jinja|data-opaque/);
    expect(findEditingMarkers(r.html)).toEqual([]);
    // 経路の見分けは `route.query.created === '1'` だけ。挿入の描画も同じ判定から経路を選ぶ。
    expect(editorSrc()).toMatch(/isCreateRoute\.value\s*\?\s*\{ route: 'create'/);
  });

  it('作成タブで挿入したパーツは共通サンプルの値で描かれる', () => {
    const r = renderPartForInsert(part, { route: 'create', sample: sampleCommon });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain(String((sampleCommon as { fund: { name: string } }).fund.name));
    // 作成経路の値は読み込み時の共通サンプル(`EditorLoad.sample`)で、値ファイルではない。
    expect(editorSrc()).toMatch(/\{ route: 'create', sample: res\.value\.sample \}/);
  });
});

describe('editor 2系統の原則: rest 経路の値入り HTML', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8');

  it('プレビューは filled が非空の文書で toTemplate を通さない', () => {
    const src = read('features/preview/services/templatePreviewService.ts');
    expect(src).toMatch(/draft && isFilled/);
  });

  it('比較の現行版は filled が非空なら描画を通さない', () => {
    const src = read('features/compare/services/compareService.ts');
    expect(src).toMatch(/if \(tpl\.filled\) return ok\(\{ html: tpl\.filled/);
  });

  // local の既定 fixture は「値入り HTML が在るものだけが `published`」という rest と同じ
  // 一覧を出す前提で組んである。片側だけにファイルが増えると、その id は local でだけ
  // `draft`(比較タブ・結合 PDF の候補から消える)になり、2 実装の見えが食い違う。
  it('fixtures の templates と filled はファイル名集合が一致する', () => {
    const names = (rel: string) => fs.readdirSync(path.resolve(__dirname, '../src', rel)).sort();
    expect(names('../../fixtures/filled')).toEqual(names('../../fixtures/templates'));
  });

  // 編集タブの値入り HTML は本番では値埋め込み済みのファイルで、往復用の印を持たない。local の fixture も
  // 同じ前提に揃える。印が残ると、編集経路の申請が関所(編集用の印の 400)で止まる。
  it('fixtures の値入り HTML は編集用の印も Jinja も含まない', () => {
    const dir = path.resolve(__dirname, '../../fixtures/filled');
    expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(8);
    for (const name of fs.readdirSync(dir)) {
      const html = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(findEditingMarkers(html), name).toEqual([]);
      expect(html, name).not.toMatch(/\{\{|\{%|\{#/);
    }
  });
});
