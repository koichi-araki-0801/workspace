// =============================================================================
// htmlBlockDiff.limits.test.ts — 語句 LCS の資源上限とフォールバック(F18)
// =============================================================================
// 語句 diff の DP は `(n+1) x (m+1)` の密行列を確保する。テキストノードの中身は他ユーザ
// (申請者)が書いた本文で、`tokenize` は CJK を 1 文字 1 トークンに刻むため、上限が無いと
// 巨大な段落 1 つで承認者のタブを落とせる。ここでは
//   1. 上限超過で例外ではなく粗い差分(全文 del + 全文 ins)へ落ちること
//   2. 落ちても差分表示自体は必ず出ること(承認者が「差分が見られない」状態を作らない)
//   3. 上限内では従来どおり語句単位で着色されること
// を対にして固定する。
import { describe, expect, it } from 'vitest';
import {
  buildHtmlDiff,
  createLcsBudget,
  diffHighlightCss,
  diffTokens,
  HL_COARSE,
  HL_DEL,
  HL_INS,
  hasCoarseDiff,
  MAX_LCS_CELLS,
  MAX_LCS_DIM,
  MAX_LCS_TOTAL_CELLS,
} from '@/features/compare/htmlBlockDiff';

/** 全トークンが互いに異なる長さ `len` の列(共通 prefix トリムが効かない最悪形)。 */
function distinctTokens(prefix: string, len: number): string[] {
  return Array.from({ length: len }, (_, i) => `${prefix}${i}`);
}

/** body 断片を最小の HTML 文書に包む(`renderJinja` の出力形)。 */
function doc(...body: string[]): string {
  return `<!doctype html><html><body>${body.join('')}</body></html>`;
}

describe('diffTokens の面積上限', () => {
  it('上限は文書化された 4,000,000 セルで固定', () => {
    // 値を動かすとメモリ上限(約 32MB)と「通したい本文の大きさ」の両方が変わるため、
    // 変更は意図的な設計判断として本テストの更新を伴わせる。
    expect(MAX_LCS_CELLS).toBe(4_000_000);
  });

  it('上限内(1000 x 1000)は従来どおり語句単位の full DP を通る', () => {
    const a = distinctTokens('a', 1000);
    const b = [...a.slice(0, 999), 'zzz'];
    const res = diffTokens(a, b);
    expect(res.coarse).toBe(false);
    // 末尾 1 トークンだけが del/ins になり、残りは same のまま。
    expect(res.ops.filter((o) => o.type === 'same')).toHaveLength(999);
    expect(res.ops.filter((o) => o.type === 'del')).toEqual([{ type: 'del', text: 'a999' }]);
    expect(res.ops.filter((o) => o.type === 'ins')).toEqual([{ type: 'ins', text: 'zzz' }]);
  });

  it('上限超過(2001 x 2001)は行列を確保せず全文 del + 全文 ins へ落ちる', () => {
    const a = distinctTokens('a', 2001);
    const b = distinctTokens('b', 2001);
    expect(a.length * b.length).toBeGreaterThan(MAX_LCS_CELLS);
    const res = diffTokens(a, b);
    expect(res.coarse).toBe(true);
    // 情報は落とさない: 両側の全文がそのまま 1 対の op として残る。
    expect(res.ops).toEqual([
      { type: 'del', text: a.join('') },
      { type: 'ins', text: b.join('') },
    ]);
  });

  it('共通 prefix が長いだけの長文は上限に当たらない(トリムが先に効く)', () => {
    // 素の列は 3001 x 3001 = 約 900 万セルだが、prefix トリム後は 1 x 1 になる。
    const head = distinctTokens('h', 3000);
    const res = diffTokens([...head, '甲'], [...head, '乙']);
    expect(res.coarse).toBe(false);
    expect(res.ops.filter((o) => o.type !== 'same')).toEqual([
      { type: 'del', text: '甲' },
      { type: 'ins', text: '乙' },
    ]);
  });
});

