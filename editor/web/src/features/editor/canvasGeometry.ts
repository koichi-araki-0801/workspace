// =============================================================================
// canvasGeometry.ts — canvas の根要素の取得と、幾何の計測を安全に行う小さな補助
// =============================================================================
// `useGrapes.ts` / `useCanvasMarkers.ts` / `usePageGuides.ts` / `useRedline.ts` が共有する。
// 座標計算自体(zoom/scroll 不変の扱い)は各 composable が持ち、ここは触らない。

import { toAppError } from '@editor/shared';
import type { Editor } from 'grapesjs';
import { logError } from '@/lib/appError';

/**
 * canvas のルート要素(GrapesJS の wrapper)。パーツ列挙/キー解決の基準。まだ描かれていなければ
 * null — canvas の body の直下は wrapper 1 つでパーツの並びではないので、body へ代えると全体が
 * 1 パーツに数えられ、キーもラベルも静的な文書側と食い違う。
 */
export function canvasRoot(editor: { value: Editor | null | undefined }): HTMLElement | null {
  return (editor.value?.getWrapper()?.getEl?.() as HTMLElement | undefined) ?? null;
}

/**
 * `measure` で幾何を測る。canvas の一時的な状態で失敗したら、観測のため log は残すが利用者には
 * 見せず(toast なし)、`clear` で overlay の表示を隠す。
 */
export function measureOrClear(measure: () => void, clear: () => void): void {
  try {
    measure();
  } catch (e) {
    logError(toAppError(e));
    clear();
  }
}
