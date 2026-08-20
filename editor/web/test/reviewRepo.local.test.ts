// =============================================================================
// reviewRepo.local.test.ts — local 確定保存承認ワークフローのラウンドトリップ
// =============================================================================
// submit は実反映せず pending を作り、approve で既存 confirmSaveLocal 経路を通して本文へ反映、
// reject は反映しない、を localStorage 上で検証する。承認者(admin)でログインしてから操作する。
import { isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localReviewRepo } from '@/api/local/reviewRepo';
import { localTemplateRepo } from '@/api/local/templateRepo';
import { K } from '@/lib/storageKeys';

beforeEach(() => localStorage.clear());

/** approver|admin としてログインし、承認操作と全件可視を有効にする。 */
async function loginAdmin(): Promise<void> {
  const r = await localAuthRepo.login({ username: 'admin', password: 'admin' });
  expect(isOk(r)).toBe(true);
}

/** 既存テンプレを 1 件返す(fixtures 由来)。無ければ null。 */
async function firstTemplate() {
  const list = await localTemplateRepo.listTemplates({});
  if (!isOk(list) || list.value.length === 0) return null;
  return list.value[0];
}

describe('localReviewRepo round-trip', () => {
  it('submit creates a pending request without applying to the template', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    if (!target) return;
    const before = await localTemplateRepo.getTemplate(target.id);

    const submitted = await localReviewRepo.submitReview({
      templateId: target.id,
      html: '<p>申請版の本文</p>',
      css: '.x{}',
      fundCode: target.attributes.fundCode,
      origin: 'edit',
    });
    expect(isOk(submitted)).toBe(true);
    if (isOk(submitted)) expect(submitted.value.status).toBe('pending');

    // 実反映されていない(テンプレ本文は元のまま)。
    const after = await localTemplateRepo.getTemplate(target.id);
    if (isOk(before) && isOk(after)) expect(after.value.html).toBe(before.value.html);

    const pending = await localReviewRepo.listReviews({ status: 'pending' });
    expect(isOk(pending)).toBe(true);
    if (isOk(pending)) expect(pending.value.length).toBe(1);
  });

  it('approve applies the submitted body and marks the request approved', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    if (!target) return;

    const submitted = await localReviewRepo.submitReview({
      templateId: target.id,
      html: '<p>承認後に反映される本文</p>',
      css: '.y{}',
      fundCode: target.attributes.fundCode,
      origin: 'edit',
    });
    if (!isOk(submitted)) throw new Error('submit failed');

    const approved = await localReviewRepo.approveReview(submitted.value.id, { comment: 'ok' });
    expect(isOk(approved)).toBe(true);
    // 申請〜承認の間に現行版へ割り込みが無いので並行性警告は立たない。
    if (isOk(approved)) {
      expect(approved.value.meta.id).toBe(target.id);
      expect(approved.value.staleWarning).toBe(false);
    }

    const reread = await localTemplateRepo.getTemplate(target.id);
    if (isOk(reread)) expect(reread.value.html).toContain('承認後に反映される本文');

    const detail = await localReviewRepo.getReview(submitted.value.id);
    if (isOk(detail)) {
      expect(detail.value.status).toBe('approved');
      expect(detail.value.comment).toBe('ok');
    }
  });

  it('reject marks the request rejected without applying', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    if (!target) return;
    const before = await localTemplateRepo.getTemplate(target.id);

    const submitted = await localReviewRepo.submitReview({
      templateId: target.id,
      html: '<p>却下されるべき本文</p>',
      css: '.z{}',
      fundCode: target.attributes.fundCode,
      origin: 'edit',
    });
    if (!isOk(submitted)) throw new Error('submit failed');

    const rejected = await localReviewRepo.rejectReview(submitted.value.id, { comment: 'NG' });
    expect(isOk(rejected)).toBe(true);
    if (isOk(rejected)) expect(rejected.value.status).toBe('rejected');

    const after = await localTemplateRepo.getTemplate(target.id);
    if (isOk(before) && isOk(after)) expect(after.value.html).toBe(before.value.html);
  });

  // 反映と申請の状態遷移は同一 tx。別々だと「本文は公開済みなのに申請は承認待ち」が残り、
  // 同じ申請をもう一度承認できてしまう。
  it('申請の書込に失敗したら本文反映ごと巻き戻る', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    if (!target) return;
    const before = await localTemplateRepo.getTemplate(target.id);

    const submitted = await localReviewRepo.submitReview({
      templateId: target.id,
      html: '<p>巻き戻る本文</p>',
      css: '.z{}',
      fundCode: target.attributes.fundCode,
      origin: 'edit',
    });
    if (!isOk(submitted)) throw new Error('submit failed');

    // 申請キーへの書込だけを 1 度失敗させる(ロールバックの復元書込は通す)。
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function patched(key: string, value: string) {
      if (key === K.reviews && !failed) {
        failed = true;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    try {
      const approved = await localReviewRepo.approveReview(submitted.value.id, {});
      expect(isOk(approved)).toBe(false);
    } finally {
      Storage.prototype.setItem = original;
    }

    // 本文は元のまま、申請も承認待ちのまま。
    const after = await localTemplateRepo.getTemplate(target.id);
    if (isOk(before) && isOk(after)) expect(after.value.html).toBe(before.value.html);
    const pending = await localReviewRepo.listReviews({ status: 'pending' });
    if (isOk(pending)) expect(pending.value.map((r) => r.id)).toEqual([submitted.value.id]);
  });
});
