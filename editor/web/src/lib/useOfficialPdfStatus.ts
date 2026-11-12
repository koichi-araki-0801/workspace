// =============================================================================
// useOfficialPdfStatus.ts — 正式 PDF の組版状態の問い合わせ(プレビュー画面と承認後の通知で共用)
// =============================================================================
// 組版は承認や作り直しの後に裏で進む。`queued` / `building` の間だけ一定間隔で問い合わせ、
// 終わった状態(done / failed / missing / stale)か問い合わせの失敗で止める。失敗のたびに
// 打ち直すと、サーバ停止中に永久に叩き続けるため。
import { isOk, type OfficialPdfStatus, type Result } from '@editor/shared';
import { getCurrentScope, onScopeDispose, type Ref, ref } from 'vue';
import { useTemplateRepo } from '@/api/repositories';
import { toastError } from '@/components/ui/toast';

const DEFAULT_INTERVAL_MS = 3000;

/**
 * 承認後の通知のために問い合わせ中の正式 PDF の鍵(小文字。サーバの鍵に合わせる)。画面
 * (コンポーネント)をまたいで共有し、同じ id の承認が続いても通知を重ねて出さないために使う。
 */
const watchingIds = new Set<string>();

/** テスト用。問い合わせ中の記録を空にする。 */
export function resetWatchingOfficialPdfs(): void {
  watchingIds.clear();
}

/** まだ組版が終わっていない(問い合わせを続ける)状態か。 */
function isOfficialPdfPending(status: OfficialPdfStatus): boolean {
  return status.state === 'queued' || status.state === 'building';
}

/**
 * `fetchStatus` を問い合わせ、結果を `onUpdate` へ渡す。`queued` / `building` の間だけ
 * `intervalMs` で繰り返す。戻り値は止める関数。問い合わせが終わるとき(終わった状態・失敗・
 * 例外・止められた)に、一度だけ `onEnd` を呼ぶ。
 */
export function pollOfficialPdf(
  fetchStatus: () => Promise<Result<OfficialPdfStatus>>,
  onUpdate: (status: OfficialPdfStatus) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
  onEnd?: () => void,
): () => void {
  let stopped = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const end = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    onEnd?.();
  };

  const tick = async (): Promise<void> => {
    timer = null;
    let res: Result<OfficialPdfStatus>;
    try {
      res = await fetchStatus();
    } catch {
      end();
      return;
    }
    if (stopped || !isOk(res)) {
      end();
      return;
    }
    try {
      onUpdate(res.value);
    } catch (e) {
      // 通知側の不具合で問い合わせの流れ(次の予約・終了の通知)を止めない
      console.error('[officialPdf] 状態の通知で例外が出ました:', e);
    }
    if (stopped) {
      end();
      return;
    }
    if (isOfficialPdfPending(res.value)) {
      timer = setTimeout(() => void tick(), intervalMs);
    } else {
      end();
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = null;
    end();
  };
}

/**
 * 同じ id の問い合わせが走っていれば新しく張らず(`null`)、無ければ `pollOfficialPdf` で張る。
 * 記録はどの終わり方でも問い合わせが終わる 1 か所で消えるので、呼び出し側は消さなくてよい。
 */
export function pollOfficialPdfOnce(
  id: string,
  fetchStatus: () => Promise<Result<OfficialPdfStatus>>,
  onUpdate: (status: OfficialPdfStatus) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
): (() => void) | null {
  const key = id.toLowerCase();
  if (watchingIds.has(key)) {
    return null;
  }
  watchingIds.add(key);
  return pollOfficialPdf(fetchStatus, onUpdate, intervalMs, () => watchingIds.delete(key));
}

export function useOfficialPdfStatus(
  id: Ref<string>,
  opts: { intervalMs?: number } = {},
): {
  status: Ref<OfficialPdfStatus | null>;
  start: () => void;
  stop: () => void;
  rebuild: () => Promise<void>;
} {
  const repo = useTemplateRepo();
  const status = ref<OfficialPdfStatus | null>(null);
  let stopPolling: (() => void) | null = null;

  function stop(): void {
    stopPolling?.();
    stopPolling = null;
  }

  function start(): void {
    stop();
    const target = id.value;
    stopPolling = pollOfficialPdf(
      () => repo.officialPdfStatus(target),
      (s) => {
        status.value = s;
      },
      opts.intervalMs,
    );
  }

  async function rebuild(): Promise<void> {
    const res = await repo.rebuildOfficialPdf(id.value);
    if (!isOk(res)) {
      toastError(res.error.message);
      return;
    }
    status.value = res.value;
    start();
  }

  if (getCurrentScope()) {
    onScopeDispose(stop);
  }
  return { status, start, stop, rebuild };
}
