// =============================================================================
// renderHostClient.ts — Jinja コンパイルを opaque オリジンの iframe へ委ねるクライアント
// =============================================================================
// 承認画面・比較画面・PDF 経路は、**他人が書いた**テンプレ本文を nunjucks で描画する。
// nunjucks はサンドボックスではなく**コンパイラ**で、`{{ range.constructor("…")() }}` は
// `new Function` へ到達する。これをアプリのページオリジンのメインスレッドで走らせていたのが
// 所見 F1 で、走った JS は承認者のセッション(HttpOnly cookie は同一オリジン fetch へ自動で
// 付く)のまま `/api/review-requests/:id/approve` を叩ける = 申請者が自分の申請を自分で通せた。
//
// 直し方は「コンパイルを止める」ではなく「**コンパイルする場所を移す**」。移した先は
// サーバ配信のレンダーホストページ(`server/src/render/renderHost.ts`)で、ここはその親側。
// iframe は `sandbox="allow-scripts"`(= `allow-same-origin` を付けない)で開くので子は
// opaque オリジンになり、親の DOM にも cookie にも API にも届かない。子の CSP は
// `connect-src 'none'` まで閉じてあり、仮に nunjucks の脱出を許しても**持ち出し口が無い**。
//
// ── Worker ではなく iframe である理由 ──
// 以前この描画は Web Worker(`workers/`)へ載っていたが、Worker は**同一オリジン**で動く。
// cookie 付きの `fetch` がそのまま通るため、隔離としては何も守っていない。守れるのは
// 「メインスレッドを塞がない」ことだけで、それは今回の脅威とは無関係である。
//
// ── オリジン検証の作法(`PreviewPanel.vue` と同一・重要) ──
// 親 → 子の `postMessage` は `targetOrigin` に `'*'` を使うしかない(opaque オリジンの子に
// 具体的なオリジン文字列は指定できず、指定すると配送されない)。逆に子 → 親のメッセージは
// `event.origin === 'null'` で届き、これは**他の任意の sandbox フレームとも一致する**ため
// 識別に使えない。よって発信元の検証は必ず `event.source === iframe.contentWindow` の
// **同一性**で行う。
//
// ── 失敗は例外にしない ──
// 公開 API は常に `RenderResult`(`{ html, error }`)を解決する。呼び出し側は既存の
// `renderJinja` と同じ形で `error` を分岐すればよく、隔離へ移したことで分岐が増えない。
import {
  RENDER_BOOT_ERROR_ID,
  RENDER_HOST_URL,
  RENDER_MSG_ERROR,
  RENDER_MSG_READY,
  RENDER_MSG_REQ,
  RENDER_MSG_RES,
  type RenderHostRequest,
  type SampleData,
  unexpected,
} from '@editor/shared';
import { logError } from '@/lib/appError';
import type { RenderResult } from '@/lib/nunjucksRender';

/**
 * 子の `READY` を待つ期限。ホストページの配信失敗(認証切れ・バンドル欠落)やブラウザの
 * sandbox 制約など、子が沈黙する形の失敗は親からは区別できないため時間で切る
 * (`PreviewPanel.HOST_BOOT_TIMEOUT_MS` と同値)。
 */
export const RENDER_HOST_BOOT_TIMEOUT_MS = 15_000;

/**
 * 1 要求あたりの期限。子は 1 要求 1 応答で状態を持たないので、応答が返らないのは
 * テンプレ側の無限ループか子の異常終了に限られる。待ち続けると画面が「生成中」のまま
 * 固まるため、観測可能な失敗へ変える。
 */
export const RENDER_HOST_CALL_TIMEOUT_MS = 30_000;

/** 子が起動しなかった/落ちたときの文言。原因は `logError` 側へ記録する。 */
const BOOT_FAILED_MSG =
  'テンプレートの描画環境を起動できませんでした。画面を再読み込みしてください。';

/** 1 要求が期限内に返らなかったときの文言。 */
const CALL_TIMEOUT_MSG = 'テンプレートの描画が時間内に完了しませんでした。';

/** 子が理由を伴わない失敗を返したときの文言(`error` が空文字・非文字列の場合)。 */
const UNKNOWN_ERROR_MSG = 'テンプレートの描画に失敗しました。';

export interface RenderHostClient {
  /** 生 Jinja HTML を隔離 iframe で描画する。失敗も `RenderResult.error` で返る。 */
  render(template: string, data: unknown): Promise<RenderResult>;
  /** iframe と window リスナを片付ける(テストと HMR 用。通常運転では呼ばない)。 */
  dispose(): void;
}

