// =============================================================================
// pre-push.mjs — push 内容に応じて CI ゲートを出し分ける pre-push 振り分け
// =============================================================================
// `.husky/pre-push` から呼ぶ。git は pre-push の stdin に更新 ref を
// `<localRef> <localSha> <remoteRef> <remoteSha>` の行で渡す。push 対象が
// 「ローリングタグなどタグだけ」のときはコード用 CI を走らせない。
//
// なぜ: リリース更新は post-commit の `offline/publish-offline-bundle.ps1` が
// `git push origin +HEAD:refs/tags/offline-bundle-v1` でタグを動かす。この push でも
// pre-push が発火するため、従来は `ci:affected`(フル CI)が走り、しかも commit フック内の
// `GIT_AUTHOR_NAME` 漏れで `gitRepo.test` が落ちてタグ push が中断していた。タグは既に
// CI 済みコミットへのポインタなので、タグのみの push では CI を省く。ブランチ push の
// ゲートは従来どおり維持する。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. push される ref を stdin から読む ──
const stdin = readStdinSync();
const lines = stdin
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

// 各行の 3 列目 = remoteRef。push 対象の参照先を集める。
const remoteRefs = lines.map((l) => l.split(/\s+/)[2]).filter(Boolean);

// ── 2. タグのみ(または対象なし)なら CI をスキップ ──
const tagOnly = remoteRefs.length > 0 && remoteRefs.every((r) => r.startsWith('refs/tags/'));
if (remoteRefs.length === 0 || tagOnly) {
  const why = remoteRefs.length === 0 ? 'push 対象なし' : `タグのみ (${remoteRefs.join(', ')})`;
  console.log(`[pre-push] ${why} → CI をスキップ`);
  process.exit(0);
}

// ── 3. ブランチを含む push は従来どおり affected CI を実行 ──
// `pnpm` ラッパを介さず node で直接起動し、Windows の pnpm.cmd 解決を避ける。
const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'ci-affected.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

// ── 4. ユーティリティ ──
// pre-push の stdin(fd 0)を同期読み。TTY 等で読めない場合は空文字 (= 対象なし扱い)。
function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
