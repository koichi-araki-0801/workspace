import { isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localReviewRepo } from '@/api/local/reviewRepo';
import { localTemplateRepo } from '@/api/local/templateRepo';

beforeEach(() => localStorage.clear());

/** 既存テンプレを 1 件返す(fixtures 由来)。無ければ null。 */
async function firstTemplate() {
  const list = await localTemplateRepo.listTemplates({});
  if (!isOk(list) || list.value.length === 0) return null;
  return list.value[0];
}

/** approver|admin としてログイン */
async function loginAdmin(): Promise<void> {
  const r = await localAuthRepo.login({ username: 'admin', password: 'admin' });
  expect(isOk(r)).toBe(true);
}

describe('localReviewRepo.holdReview', () => {
  it('pending を held にし、held から承認できる', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    if (!target) return;

    const submitted = await localReviewRepo.submitReview({
      templateId: target.id,
      fundCode: target.attributes.fundCode,
      origin: 'edit',
      html: '<div>Test</div>',
      css: 'div { color: black; }',
    });
    expect(isOk(submitted)).toBe(true);
    if (!isOk(submitted)) return;

    const held = await localReviewRepo.holdReview(submitted.value.id, { comment: 'メモ' });
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value.status).toBe('held');
    expect(held.value.holdComment).toBe('メモ');

    // held からの承認
    const approved = await localReviewRepo.approveReview(submitted.value.id, {});
    expect(isOk(approved)).toBe(true);
  });
});
