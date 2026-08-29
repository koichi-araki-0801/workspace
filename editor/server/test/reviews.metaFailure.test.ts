// =============================================================================
// reviews.metaFailure.test.ts — 承認確定メタ更新の部分失敗(リトライ/明示エラー)
// =============================================================================
// `applyConfirmedSave`(実ファイル反映 + git commit)成功後の `updateReviewMeta` 失敗を
// 部分モックで再現し、(a) 一時失敗はリトライで回復する、(b) 恒常失敗は
// `REVIEW_META_UPDATE_FAILED` の明示エラーになり実ファイルは反映済みのまま残る、を検証する。
// vi.mock は hoist されるため `reviews.test.ts` とはファイルを分ける。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// config を import する前に一時ディレクトリへ向ける。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-metafail-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');
process.env.PENDING_DIR = path.join(tmp, 'pending');

// DB(sproc)は本テストの対象外。承認直後の注記マスタ書き戻しが実 DB へ触れないよう
// `callSproc` を決定的に失敗させる(reviews.test.ts と同じ理由)。
vi.mock('../src/db/sproc.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/db/sproc.js')>();
  return {
    ...orig,
    callSproc: async () => {
      throw new Error('DB 不在(テストの意図的失敗)');
    },
  };
});

// updateReviewMeta だけを差し替え、指定回数だけ失敗させる(他は実装のまま)。
const metaFail = vi.hoisted(() => ({ remaining: 0 }));
vi.mock('../src/files/reviewFiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/files/reviewFiles.js')>();
  return {
    ...actual,
    updateReviewMeta: async (
      ...args: Parameters<typeof actual.updateReviewMeta>
    ): ReturnType<typeof actual.updateReviewMeta> => {
      if (metaFail.remaining > 0) {
        metaFail.remaining--;
        throw new Error('EPERM: simulated meta write failure');
      }
      return actual.updateReviewMeta(...args);
    },
  };
});

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('review approve — meta 更新の部分失敗', () => {
  let reviews: typeof import('../src/repositories/reviewRepo.js');
  const submitter = { username: 'editor1', role: 'editor' };
  const approver = { username: 'approver1', role: 'approver' };

  const submit = (templateId: string, fundCode: string, html: string) =>
    reviews.submitReview({ templateId, html, css: '.x{}', fundCode, origin: 'edit' }, submitter);

  beforeAll(async () => {
    reviews = await import('../src/repositories/reviewRepo.js');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('一時失敗(1 回)はリトライで回復し approved になる', async () => {
    const tplId = 'AM01_111111_20250101_交付版';
    const meta = await submit(tplId, '111111', '<p>リトライ回復</p>');
    metaFail.remaining = 1;

    const res = await reviews.approveReview(meta.id, {}, approver);
    expect(res.meta.id).toBe(tplId);
    const after = await reviews.getReview(meta.id, approver);
    expect(after.status).toBe('approved');
  });

  it('恒常失敗は REVIEW_META_UPDATE_FAILED を投げ、実ファイルは反映済みのまま残る', async () => {
    const tplId = 'AM01_222222_20250101_交付版';
    const meta = await submit(tplId, '222222', '<p>恒常失敗</p>');
    metaFail.remaining = Number.MAX_SAFE_INTEGER;

    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'unexpected',
      code: 'REVIEW_META_UPDATE_FAILED',
    });
    metaFail.remaining = 0;
    // 実ファイル反映と git commit は完了済み(エラーメッセージの前提)であること。
    const written = fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8');
    expect(written).toContain('恒常失敗');
    // meta は pending のまま残る(承認キューに可視 = 手動復旧の手掛かり)。
    const after = await reviews.getReview(meta.id, approver);
    expect(after.status).toBe('pending');
  });
});
