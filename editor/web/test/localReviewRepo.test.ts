import { isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localReviewRepo } from '@/api/local/reviewRepo';
import { K } from '@/api/local/store';
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

describe('localReviewRepo の旧 held 申請', () => {
  it('localStorage に held で残る申請は pending として読み、そのまま承認できる', async () => {
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

    const all = JSON.parse(localStorage.getItem(K.reviews) ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    all[submitted.value.id] = {
      ...all[submitted.value.id],
      status: 'held',
      heldBy: 'x',
      holdComment: 'メモ',
    };
    localStorage.setItem(K.reviews, JSON.stringify(all));

    const list = await localReviewRepo.listReviews({});
    expect(isOk(list) && list.value.find((m) => m.id === submitted.value.id)?.status).toBe(
      'pending',
    );
    const approved = await localReviewRepo.approveReview(submitted.value.id, {});
    expect(isOk(approved)).toBe(true);
  });
});
