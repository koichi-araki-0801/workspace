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

/** 実行中/待機中のチェーン。空になったキーは捨てて Map が単調増加しないようにする。 */
const chains = new Map<string, Promise<unknown>>();

/**
 * `key` について `fn` を直列に実行する。同じ `key` の呼び出しは到着順に 1 つずつ走る。
 * `fn` の失敗はそのまま呼び出し側へ伝わり、後続のチェーンは(成否に関わらず)続行する。
 */
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // チェーン用の握りつぶし版を繋ぐ(個々の結果は `run` が保持する)。
  const chained = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, chained);
  void chained.then(() => {
    // 自分が最後尾のままならエントリを掃除する(後から積まれていれば触らない)。
    if (chains.get(key) === chained) chains.delete(key);
  });
  return run;
}
