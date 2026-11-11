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

/** まだ組版が終わっていない(問い合わせを続ける)状態か。 */
export function isOfficialPdfPending(status: OfficialPdfStatus): boolean {
  return status.state === 'queued' || status.state === 'building';
}

/**
 * `fetchStatus` を問い合わせ、結果を `onUpdate` へ渡す。`queued` / `building` の間だけ
 * `intervalMs` で繰り返す。戻り値は止める関数。
 */
export function pollOfficialPdf(
  fetchStatus: () => Promise<Result<OfficialPdfStatus>>,
  onUpdate: (status: OfficialPdfStatus) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    timer = null;
    let res: Result<OfficialPdfStatus>;
    try {
      res = await fetchStatus();
    } catch {
      return;
    }
    if (stopped || !isOk(res)) {
      return;
    }
    onUpdate(res.value);
    if (isOfficialPdfPending(res.value)) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = null;
  };
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
