// =============================================================================
// reviewRepo.local.test.ts — local 確定保存承認ワークフローのラウンドトリップ
// =============================================================================
// submit は実反映せず pending を作り、approve で既存 confirmSaveLocal 経路を通して本文へ反映、
// reject は反映しない、を localStorage 上で検証する。承認者(admin)でログインしてから操作する。
import { isErr, isOk } from '@editor/shared';
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
    if (isOk(reread)) expect(reread.value.filled).toContain('承認後に反映される本文');

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

describe('localReviewRepo の重複申請', () => {
  const TPL = 'AM01_610001_20250101_交付版';
  const login = async (username: string) => {
    expect(isOk(await localAuthRepo.login({ username, password: username }))).toBe(true);
  };
  const submit = (html: string, css = '.x{}', templateId = TPL) =>
    localReviewRepo.submitReview({ templateId, html, css, origin: 'create' });
  const pendingCount = async () => {
    const r = await localReviewRepo.listReviews({ status: 'pending' });
    return isOk(r) ? r.value.length : -1;
  };

  it('同じ人の同じ内容の 2 回目は conflict REVIEW_DUPLICATE で、申請は 1 件のまま', async () => {
    await login('editor');
    expect(isOk(await submit('<p>重複</p>'))).toBe(true);
    const second = await submit('<p>重複</p>');
    expect(isErr(second) && second.error).toMatchObject({
      kind: 'conflict',
      code: 'REVIEW_DUPLICATE',
      message: expect.stringContaining('同じ内容の確定保存申請が既に承認待ちです'),
    });
    expect(await pendingCount()).toBe(1);
  });

  it('HTML か CSS が 1 文字でも違えば受け付ける', async () => {
    await login('editor');
    await submit('<p>a</p>', '.x{}');
    await submit('<p>b</p>', '.x{}');
    await submit('<p>a</p>', '.y{}');
    expect(await pendingCount()).toBe(3);
  });

  it('HTML と CSS の境界がずれた別の組は重複とみなさない', async () => {
    await login('editor');
    await submit('ab', 'c');
    expect(isOk(await submit('a', 'bc'))).toBe(true);
  });

  it('別の人の同じ内容は受け付ける', async () => {
    await login('editor');
    await submit('<p>同じ</p>');
    await login('admin');
    expect(isOk(await submit('<p>同じ</p>'))).toBe(true);
    expect(await pendingCount()).toBe(2);
  });

  it('別のテンプレの同じ内容は受け付ける', async () => {
    await login('editor');
    await submit('<p>同じ</p>');
    expect(isOk(await submit('<p>同じ</p>', '.x{}', 'AM01_610002_20250101_交付版'))).toBe(true);
  });

  it('別の経路の同じ内容は重複とみなさない', async () => {
    await login('editor');
    await submit('<p>同じ</p>');
    const viaEdit = await localReviewRepo.submitReview({
      templateId: TPL,
      html: '<p>同じ</p>',
      css: '.x{}',
      origin: 'edit',
    });
    // 編集経路は値入り HTML が前提なので別の検査で落ちてよい。重複でなければよい。
    expect(isErr(viaEdit) && viaEdit.error.code).not.toBe('REVIEW_DUPLICATE');
  });

  it('1 件目が却下済みなら同じ内容でも受け付ける', async () => {
    await login('admin');
    const first = await submit('<p>再申請</p>');
    if (!isOk(first)) throw new Error('submit failed');
    const rejected = await localReviewRepo.rejectReview(first.value.id, { comment: '理由' });
    expect(isOk(rejected)).toBe(true);
    expect(isOk(await submit('<p>再申請</p>'))).toBe(true);
  });

  it('templateId の大文字小文字だけが違うものは重複とみなす', async () => {
    await login('editor');
    await submit('<p>大小</p>', '.x{}', 'am01_610001_20250101_交付版');
    const second = await submit('<p>大小</p>', '.x{}', 'AM01_610001_20250101_交付版');
    expect(isErr(second) && second.error.code).toBe('REVIEW_DUPLICATE');
  });

  it('文言の日時は YYYY/MM/DD HH:mm の全角括弧書きで終わる', async () => {
    await login('editor');
    await submit('<p>日時</p>');
    const second = await submit('<p>日時</p>');
    expect(isErr(second) && second.error.message).toMatch(
      /（\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}に申請）。新しい申請は作りませんでした。$/,
    );
  });
});
