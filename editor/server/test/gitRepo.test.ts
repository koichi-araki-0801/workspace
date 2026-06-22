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

  it('commitAll is a no-op when there is nothing to commit (HEAD unchanged)', async () => {
    const before = await git.commitFiles('HEAD');
    const h1 = await git.commitAll('変更なし', { name: 'tester' });
    const h2 = await git.commitAll('変更なし2', { name: 'tester' });
    expect(h1).toBe(h2);
    // 直近コミットは変わらない。
    const after = await git.commitFiles('HEAD');
    expect(after).toEqual(before);
  });
});