/** 親が採番した要求 1 件の待ち合わせ(応答 or 期限切れのどちらかで必ず解決する)。 */
interface PendingCall {
  resolve: (r: RenderResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 隔離フレームを DOM へ置く。**表示はしない**(子は描画結果を文字列で返すだけで、何も
 * 見せない)。`display:none` ではなく 0 サイズの不可視要素にするのは、`display:none` の
 * iframe の読み込み優先度がブラウザ実装依存で下がるため — 起動を確実にする側に倒す。
 */
function mountHostFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  // `allow-same-origin` は付けない。付けた瞬間に sandbox は無効化と等価になり、隔離が消える。
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', 'テンプレート描画');
  frame.setAttribute(
    'style',
    'position:fixed;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden',
  );
  frame.src = RENDER_HOST_URL;
  document.body.appendChild(frame);
  return frame;
}

/**
 * レンダーホストのクライアントを 1 つ作る。フレームは**最初の `render` で初めて**生成する
 * (承認画面を開かないセッションで iframe と 90KB のページを引かないため)。
 *
 * `opts.mount` はテスト用の差し替え点。既定は `mountHostFrame`。
 */
export function createRenderHostClient(opts?: {
  bootTimeoutMs?: number;
  callTimeoutMs?: number;
  mount?: () => HTMLIFrameElement;
}): RenderHostClient {
  const bootTimeoutMs = opts?.bootTimeoutMs ?? RENDER_HOST_BOOT_TIMEOUT_MS;
  const callTimeoutMs = opts?.callTimeoutMs ?? RENDER_HOST_CALL_TIMEOUT_MS;
  const mount = opts?.mount ?? mountHostFrame;

  let frame: HTMLIFrameElement | null = null;
  let ready = false;
  /** 恒久失敗の文言。非 null になったら以降の要求は即座にこれを返す。 */
  let broken: string | null = null;
  /** 親が採番する連番。子は覚えないので、対応付けはこの `id` だけが担う。 */
  let nextId = 0;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, PendingCall>();
  /** `READY` 前に積まれた要求。子が起動したら順に流す。 */
  const queued: RenderHostRequest[] = [];

  function clearBootTimer(): void {
    if (bootTimer !== null) clearTimeout(bootTimer);
    bootTimer = null;
  }

  /** 要求 1 件を解決して待ち合わせを畳む。未知の `id` は黙って捨てる。 */
  function settle(id: unknown, result: RenderResult): void {
    if (typeof id !== 'number') return;
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    call.resolve(result);
  }

  /**
   * 恒久失敗にする。**フレームを作り直して再試行しない** — 起動しない原因はページの配信
   * 失敗(認証切れ・CSP・sandbox 不許可)のように再試行で直らないものばかりで、要求ごとに
   * 期限分待たせるだけになるため。Worker の恒久フォールバックと同じ判断。
   */
  function fail(reason: string): void {
    if (broken !== null) return;
    broken = BOOT_FAILED_MSG;
    clearBootTimer();
    logError(unexpected('render host unavailable', { cause: reason }));
    queued.length = 0;
    for (const id of Array.from(pending.keys())) settle(id, { html: '', error: broken });
  }

  function post(req: RenderHostRequest): void {
    // `targetOrigin` は `'*'` 固定(上記「オリジン検証の作法」)。運ぶのは親が既に持っている
    // テンプレ本文と sample data だけで、子へ渡すことで新たに漏れる秘密は無い。
    frame?.contentWindow?.postMessage({ type: RENDER_MSG_REQ, ...req }, '*');
  }

  function onMessage(e: MessageEvent): void {
    // 発信元は `contentWindow` との同一性だけで判定する(`origin` は 'null' で識別不能)。
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as { type?: unknown; id?: unknown; html?: unknown; error?: unknown } | null;
    if (!d || typeof d.type !== 'string') return;

    if (d.type === RENDER_MSG_READY) {
      clearBootTimer();
      ready = true;
      for (const req of queued.splice(0)) post(req);
      return;
    }
    if (d.type === RENDER_MSG_RES) {
      settle(d.id, { html: typeof d.html === 'string' ? d.html : '', error: null });
      return;
    }
    if (d.type === RENDER_MSG_ERROR) {
      const message = typeof d.error === 'string' && d.error !== '' ? d.error : UNKNOWN_ERROR_MSG;
      // `id` が予約値のときだけは要求に紐づかないブート段の致命失敗(nunjucks バンドルが
      // 読めなかった等)。この 1 件だけを恒久失敗として扱い、他はテンプレ側の構文エラー。
      if (d.id === RENDER_BOOT_ERROR_ID) fail(message);
      else settle(d.id, { html: '', error: message });
    }
  }

  function ensureFrame(): void {
    if (frame !== null || broken !== null) return;
    try {
      window.addEventListener('message', onMessage);
      frame = mount();
    } catch (e) {
      fail(String(e));
      return;
    }
    bootTimer = setTimeout(() => {
      bootTimer = null;
      if (!ready) fail(`起動確認が取れませんでした (>${bootTimeoutMs}ms)`);
    }, bootTimeoutMs);
  }

  return {
    render(template, data) {
      if (broken !== null) return Promise.resolve({ html: '', error: broken });
      ensureFrame();
      if (broken !== null) return Promise.resolve({ html: '', error: broken });
      const id = ++nextId;
      const req: RenderHostRequest = { id, template, data };
      return new Promise<RenderResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          logError(unexpected(`render host call timed out (id=${id}, >${callTimeoutMs}ms)`));
          resolve({ html: '', error: CALL_TIMEOUT_MSG });
        }, callTimeoutMs);
        pending.set(id, { resolve, timer });
        if (ready) post(req);
        else queued.push(req);
      });
    },

    dispose() {
      clearBootTimer();
      window.removeEventListener('message', onMessage);
      frame?.remove();
      frame = null;
      ready = false;
      queued.length = 0;
      for (const id of Array.from(pending.keys())) {
        settle(id, { html: '', error: BOOT_FAILED_MSG });
      }
    },
  };
}

/**
 * アプリ全体で 1 つだけ共有するクライアント。iframe を画面ごとに作らないのは、起動コスト
 * (ページ + nunjucks バンドル)を毎回払わないためで、**隔離の粒度が緩むことはない** —
 * 子は 1 要求 1 応答で状態を持たず、前の要求の副作用は次の要求へ持ち越されない。
 */
let sharedClient: RenderHostClient | null = null;

/**
 * 生 Jinja HTML を opaque オリジンの iframe で描画する。**アプリオリジンで nunjucks を
 * コンパイルする経路の唯一の置き換え先**で、戻り値は従来の `renderJinja` と同じ
 * `RenderResult` — 呼び出し側の分岐は変わらない。
 */
export function renderJinjaIsolated(template: string, data: SampleData): Promise<RenderResult> {
  sharedClient ??= createRenderHostClient();
  return sharedClient.render(template, data);
}
