// =============================================================================
// hostProtocol.ts — Jinja 描画 iframe(レンダーホストページ)と親の postMessage 契約
// =============================================================================
// 承認画面・比較画面は、**他人が書いた**テンプレ本文を nunjucks でコンパイルして表示する。
// nunjucks はサンドボックスではなくコンパイラで、`{{ range.constructor("…")() }}` は
// `new Function` へ到達する。これを承認者のページオリジンのメインスレッドで走らせると、
// 申請者の書いた JS が承認者のセッション(HttpOnly cookie は同一オリジン fetch へ自動で
// 付く)で `/api/review-requests/:id/approve` を叩ける = 職務分掌が申請者側から破れる。
//
// 直し方は「コンパイルを止める」ではなく「**コンパイルする場所を移す**」。サーバが定数の
// レンダーホストページを配信し、web はそれを `sandbox="allow-scripts"`(= `allow-same-origin`
// なし)の iframe に置く。子は opaque オリジンになり、親の DOM にも cookie にも API にも
// 届かない。プレビューの隔離(`preview/hostProtocol.ts`)と同じ設計で、違いは**子が
// ネットワークへ一切出ない**ことだけ(描画に必要なものは全部メッセージで渡る)。
//
// ── オリジン検証の作法(プレビューと同一・重要) ──
// 親 → 子の `postMessage` は `targetOrigin` に `'*'` を使うしかない(子は opaque オリジンで、
// 具体的なオリジン文字列を指定すると配送されない)。逆に子 → 親のメッセージは
// `event.origin === 'null'` で届き、これは**他の任意の sandbox フレームとも一致する**ため
// 識別に使えない。よって発信元の検証は必ず `event.source === iframe.contentWindow` の
// **同一性**で行う。子側は `event.source !== parent` を弾く。
//
// ── なぜ子を状態レスにするか ──
// 子は 1 要求につき 1 応答を返すだけで、要求の間に何も覚えない。`id` は**親が採番する
// 連番**で、親は自分が出した `id` の応答だけを受け取る。子に「前回の template」のような
// 状態を持たせると、申請 A のテンプレが仕込んだ副作用が申請 B の描画へ持ち越せてしまう
// (隔離の単位が iframe ではなく「その iframe の寿命全体」に薄まる)。

/**
 * レンダーホストページ一式の配信接頭辞(`/api` プレフィックスを含まない — 付与は
 * server の register が担う。`preview/hostProtocol.ts` と同じ規約)。
 *
 * **`apiPaths` には載せない。** あれは「全 REST エンドポイントの正典」で OpenAPI に載る
 * 外部契約の集合だが、ここは web UI が内部で読む配信面(HTML ページ + バンドル)であって
 * REST の契約ではない。
 */
export const RENDER_HOST_BASE = '/render-host';

/**
 * 隔離 iframe の src。**末尾のファイル名まで含めるのが要件**で、`/api/render-host` 単体を
 * src にすると fallback の相対参照(`nunjucks.js`)が 1 階層上へ解決される。
 */
export const RENDER_HOST_URL = `/api${RENDER_HOST_BASE}/index.html`;

/** 子 → 親: ブート完了(以後 `RENDER_MSG_REQ` を受け付ける)。 */
export const RENDER_MSG_READY = 'editor:render-ready';

/** 親 → 子: 描画要求(`RenderHostRequest`)。 */
export const RENDER_MSG_REQ = 'editor:render-req';

/** 子 → 親: 描画成功(`RenderHostResponse`)。 */
export const RENDER_MSG_RES = 'editor:render-res';

/** 子 → 親: 描画失敗(`RenderHostErrorResponse`)。例外は親へ投げっぱなしにせずこれで返す。 */
export const RENDER_MSG_ERROR = 'editor:render-error';

/**
 * 親 → 子の描画要求。
 *
 * `template` は**他人が書いた生 Jinja HTML**(信頼しない側)、`data` は差し込む sample data
 * で、いずれも親が既に持っている値である = 子へ渡すことで新たに漏れる秘密は無い。
 */
export interface RenderHostRequest {
  /** 親が採番する 1 起点の連番。子は覚えず、そのまま応答へ写して返す。 */
  id: number;
  /** 生 Jinja2 テンプレート本文。 */
  template: string;
  /** 差し込む値(`SampleData` 相当だが、子は構造を仮定せずそのまま context にする)。 */
  data: unknown;
}

/** 子 → 親の成功応答。`html` は nunjucks 適用後の HTML(サニタイズは親が行う)。 */
export interface RenderHostResponse {
  id: number;
  html: string;
}

/**
 * 子 → 親の失敗応答。`error` は nunjucks の例外メッセージ(利用者に見せる文言)。
 *
 * `id` が `0` のときだけは要求に紐づかない**ブート段の致命失敗**(nunjucks バンドルが
 * 読めなかった等)を表す。親の採番は 1 起点なので `0` と衝突しない。
 */
export interface RenderHostErrorResponse {
  id: number;
  error: string;
}

/** ブート段の致命失敗を表す予約 `id`(要求に紐づかないことの目印)。 */
export const RENDER_BOOT_ERROR_ID = 0;
