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

describe('localReviewRepo の現行の 3 状態の外にある申請', () => {
  it('held で残る申請は読み飛ばし、他の申請は一覧に出す', async () => {
    await loginAdmin();
    const listed = await localTemplateRepo.listTemplates({});
    const [t1, t2] = isOk(listed) ? listed.value : [];
    expect(t2).toBeDefined();
    if (!t1 || !t2) return;
    const submit = (t: typeof t1) =>
      localReviewRepo.submitReview({
        templateId: t.id,
        fundCode: t.attributes.fundCode,
        origin: 'edit',
        html: `<div>${t.id}</div>`,
        css: '',
      });
    const a = await submit(t1);
    const b = await submit(t2);
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;

    const all = JSON.parse(localStorage.getItem(K.reviews) ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    all[a.value.id] = { ...all[a.value.id], status: 'held', heldBy: 'x' };
    localStorage.setItem(K.reviews, JSON.stringify(all));

    const list = await localReviewRepo.listReviews({});
    expect(isOk(list)).toBe(true);
    const ids = isOk(list) ? list.value.map((m) => m.id) : [];
    expect(ids).toContain(b.value.id);
    expect(ids).not.toContain(a.value.id);
    const got = await localReviewRepo.getReview(a.value.id);
    expect(isErr(got) && got.error.kind).toBe('not_found');
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

describe('localReviewRepo の値入り HTML 要求(承認時)', () => {
  it("origin='edit' の申請は承認時にも値入り HTML を要求し、失われていれば反映しない", async () => {
    await loginAdmin();
    const target = await firstTemplate();
    expect(target).not.toBeNull();
    if (!target) return;
    const sub = await localReviewRepo.submitReview({
      templateId: target.id,
      fundCode: target.attributes.fundCode,
      origin: 'edit',
      html: '<p>申請本文</p>',
      css: '',
    });
    expect(isOk(sub)).toBe(true);
    if (!isOk(sub)) return;

    // 申請後に作成タブの承認が割り込むと、その id は Jinja 骨組みだけになり静的 filled は
    // 捨てられる(値入り HTML 無し)。承認側で止まらないと、ここへ編集本文が書き戻る。
    localStorage.setItem(K.htmlOverride, JSON.stringify({ [target.id]: '<p>{{ x }}</p>' }));
    const before = await localTemplateRepo.getTemplate(target.id);
    expect(isOk(before)).toBe(true);
    if (!isOk(before)) return;

    const approved = await localReviewRepo.approveReview(sub.value.id, {});
    expect(isErr(approved) && approved.error.kind).toBe('validation');

    const after = await localTemplateRepo.getTemplate(target.id);
    expect(isOk(after) && after.value.html).toBe(before.value.html);
    expect(isOk(after) && after.value.filled).toBe(before.value.filled);
    // 申請は未決着のまま残る(承認済みにしない)。
    const stored = await localReviewRepo.getReview(sub.value.id);
    expect(isOk(stored) && stored.value.status).toBe('pending');
  });
});

describe('localReviewRepo の空本文の申請', () => {
  it("origin='edit' の申請は本文が空なら validation(承認がテンプレを draft へ落とすため)", async () => {
    await loginAdmin();
    const target = await firstTemplate();
    expect(target).not.toBeNull();
    if (!target) return;
    const empty = await localReviewRepo.submitReview({
      templateId: target.id,
      fundCode: target.attributes.fundCode,
      origin: 'edit',
      html: '',
      css: '',
    });
    expect(isErr(empty) && empty.error.kind).toBe('validation');
    expect(isErr(empty) && empty.error.message).toContain('本文が空');
  });
});
