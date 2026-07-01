// =============================================================================
// reviews.test.ts — 確定保存の精査者承認ワークフロー(reviewRepo)の結合テスト
// =============================================================================
// 一時 dataRoot/git を環境変数で固定し、submit(実ファイル非更新)→ approve(実ファイル書込 +
// git commit + meta=approved)→ reject(非更新)と、自己承認拒否を検証する。git CLI が前提。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に一時ディレクトリへ向ける。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('review workflow (reviewRepo)', () => {
  let reviews: typeof import('../src/repositories/reviewRepo.js');
  const submitter = { username: 'editor1', role: 'editor' };
  const approver = { username: 'approver1', role: 'approver' };

  const submit = (templateId: string, fundCode: string, html: string) =>
    reviews.submitReview({ templateId, html, css: '.x{}', fundCode, origin: 'edit' }, submitter);

  beforeAll(async () => {
    reviews = await import('../src/repositories/reviewRepo.js');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('submit creates a pending request and does NOT touch the template file', async () => {
    const tplId = 'AM01_111111_20250101_交付版';
    const meta = await submit(tplId, '111111', '<p>{{ fund.name }} 申請</p>');
    expect(meta.status).toBe('pending');
    expect(meta.submittedBy).toBe('editor1');
    // 実ファイルは未作成、申請だけが data/reviews 配下に在る。
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'reviews', meta.id, 'meta.json'))).toBe(true);
  });

  it('rejects self-approval unless admin (forbidden)', async () => {
    const meta = await submit('AM01_222222_20250101_交付版', '222222', '<p>x</p>');
    await expect(reviews.approveReview(meta.id, {}, submitter)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('approve writes the template file, commits, and marks the request approved', async () => {
    const tplId = 'AM01_333333_20250101_交付版';
    const meta = await submit(tplId, '333333', '<p>{{ fund.name }} 反映済</p>');
    const tplMeta = await reviews.approveReview(meta.id, { comment: 'ok' }, approver);

    expect(tplMeta.id).toBe(tplId);
    // 実ファイルが書かれた。
    const written = fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8');
    expect(written).toContain('反映済');
    // git に承認コミットが積まれた(申請者・承認者の双方を残す)。
    const log = execFileSync('git', ['log', '-1', '--format=%an%x09%s'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    expect(log).toContain('approver1');
    expect(log).toContain('確定保存(承認)');
    // 申請は approved に。
    const after = await reviews.getReview(meta.id);
    expect(after.status).toBe('approved');
    expect(after.reviewedBy).toBe('approver1');
  });

  it('approving an already-decided request conflicts (409)', async () => {
    const meta = await submit('AM01_444444_20250101_交付版', '444444', '<p>y</p>');
    await reviews.approveReview(meta.id, {}, approver);
    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('reject marks the request rejected without writing the template file', async () => {
    const tplId = 'AM01_555555_20250101_交付版';
    const meta = await submit(tplId, '555555', '<p>却下対象</p>');
    const rejected = await reviews.rejectReview(meta.id, { comment: '理由' }, approver);

    expect(rejected.status).toBe('rejected');
    expect(rejected.comment).toBe('理由');
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
  });
});
