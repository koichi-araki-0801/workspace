// =============================================================================
// confirmedCanonicalGate.ts — 確定版正規形(confirmedCanonical)を測ってよいかの純判定
// =============================================================================
// `useTemplateEditor.ts` の load から切り出した純関数。呼び出し側の分岐は副作用(GrapesJS の
// getBodyHtml/getCss 呼び出し・localStorage への書き込み)を持つため、条件だけを単体テストで
// 固定できるようにここへ抽出する。

/**
 * 直後に(GrapesJS の現在の canvas 内容から)確定版正規形を測ってキャッシュしてよいかを返す。
 *
 * `false` を返すべき場面が 3 つある:
 * - 作成経路(`isCreateRoute`): 確定版そのものが無い。
 * - 既にキャッシュを持っている(`hasCanonical`): 二重に測る必要が無い。
 * - 確定版の quiet load に失敗した直後(`loadFailed`): この時点の canvas はまだ「これから
 *   読み込む draft の本体」ではなく直前の状態のままで、正規形の元にできる確定版の内容を
 *   持っていない。ここで「canvas の現在の内容」を正規形として測ってしまうと、直後に draft を
 *   読み込んだ canvas とその正規形が同一になり、`settleIfClean` の同一判定が「変更なし」と
 *   誤認して正当な draft を自動で消してしまう(過去の回帰実績)。
 */
export function shouldMeasureCanonical(
  isCreateRoute: boolean,
  hasCanonical: boolean,
  loadFailed: boolean,
): boolean {
  return !isCreateRoute && !hasCanonical && !loadFailed;
}
