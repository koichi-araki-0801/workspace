// =============================================================================
// officialPdfJobs.ts — 正式 PDF の組版を id ごとに 1 本で回すメモリ上のジョブ
// =============================================================================
// 組版中に来た要求は「もう 1 回」の印だけを立てる(何回来ても 1 回)。組版が終わったあとに
// 1 回だけ回し直すので、要求の時点より新しい filled が必ず PDF に反映される。
// 枠(`withGeneratorSlot`)は `build` の中で取る。ここでは足さない。
import { type OfficialPdfStatus, toAppError } from '@editor/shared';
import { logger } from '../logger.js';

export interface OfficialPdfJobs {
  request(id: string): void;
  status(id: string): Promise<OfficialPdfStatus>;
  /** 走っている・待っている組版がすべて終わるまで待つ(テストと終了時用)。 */
  settled(): Promise<void>;
}

export interface OfficialPdfJobsDeps {
  build(id: string): Promise<void>;
  pdfMtime(id: string): Promise<Date | null>;
  filledMtime(id: string): Promise<Date | null>;
  now?: () => Date;
}

type JobRecord = Omit<OfficialPdfStatus, 'id'>;

export function createOfficialPdfJobs(deps: OfficialPdfJobsDeps): OfficialPdfJobs {
  const now = deps.now ?? (() => new Date());
  const records = new Map<string, JobRecord>();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  async function runLoop(key: string, id: string): Promise<void> {
    // queued を一度は観測できるよう、同期の呼び出し元から切り離して始める
    await Promise.resolve();
    try {
      do {
        again.delete(key);
        records.set(key, { state: 'building', updatedAt: null, error: null });
        try {
          await deps.build(id);
          records.set(key, { state: 'done', updatedAt: now().toISOString(), error: null });
        } catch (err) {
          // 画面に出すのは利用者向けの文言だけ。DB エラーなどの生の文言は logger にだけ残す。
          const message = toAppError(err).message;
          logger.error({ id, err }, '[report] 正式 PDF の組版に失敗しました');
          records.set(key, { state: 'failed', updatedAt: now().toISOString(), error: message });
        }
      } while (again.has(key));
    } finally {
      // 「もう 1 回」の印の確認と running からの解放を同じ同期区間で行う。間が空くと、
      // その隙に来た request が印だけ立てて、誰にも回されないまま取りこぼされる
      running.delete(key);
    }
  }

  async function fromFiles(id: string): Promise<JobRecord> {
    const pdf = await deps.pdfMtime(id);
    if (pdf === null) {
      return { state: 'missing', updatedAt: null, error: null };
    }
    const filled = await deps.filledMtime(id);
    const state = filled === null || pdf.getTime() >= filled.getTime() ? 'done' : 'stale';
    return { state, updatedAt: pdf.toISOString(), error: null };
  }

  return {
    request(id) {
      const key = id.toLowerCase();
      if (running.has(key)) {
        again.add(key);
        return;
      }
      records.set(key, { state: 'queued', updatedAt: null, error: null });
      const job = runLoop(key, id).catch((err) => {
        logger.error({ id, err }, '[report] 正式 PDF のジョブが異常終了しました');
      });
      running.set(key, job);
    },
    async status(id) {
      const rec = records.get(id.toLowerCase()) ?? (await fromFiles(id));
      return { id, ...rec };
    },
    async settled() {
      while (running.size > 0) {
        await Promise.all([...running.values()]);
      }
    },
  };
}
