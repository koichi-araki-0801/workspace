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
import { describe, expect, it } from 'vitest';
import sample110024 from '@/api/fixtures/sample/110024.json';
import sample510037 from '@/api/fixtures/sample/510037.json';
import { jinjaChipCanvasCss } from '@/features/editor/jinjaComponents';
import { tabOf } from '@/features/layout/tabOf';

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
});

describe('editor 2系統の原則: 編集タブの値はファンド別実値(共通ダミー化しない)', () => {
  it('異なるファンドの `fund.nav` は異なる(全ファンド同一ダミーでない)', () => {
    const a = (sample110024 as { fund?: { nav?: string } }).fund?.nav;
    const b = (sample510037 as { fund?: { nav?: string } }).fund?.nav;
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
