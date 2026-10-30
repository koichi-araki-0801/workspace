// =============================================================================
// gitRepo.isolation.test.ts — git の子プロセスがリポジトリ側の実行面と環境変数を受けないこと
// =============================================================================
// dataRoot はネットワーク上の共有に置かれうる。共有に書ける人が `.git/hooks` や `.git/config`
// (`core.hooksPath` / `core.fsmonitor` / `commit.gpgSign` / `log.showSignature`)を仕込むと、
// 承認のたびの git がそれをサーバのアカウントで動かす。ここでは、仕込んだ実行面がどれも
// 動かない(印のファイルが作られない)ことと、git の子へ渡る環境変数が許可リストだけで
// あることを、全呼び出しについて確かめる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-git-iso-'));
const repo = path.join(root, 'repo');
const markers = path.join(root, 'markers');
const planted = path.join(root, 'planted');
process.env.GIT_REPO_DIR = repo;
process.env.TMP_DIR = path.join(root, 'apptmp');
// 許可リストに無い値。git の子へ 1 つも渡ってはならない。
process.env.EDITOR_ISOLATION_SECRET = 'must-not-leak';

/** git の子の起動を記録する(実行は本物に任せる)。 */
const calls = vi.hoisted(
  () => [] as { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[],
);
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const realAsync = promisify(real.execFile);
  const execFile = Object.assign((...a: Parameters<typeof real.execFile>) => real.execFile(...a), {
    [promisify.custom]: (
      file: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv } & Record<string, unknown>,
    ) => {
      calls.push({ file, args, env: opts?.env });
      return realAsync(file, args, opts);
    },
  });
  return { ...real, default: { ...real, execFile }, execFile };
});

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

/** sh が読める区切り(Git for Windows の sh はバックスラッシュを区切りとして読まない)。 */
const sh = (p: string): string => p.split(path.sep).join('/');

/** 起動されたら印を書くだけの無害なスクリプト。 */
function markerScript(name: string, exitCode = 0): string {
  return `#!/bin/sh\necho ran > "${sh(path.join(markers, name))}"\nexit ${exitCode}\n`;
}

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o755 });
}

/** テスト側の素の git(フックは仕込む前にだけ使う)。 */
function rawGit(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

const HOOKS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-auto-gc',
  'post-index-change',
  'reference-transaction',
];

/** 許可する名前(大文字小文字は区別しない。Windows の env は `Path` のように綴る)。 */
const ALLOWED = new Set([
  'PATH',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'LC_ALL',
]);
const isAllowed = (k: string): boolean => {
  const u = k.toUpperCase();
  return ALLOWED.has(u) || u.startsWith('GIT_AUTHOR_') || u.startsWith('GIT_COMMITTER_');
};

