// =============================================================================
// reviewCompareDocs.ts — 精査画面の左右組版比較(PreviewPanel×2)へ渡す完全文書
// =============================================================================
// 精査画面の主役は「修正前｜修正後」を実際の帳票と同じ組版(vivliostyle)で並べる比較で、
// 本モジュールは compare サービスが返す本文 HTML + CSS を PreviewPanel が受け取れる
// 完全文書へ包み、変更ページへマーカーとアンカーを付ける。
//
// - マーカーはページ単位。変更のあったページ全体（`.page` 要素）を囲む。複数ページの
//   テンプレでは複数の `.page` が変更ページ分だけマーク対象になる。
// - マーカーは既存の差分装飾と同じ「CSPRNG レイヤ名のカスケードレイヤ + !important」で
//   守る(申請者 CSS は同レイヤ名を当てられない限り上書きできない)。`display` は
//   上書きしない(表セルのレイアウトを壊す)。
// - ここで作る文書は**表示専用**で、申請へ保存されるバイト列(html/css/filledHtml)には
//   一切触れない。DOM 経由の再直列化はこの表示境界だけで行う。
// - 変更ページの粒度は `buildHtmlDiff` の `diff.pages` の index（0 始まり）。実テンプレは
//   `.page` 1 個 = 1 ページの構成のため、index と `.page` 出現順は直接対応する。

export interface CompareDocsInput {
  beforeHtml: string;
  afterHtml: string;
  cssBefore: string;
  cssAfter: string;
  /** 変更ページの index 集合(0 始まり。`buildHtmlDiff` の `diff.pages` の index 由来)。 */
  changedPageIndexes: ReadonlySet<number>;
  /** 黄マーカーを描くか。false でも位置ジャンプ用のアンカー id は付ける。 */
  marker: boolean;
}

export interface CompareDocs {
  beforeDoc: string;
  afterDoc: string;
  /** after 文書内の出現順のアンカー id(「次の変更箇所へ」の巡回に使う)。 */
  anchors: string[];
}

/** 文書内の `.page` 要素を出現順に数え、変更ページへ印とアンカー id を付ける。 */
function annotatePages(
  html: string,
  changedPageIndexes: ReadonlySet<number>,
): { html: string; anchorByIndex: Map<number, string> } {
  const anchorByIndex = new Map<number, string>();
  if (!html.trim()) return { html, anchorByIndex };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pages = Array.from(doc.querySelectorAll('.page'));
  pages.forEach((el, i) => {
    if (!changedPageIndexes.has(i)) return;
    el.setAttribute('data-review-marker', '');
    // 既存 id は差分キーの一部でありうるため上書きしない(未設定のときだけ振る)。
    if (!el.id) el.id = `review-anchor-${i + 1}`;
    anchorByIndex.set(i, el.id);
  });
  return { html: doc.body.innerHTML, anchorByIndex };
}

/** マーカー装飾。レイヤ名は文書ごとに CSPRNG で変え、申請者 CSS からの同名上書きを防ぐ。 */
function markerCss(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const layer = `rvm${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return [
    `@layer ${layer};`,
    `@layer ${layer} {`,
    '[data-review-marker] {',
    '  background-color: #FFF3BF !important;',
    '  outline: 2px solid #E8B931 !important;',
    '  outline-offset: 1px !important;',
    '}',
    '}',
  ].join('\n');
}

/** 完全な HTML 文書を組み立てる。マーカー CSS は申請者 CSS より前に出す。 */
function wrapDoc(bodyHtml: string, css: string, marker: boolean): string {
  const markerBlock = marker ? `<style>${markerCss()}</style>` : '';
  // マーカーのレイヤ宣言は申請者 CSS より**前**に出す(重要宣言はレイヤ優先順位が逆転する
  // 性質を使うため、先に宣言した側が勝つ)。
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">${markerBlock}<style>${css}</style></head><body>${bodyHtml}</body></html>`;
}

export function buildCompareDocs(input: CompareDocsInput): CompareDocs {
  const before = annotatePages(input.beforeHtml, input.changedPageIndexes);
  const after = annotatePages(input.afterHtml, input.changedPageIndexes);
  // ページ index の昇順。after 優先、after に無い index は before から拾う。
  const indexes = [
    ...new Set([...after.anchorByIndex.keys(), ...before.anchorByIndex.keys()]),
  ].sort((a, b) => a - b);
  const anchors = indexes.map(
    (i) => after.anchorByIndex.get(i) ?? (before.anchorByIndex.get(i) as string),
  );
  // .page が 1 つも無い文書はマーカー無しへ degrade（マークもジャンプも出ない）。
  const hasPages = after.anchorByIndex.size > 0 || before.anchorByIndex.size > 0;
  const markerEnabled = input.marker && hasPages;
  return {
    beforeDoc: wrapDoc(before.html, input.cssBefore, markerEnabled),
    afterDoc: wrapDoc(after.html, input.cssAfter, markerEnabled),
    anchors,
  };
}
