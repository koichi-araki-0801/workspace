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
import { isGitObjectId, validation } from '@editor/shared';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** 同梱 PortableGit へのフォールバックは phase 5 で `GIT_BIN` 経由で差し込む。 */
const GIT_BIN = process.env.GIT_BIN ?? 'git';

/** 日本語パスを生のまま扱うための共通フラグ。 */
const COMMON_ARGS = ['-c', 'core.quotepath=false'];

// ── ユーザー由来引数の検証(git のオプション注入対策) ──
// 呼び出しは `execFile` 直叩きなのでシェル注入は起きないが、`-` で始まる値を渡すと git は
// それをオプションとして解釈する(`git show --output=<file>` はリポジトリ外のファイルを
// 作成/切り詰める)。リビジョンは `--` の後ろへ回すとパス扱いになって使えないので、
// 形式検証 + `--end-of-options`(以降を非オプションとして扱う git 2.24+ の区切り)の 2 段で
// 守る。パス側は `--` の後ろに置けるため、区切り + 形式検証で守る。
// 到達経路: `historyId`(GET /snapshots/:historyId)→ `commitFiles`/`showFile`/`commitDate`、
// `templateId`(GET /templates/:templateId/versions)→ `logForFile`。

/** リビジョン引数を「オプションと解釈されない形」に限る。`HEAD` はコード内定数用。 */
function checkRevision(rev: string): string {
  if (rev === 'HEAD' || isGitObjectId(rev)) return rev;
  throw validation(`版の指定が不正です: ${rev}`);
}

/**
 * リポジトリ相対パス(pathspec / `<rev>:<path>` のパス部)を検証する。`--` の後ろでは
 * オプション注入は起きないが、`:` 始まりは pathspec magic(`:(exclude)` 等)として働き、
 * `..` はリポジトリ外を指す。Windows のパス区切り `\` は git のパス表現ではないので落とす。
 */
function checkRelPath(relPath: string): string {
  const unsafe =
    relPath.length === 0 ||
    relPath.includes('\0') ||
    relPath.startsWith('-') ||
    relPath.startsWith(':') ||
    relPath.startsWith('/') ||
    relPath.includes('\\') ||
    /(^|\/)\.\.(\/|$)/.test(relPath);
  if (unsafe) throw validation(`ファイルの指定が不正です: ${relPath}`);
  return relPath;
}

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
interface GitAuthor {
  name: string;
}

/**
 * 1 回の git 実行の上限時間。超過で子プロセスを kill する。
 *
 * 上限が無いと、応答しない git(ネットワークドライブ上の dataRoot・`.git/index.lock` の
 * 待ち・巨大リポジトリ)がリクエストごとに 1 プロセスを残し続ける。timeout だけでは
 * 既定の SIGTERM を無視する子が残るので `killSignal` も明示する。
 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * `git <COMMON_ARGS> <args>` を gitRepoDir で実行し stdout を返す。
 * `env` を渡すと spawn 環境を差し替える(identity を環境変数で確定する commit で使う)。
 */
