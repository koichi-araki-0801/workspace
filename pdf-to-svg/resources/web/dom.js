// PdfToSvg フロントエンドの純粋な DOM/文字列ヘルパ（アプリ状態に依存しない）。

// インライン SVG アイコン生成。p=path 群, w=一辺px(任意), sw=stroke幅(既定1.7)。
export function svg(p, w, sw) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
    (sw || 1.7) +
    '" stroke-linecap="round" stroke-linejoin="round"' +
    (w ? ' style="width:' + w + "px;height:" + w + 'px"' : "") +
    ">" +
    p +
    "</svg>"
  );
}

// HTML 属性/本文へ埋め込む際の最小エスケープ。
export function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
