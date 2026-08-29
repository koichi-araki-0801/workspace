// =============================================================================
// historyRepo.multiTemplate.test.ts — 1 コミットが複数テンプレに触れた版の帰属
// =============================================================================
// 確定コミットは `git add -A` で作るため、承認とペア転写が同じコミットへ入るなど
// 1 コミットが 2 つ以上の `templates/*.html` を持つことがある。版一覧は各テンプレごとに
// 同じ hash を返すので、hash だけで対象ファイルを決めると先頭のテンプレの内容が
// 別テンプレの版として表示される(誤帰属)。実 git の一時リポジトリで固定する。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に一時ディレクトリへ向ける(gitRepo.test.ts と同方針)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-history-multi-'));
process.env.DATA_ROOT = tmp;

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

const FIRST = 'AM01_999999_20250101_交付版';
const SECOND = 'AM01_999999_20250101_全体版';

d('複数テンプレを含む版のスナップショット', () => {
  let history: typeof import('../src/repositories/historyRepo.js');
  let hash: string;

  beforeAll(async () => {
    const git = await import('../src/git/gitRepo.js');
    history = await import('../src/repositories/historyRepo.js');
    await git.ensureRepo();
    fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'templates', `${FIRST}.html`), '<p>交付版の本文</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'templates', `${SECOND}.html`), '<p>全体版の本文</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', '999999.css'), 'p{color:#000}', 'utf8');
    hash = await git.commitAll('確定保存 + ペア転写', { name: 'tester' });
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('templateId を指定すればそのテンプレの内容を返す', async () => {
    const first = await history.getSnapshot(hash, FIRST);
    expect(first.templateId).toBe(FIRST);
    expect(first.html).toContain('交付版の本文');

    const second = await history.getSnapshot(hash, SECOND);
    expect(second.templateId).toBe(SECOND);
    expect(second.html).toContain('全体版の本文');
  });

  it('版に含まれない templateId は明示エラー(先頭のテンプレで代用しない)', async () => {
    await expect(history.getSnapshot(hash, 'AM01_999999_20250101_運用報告書')).rejects.toThrow();
  });

  it('templateId 未指定で対象が絞れないときは黙って先頭を選ばない', async () => {
    await expect(history.getSnapshot(hash)).rejects.toThrow();
  });

  it('編集履歴は触れたテンプレごとに 1 行を出す', async () => {
    const entries = await history.getEditHistory();
    expect(entries.map((e) => e.templateId).sort()).toEqual([FIRST, SECOND].sort());
  });

  it('行 id はテンプレごとに一意で、コミット参照は historyId が持つ', async () => {
    // 行 id が hash のままだと、同じコミットの 2 行が同じキーになる(一覧の `:key` が衝突し、
    // 行の再利用で別テンプレの内容が表示されうる)。コミットを指す値は `historyId` に分ける。
    const entries = await history.getEditHistory();
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of entries) {
      expect(e.historyId).toBe(hash);
      expect(e.id).toBe(`${hash}:${e.templateId}`);
    }
  });
});
