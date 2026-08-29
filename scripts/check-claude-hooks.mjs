// =============================================================================
// check-claude-hooks.mjs — .claude/hooks/*.cjs の構文検査
// =============================================================================
// `.claude/` は BENIGN_PREFIXES から除外されており(`scripts/ci-affected.mjs`)、変更時は
// この検査が唯一の機械ゲートになる。フックは PreToolUse/PostToolUse で毎回子プロセス実行
// されるため、構文エラーを混入したまま気づかず放置すると全ツール呼び出しが壊れる。
//
// `node --check` を子プロセスで呼ぶ(`new Function` による自前パースはしない): 実行系の
// パーサそのものに構文検査させることで、パーサ実装差分による見逃しを避ける。

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = join(ROOT, '.claude', 'hooks');

let files = [];
try {
  files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.cjs'));
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('[check-claude-hooks] .claude/hooks が無いためスキップします。');
    process.exit(0);
  }
  throw err;
}

if (files.length === 0) {
  console.log('[check-claude-hooks] 検査対象の .cjs がありません。');
  process.exit(0);
}

let failed = false;
for (const file of files) {
  const path = join(HOOKS_DIR, file);
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    console.log(`[check-claude-hooks] OK: ${file}`);
  } catch (err) {
    failed = true;
    console.error(`[check-claude-hooks] NG: ${file}`);
    console.error(err.stderr ? err.stderr.toString() : String(err));
  }
}

if (failed) {
  console.error('\n[check-claude-hooks] 構文エラーのあるフックがあります。');
  process.exit(1);
}

console.log(`\n[check-claude-hooks] ${files.length} 件すべて OK。`);