d('gitRepo はリポジトリ側の実行面を動かさない', () => {
  let git: typeof import('../src/git/gitRepo.js');
  let signedHead = '';

  beforeAll(async () => {
    git = await import('../src/git/gitRepo.js');
    await git.ensureRepo();
    fs.mkdirSync(path.join(repo, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'templates', '署名_元.html'), '<p>a</p>', 'utf8');
    await git.commitAll('署名付きの土台', { name: 'tester' });

    // `log.showSignature` が効くには署名付きのコミットが要る。gpg を持たない環境でも作れるよう、
    // HEAD のコミットに `gpgsig` ヘッダを差し込んだ写しを作って HEAD を付け替える
    // (署名の検証は gpg.program を呼ぶので、仕込んだスクリプトが動けば印が残る)。
    const body = rawGit(['cat-file', 'commit', 'HEAD']);
    const sig = [
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' iQEzBAABCAAdFiEEAAAAAAAAAAAAAAAAAAAAAAAAAAAFAmAAAAAACgkQAAAAAAAA',
      ' =AAAA',
      ' -----END PGP SIGNATURE-----',
    ].join('\n');
    const signed = body.replace(/^(committer [^\n]*\n)/m, `$1${sig}\n`);
    signedHead = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo,
      input: signed,
      encoding: 'utf8',
    }).trim();
    rawGit(['update-ref', 'HEAD', signedHead]);

    // ── ここから仕込み(以後テスト側は素の git を呼ばない) ──
    fs.mkdirSync(markers, { recursive: true });
    for (const h of HOOKS) {
      writeExecutable(path.join(repo, '.git', 'hooks', h), markerScript(`dotgit-${h}`));
      writeExecutable(path.join(planted, 'hooks', h), markerScript(`hookspath-${h}`));
    }
    writeExecutable(path.join(planted, 'fsmonitor.sh'), markerScript('fsmonitor', 1));
    writeExecutable(path.join(planted, 'gpg.sh'), markerScript('gpg', 1));
    const cfg = (k: string, v: string) =>
      execFileSync('git', ['config', k, v], { cwd: repo, stdio: 'ignore' });
    cfg('core.hooksPath', sh(path.join(planted, 'hooks')));
    cfg('core.fsmonitor', sh(path.join(planted, 'fsmonitor.sh')));
    cfg('commit.gpgSign', 'true');
    cfg('gpg.program', sh(path.join(planted, 'gpg.sh')));
    cfg('log.showSignature', 'true');
    calls.length = 0;
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.EDITOR_ISOLATION_SECRET;
  });

  it('commitAll と log 系を呼んでも、フック・fsmonitor・gpg のどれも動かない', async () => {
    const rel = 'templates/日本語の名前_交付版.html';
    fs.writeFileSync(path.join(repo, rel), '<p>{{ fund.name }}</p>', 'utf8');
    const hash = await git.commitAll('確定保存: 日本語のメッセージ', { name: 'tester' });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);

    const log = await git.logForFile(rel);
    expect(log[0]).toMatchObject({ author: 'tester', subject: '確定保存: 日本語のメッセージ' });
    const all = await git.logAllWithFiles('templates');
    expect(all[0].files).toContain(rel);
    // 署名付きのコミットも読む(`log.showSignature` が効けば gpg.program が呼ばれる)。
    expect(all.map((c) => c.hash)).toContain(signedHead);
    expect(await git.commitFiles(hash)).toContain(rel);
    expect(await git.showFile(hash, rel)).toContain('{{ fund.name }}');
    expect(await git.commitDate(signedHead)).toMatch(/^\d{4}-/);

    // 署名を付けずにコミットした(`commit.gpgSign` は効いていない)。
    const raw = execFileSync('git', ['cat-file', 'commit', hash], { cwd: repo, encoding: 'utf8' });
    expect(raw).not.toContain('gpgsig');
    expect(fs.readdirSync(markers)).toEqual([]);
  });

  it('全呼び出しで、無効化の -c と許可リストだけの環境変数を渡す', () => {
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      const joined = c.args.join(' ');
      expect(joined).toMatch(/-c core\.hooksPath=\S+/);
      expect(joined).toContain('-c core.fsmonitor=false');
      expect(joined).toContain('-c commit.gpgSign=false');
      expect(joined).toContain('-c log.showSignature=false');
      // 空のフォルダはリポジトリの外(editor の持ち物)にある。
      const hooksPath = /-c core\.hooksPath=(\S+)/.exec(joined)?.[1] ?? '';
      expect(path.resolve(hooksPath).startsWith(path.resolve(repo))).toBe(false);
      expect(fs.readdirSync(hooksPath)).toEqual([]);

      expect(c.env).toBeDefined();
      const env = c.env as NodeJS.ProcessEnv;
      expect(Object.keys(env).filter((k) => !isAllowed(k))).toEqual([]);
      expect(env.LC_ALL).toBe('C');
      expect(Object.values(env)).not.toContain('must-not-leak');
      // PATH は通す(git 自身と、その下請けの解決に要る)。
      expect(Object.keys(env).some((k) => k.toUpperCase() === 'PATH')).toBe(true);
    }
  });

  it('commit には --no-verify、diff・log・show には --no-ext-diff --no-textconv を付ける', () => {
    const sub = (c: { args: string[] }) =>
      c.args.find((a, i) => i > 0 && c.args[i - 1] !== '-c' && !a.startsWith('-'));
    const commits = calls.filter((c) => sub(c) === 'commit');
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) expect(c.args).toContain('--no-verify');
    const reads = calls.filter((c) => ['diff', 'log', 'show'].includes(sub(c) ?? ''));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const c of reads) {
      expect(c.args).toContain('--no-ext-diff');
      expect(c.args).toContain('--no-textconv');
    }
  });
});
