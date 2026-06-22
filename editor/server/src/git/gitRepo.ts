// =============================================================================
// gitRepo.ts — テンプレ版管理の git リポジトリ操作(CLI 直叩き)
// =============================================================================
// テンプレ/css の確定版を `config.gitRepoDir`(= dataRoot)の git リポジトリで版管理
// する。確定保存ごとに 1 コミットを積み、版一覧/スナップ/編集履歴は git log/show
// から導く。オフライン/エアギャップ運用のため npm 依存は足さず、git CLI を
// `node:child_process` で直接呼ぶ(唯一の集約点)。
//
// 設計上の要点:
//   - コミットは `withGitLock` で直列化し、Windows の `.git/index.lock` 競合を防ぐ。
//   - 日本語ファイル名のため `-c core.quotepath=false` を常用する。
//   - author/committer はログインID を都度 `-c user.*` で与え、サーバ環境の
//     グローバル git 設定に依存しない。
//   - `ensureRepo` は lazy: 未初期化なら init + .gitignore/.gitattributes + 初回
//     コミットまで行う(local/テストでは確定保存を呼ばない限り起動しない)。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** 同梱 PortableGit へのフォールバックは phase 5 で `GIT_BIN` 経由で差し込む。 */
const GIT_BIN = process.env.GIT_BIN ?? 'git';

/** 日本語パスを生のまま扱うための共通フラグ。 */
const COMMON_ARGS = ['-c', 'core.quotepath=false'];

/** git log の 1 コミット分のメタ(版一覧/編集履歴の素)。 */
export interface GitCommitMeta {
  hash: string;
  /** author date(ISO 8601)。 */
  date: string;
  /** author 名(= ログインID)。 */
  author: string;
  /** コミットメッセージ subject。 */
  subject: string;
}

/** コミットの author/committer identity(= ログインID)。 */
export interface GitAuthor {
  name: string;
}

/** `git <COMMON_ARGS> <args>` を gitRepoDir で実行し stdout を返す。 */
async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, [...COMMON_ARGS, ...args], {
    cwd: config.gitRepoDir,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

// ── コミット直列化(index.lock 競合対策) ──
// モジュール内の単一 Promise チェーン。全コミットを直列に実行する。
let lock: Promise<unknown> = Promise.resolve();
export function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  // チェーンは握りつぶして次へ繋ぐ(個々の結果は run が保持)。
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** identity を表す `-c user.name=... -c user.email=...` 引数を組む。 */
function identityArgs(author: GitAuthor): string[] {
  const name = author.name || 'system';
  // email はメタにのみ使う。ログインID から安全な local アドレスを合成する。
  const email = `${name.replace(/[^\w.-]/g, '_')}@editor.local`;
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

/**
 * gitRepoDir 自身が git リポジトリのルートか(`.git` が直下に在るか)。
 * `rev-parse --is-inside-work-tree` は親方向へ探索してしまい、dataRoot が別リポジトリ
 * (例: ユーザーのホーム)配下にあると誤検知するため、`.git` の直接存在で判定する。
 */
async function isRepo(): Promise<boolean> {
  return fs
    .stat(path.join(config.gitRepoDir, '.git'))
    .then(() => true)
    .catch(() => false);
}

/** HEAD コミットが存在するか(初回コミット前は false)。 */
async function hasHead(): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * リポジトリを必要に応じて初期化する(lazy)。未初期化なら init + .gitignore/
 * .gitattributes 配置 + 既存 templates/css を初回コミット(author=system)。
 */
export async function ensureRepo(): Promise<void> {
  await fs.mkdir(config.gitRepoDir, { recursive: true });
  if (await isRepo()) return;
  await git(['init']);
  await fs.writeFile(
    path.join(config.gitRepoDir, '.gitignore'),
    // 下書き(作業コピー)と atomicWrite の一時ファイルは追跡しない。
    '/drafts/\n*.tmp-*\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(config.gitRepoDir, '.gitattributes'),
    // Windows でも byte が揺れないよう改行を LF 固定にする。
    '* text=lf\n',
    'utf8',
  );
  await git(['add', '-A']);
  await git([
    ...identityArgs({ name: 'system' }),
    'commit',
    '-m',
    '初期化: テンプレ版管理リポジトリ',
  ]);
}

/**
 * 作業ツリーの全変更を 1 コミットにする。変更が無ければ HEAD を維持する。
 * コミットの author/committer は `author`(= ログインID)。新しい HEAD の hash を返す。
 */
export async function commitAll(message: string, author: GitAuthor): Promise<string> {
  await git(['add', '-A']);
  // ステージに差分が無ければ commit しない(空コミット回避)。
  let dirty = true;
  try {
    await git(['diff', '--cached', '--quiet']);
    dirty = false; // exit 0 = 差分なし
  } catch {
    dirty = true; // exit 1 = 差分あり
  }
  if (dirty) {
    await git([...identityArgs(author), 'commit', '-m', message]);
  }
  return (await git(['rev-parse', 'HEAD'])).trim();
}

const LOG_FORMAT = '%H%x09%aI%x09%an%x09%s';

/** コミット行(タブ区切り)を `GitCommitMeta` に解す。 */
function parseLog(stdout: string): GitCommitMeta[] {
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [hash, date, author, ...rest] = l.split('\t');
      return { hash, date, author, subject: rest.join('\t') };
    });
}

/** 指定パス(リポジトリ相対)に触れたコミット履歴を新しい順で返す。 */
export async function logForFile(relPath: string): Promise<GitCommitMeta[]> {
  if (!(await isRepo()) || !(await hasHead())) return [];
  const out = await git(['log', '--follow', `--format=${LOG_FORMAT}`, '--', relPath]);
  return parseLog(out);
}

/** 全テンプレの編集履歴(templates/ に触れたコミット)を新しい順で返す。 */
export async function logAll(pathspec: string): Promise<GitCommitMeta[]> {
  if (!(await isRepo()) || !(await hasHead())) return [];
  const out = await git(['log', `--format=${LOG_FORMAT}`, '--', pathspec]);
  return parseLog(out);
}

/** あるコミットで変更されたファイル(リポジトリ相対パス)の一覧。 */
export async function commitFiles(hash: string): Promise<string[]> {
  const out = await git(['show', '--name-only', '--format=', hash]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** あるコミット時点のファイル内容。存在しなければ空文字。 */
export async function showFile(hash: string, relPath: string): Promise<string> {
  try {
    return await git(['show', `${hash}:${relPath}`]);
  } catch {
    return '';
  }
}

/** あるコミットの author date(ISO)。 */
export async function commitDate(hash: string): Promise<string> {
  const out = await git(['show', '-s', '--format=%aI', hash]);
  return out.trim();
}
