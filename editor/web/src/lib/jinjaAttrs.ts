// =============================================================================
// jinjaAttrs.ts — Jinja round-trip 用 data 属性名の正典
// =============================================================================
// `fillJinja.ts` / `jinjaMask.ts` が「書き手」、`jinjaMask.ts` の `toTemplate` が
// 「読み手(復元側)」となる分散プロトコルの属性名をここに一元化する。書き手と読み手が
// 別ファイルにあるため、リテラル散在だと片側だけの typo が round-trip 破壊として
// しか現れない — 本モジュールを両者が import することで契約をコード上に可視化する。
//
// ⚠ 値の変更は既存 fixture(`api/fixtures/filled/*.html`)・保存済みテンプレートとの
//   互換を壊す。fixture 側リテラルは意図的に定数化しておらず、値を誤変更すると
//   `htmlWorkerImpl.test.ts` の round-trip が落ちて検知される。

/** inline chip の厳密ソース(base64)。書: `wrapInlineTokens`/`fillInline` → 復: `toTemplate` step1 */
export const DATA_JINJA = 'data-jinja';
/** absorb/展開したブロック開始文(base64)。書: `absorbBlocks`/`expandLoops` → 復: `toTemplate` step2 */
export const DATA_JINJA_OPEN = 'data-jinja-open';
/** absorb/展開したブロック終了文(base64)。書: `absorbBlocks`/`expandLoops` → 復: `toTemplate` step2 */
export const DATA_JINJA_CLOSE = 'data-jinja-close';
/** collapse した if ブロック全体(base64)。書: `collapseIfs` → 復: `toTemplate` step1c */
export const DATA_JINJA_BLOCK = 'data-jinja-block';
/** ループ展開の表示専用 clone 行。書: `expandLoops` → 破棄: `toTemplate` step0 */
export const DATA_JINJA_LOOP_CLONE = 'data-jinja-loop-clone';
/** opaque mask した verbatim ソース(base64)。書: `opaqueChip` → 復: `toTemplate` step1b */
export const DATA_OPAQUE = 'data-opaque';
/** opaque chip の種別(script/math)。書: `opaqueChip`。復元には使わず live-render 層の dispatch 用 */
export const DATA_OPAQUE_KIND = 'data-opaque-kind';
