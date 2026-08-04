// =============================================================================
// fallback.ts — Worker RPC を main-thread フォールバック付きで包む(テスト可能な純粋層)
// =============================================================================
// `index.ts` は `new Worker(new URL(...))` の構築を持ち jsdom では実行できないため、
// 「remote(Worker) が失敗/ハングしたら fallback(main-thread)へ倒す」判断ロジックだけを
// ここへ切り出して単体テスト可能にする。`index.ts` は本層を Worker と main-thread 実装で
// 束ねるだけにする。
import { isAppError, unexpected } from '@editor/shared';
import { logError } from '@/lib/appError';
import type { AsyncHtmlWorker } from './index';

/**
 * Worker 呼び出しの打ち切り時間。**一度でも応答が返った後**のタイムアウトは main-thread への
 * 救済ではなくエラーにするので(下記 `call` の doc を参照)、救済を失う代わりに待ち時間を
 * 長く取る。重処理(400 ページ級の diff/mask)でも数秒で済むため 120 秒は十分な余裕。
 */
export const WORKER_CALL_TIMEOUT_MS = 120_000;

/**
 * **初回応答が返る前**の打ち切り時間。この時間帯のハングは重処理ではなく
 * 「Worker が事実上死んでいる」(チャンクが読めない / Comlink ハンドシェイク不成立)の徴候で、
 * `worker.onerror` は発火しない — 動的 import の reject もハンドシェイク不成立も error
 * イベントを起こさないため、ここが唯一の検知経路になる。オフライン配布バンドルで
 * 「プレビューが白紙のまま進まない」が起きた当の環境なので、**恒久フォールバックの契機として
 * 残す**(120 秒待たせてから失敗にすると元の不具合が再発する)。
 * 初回は 1 回しか起きないので「同じ重処理を 2 回走らせる増幅器」にはならない。
 */
export const WORKER_HANDSHAKE_TIMEOUT_MS = 30_000;

/** タイムアウト起因の失敗を実行時エラーと区別するための機械可読コード。 */
const WORKER_TIMEOUT_CODE = 'WORKER_TIMEOUT';

/** `p` を `ms` で打ち切る。期限超過で reject し、ハングを観測可能な失敗へ変える。 */
function withTimeout<T>(p: Promise<T>, ms: number, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          unexpected(`html worker call timed out: ${method} (>${ms}ms)`, {
            code: WORKER_TIMEOUT_CODE,
          }),
        ),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface FallbackWorker {
  /** フォールバック付きの公開プロキシ。`AsyncHtmlWorker` と同一インタフェース。 */
  worker: AsyncHtmlWorker;
  /** Worker の致命エラー検知時に呼ぶ。in-flight 呼び出しを即フォールバックへ落とす。 */
  markBroken: (reason: unknown) => void;
}

/**
 * `remote`(Worker RPC)を呼びつつ、実行時エラー・ハング(タイムアウト)・明示的な
 * `markBroken` のいずれかで `fallback`(main-thread)へ倒すプロキシを作る。
 *
 * Worker は重処理でメインを塞がないための最適化であり、読めない/壊れた環境
 * (オフライン配信で worker チャンクが解決できない等)では描画の正しさを優先して
 * main-thread 実行へ落とす。**フォールバックは恒久障害に限る** — 実行時エラー・
 * `markBroken`・Worker 不達がそれで、以降は即フォールバックして無駄な待ちを避ける。
 *
 * タイムアウトの扱いは**初回応答の前後で分ける**:
 * - 初回応答前(`WORKER_HANDSHAKE_TIMEOUT_MS`)= Worker が事実上死んでいる徴候。
 *   `onerror` が発火しない不達(チャンク解決失敗・ハンドシェイク不成立)を捕まえる唯一の
 *   経路なので、従来どおり main-thread へ恒久フォールバックする。
 * - 初回応答後(`WORKER_CALL_TIMEOUT_MS`)= 単に重い。main でやり直すと同じ重処理を
 *   メインスレッドで走らせ UI フリーズまで被害を広げる増幅器になるので、**エラーとして
 *   呼び出し側へ返す**。
 */
export function createFallbackWorker(
  remote: AsyncHtmlWorker,
  fallback: AsyncHtmlWorker,
  timeoutMs = WORKER_CALL_TIMEOUT_MS,
  handshakeTimeoutMs = WORKER_HANDSHAKE_TIMEOUT_MS,
): FallbackWorker {
  // Worker が不達/エラーと判明したら true。以降は main-thread へ恒久フォールバックする。
  let workerBroken = false;
  // Worker から一度でも応答が返ったか。タイムアウトの扱いを分ける唯一の判定材料。
  let hasSucceeded = false;
  // Worker の error イベント発火を in-flight 呼び出しへ即時伝える reject シグナル。
  let markBroken!: (reason: unknown) => void;
  const brokenSignal = new Promise<never>((_, reject) => {
    markBroken = (reason) => {
      workerBroken = true;
      reject(reason);
    };
  });
  // 誰も race していない間の unhandledrejection を防ぐ(シグナルは複数回 race され得る)。
  brokenSignal.catch(() => {});

  // 各メソッドを「remote 呼び出し vs タイムアウト vs broken シグナル」の race で実行し、
  // 失敗時はその場で main-thread へ落としつつ `workerBroken` を立てて以降を即フォールバックする。
  function call<K extends keyof AsyncHtmlWorker>(
    method: K,
    args: Parameters<AsyncHtmlWorker[K]>,
  ): ReturnType<AsyncHtmlWorker[K]> {
    const fallbackFn = fallback[method] as (...a: unknown[]) => Promise<unknown>;
    if (workerBroken) return fallbackFn(...args) as ReturnType<AsyncHtmlWorker[K]>;
    const remoteFn = remote[method] as (...a: unknown[]) => Promise<unknown>;
    const limitMs = hasSucceeded ? timeoutMs : handshakeTimeoutMs;
    const result = (async () => {
      try {
        const v = await Promise.race([
          withTimeout(remoteFn(...args), limitMs, String(method)),
          brokenSignal,
        ]);
        hasSucceeded = true;
        return v;
      } catch (e) {
        // 初回応答後のタイムアウトは「重すぎる」の徴候であって Worker の恒久障害ではない。
        // main でやり直すと同じ重処理をメインスレッドで走らせることになるので、再 throw する。
        // 初回応答前のタイムアウトは Worker 不達なので下の恒久フォールバックへ落とす。
        if (hasSucceeded && isAppError(e) && e.code === WORKER_TIMEOUT_CODE) {
          logError(e);
          throw e;
        }
        workerBroken = true;
        logError(
          unexpected(`html worker call failed; falling back to main thread: ${String(method)}`, {
            cause: e,
          }),
        );
        return fallbackFn(...args);
      }
    })();
    return result as ReturnType<AsyncHtmlWorker[K]>;
  }

  const worker: AsyncHtmlWorker = {
    buildHtmlDiff: (...a) => call('buildHtmlDiff', a),
    buildHtmlDiffAligned: (...a) => call('buildHtmlDiffAligned', a),
    toTemplate: (...a) => call('toTemplate', a),
    toFilled: (...a) => call('toFilled', a),
    renderJinja: (...a) => call('renderJinja', a),
  };
  return { worker, markBroken };
}