// 面積 `n * m` だけでは守れない 2 つの穴を塞ぐ。1 辺の上限は「n=400 万 / m=1」のような
// 偏った形(積は上限内だが 400 万個の小配列を確保する)を、文書単位の予算は「上限直下の
// ノードを大量に並べる」形(総量がノード数に比例して伸びる)を止める。
describe('偏りと総量の上限', () => {
  it('1 辺だけが巨大な形(片側 1 トークン)も粗い差分へ落ちる', () => {
    const a = distinctTokens('a', MAX_LCS_DIM + 1);
    const b = ['zzz'];
    // 積は上限内 — 面積判定だけでは通り抜けてしまう形。
    expect(a.length * b.length).toBeLessThan(MAX_LCS_CELLS);
    const res = diffTokens(a, b);
    expect(res.coarse).toBe(true);
    expect(res.ops).toEqual([
      { type: 'del', text: a.join('') },
      { type: 'ins', text: 'zzz' },
    ]);
  });

  it('文書予算はノードを跨いで減り、使い切ったら以降は粗い差分へ落ちる', () => {
    const budget = createLcsBudget();
    const a = distinctTokens('a', 1000);
    const b = distinctTokens('b', 1000);
    expect(diffTokens(a, b, budget).coarse).toBe(false);
    // 1 ノードぶん(1000 x 1000)がそのまま引かれる = 総量はノード数に比例して減る。
    expect(budget.remaining).toBe(MAX_LCS_TOTAL_CELLS - 1_000_000);
    // 予算が尽きた後は、1 ノード単位では上限内でも full DP を回さない。
    budget.remaining = 10;
    expect(diffTokens(a, b, budget).coarse).toBe(true);
    expect(budget.remaining).toBe(10);
  });

  it('予算を渡さない単発呼び出しは従来どおり(節約しない)', () => {
    const a = distinctTokens('a', 1000);
    const b = distinctTokens('b', 1000);
    for (let i = 0; i < 3; i++) expect(diffTokens(a, b).coarse).toBe(false);
  });
});

describe('buildHtmlDiff の粗いフォールバック', () => {
  // CJK は 1 文字 1 トークン。3000 字同士 = 900 万セルで上限を超える。
  const bigBefore = 'あ'.repeat(3000);
  const bigAfter = 'い'.repeat(3000);

  it('巨大テキストノードでも差分は必ず出し、簡易表示フラグを立てる', () => {
    const diff = buildHtmlDiff(doc(`<p id="x">${bigBefore}</p>`), doc(`<p id="x">${bigAfter}</p>`));
    expect(diff.changedPageCount).toBe(1);
    const page = diff.pages[0];
    expect(page.changed).toBe(true);
    expect(page.changedBlockCount).toBe(1);
    // フラグはパーツ → ページ → 文書全体まで持ち上がる(2 画面の注記が読む)。
    expect(page.blocks[0].coarse).toBe(true);
    expect(page.coarse).toBe(true);
    expect(diff.coarse).toBe(true);
    // 着色は「全文の塊」1 つ。中身は欠落せず両ペインに残る。
    expect(page.beforeHtml).toContain(`<span class="${HL_DEL} ${HL_COARSE}">`);
    expect(page.afterHtml).toContain(`<span class="${HL_INS} ${HL_COARSE}">`);
    expect(page.beforeHtml).toContain(bigBefore);
    expect(page.afterHtml).toContain(bigAfter);
  });

  it('上限内の通常テキストは語句単位の着色のまま(フラグは立たない)', () => {
    const diff = buildHtmlDiff(
      doc('<p id="x">売上は 105 パーセント 増加しました</p>'),
      doc('<p id="x">売上は 112 パーセント 増加しました</p>'),
    );
    const page = diff.pages[0];
    expect(page.blocks[0].coarse).toBe(false);
    expect(page.coarse).toBe(false);
    expect(diff.coarse).toBe(false);
    expect(page.beforeHtml).toContain(`<span class="${HL_DEL}">105</span>`);
    expect(page.afterHtml).toContain(`<span class="${HL_INS}">112</span>`);
    expect(page.afterHtml).not.toContain(HL_COARSE);
  });

  it('無変更文書ではフラグが立たない(高速パス)', () => {
    const html = doc(`<p id="x">${bigBefore}</p>`);
    const diff = buildHtmlDiff(html, html);
    expect(diff.coarse).toBe(false);
    expect(diff.pages[0].blocks.every((b) => b.coarse === false)).toBe(true);
  });
});

describe('hasCoarseDiff(承認画面の行判定)', () => {
  it('削除側・挿入側どちらの塊でも検出する', () => {
    expect(hasCoarseDiff(`<span class="${HL_DEL} ${HL_COARSE}">x</span>`)).toBe(true);
    expect(hasCoarseDiff(`<span class="${HL_INS} ${HL_COARSE}">x</span>`)).toBe(true);
    // 複数ペインをまとめて渡せる(片方だけ粗くても true)。
    expect(hasCoarseDiff('', `<span class="${HL_INS} ${HL_COARSE}">x</span>`)).toBe(true);
  });

  it('通常の語句着色や無着色では false', () => {
    expect(
      hasCoarseDiff(`<span class="${HL_DEL}">old</span>`, `<span class="${HL_INS}">new</span>`),
    ).toBe(false);
    expect(hasCoarseDiff('')).toBe(false);
  });

  it('簡易表示の塊は iframe 内でも見分けが付く(CSS 規則がある)', () => {
    expect(diffHighlightCss(14)).toContain(`.${HL_COARSE}{`);
  });
});