async function git(args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, [...COMMON_ARGS, ...args], {
    cwd: config.gitRepoDir,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
    env: opts?.env,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
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

/** identity の name/email を解決する。email はログインID から安全な local アドレスを合成。 */
function resolveIdentity(author: GitAuthor): { name: string; email: string } {
  const name = author.name || 'system';
  return { name, email: `${name.replace(/[^\w.-]/g, '_')}@editor.local` };
}

/** identity を表す `-c user.name=... -c user.email=...` 引数を組む。 */
function identityArgs(author: GitAuthor): string[] {
  const { name, email } = resolveIdentity(author);
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

// commit の author/committer を環境変数で確定する。`GIT_AUTHOR_*`/`GIT_COMMITTER_*` は
// `user.*` config より優先されるため、外側の git フック等から漏れた `GIT_AUTHOR_NAME` が
// `-c user.name` を上書きする事故(`gitRepo.test` 偽陽性の原因)を防ぐ。
function identityEnv(author: GitAuthor): NodeJS.ProcessEnv {
  const { name, email } = resolveIdentity(author);
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
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
 * 追跡対象外にすべき作業コピー(下書き・承認待ち申請・一時ファイル)を .gitignore へ
 * 冪等に揃える。初期化済みリポジトリにも適用し、`/reviews/` 追加のような後付けでも
 * `commitAll` の `git add -A` がそれらを誤って取り込まないようにする。
 */
async function ensureGitignore(): Promise<void> {
  const file = path.join(config.gitRepoDir, '.gitignore');
  // `/pending/` は整理ではなく防御の一部: 生成直後の未承認テンプレ実体を置く場所で、
  // 追跡すると承認コミット(`git add -A`)へ未承認の内容が混ざり、確定領域へ書けないよう
  // にした意味が消える。
  // `/notes/` も同じ理由で追跡外。パーツ単位メモは editor ロールが自由に書ける作業メモで、
  // 承認を経ていない。追跡すると承認コミットへ第三者のメモが混ざり、承認者の identity と
  // 承認メッセージを着せられた「承認済みの内容」として履歴に残る。
  const required = ['/drafts/', '/reviews/', '/pending/', '/notes/', '*.tmp-*'];
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  const lines = existing.split('\n').map((l) => l.trim());
  const missing = required.filter((r) => !lines.includes(r));
  if (missing.length === 0 && existing !== '') return;
  const merged = [...new Set([...lines.filter((l) => l !== ''), ...missing])];
  await fs.writeFile(file, `${merged.join('\n')}\n`, 'utf8');
}

/**
 * リポジトリを必要に応じて初期化する(lazy)。未初期化なら init + .gitignore/
 * .gitattributes 配置 + 既存 templates/css を初回コミット(author=system)。
 * 初期化済みでも .gitignore は冪等に補修する(`/reviews/` の後付け対応)。
 */
export async function ensureRepo(): Promise<void> {
  await fs.mkdir(config.gitRepoDir, { recursive: true });
  if (await isRepo()) {
    await ensureGitignore();
    return;
  }
  await git(['init']);
  await ensureGitignore();
  await fs.writeFile(
    path.join(config.gitRepoDir, '.gitattributes'),
    // Windows でも byte が揺れないよう改行を LF 固定にする。
    '* text=lf\n',
    'utf8',
  );
  // 初回コミットも許可リストの領域だけを取り込む(既存 dataRoot に notes 等が
  // 残っている状態で初期化されても、確定領域以外を追跡下へ入れない)。
  await stageTrackedAreas();
  await git(
    [...identityArgs({ name: 'system' }), 'commit', '-m', '初期化: テンプレ版管理リポジトリ'],
    {
      env: identityEnv({ name: 'system' }),
    },
  );
}

/**
 * 承認フローが書き込む領域(= コミットしてよい領域)の許可リスト。
 *
 * `git add -A`(作業ツリー全体)を使っていた版は、dataRoot 直下に生えた**未承認の
 * 利用者コンテンツを承認コミットへ巻き込んだ**。実例が `notes/`(editor が任意に書ける
 * メモ)で、`.gitignore` の必須リストから漏れていた 1 ディレクトリがそのまま
 * 「承認者の identity で第三者の内容がコミットされる」経路になっていた。
 *
 * 除外リスト(`.gitignore`)は**足し忘れが穴になる**方向の設計なので、staging 側は
 * 許可リストで書く。ここに無いディレクトリは、`.gitignore` へ書き忘れても混ざらない。
 * `.gitignore` 側の必須リストは多層防御として残す(`ensureGitignore`)。
 */
const COMMITTED_PATHSPECS = ['templates', 'css', 'sync', '.gitignore', '.gitattributes'];

/**
 * 許可リストの領域だけを stage する。存在しない pathspec を渡すと git は
 * `pathspec did not match any files` で失敗するため、実在するものだけに絞る。
 */
async function stageTrackedAreas(): Promise<void> {
  const present: string[] = [];
  for (const spec of COMMITTED_PATHSPECS) {
    const exists = await fs
      .stat(path.join(config.gitRepoDir, spec))
      .then(() => true)
      .catch(() => false);
    if (exists) present.push(spec);
  }
  if (present.length === 0) return;
  await git(['add', '-A', '--', ...present]);
}

/**
 * 作業ツリーの全変更を 1 コミットにする。変更が無ければ HEAD を維持する。
 * コミットの author/committer は `author`(= ログインID)。新しい HEAD の hash を返す。
 * `message`/`author` はユーザー由来だが `-m` / `-c` の値位置に置かれるため、`-` 始まりでも
 * git はオプションとして読まない(検証が要るのはリビジョン/パス位置のみ)。
 */
export async function commitAll(message: string, author: GitAuthor): Promise<string> {
  await stageTrackedAreas();
  // ステージに差分が無ければ commit しない(空コミット回避)。
  let dirty = true;
  try {
    await git(['diff', '--cached', '--quiet']);
    dirty = false; // exit 0 = 差分なし
  } catch {
    dirty = true; // exit 1 = 差分あり
  }
  if (dirty) {
    await git([...identityArgs(author), 'commit', '-m', message], { env: identityEnv(author) });
  }
  return (await git(['rev-parse', 'HEAD'])).trim();
}

const LOG_FORMAT = '%H%x09%aI%x09%an%x09%s';

/**
 * 1 回の `git log` が返すコミット数の上限。履歴は承認のたび単調に伸びるので、上限が
 * 無いと「古いリポジトリほど 1 リクエストが重い」= 時間とともに悪化する経路になる。
 */
export const MAX_LOG_COMMITS = 500;

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
  // 検証はリポジトリ状態の判定より先に置く。未初期化時の早期 return に隠れて不正入力が
  // 素通り(= 検査がリポジトリ状態依存)になるのを避けるため。
  const spec = checkRelPath(relPath);
  if (!(await isRepo()) || !(await hasHead())) return [];
  // 版一覧も件数を有界にする(履歴は承認のたび伸びる一方で、画面が使うのは直近だけ)。
  const out = await git([
    'log',
    `-n${MAX_LOG_COMMITS}`,
    '--follow',
    `--format=${LOG_FORMAT}`,
    '--',
    spec,
  ]);
  return parseLog(out);
}

/** コミットメタ + そのコミットで変更されたファイル(pathspec に一致するもの)。 */
export interface GitCommitWithFiles extends GitCommitMeta {
  files: string[];
}

/**
 * 指定 pathspec に触れたコミットを、**変更ファイル込み**で新しい順に返す(件数上限つき)。
 *
 * 呼び出し側が「コミット一覧を取ってから 1 件ずつ `git show`」をしていた版は、承認のたび
 * 増えるコミット数ぶんの子プロセスを**同一 tick で spawn** していた(`Array#map` の
 * async コールバックは最初の `await` まで同期に走る)。各子は `maxBuffer` 64MB を持つので、
 * 履歴が伸びるほど 1 リクエストの資源消費が線形に増える。`--name-only` を同じ `git log` へ
 * 畳めば子プロセスは常に 1 個で済み、`-n` で入力側も有界になる。
 *
 * 出力はレコード境界に NUL を置いて区切る。`%s`(subject)は 1 行目だけなので改行を含まず、
 * ファイル名側と混ざらない。
 */
export async function logAllWithFiles(
  pathspec: string,
  limit: number = MAX_LOG_COMMITS,
): Promise<GitCommitWithFiles[]> {
  const spec = checkRelPath(pathspec);
  if (!(await isRepo()) || !(await hasHead())) return [];
  const capped = Math.max(1, Math.min(Math.trunc(limit), MAX_LOG_COMMITS));
  const out = await git([
    'log',
    `-n${capped}`,
    `--format=%x00${LOG_FORMAT}`,
    '--name-only',
    '--',
    spec,
  ]);
  const records: GitCommitWithFiles[] = [];
  for (const chunk of out.split('\0')) {
    if (chunk.trim() === '') continue;
    const [head, ...rest] = chunk.split('\n');
    const [meta] = parseLog(head);
    if (!meta) continue;
    records.push({ ...meta, files: rest.map((l) => l.trim()).filter((l) => l.length > 0) });
  }
  return records;
}

/** あるコミットで変更されたファイル(リポジトリ相対パス)の一覧。 */
export async function commitFiles(hash: string): Promise<string[]> {
  const out = await git([
    'show',
    '--name-only',
    '--format=',
    '--end-of-options',
    checkRevision(hash),
  ]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * あるコミット時点のファイル内容。存在しなければ空文字。
 * 検証は try の外に置く: 不正な引数は「そのコミットに無い」ではなく入力の誤りなので、
 * 空文字へ丸めず `validation` として呼び出し元(= HTTP 400)へ返す。
 */
export async function showFile(hash: string, relPath: string): Promise<string> {
  const rev = `${checkRevision(hash)}:${checkRelPath(relPath)}`;
  try {
    return await git(['show', '--end-of-options', rev]);
  } catch {
    return '';
  }
}

/** あるコミットの author date(ISO)。 */
export async function commitDate(hash: string): Promise<string> {
  const out = await git(['show', '-s', '--format=%aI', '--end-of-options', checkRevision(hash)]);
  return out.trim();
}
