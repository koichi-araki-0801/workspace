// =============================================================================
// historyRepo.multiTemplate.test.ts — 1 コミットが複数テンプレに触れた版の帰属
// =============================================================================
// 確定コミットは `git add -A` で作るため、承認とペア転写が同じコミットへ入るなど
// 1 コミットが 2 つ以上の `filled/*.html` を持つことがある。版一覧は各テンプレごとに
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
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'filled', `${FIRST}.html`), '<p>交付版の本文</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'filled', `${SECOND}.html`), '<p>全体版の本文</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', '999999.css'), 'p{color:#000}', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', 'AM01_999999_交付版.css'), 'p{color:#111}', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', 'AM01_999999_全体版.css'), 'p{color:#222}', 'utf8');
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

  it('スナップショットの CSS は版種ごとのテンプレの CSS で、旧名(<fund>.css)は読まない', async () => {
    const first = await history.getSnapshot(hash, FIRST);
    const second = await history.getSnapshot(hash, SECOND);
    expect(first.css).toBe('p{color:#111}');
    expect(second.css).toBe('p{color:#222}');
    expect(first.fundCode).toBe('999999');
  });
  it('日本語名の CSS を承認コミットで書き、git の既定(core.quotepath=true)でも履歴から読める', async () => {
    // 既定の quotepath は日本語のパスを `"css/ã…"` と引用符付きで出す。リポジトリ側の
    // 設定がどうであれ、承認の書込・コミットと履歴の読み出しが同じ名前で往復することを固定する。
    execFileSync('git', ['config', 'core.quotepath', 'true'], { cwd: tmp });
    const { applyConfirmedWrite } = await import('../src/repositories/confirmedWrite.js');
    const git = await import('../src/git/gitRepo.js');
    const id = 'SMTAM_110024_20240517_交付版';
    await applyConfirmedWrite({
      kind: 'review-approve',
      target: 'filled',
      templateId: id,
      html: '<p>日本語名</p>',
      css: '.jp{}',
      author: 'approver1',
      commitMessage: '確定保存(承認): 日本語名の CSS',
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    expect(await git.commitFiles(head)).toEqual(
      expect.arrayContaining(['css/SMTAM_110024_交付版.css', `filled/${id}.html`]),
    );
    const snap = await history.getSnapshot(head, id);
    expect(snap.html).toBe('<p>日本語名</p>');
    expect(snap.css).toBe('.jp{}');
    expect((await history.getEditHistory()).map((e) => e.templateId)).toContain(id);
  });
});
