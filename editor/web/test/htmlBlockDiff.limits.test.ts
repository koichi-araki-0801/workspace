// =============================================================================
// htmlBlockDiff.limits.test.ts — 語句 LCS の資源上限とフォールバック
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
  buildDiffDoc,
  buildHtmlDiff,
  createLcsBudget,
  diffHighlightCss,
  diffTokens,
  HL_COARSE,
  HL_DEL,
  HL_INS,
  hasCoarseDiff,
  hasPrintOnlyRules,
  MAX_COMPLEX_SELECTORS,
  MAX_LCS_CELLS,
  MAX_LCS_DIM,
  MAX_LCS_TOTAL_CELLS,
  MAX_TOP_LEVEL_BLOCKS,
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

// =============================================================================
// ページ分割側の上限
// =============================================================================
// 承認画面のページ分割は、申請者が書いた CSS と HTML の両方を無加工で受け取る。
// 上限が無いと ① CSS ルール抽出の正規表現 `/([^{}]+)\{([^{}]*)\}/g` は波括弧を含まない
// 入力で二次(実測 160KB=13 秒)になり、② セレクタ照合を「直下要素数 x セレクタ数」の
// 総当たりにすると linkedom がコール毎にセレクタをコンパイルする(B=S=20,000 で数百〜数千秒)。
// **迂回入力で二次にならないこと**を比で主張する(絶対時間はマシン差に弱い)。

