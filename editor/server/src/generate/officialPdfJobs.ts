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
  /** 走っている・待っている組版がすべて終わるまで待つ(テスト用)。 */
  settled(): Promise<void>;
}

export interface OfficialPdfJobsDeps {
  build(id: string): Promise<void>;
  /** `pdf/<id>.pdf` を最後に変えたコミット。記録が無ければ null。 */
  pdfCommit(id: string): Promise<CommitRef | null>;
  /** `filled/<id>.html` を最後に変えたコミット。記録が無ければ null。 */
  filledCommit(id: string): Promise<CommitRef | null>;
  isAncestorOrSame(ancestor: string, descendant: string): Promise<boolean>;
  now?: () => Date;
}

interface CommitRef {
  hash: string;
  date: string;
}

export interface GitDerivedState {
  state: 'missing' | 'done' | 'stale';
  updatedAt: string | null;
  pdfHash: string | null;
}

/**
 * git の記録から PDF の状態を出す。ファイルの更新時刻は共有ドライブ上でサーバごとの
 * 時計のずれに振り回されるので使わず、コミットの祖先関係で新旧を決める。
 * 未追跡の PDF は記録が無いので `missing` と数える。
 */
export async function stateFromGit(
  deps: Pick<OfficialPdfJobsDeps, 'pdfCommit' | 'filledCommit' | 'isAncestorOrSame'>,
  id: string,
): Promise<GitDerivedState> {
  const pdf = await deps.pdfCommit(id);
  if (pdf === null) {
    return { state: 'missing', updatedAt: null, pdfHash: null };
  }
  const filled = await deps.filledCommit(id);
  // filled が pdf と同じかその祖先なら PDF は最新。そうでなければ filled の方が新しい。
  const fresh = filled === null || (await deps.isAncestorOrSame(filled.hash, pdf.hash));
  return { state: fresh ? 'done' : 'stale', updatedAt: pdf.date, pdfHash: pdf.hash };
}

type JobRecord = Omit<OfficialPdfStatus, 'id'>;

export function createOfficialPdfJobs(deps: OfficialPdfJobsDeps): OfficialPdfJobs {
  const now = deps.now ?? (() => new Date());
  const records = new Map<string, JobRecord>();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  // 失敗を記録した時点の PDF のコミット。いまの hash と同じなら、失敗のあとに PDF は変わっていない。
  const failedPdfHash = new Map<string, string | null>();

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
          // 記録中に git が読めなくても失敗の記録は残す。null に倒すと、のちに PDF の hash が
          // 取れた時点で failed が done に切り替わるだけで、誤って失敗が残り続けることはない。
          const hashAtFailure = await deps.pdfCommit(id).then(
            (c) => c?.hash ?? null,
            (gitErr) => {
              logger.warn({ id, err: gitErr }, '[report] 失敗時の PDF の記録を git から読めません');
              return null;
            },
          );
          failedPdfHash.set(key, hashAtFailure);
          records.set(key, { state: 'failed', updatedAt: now().toISOString(), error: message });
        }
      } while (again.has(key));
    } finally {
      // 「もう 1 回」の印の確認と running からの解放を同じ同期区間で行う。間が空くと、
      // その隙に来た request が印だけ立てて、誰にも回されないまま取りこぼされる
      running.delete(key);
    }
  }

  // 組版中(queued / building)はメモリの記録が正。それ以外は git の記録から出し直す。
  // 単独の create_report が filled や PDF をコミットしても、古い done / failed を見せ続けない。
  async function resolveRecord(id: string): Promise<JobRecord> {
    const key = id.toLowerCase();
    const rec = records.get(key);
    if (rec && (rec.state === 'queued' || rec.state === 'building')) {
      return rec;
    }
    const git = await stateFromGit(deps, id);
    const derived: JobRecord = { state: git.state, updatedAt: git.updatedAt, error: null };
    if (rec?.state !== 'failed') {
      return derived;
    }
    // PDF のコミットが失敗時から変わっていなければ失敗のまま。変わったなら、失敗のあとに
    // 単独の組版などで作られたので、git から出した状態を見せる。
    return git.pdfHash === failedPdfHash.get(key) ? rec : derived;
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
      return { id, ...(await resolveRecord(id)) };
    },
    async settled() {
      while (running.size > 0) {
        await Promise.all([...running.values()]);
      }
    },
  };
}
