import { err, isErr, isOk, notFound } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('localReviewRepo の拒否と既定値', () => {
  it('規約外 templateId の申請は not_found、未ログインの申請者は「不明」', async () => {
    const bad = await localReviewRepo.submitReview({
      templateId: 'not-a-template',
      fundCode: 'x',
      origin: 'edit',
      html: '',
      css: '',
    });
    expect(isErr(bad) && bad.error.kind).toBe('not_found');

    const target = await firstTemplate();
    expect(target).not.toBeNull();
    if (!target) return;
    const r = await localReviewRepo.submitReview({
      templateId: target.id,
      fundCode: target.attributes.fundCode,
      origin: 'edit',
      html: '<p>x</p>',
      css: '',
      filledHtml: '<p>f</p>',
      changedSummary: { count: 1, names: ['a'] },
    });
    expect(isOk(r) && r.value.submittedBy).toBe('不明');
  });

  it('現行版の取得に失敗した申請は baseHash が null(申請自体は妨げない)', async () => {
    const target = await firstTemplate();
    expect(target).not.toBeNull();
    if (!target) return;
    const spy = vi
      .spyOn(localTemplateRepo, 'getTemplate')
      .mockResolvedValueOnce(err(notFound('x')));
    const sub = await localReviewRepo.submitReview({
      templateId: target.id,
      fundCode: target.attributes.fundCode,
      origin: 'edit',
      html: '<p>x</p>',
      css: '',
    });
    spy.mockRestore();
    expect(isOk(sub)).toBe(true);
    if (!isOk(sub)) return;
    const stored = await localReviewRepo.getReview(sub.value.id);
    expect(isOk(stored) && stored.value.baseHash).toBeNull();
  });

  it('未知の申請 id は取得・承認・却下とも not_found', async () => {
    await loginAdmin();
    expect(isErr(await localReviewRepo.getReview('rv-none'))).toBe(true);
    expect(isErr(await localReviewRepo.approveReview('rv-none', {}))).toBe(true);
    expect(isErr(await localReviewRepo.rejectReview('rv-none', { comment: 'x' }))).toBe(true);
  });

  it('却下は理由必須(空白だけも不可)、処理済みの申請は承認も却下も conflict', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    expect(target).not.toBeNull();
    if (!target) return;
    const sub = await localReviewRepo.submitReview({
      templateId: target.id,
      fundCode: target.attributes.fundCode,
      origin: 'edit',
      html: '<p>x</p>',
      css: '',
    });
    const id = isOk(sub) ? sub.value.id : '';
    const noReason = await localReviewRepo.rejectReview(id, { comment: '   ' });
    expect(isErr(noReason) && noReason.error.kind).toBe('validation');
    expect(isOk(await localReviewRepo.rejectReview(id, { comment: '理由' }))).toBe(true);
    const again = await localReviewRepo.approveReview(id, {});
    expect(isErr(again) && again.error.kind).toBe('conflict');
    const rejectAgain = await localReviewRepo.rejectReview(id, { comment: '再' });
    expect(isErr(rejectAgain) && rejectAgain.error.kind).toBe('conflict');
  });

  it('一覧は未ログインでも落ちず、自分の申請だけを見せる(誰でもない = 0 件)', async () => {
    const list = await localReviewRepo.listReviews({});
    expect(isOk(list)).toBe(true);
    if (isOk(list)) expect(list.value).toEqual([]);
  });
});

describe('localReviewRepo の値入り HTML 要求', () => {
  it("origin='edit' の申請は値入り HTML の無いテンプレを validation で拒む", async () => {
    await loginAdmin();
    // 作成タブが生成しただけのテンプレは値入り HTML を持たない(fixture が無く
    // `htmlOverride` だけが在る)。server の `assertFilledPresentForEdit` と同じ拒否になる。
    const gen = await localTemplateRepo.generate({
      companyCode: 'AM01',
      fundCode: '510037',
      editionType: '交付版',
    });
    expect(isOk(gen)).toBe(true);
    if (!isOk(gen)) return;
    const id = gen.value.template.meta.id;

    const bad = await localReviewRepo.submitReview({
      templateId: id,
      fundCode: '510037',
      origin: 'edit',
      html: '<p>x</p>',
      css: '',
    });
    expect(isErr(bad) && bad.error.kind).toBe('validation');
    expect(isErr(bad) && bad.error.message).toContain('値入り HTML');

    // 同じテンプレでも作成タブ経路(`create`)の申請は通る。
    const good = await localReviewRepo.submitReview({
      templateId: id,
      fundCode: '510037',
      origin: 'create',
      html: '<p>{{ x }}</p>',
      css: '',
    });
    expect(isOk(good)).toBe(true);
  });
});
