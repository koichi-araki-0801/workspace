// =============================================================================
// hostProtocol.ts — プレビュー iframe(ビューアホストページ)と親の postMessage 契約
// =============================================================================
// プレビューは `@vivliostyle/core` を**アプリと同一オリジンの本体 document** ではなく、
// サーバが配信するビューアホストページ(`sandbox="allow-scripts"` = same-origin なし)の
// 中で動かす。テンプレの JS は正当なコンテンツなので実行させるが、実行先を opaque な
// オリジンへ隔離してアプリの DOM・cookie・API へ触れないようにするのが目的である。
//
// この構成では親と子は**互いに DOM を読めない**ので、命令も状態も全部この postMessage 契約を
// 通る。契約が web と server の 2 箇所に手書きで散ると、片方だけ直したときに「プレビューが
// 無言で白紙」になる形の退行が出るため、文字列定数は shared のここ 1 箇所に置く。
//
// ── オリジン検証の作法(重要) ──
// 親 → 子の `postMessage` は `targetOrigin` に `'*'` を使うしかない。子は opaque オリジンで、
// 具体的なオリジン文字列を指定する手段が無い(指定すると配送されない)。逆に子 → 親の
// メッセージは `event.origin === 'null'` で届き、これは**他の任意の sandbox フレームとも
// 一致する**ため識別に使えない。よって発信元の検証は必ず
// `event.source === iframe.contentWindow` の**同一性**で行う(`useIframeAutoFit.ts` と同じ)。
// 運ぶのは文書 HTML(既にアプリ側が持っているもの)とページ番号・倍率の数値だけで、
// 子から親へ渡る情報に秘密は無い。

/**
 * ビューアホストページ一式の配信接頭辞(`/api` プレフィックスを含まない — 付与は
 * `api-paths.ts` 冒頭と同じ規約で server の register が担う)。
 *
 * **`apiPaths` には載せない。** あれは「全 REST エンドポイントの正典」で、OpenAPI に載る
 * 外部契約の集合である。ここは web UI が内部で読む配信面(HTML ページ・ビューアバンドル・
 * 同梱資産)であって REST の契約ではない。
 */
export const PREVIEW_HOST_BASE = '/preview-host';

/**
 * 隔離 iframe の src。**末尾のファイル名まで含めるのが要件**で、`/api/preview-host` 単体を
 * src にするとテンプレの相対参照(`js/x.js`)が 1 階層上(`/api/js/x.js`)へ解決される。
 */
export const PREVIEW_HOST_URL = `/api${PREVIEW_HOST_BASE}/index.html`;

/** 親 → 子: 組版する文書を渡す(`html` は完成済みのプレビュー文書文字列)。 */
export const PREVIEW_MSG_DOC = 'editor:preview-doc';

/** 親 → 子: 操作命令(`cmd` は `PreviewCommand`)。 */
export const PREVIEW_MSG_CMD = 'editor:preview-cmd';

/** 子 → 親: ブート完了(以後 `PREVIEW_MSG_DOC` を受け付ける)。 */
export const PREVIEW_MSG_READY = 'editor:preview-ready';

/** 子 → 親: ページ送り/ズーム状態の通知。 */
export const PREVIEW_MSG_STATE = 'editor:preview-state';

/** 子 → 親: 組版の失敗通知(親はフォールバック表示へ倒す)。 */
export const PREVIEW_MSG_ERROR = 'editor:preview-error';

/** 親から子へ送れる操作。`goToPage` だけが引数(1 起点のページ番号)を取る。 */
export type PreviewCommand = 'prevPage' | 'nextPage' | 'goToPage' | 'zoomIn' | 'zoomOut' | 'fit';

/** 子が通知する状態。親のツールバー表示に必要な値だけを運ぶ。 */
export interface PreviewHostState {
  currentPage: number;
  pageCount: number;
  atFirst: boolean;
  atLast: boolean;
  zoom: number;
  /** 組版が完了して操作を受け付けられるか(ローダー解除の契機)。 */
  ready: boolean;
}
