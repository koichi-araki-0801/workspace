// =============================================================================
// fileLock.ts — ファイル単位の直列化(プロセス内・Promise チェーン)
// =============================================================================
// 「読んで → 変えて → 書く」をするファイル操作は、直列化しないと後勝ちで更新が消える。
// editor は単一プロセスなので、キーごとの Promise チェーンで十分に守れる
// (`git/gitRepo.ts` の `withGitLock`・`files/reviewFiles.ts` の `withReviewLock` と同じ流儀。
// 違いは「対象ごとに独立したチェーンを持つ」点だけ)。
//
// ⚠ プロセスをまたぐ保証は無い。多重プロセス配備をする日が来たら、この module の内部だけを
// ファイルロック(`proper-lockfile` 等)へ差し替える(公開関数の形は保つ)。
//
// キーの粒度は**書き込む実ファイルのパス**にする。テンプレ id 等の論理キーで取ると、
// 同じファイルを指す別表記(絶対/相対)が別ロックになり、直列化が効かない。

/** 失敗を握りつぶして成功に倒した版。チェーンへ繋ぐ用で、個々の結果は元の Promise が保持する。 */
function settle(p: Promise<unknown>): Promise<undefined> {
  return p.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * 渡した処理を 1 本ずつ順に走らせる直列キューを作る。到着順に走り、ある処理が失敗しても
 * 次は走る。処理の戻り値と例外はそのまま呼び出し元へ返る。
 * モジュール直下で 1 度だけ作り、プロセス全体で 1 本の鎖として使う想定。
 */
export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = settle(run);
    return run;
  };
}

/** 実行中/待機中のチェーン。空になったキーは捨てて Map が単調増加しないようにする。 */
const chains = new Map<string, Promise<unknown>>();

/**
 * `key` について `fn` を直列に実行する。同じ `key` の呼び出しは到着順に 1 つずつ走る。
 * `fn` の失敗はそのまま呼び出し側へ伝わり、後続のチェーンは(成否に関わらず)続行する。
 */
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const chained = settle(run);
  chains.set(key, chained);
  void chained.then(() => {
    // 自分が最後尾のままならエントリを掃除する(後から積まれていれば触らない)。
    if (chains.get(key) === chained) chains.delete(key);
  });
  return run;
}
