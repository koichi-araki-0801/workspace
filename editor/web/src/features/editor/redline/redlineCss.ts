// =============================================================================
// redlineCss.ts — 赤入れ表示のキャンバス注入 CSS
// =============================================================================
// 役割: `useGrapes.init` が canvas iframe の head へ入れる CSS の一部。表示の ON/OFF は
// body のクラス `redline-on` で出し分ける（差し込み値ハイライトの `jinja-vars-highlight`
// と同じ手法。body 直書きのクラスは `getHtml()` に載らないので保存出力を汚さない）。
// 配色は精査画面（`htmlBlockDiff.diffHighlightCss`）に揃える: 削除 = 赤、追加 = 緑、
// 削除された要素 = 橙の左帯。

import {
  REDLINE_ADDED_ATTR,
  REDLINE_ATTR,
  REDLINE_BLOCK_CLASS,
  REDLINE_HIGHLIGHT,
} from './redlineApply';

/** 赤入れを見せている間だけ canvas body に付けるクラス。 */
export const REDLINE_BODY_CLASS = 'redline-on';

export const redlineCanvasCss = `
.${REDLINE_BODY_CLASS} [${REDLINE_ATTR}] {
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
  color: #b91c1c;
  background: rgba(220, 38, 38, 0.12);
  border-radius: 2px;
  user-select: none;
  cursor: default;
}
.${REDLINE_BODY_CLASS} del.${REDLINE_BLOCK_CLASS}[${REDLINE_ATTR}] {
  display: block;
  box-shadow: inset 3px 0 0 #d97706;
  background: rgba(217, 119, 6, 0.08);
}
.${REDLINE_BODY_CLASS} [${REDLINE_ADDED_ATTR}] { box-shadow: inset 3px 0 0 #16a34a; }
.${REDLINE_BODY_CLASS} ::highlight(${REDLINE_HIGHLIGHT}) {
  background: rgba(22, 163, 74, 0.2);
  color: #15803d;
}
/* トグル OFF: 旧文言を流れから外し、行送り・改ページを PDF と同じに戻す。 */
body:not(.${REDLINE_BODY_CLASS}) [${REDLINE_ATTR}] { display: none; }
`;
