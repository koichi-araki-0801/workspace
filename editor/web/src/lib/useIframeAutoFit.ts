// =============================================================================
// useIframeAutoFit.ts — srcdoc iframe を中身の高さに合わせ、幅変化にも追随させる composable
// =============================================================================
// 版比較(`CompareResultView`)と承認プレビュー(`ReviewDiffView`)は、`<iframe srcdoc>` を
// 中身の高さへ合わせ、さらに幅が変わると再フローで高さも変わるため `ResizeObserver` で
// 追随させる、という同じ処理を各自で持っていた。ここへ集約し `@load="fitFrame"` に渡すだけで
// 使えるようにする。監視の帳簿は `Map` 1 つ(has 判定・unmount 時の列挙・解放を全て賄う)。
import { onBeforeUnmount } from 'vue';

interface IframeAutoFit {
  /** `<iframe @load>` ハンドラ。初回フィット + 以降の幅変化監視を仕掛ける。 */
  fitFrame(e: Event): void;
}

export function useIframeAutoFit(): IframeAutoFit {
  const frameObservers = new Map<HTMLIFrameElement, ResizeObserver>();

  function fitTo(f: HTMLIFrameElement | null | undefined): void {
    if (!f) return;
    try {
      const h = f.contentDocument?.body?.scrollHeight;
      if (h) f.style.height = `${h + 4}px`;
    } catch {
      /* ignore cross-doc */
    }
  }

  function fitFrame(e: Event): void {
    const f = e.target as HTMLIFrameElement;
    fitTo(f);
    if (!frameObservers.has(f)) {
      const ro = new ResizeObserver(() => fitTo(f));
      ro.observe(f);
      frameObservers.set(f, ro);
    }
  }

  onBeforeUnmount(() => {
    for (const ro of frameObservers.values()) ro.disconnect();
    frameObservers.clear();
  });

  return { fitFrame };
}
