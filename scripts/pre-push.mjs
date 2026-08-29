// =============================================================================
// pre-push.mjs — push 内容に応じて CI ゲートを出し分ける pre-push 振り分け
// =============================================================================
// `.husky/pre-push` から呼ぶ。git は pre-push の stdin に更新 ref を
// `<localRef> <localSha> <remoteRef> <remoteSha>` の行で渡す。push 対象が
// 「ローリングタグなどタグだけ」のときはコード用 CI を走らせない。
//
// なぜ: リリース更新は post-commit の `offline/publish-offline-bundle.ps1` が
// `git push origin +HEAD:refs/tags/offline-bundle-v1` でタグを動かす。この push でも
// pre-push が発火するため、素通しにすると `ci:affected`(フル CI)が走り、しかも commit フック内の
// `GIT_AUTHOR_NAME` 漏れで `gitRepo.test` が落ちてタグ push が中断する。タグは既に
// CI 済みコミットへのポインタなので、タグのみの push では CI を省く。ブランチ push の
// ゲートはそのまま維持する。
//
// ⚠ stdin は起動経路によっては refs があるのに**空文字**で届く(フック内から
// `execSync('git push')` した場合の実測。ブランチ 10 コミットの push が「対象なし」判定で
// CI を素通りした)。空 stdin を無条件にスキップへ倒さず、upstream との実差分で判定する。

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * push 内容から CI の要否を決める。'ci' = affected CI を実行 / 'skip' = 実行しない。
 *
 * - ブランチ ref を 1 つでも含む push は CI(従来どおり)。
 * - タグのみの push はスキップ。`aheadCount` より優先するのは、post-commit のタグ移動が
 *   「コミット直後・ブランチ未 push」のタイミングで走り aheadCount > 0 になるため
 *   (ここで CI を挟むとタグ push が数分ブロックされ、冒頭の「なぜ」の動線が壊れる)。
 * - refs が空のときは stdin を信用せず実差分で判定する: upstream より先行していれば
 *   ブランチ push とみなして CI、先行 0 なら本当に対象なし、先行数が取れない
 *   (upstream 未設定・git 失敗)なら安全側で CI。
 */
export function decidePrePushAction(remoteRefs, aheadCount) {
  if (remoteRefs.length > 0) {
    const tagOnly = remoteRefs.every((r) => r.startsWith('refs/tags/'));
    return tagOnly ? 'skip' : 'ci';
  }
  if (aheadCount === null) return 'ci';
  return aheadCount > 0 ? 'ci' : 'skip';
}

/**
 * upstream(@{u}) に対する HEAD の先行コミット数。upstream 未設定や git の失敗は null
 * (呼び出し側が安全側 = CI 実行へ倒す)。
 */
export function countAheadOfUpstream() {
  try {
    const out = execFileSync('git', ['rev-list', '--count', '@{u}..HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// ── 実行部(直接起動時のみ。テストからの import では走らせない) ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  // ── 1. push される ref を stdin から読む ──
  const stdin = readStdinSync();
  if (stdin === null) {
    // 読取失敗を「対象なし」に倒すとブランチ push の CI ゲートまで無言で素通りする
    // (fail-open)。安全側 = CI 実行へ倒す。意図的なスキップは `git push --no-verify` で行う。
    console.log('[pre-push] stdin の読取に失敗 → 安全側で CI を実行');
    runAffectedCi();
  }
  const lines = (stdin ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 各行の 3 列目 = remoteRef。push 対象の参照先を集める。
  const remoteRefs = lines.map((l) => l.split(/\s+/)[2]).filter(Boolean);

  // ── 2. 判定(タグのみ / 空 stdin の実差分判定は decidePrePushAction に集約) ──
  const ahead = remoteRefs.length === 0 ? countAheadOfUpstream() : 0;
  const action = decidePrePushAction(remoteRefs, ahead);
  if (action === 'skip') {
    const why =
      remoteRefs.length === 0 ? 'push 対象なし(upstream と差分なし)' : `タグのみ (${remoteRefs.join(', ')})`;
    console.log(`[pre-push] ${why} → CI をスキップ`);
    process.exit(0);
  }
  if (remoteRefs.length === 0) {
    const detail = ahead === null ? 'upstream 先行数が取れない' : `upstream より ${ahead} コミット先行`;
    console.log(`[pre-push] stdin に ref が無いが ${detail} → 安全側で CI を実行`);
  }

  // ── 3. ブランチを含む(または実差分のある) push は affected CI を実行 ──
  runAffectedCi();
}

// ── ユーティリティ ──
/** affected CI を実行し、その終了コードでプロセスを終える(戻らない)。 */
function runAffectedCi() {
  // `pnpm` ラッパを介さず node で直接起動し、Windows の pnpm.cmd 解決を避ける。
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'ci-affected.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(res.status ?? 1);
}

// pre-push の stdin(fd 0)を同期読み。空文字は「読めたが ref なし」で、対象なしと同義では
// ない(冒頭⚠参照)。読取自体の失敗(fd 0 が読めない環境要因)は null で区別し、呼び出し側で
// 安全側(CI 実行)へ倒す。
function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}
