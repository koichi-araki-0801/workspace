// =============================================================================
// reviews.editingMarkers.test.ts — 申請本文に残った往復用の印を入口で拒否する
// =============================================================================
// 作成経路(Jinja へ戻した原文)と編集経路(値入り HTML)のどちらの本文にも、往復用の印
// (範囲のコメント・チップ・clone)は残らないはずである。残った申請を受けると承認で確定ファイルへ
// 焼き付くので、申請の入口で validation(400)にする。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionStub } from './helpers/sessionStub.js';

// config を import する前に一時ディレクトリへ向ける。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-markers-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');
process.env.PENDING_DIR = path.join(tmp, 'pending');
// 監査ログの DB 複写が実 DB へ出ないようにする(`reviews.test.ts` と同じ理由)。
process.env.AUDIT_DB = 'false';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('申請本文の編集用の印(両経路)', () => {
  let reviews: import('../src/repositories/reviewRepo.js').ReviewRepo;
  const submitter = { username: 'editor1', role: 'editor' };
  const CREATE_ID = 'AM01_510037_交付版';
  const EDIT_ID = 'AM01_510037_20240710_交付版';
  const RT = '<p><!--jinja-rt:o:1:e3sgaWYgYSAlfQ==-->x</p>';
  const CHIP = '<p><span data-gjs-type="jinja-var" data-jinja="e3sgYSB9fQ==">1</span></p>';
  const CLONE = '<table><tbody><tr data-jinja-loop-clone=""><td>1</td></tr></tbody></table>';

  beforeAll(async () => {
    fs.mkdirSync(path.join(tmp, 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pending', `${CREATE_ID}.html`), '<p>{{ fund.name }}</p>');
    fs.writeFileSync(path.join(tmp, 'filled', `${EDIT_ID}.html`), '<p>日本株式オープン</p>');
    // DB(sproc)は対象外。決定的に失敗する実行面を渡し、開発機の LocalDB へ触れないようにする。
    // helper は動的に取る — 静的 import だと冒頭の env 設定より先に `config.js` が読まれる。
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createDeps } = await import('../src/deps.js');
    reviews = createDeps(createOfflineSproc(), createSessionStub()).reviews;
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.each([
    ['create', CREATE_ID, RT],
    ['create', CREATE_ID, CHIP],
    ['edit', EDIT_ID, CHIP],
    ['edit', EDIT_ID, CLONE],
  ] as const)('%s 経路の印入り本文は validation(400)', async (origin, templateId, html) => {
    await expect(
      reviews.submitReview({ templateId, html, css: '', origin }, submitter),
    ).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('編集用の印') });
  });

  it('filledHtml(プレビュー文書)に印があっても拒否する', async () => {
    await expect(
      reviews.submitReview(
        { templateId: EDIT_ID, html: '<p>値</p>', filledHtml: CHIP, css: '', origin: 'edit' },
        submitter,
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('印の無い申請は両経路とも通る', async () => {
    const created = await reviews.submitReview(
      { templateId: CREATE_ID, html: '<p>{{ fund.name }}</p>', css: '', origin: 'create' },
      submitter,
    );
    expect(created.status).toBe('pending');
    const edited = await reviews.submitReview(
      { templateId: EDIT_ID, html: '<p>日本株式オープン(改)</p>', css: '', origin: 'edit' },
      submitter,
    );
    expect(edited.status).toBe('pending');
  });
});
