// =============================================================================
// gitRepo.test.ts — git 版管理レイヤの単体テスト(一時リポジトリ)
// =============================================================================
// 一時ディレクトリを `GIT_REPO_DIR` に向け、init/commit/log/show が期待どおり
// 動くことを確認する。git CLI が PATH に必要(環境前提)。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に gitRepoDir を一時ディレクトリへ固定する。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-git-'));
process.env.GIT_REPO_DIR = tmp;

// git が無い環境ではスキップ(CI 前提だが安全弁)。
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

const d = gitAvailable ? describe : describe.skip;

d('gitRepo', () => {
  let git: typeof import('../src/git/gitRepo.js');

  beforeAll(async () => {
    git = await import('../src/git/gitRepo.js');
    await git.ensureRepo();
    fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ensureRepo creates a repo with an initial commit', async () => {
    expect(fs.existsSync(path.join(tmp, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.gitattributes'))).toBe(true);
  });

  it('commitAll commits changes with the login id as author and logForFile lists them', async () => {
    const rel = 'templates/AM01_999999_20250101_交付版.html';
    fs.writeFileSync(path.join(tmp, rel), '<p>{{ fund.name }}</p>', 'utf8');
    const hash = await git.commitAll('確定保存: AM01_999999_20250101_交付版 by tester', {
      name: 'tester',
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);

    const log = await git.logForFile(rel);
    expect(log.length).toBe(1);
    expect(log[0].author).toBe('tester');
    expect(log[0].subject).toContain('確定保存');

    // git show でコミット時点の内容を取り出せる。
    const shown = await git.showFile(hash, rel);
    expect(shown).toContain('{{ fund.name }}');

    // コミットで変更されたファイルに当該テンプレが含まれる。
    const files = await git.commitFiles(hash);
    expect(files).toContain(rel);
  });

  it('commitAll keeps the given author even when GIT_AUTHOR_NAME leaks from the env', async () => {
    // git フック連鎖(post-commit→push→pre-push→CI)では外側 commit の `GIT_AUTHOR_NAME` が
    // 子プロセスへ漏れ、`-c user.name` を上書きしうる。identity を環境変数で確定しているため
    // 漏れ値ではなく指定 author になることを保証する。
    const saved = process.env.GIT_AUTHOR_NAME;
    process.env.GIT_AUTHOR_NAME = 'leaked-author';
    try {
      const rel = 'templates/AM01_999999_20250102_交付版.html';
      fs.writeFileSync(path.join(tmp, rel), '<p>{{ fund.code }}</p>', 'utf8');
      await git.commitAll('確定保存: env leak 回帰', { name: 'tester' });
      const log = await git.logForFile(rel);
      expect(log[0].author).toBe('tester');
    } finally {
      if (saved === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = saved;
    }
  });

  it('commitAll is a no-op when there is nothing to commit (HEAD unchanged)', async () => {
    const before = await git.commitFiles('HEAD');
    const h1 = await git.commitAll('変更なし', { name: 'tester' });
    const h2 = await git.commitAll('変更なし2', { name: 'tester' });
    expect(h1).toBe(h2);
    // 直近コミットは変わらない。
    const after = await git.commitFiles('HEAD');
    expect(after).toEqual(before);
  });

  it('showFile still resolves a valid hash:path after the option guard', async () => {
    const rel = 'templates/AM01_999999_20250103_交付版.html';
    fs.writeFileSync(path.join(tmp, rel), '<p>guard 正常系</p>', 'utf8');
    const hash = await git.commitAll('確定保存: guard 正常系', { name: 'tester' });
    expect(await git.showFile(hash, rel)).toContain('guard 正常系');
    // 短縮 hash(7 桁)も検証を通り、同じ内容を返す。
    expect(await git.showFile(hash.slice(0, 7), rel)).toContain('guard 正常系');
    expect(await git.commitDate(hash)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── 引数注入ガード(git 不要: 検証は git を起動する前に効く) ──
// `execFile` 直叩きなのでシェル注入は起きないが、`-` 始まりの値は git がオプションとして
// 読む。`git show --output=<file>` は任意ファイルを作成/切り詰められるため、リビジョン/
// パス位置に来たユーザー入力が git へ届かないことを固定する(F30 の回帰)。
describe('gitRepo argument guards', () => {
  let git: typeof import('../src/git/gitRepo.js');
  const hash = 'a'.repeat(40);

  beforeAll(async () => {
    git = await import('../src/git/gitRepo.js');
  });

  it('rejects an --output= revision without creating the target file', async () => {
    const victim = path.join(tmp, 'pwned.html');
    await expect(git.commitFiles(`--output=${victim}`)).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(fs.existsSync(victim)).toBe(false);
  });

  it('rejects option-shaped revisions in commitDate / showFile', async () => {
    await expect(git.commitDate('--format=%H')).rejects.toMatchObject({ kind: 'validation' });
    await expect(git.showFile('-deadbeef', 'templates/a.html')).rejects.toMatchObject({
      kind: 'validation',
    });
    // 記号リビジョン(`HEAD~1` 等)もオブジェクトID ではないので通さない。
    await expect(git.commitDate('HEAD~1')).rejects.toMatchObject({ kind: 'validation' });
  });

  it('rejects escaping or pathspec-magic paths', async () => {
    await expect(git.showFile(hash, '../../etc/passwd')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(git.showFile(hash, ':(exclude)templates')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(git.logForFile('-Ppwn')).rejects.toMatchObject({ kind: 'validation' });
    await expect(git.logForFile('templates/../../x')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(git.logAll('')).rejects.toMatchObject({ kind: 'validation' });
  });

  it('keeps normal repo-relative paths (including Japanese names) valid', async () => {
    // 検証はリポジトリ未初期化でも先に効くため、正常な pathspec は空配列で返る。
    await expect(git.logForFile('templates/AM01_510037_20240710_交付版.html')).resolves.toEqual(
      expect.any(Array),
    );
    await expect(git.logAll('templates')).resolves.toEqual(expect.any(Array));
  });
});
