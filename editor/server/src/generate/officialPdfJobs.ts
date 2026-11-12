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
  /** `base` より後の `filled/<id>.html` のコミットが、すべて create_report.py の作者のものか。 */
  filledChangedOnlyByCreateReport(id: string, base: string): Promise<boolean>;
  now?: () => Date;
}

interface CommitRef {
  hash: string;
  date: string;
}

interface GitDerivedState {
  state: 'missing' | 'done' | 'stale';
  updatedAt: string | null;
  pdfHash: string | null;
  /** `pdf` の記録があるときだけ引く。無ければ null。 */
  filledHash: string | null;
}

/**
 * git の記録から PDF の状態を出す。ファイルの更新時刻は共有ドライブ上でサーバごとの
 * 時計のずれに振り回されるので使わず、コミットの祖先関係で新旧を決める。
 * 未追跡の PDF は記録が無いので `missing` と数える。
 */
async function stateFromGit(
  deps: Pick<OfficialPdfJobsDeps, 'pdfCommit' | 'filledCommit' | 'isAncestorOrSame'>,
  id: string,
): Promise<GitDerivedState> {
  const pdf = await deps.pdfCommit(id);
  if (pdf === null) {
    return { state: 'missing', updatedAt: null, pdfHash: null, filledHash: null };
  }
  const filled = await deps.filledCommit(id);
  // filled が pdf と同じかその祖先なら PDF は最新。そうでなければ filled の方が新しい。
  const fresh = filled === null || (await deps.isAncestorOrSame(filled.hash, pdf.hash));
  return {
    state: fresh ? 'done' : 'stale',
    updatedAt: pdf.date,
    pdfHash: pdf.hash,
    filledHash: filled?.hash ?? null,
  };
}

type JobRecord = Omit<OfficialPdfStatus, 'id'>;

export function createOfficialPdfJobs(deps: OfficialPdfJobsDeps): OfficialPdfJobs {
  const now = deps.now ?? (() => new Date());
  const records = new Map<string, JobRecord>();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  // 失敗を記録した時点の PDF のコミット。いまの hash と同じなら、失敗のあとに PDF は変わっていない。
  const failedPdfHash = new Map<string, string | null>();
  // 組版が成功した時点の PDF と filled のコミット。filled が変わっても PDF が同じバイトになれば
  // スクリプトはコミットを省くので、git の祖先関係だけでは `stale` に見える。両方が成功時のまま
  // なら、その組版が今の filled から作ったと分かるので `done` を保つ。メモリにしか無いので、
  // サーバを再起動するとこの id は git から出し直して `stale` になる(組み直せば戻る)。
  const doneHashes = new Map<string, { pdf: string | null; filled: string | null }>();

  /** git から最後のコミットの hash を読む。読めなければ undefined(覚えない側へ倒す)。 */
  async function readHash(
    read: (id: string) => Promise<CommitRef | null>,
    id: string,
  ): Promise<string | null | undefined> {
    try {
      return (await read(id))?.hash ?? null;
    } catch (gitErr) {
      logger.warn({ id, err: gitErr }, '[report] 正式 PDF の成功時の記録を git から読めません');
      return undefined;
    }
  }

  /**
   * 成功時のコミットを覚える。filled は組版の前に読んだものを使う: 組版中に承認が filled を
   * コミットしても、その新しい filled から組んだ `done` と取り違えないため。
   */
  async function rememberDone(key: string, id: string, filledBefore: string | null | undefined) {
    const pdf = await readHash(deps.pdfCommit, id);
    if (pdf === undefined || filledBefore === undefined) {
      doneHashes.delete(key);
      return;
    }
    doneHashes.set(key, { pdf, filled: await filledAfterBuild(id, filledBefore) });
  }

  /**
   * 組版の後の filled の記録として覚える hash。create_report.py は組版で filled を書き直し
   * (改ページなど)、PDF が同じバイトなら filled だけをコミットしうる。組版の前からの filled の
   * コミットがすべて create_report.py の作者なら、それはこの組版の結果なので組版後の hash を
   * 覚える。ほかの作者(承認など)が混ざるか、確かめられなければ組版の前の hash のまま
   * (git から出し直して `stale` になる)。
   */
  async function filledAfterBuild(id: string, before: string | null): Promise<string | null> {
    const after = await readHash(deps.filledCommit, id);
    if (before === null || after === undefined || after === null || after === before) {
      return before;
    }
    try {
      return (await deps.filledChangedOnlyByCreateReport(id, before)) ? after : before;
    } catch (gitErr) {
      logger.warn({ id, err: gitErr }, '[report] 組版後の filled の作者を git から読めません');
      return before;
    }
  }

  async function runLoop(key: string, id: string): Promise<void> {
    // queued を一度は観測できるよう、同期の呼び出し元から切り離して始める
    await Promise.resolve();
    try {
      do {
        again.delete(key);
        records.set(key, { state: 'building', updatedAt: null, error: null });
        try {
          const filledBefore = await readHash(deps.filledCommit, id);
          await deps.build(id);
          await rememberDone(key, id, filledBefore);
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
  // 例外は成功・失敗の時点から記録が変わっていない場合で、そのときはメモリの判断を残す。
  async function resolveRecord(id: string): Promise<JobRecord> {
    const key = id.toLowerCase();
    const rec = records.get(key);
    if (rec && (rec.state === 'queued' || rec.state === 'building')) {
      return rec;
    }
    const git = await stateFromGit(deps, id);
    const derived: JobRecord = { state: git.state, updatedAt: git.updatedAt, error: null };
    if (rec?.state === 'done') {
      const at = doneHashes.get(key);
      const unchanged = at?.pdf === git.pdfHash && at?.filled === git.filledHash;
      // 日時は git の記録に合わせる(状態だけを成功時の判断で上書きする)。
      return at !== undefined && unchanged ? { ...derived, state: 'done' } : derived;
    }
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
