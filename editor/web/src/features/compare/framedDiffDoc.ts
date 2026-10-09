// =============================================================================
// framedDiffDoc.ts — 差分表示の iframe に渡す文書の組み立て(比較画面・承認画面で共有)
// =============================================================================
// 着色 CSS は両画面で同じで、本文の余白(`bodyPadding`)だけが画面ごとに違う。
import { withHeightReporter } from '@/lib/useIframeAutoFit';
import { buildDiffDoc, diffHighlightCss } from './htmlBlockDiff';

/**
 * 断片 HTML とテンプレ CSS から、差分の着色と高さ通知の計測スクリプトを付けた `srcdoc` 文書を作る
 * 関数を返す。`buildDiffDoc` はカスケードレイヤ名を呼ぶたびに乱数で作るので、結果は呼び出し側が
 * データ依存の `computed` で 1 度だけ作る。
 */
export function buildFramedDiffDoc(bodyPadding: number): (fragment: string, css: string) => string {
  const highlightCss = diffHighlightCss(bodyPadding);
  return (fragment, css) => withHeightReporter(buildDiffDoc(fragment, css, highlightCss));
}
