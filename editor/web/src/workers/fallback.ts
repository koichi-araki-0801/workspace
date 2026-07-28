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

// Worker 呼び出しがこの時間内に解決しなければ「不達」とみなして main-thread へ落とす上限。
// 重処理(400 ページ級の diff/mask)でも数秒で済むため十分な余裕。これを超えるのは
// チャンク読込失敗や Comlink ハンドシェイク不成立など、Worker が事実上死んでいる場合。
const WORKER_CALL_TIMEOUT_MS = 30_000;

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
 * main-thread 実行へ落とす。実行時エラー・`markBroken`・初回応答前のタイムアウトは
 * 「Worker が事実上死んでいる」ため以降は即フォールバックして無駄な待ちを避ける(恒久化)。
 * 例外は「一度でも RPC が正常応答した後のタイムアウト」: チャンクは読めており単に処理が
 * 重い(低速マシン + 大規模ドキュメント)だけの可能性が高いので、当該呼び出しのみ
 * フォールバックし、次回は remote を再試行する(恒久化すると以降の全処理が main-thread で
 * 走り、エディタ操作のたびに UI が固まる)。
 */
export function createFallbackWorker(
  remote: AsyncHtmlWorker,
  fallback: AsyncHtmlWorker,
  timeoutMs = WORKER_CALL_TIMEOUT_MS,
): FallbackWorker {
  // Worker が不達/エラーと判明したら true。以降は main-thread へ恒久フォールバックする。
  let workerBroken = false;
  // 一度でも remote RPC が正常応答したか(= チャンク読込と Comlink ハンドシェイクは成立済み)。
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
    const result = (async () => {
      try {
        const v = await Promise.race([
          withTimeout(remoteFn(...args), timeoutMs, String(method)),
          brokenSignal,
        ]);
        hasSucceeded = true;
        return v;
      } catch (e) {
        // 成功実績のある Worker のタイムアウトは「重い処理」の可能性が高く、恒久化しない
        // (今回だけ main-thread で救済し、次回は remote を再試行する)。それ以外は恒久化。
        const transientTimeout = hasSucceeded && isAppError(e) && e.code === WORKER_TIMEOUT_CODE;
        if (!transientTimeout) workerBroken = true;
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
