// =============================================================================
// useIframeAutoFit.ts — srcdoc iframe を中身の高さに合わせる composable(postMessage 経由)
// =============================================================================
// 版比較(`CompareResultView`)・承認プレビュー(`ReviewDiffView`)・パーツプレビュー
// (`PartPreview`)は、`<iframe srcdoc>` を中身の高さへ合わせるという同じ処理を持つ。
//
// **高さの取得は `contentDocument` の直接読み取りではなく子からの postMessage で行う。**
// テンプレの JavaScript は正当なコンテンツで、承認者は「JS が効いた実行結果」を見て承認する
// (JS を止めると、承認者が承認していない見た目が確定してしまう)。よって iframe は
// `sandbox="allow-scripts"` = **`allow-same-origin` なし**で開く。この組み合わせでは
// 子は opaque origin になり、親から `contentDocument` は読めない。読めないのが目的である
// (`allow-scripts` と `allow-same-origin` を同時に付けると sandbox は事実上無効になる)。
//
// したがって計測は子側で行い、値だけを親へ渡す。子へ入れる計測スクリプトは
// `withHeightReporter` が**文書の末尾へ追記する**だけで、本文へは一切手を入れない
// (中間へ差し込む文字列手術は、テンプレ側の些細な形の違いで壊れる)。
import { onBeforeUnmount } from 'vue';

/** 子 → 親の高さ通知。値は数値の高さ 1 つだけで、文書の中身は一切運ばない。 */
export const FRAME_HEIGHT_MESSAGE = 'editor:frame-height';

/**
 * 反映を許す高さの上限(px)。子は信用できない HTML なので、巨大な値を投げて親の
 * レイアウトを潰す(実質のブラウザ DoS)ことを防ぐ。A4 数百ページ分に相当する。
 */
const MAX_FRAME_HEIGHT = 200_000;

/**
 * 子文書へ追記する計測スクリプト。自分の高さを測って親へ送るだけで、親からは何も受けない
 * (親 → 子の指示経路を作らない = 子に親の情報を渡さない)。
 * 送信先オリジンは `'*'` にするしかない — opaque origin の子は親のオリジンを知らない。
 * 運ぶのが高さの数値だけなので、これで漏れる情報は無い。
 */
const HEIGHT_REPORTER = `<script>(function(){
  var last=-1;
  function send(){
    var d=document.documentElement,b=document.body;
    var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);
    if(h===last)return;
    last=h;
    parent.postMessage({type:${JSON.stringify(FRAME_HEIGHT_MESSAGE)},height:h},'*');
  }
  if(window.ResizeObserver){var ro=new ResizeObserver(send);
    if(document.documentElement)ro.observe(document.documentElement);
    if(document.body)ro.observe(document.body);}
  window.addEventListener('load',send);
  send();
})();</script>`;

/**
 * 計測スクリプトを付けた srcdoc を作る。**末尾追記のみ**(`</body>` を探して差し込むような
 * 手術はしない)。`</html>` の後ろの script もブラウザは実行する。
 */
export function withHeightReporter(doc: string): string {
  return doc + HEIGHT_REPORTER;
}

/**
 * 子からの高さ通知を購読する。どの iframe から来たかは `event.source` と
 * `frame.contentWindow` の同一性で判定する — opaque origin では `event.origin` が
 * `'null'` になり、これは他の任意の sandbox フレームとも一致するので**判別に使えない**。
 * 戻り値は購読解除関数。
 */
export function onFrameHeight(
  handler: (source: MessageEventSource | null, height: number) => void,
): () => void {
  const listener = (e: MessageEvent): void => {
    const data = e.data as { type?: unknown; height?: unknown } | null;
    if (!data || data.type !== FRAME_HEIGHT_MESSAGE) return;
    const h = data.height;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return;
    handler(e.source, Math.min(h, MAX_FRAME_HEIGHT));
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

interface IframeAutoFit {
  /** `<iframe @load>` ハンドラ。以降その iframe からの高さ通知を反映する。 */
  fitFrame(e: Event): void;
  /** `:srcdoc` へ渡す前に計測スクリプトを付ける。 */
  withHeightReporter(doc: string): string;
}

export function useIframeAutoFit(): IframeAutoFit {
  // 通知の送り主を引き当てるための帳簿。`contentWindow` は load のたびに変わりうるので
  // 保持せず、通知が来た時点で各 iframe の現在値と突き合わせる。
  const frames = new Set<HTMLIFrameElement>();

  const stop = onFrameHeight((source, height) => {
    for (const f of frames) {
      // DOM から外れた iframe は帳簿から落とす。パーツ一覧のように v-for で iframe が
      // 入れ替わる画面では、外れた分を持ち続けると要素ごと解放されず積み上がる。
      if (f.isConnected === false) {
        frames.delete(f);
        continue;
      }
      if (f.contentWindow === source) f.style.height = `${height + 4}px`;
    }
  });

  function fitFrame(e: Event): void {
    const f = e.target as HTMLIFrameElement;
    if (!f) return;
    for (const known of frames) if (known.isConnected === false) frames.delete(known);
    frames.add(f);
  }

  onBeforeUnmount(() => {
    stop();
    frames.clear();
  });

  return { fitFrame, withHeightReporter };
}
