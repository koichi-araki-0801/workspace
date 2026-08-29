// =============================================================================
// partPreviewDoc.ts — PartPreview の srcdoc 文書組み立て(純関数)
// =============================================================================
// `PartPreview.vue` の computed から切り出した。`content`/`css` は他者(申請者)が書いた
// ものなので `<style>` は `styleTag`(= `sanitizeStyleContent` で `</style` を中和)を経由する
// — `htmlBlockDiff.buildDiffDoc` と同じ経路。素の文字列連結で `</style>` を渡すと、CSS 文字列
// リテラルに仕込んだ `</style><script>` で要素を閉じられ script を注入できる。
import { styleTag } from '@/lib/sanitizeCss';

/**
 * パーツプレビューの srcdoc を組み立てる。`width` は実寸レイアウト用の px 値
 * (呼び出し側の `CANVAS_WIDTH`)。
 */
export function buildPartPreviewDoc(content: string, css: string, width: number): string {
  // body 直書きで余白を詰め、パーツ単体が枠いっぱいに見えるようにする。
  const bodyCss = `body{margin:0;padding:10px;width:${width}px;box-sizing:border-box}`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" />${styleTag(`${css}\n${bodyCss}`)}</head><body>${content}</body></html>`;
}
