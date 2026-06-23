// =============================================================================
// pageView.ts — 編集 canvas の「1 ページだけ表示」純粋ロジック
// =============================================================================
// 役割: `useGrapes.ts` のページ送り(1 ページ表示)から DOM/GrapesJS 非依存の判定だけを
// 切り出したもの。ページ要素の列挙・可視制御 CSS の生成・index クランプを純粋関数にして
// vitest で全分岐を直接検証できるようにする(実レイアウトに依存しない)。

/** 生 DOM へ付ける現在ページ判定用のマーカー属性。Component モデルには載せない。 */
export const PV_ATTR = 'data-pv-idx';

/**
 * canvas body から「1 ページ = 1 要素」のページ要素を列挙する。テンプレは
 * `body > div.page` が 1 ページ単位(`.page { page-break-after: always }`)なので body 直下の
 * `.page` を拾う。1 件も無ければ body 全体を 1 ページ扱いの fallback とし `[body]` を返す
 * (ページ送り UI は出さず常時表示になる、`pageViewCss` の `count <= 1` 分岐を見よ)。
 */
export function enumeratePageEls(body: HTMLElement): HTMLElement[] {
  const pages = Array.from(body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('page'),
  );
  return pages.length > 0 ? pages : [body];
}

/**
 * 他ページを隠す page-view `<style>` の textContent を作る。`canvas` head に注入する 2 枚目の
 * style(load 時の A4/jinja スタイルとは別)へ流し込み、ページ送りのたびに書き換える。
 *
 * - 1 ページ表示でページが 2 枚以上のときだけ、現在 index 以外を `display:none` にする。
 * - 全ページ表示(`!singleMode`)または 1 ページ以下のときは空文字 = 従来の連続スクロール。
 *
 * `:nth-child` ではなく `enumeratePageEls` が実ページ要素にだけ付けた `PV_ATTR` を使う。
 * マーカーは `recomputePages` が毎回全クリアしてから実ページ要素にだけ付け直すため、
 * 属性セレクタ単体で一意に当たる。`body > ...` の子結合子は使わない: GrapesJS は body 直下に
 * wrapper(`[data-gjs-type=wrapper]`)を 1 段挟み、ページ要素は `body > wrapper > .page` の
 * 位置に来るため、`body >` ではマッチしない(`useGrapes.ts` の `recomputePages` を見よ)。
 */
export function pageViewCss(index: number, count: number, singleMode: boolean): string {
  if (!singleMode || count <= 1) return '';
  return (
    `[${PV_ATTR}] { display: none !important; }\n` +
    `[${PV_ATTR}="${index}"] { display: block !important; }`
  );
}

/** ページ index を `[0, count-1]` に収める(count=0 / 負数 / 超過を 0 起点で安全化)。 */
export function clampPageIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}