/** 実行時間を測る(比で主張するので絶対値は使わない)。 */
function measure(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('ページ分割の資源上限(R23 / R24)', () => {
  it('上限を定数として固定する', () => {
    expect(MAX_COMPLEX_SELECTORS).toBe(32);
    expect(MAX_TOP_LEVEL_BLOCKS).toBe(5_000);
  });

  it('波括弧を含まない長大 CSS で線形に収まる(旧実装は二次)', () => {
    const css = (k: number) => `${'a'.repeat(k)}`;
    const t1 = measure(() => buildHtmlDiff(doc('<p>x</p>'), doc('<p>y</p>'), css(20_000)));
    const t4 = measure(() => buildHtmlDiff(doc('<p>x</p>'), doc('<p>y</p>'), css(80_000)));
    // 二次なら長さ 4 倍で約 16 倍。線形なら約 4 倍。
    expect(t4).toBeLessThan(Math.max(t1, 1) * 8);
  });

  // 単体実行では 0.5 秒前後で終わるが、フルスイートは 100 本超のテストファイルを並列に
  // 走らせるため CPU 競合で数倍に伸びる。既定 5 秒のままだと「実装が線形か」ではなく
  // 「その時のマシン負荷」を測ることになるので、重い 2 本には明示タイムアウトを与える。
  // 上限そのものは緩めない — 二次の実装は同じ入力で数百〜数千秒かかる。
  const HEAVY_TIMEOUT_MS = 120_000;

  it(
    'セレクタ数 x 直下要素数を増やしても二次にならない',
    () => {
      // 単純セレクタは集合照合へ落ちるので、S が増えても照合コストは O(B) のまま。
      const rules = Array.from(
        { length: 2_000 },
        (_, i) => `.c${i} { page-break-after: always }`,
      ).join('\n');
      const blocks = Array.from({ length: 2_000 }, (_, i) => `<div class="c${i}">x</div>`).join('');
      const t = measure(() => buildHtmlDiff(doc(blocks), doc(blocks), rules));
      expect(t).toBeLessThan(30_000);
    },
    HEAVY_TIMEOUT_MS,
  );

  it('複合セレクタが上限を超えても差分は必ず出る(degrade であって停止ではない)', () => {
    const rules = Array.from(
      { length: MAX_COMPLEX_SELECTORS + 50 },
      (_, i) => `div > .x${i}:not(.y) { page-break-after: always }`,
    ).join('\n');
    const res = buildHtmlDiff(doc('<p>a</p>'), doc('<p>b</p>'), rules);
    expect(res.pages.length).toBeGreaterThan(0);
  });

  it(
    '直下要素が上限を超えても例外にならず差分が出る',
    () => {
      const blocks = Array.from({ length: MAX_TOP_LEVEL_BLOCKS + 100 }, () => '<p>x</p>').join('');
      const res = buildHtmlDiff(doc(blocks), doc(blocks));
      expect(res.pages.length).toBeGreaterThan(0);
    },
    HEAVY_TIMEOUT_MS,
  );

  it('単純セレクタによる改ページは従来どおり効く(回帰)', () => {
    const css = '.page { page-break-after: always }';
    const body = '<div class="page">1</div><div class="page">2</div><div>3</div>';
    const res = buildHtmlDiff(doc(body), doc(body), css);
    expect(res.pages).toHaveLength(3);
  });

  // `@media` の中の規則も改ページ対象である。
  // 条件付きグループ規則を読み飛ばすと承認画面のページ対応が変わる = 差分の正しさが変わる。
  it('条件付きグループ規則(@media / @supports / @layer)の中の改ページを拾う', () => {
    const body = '<div class="page">1</div><div class="page">2</div>';
    for (const css of [
      '@media print { .page { page-break-after: always } }',
      '@supports (display: grid) { .page { page-break-after: always } }',
      '@layer print { .page { page-break-after: always } }',
    ]) {
      expect(buildHtmlDiff(doc(body), doc(body), css).pages, css).toHaveLength(2);
    }
  });

  // グループ規則の後ろに続く通常規則の prelude が閉じ `}` を巻き込むと `el.matches()` が
  // 壊れたセレクタを受け取る。カーソルは前進したまま prelude だけ切り直すのが正。
  it('グループ規則の直後に置いた通常規則も正しく拾う', () => {
    const css = '@media print { .x { color: red } } .page { page-break-after: always }';
    const body = '<div class="page">1</div><div class="page">2</div>';
    expect(buildHtmlDiff(doc(body), doc(body), css).pages).toHaveLength(2);
  });

  // 中身が宣言/マージンボックスだけの at-rule は従来どおりブロックごと飛ばす。
  it('@page / @keyframes の中は走査しない', () => {
    const css = '@page { size: A4; @bottom-center { content: counter(page) } }';
    const body = '<div class="page">1</div><div class="page">2</div>';
    expect(buildHtmlDiff(doc(body), doc(body), css).pages).toHaveLength(1);
  });
});

// ── 承認画面の完全性 ──
// 差分ペインは「申請者が書いた本文 + 申請者が書いた CSS」を承認者に見せる面で、
// 見えているものが本物であることが承認の前提になる。ここが崩れると、無害に見える差分を
// 承認させて別の内容を確定領域へ入れられる(職務分掌の回避)。
describe('差分装飾は申請者 CSS から守られる', () => {
  const layerDecl = /<style>@layer (d[0-9a-f]{16});<\/style>/;

  it('レイヤ宣言が申請者 CSS より前にある(重要宣言の逆転はレイヤ順で決まる)', () => {
    const built = buildDiffDoc('<p>x</p>', '.applicant{color:red}', diffHighlightCss(8));
    const declAt = built.search(layerDecl);
    const applicantAt = built.indexOf('.applicant');
    expect(declAt).toBeGreaterThanOrEqual(0);
    // 後ろに置くと、申請者が自分の CSS 先頭で宣言したレイヤの方が先になり逆転が向こうへ効く。
    expect(declAt).toBeLessThan(applicantAt);
  });

  it('ハイライト CSS はそのレイヤの中に入る', () => {
    const built = buildDiffDoc('<p>x</p>', '', diffHighlightCss(8));
    const name = layerDecl.exec(built)?.[1] as string;
    expect(built).toContain(`@layer ${name}{`);
    // 装飾は `!important` であること(通常宣言ではレイヤ順が逆転せず守りにならない)。
    expect(diffHighlightCss(8)).toContain(`.${HL_INS}{background:rgba(22,163,74,.18)!important`);
    // `display` は入れない(表セル等の正当なレイアウトを壊すため。守りが本体を壊さない)。
    expect(diffHighlightCss(8)).not.toContain('display:block!important');
  });

  it('レイヤ名は文書ごとに変わる(同名レイヤへの相乗りを塞ぐ)', () => {
    // 実ブラウザで確認した唯一の突破口が「名前を当てて同じレイヤへ高詳細度で書く」形。
    // 名前が固定だとその 1 手で装飾を消せるため、推測不能であることが防御の一部になる。
    const names = new Set(
      Array.from({ length: 8 }, () => layerDecl.exec(buildDiffDoc('<p>x</p>', '', 'a{}'))?.[1]),
    );
    expect(names.size).toBe(8);
  });
});

describe('差分の打ち切りは必ず申告される', () => {
  it('上限内では truncated=false', () => {
    const body = '<div>a</div><div>b</div>';
    expect(buildHtmlDiff(doc(body), doc(body)).truncated).toBe(false);
  });

  // 上限いっぱいのブロックを実際に diff するので、ルート CI(5 プロジェクト並列 + coverage)
  // では既定 5s を超えて落ちる(単独なら 1s 未満)。遅いこと自体は退行ではないので上限を
  // 実測へ合わせる。
  it('body 直下が上限を超えたら truncated=true(捨てた分は差分に出ない)', {
    timeout: 60_000,
  }, () => {
    const many = Array.from({ length: MAX_TOP_LEVEL_BLOCKS + 5 }, () => '<div>x</div>').join('');
    const d = buildHtmlDiff(doc(many), doc(many));
    // 例外にはしない(承認者が差分を見られない状態を作らない)が、黙ってもいない。
    expect(d.pages.length).toBeGreaterThan(0);
    expect(d.truncated).toBe(true);
  });
});

describe('印刷時だけ効く規則の検出', () => {
  it('@media print だけの規則を検出する', () => {
    expect(hasPrintOnlyRules('.x{display:none}@media print{.x{display:block}}')).toBe(true);
  });

  // CSS エスケープ(`@\6d edia print`)は実ブラウザでは `CSSMediaRule:print` として解決され、
  // 判定に CSSOM を使う理由そのものになっている(Chromium で実測)。ただし **jsdom の cssom は
  // エスケープを解決しない**ため、ここで assert すると製品ではなく jsdom の限界を固定して
  // しまう。よって単体では主張しない(正規表現へ戻すと実ブラウザで迂回されることに注意)。

  it('@supports / @layer の内側でも検出する', () => {
    expect(hasPrintOnlyRules('@supports (color:red){@media print{.x{color:red}}}')).toBe(true);
  });

  it('screen にも効くもの・print と無関係なものは検出しない(誤検知しない)', () => {
    expect(hasPrintOnlyRules('@media screen, print{.x{color:red}}')).toBe(false);
    expect(hasPrintOnlyRules('@media all{.x{color:red}}')).toBe(false);
    expect(hasPrintOnlyRules('@media (min-width:600px){.x{color:red}}')).toBe(false);
    expect(hasPrintOnlyRules('.x{color:red}')).toBe(false);
    expect(hasPrintOnlyRules('')).toBe(false);
  });
});
