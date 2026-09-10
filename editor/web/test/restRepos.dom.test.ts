// =============================================================================
// restRepos.dom.test.ts — rest リポジトリ 7 種が契約どおりの HTTP 要求を組み立てること
// =============================================================================
// rest 実装は `apiFetch` への薄い委譲なので、壊れ方は「パスのパラメータ名違い」「メソッド違い」
// 「ボディの形違い」の 3 つに集約される。ここでは `fetch` を記録スタブに差し替え、要求の
// 3 要素と `Result` 化(throw → err)を主張する。サーバ側の挙動は server の inject テストが持つ。
import { isErr, isOk } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restAuthRepo } from '@/api/rest/authRepo';
import { restHistoryRepo } from '@/api/rest/historyRepo';
import { restNoteRepo } from '@/api/rest/noteRepo';
import { restPartRepo } from '@/api/rest/partRepo';
import { restReviewRepo } from '@/api/rest/reviewRepo';
import { restTemplateRepo } from '@/api/rest/templateRepo';
import { restUserRepo } from '@/api/rest/userRepo';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  contentType: string | undefined;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** 直近の要求を記録し、`response` を返す `fetch` スタブを立てる。 */
function stubFetch(response: () => Response = () => json({})): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: url.replace(window.location.origin, ''),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        contentType: headers['Content-Type'],
      });
      return response();
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('restAuthRepo', () => {
  it('login は POST /api/auth/login に資格情報をそのまま送る', async () => {
    const calls = stubFetch(() => json({ user: { username: 'u' } }));
    const r = await restAuthRepo.login({ username: 'u', password: 'p' });
    expect(calls[0]).toMatchObject({
      url: '/api/auth/login',
      method: 'POST',
      body: { username: 'u', password: 'p' },
      contentType: 'application/json',
    });
    expect(isOk(r) && r.value.user.username).toBe('u');
  });
  it('logout は POST(ボディ無し = Content-Type も付けない)、me は GET、initPassword は POST', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    expect(isOk(await restAuthRepo.logout())).toBe(true);
    expect(calls[0]).toMatchObject({ url: '/api/auth/logout', method: 'POST', body: undefined });
    expect(calls[0].contentType).toBeUndefined();
    await restAuthRepo.me();
    expect(calls[1]).toMatchObject({ url: '/api/auth/me', method: 'GET' });
    await restAuthRepo.initPassword({ username: 'u', currentPassword: 'a', newPassword: 'b' });
    expect(calls[2]).toMatchObject({ url: '/api/auth/init-password', method: 'POST' });
  });
});

describe('restTemplateRepo', () => {
  it('一覧・候補は未指定のクエリを付けず、指定分だけを query string にする', async () => {
    const calls = stubFetch(() => json([]));
    await restTemplateRepo.listTemplates({
      companyCode: 'AM01',
      fundCode: undefined,
      baseDate: '',
    });
    expect(calls[0].url).toBe('/api/templates?companyCode=AM01');
    await restTemplateRepo.getDropdownOptions({});
    expect(calls[1].url).toBe('/api/templates/options');
  });
  it(':id は encodeURIComponent される(日本語 id)', async () => {
    const calls = stubFetch(() => json({ meta: {}, html: '', css: '', filled: '' }));
    await restTemplateRepo.getTemplate('AM01_510037_20240710_交付版');
    expect(calls[0].url).toBe(
      `/api/templates/${encodeURIComponent('AM01_510037_20240710_交付版')}`,
    );
  });
  it('resolveFund は series 応答に自分以外のファンドがあるときだけ isSeriesFund=true', async () => {
    stubFetch(() =>
      json([{ attributes: { fundCode: '510037' } }, { attributes: { fundCode: '510038' } }]),
    );
    const r = await restTemplateRepo.resolveFund('AM01', '510037', '交付版');
    expect(isOk(r) && r.value.isSeriesFund).toBe(true);
    stubFetch(() => json([{ attributes: { fundCode: '510037' } }]));
    const only = await restTemplateRepo.resolveFund('AM01', '510037', '交付版');
    expect(isOk(only) && only.value.isSeriesFund).toBe(false);
  });
  it('listSeriesFunds は 3 引数をクエリに載せる', async () => {
    const calls = stubFetch(() => json([]));
    await restTemplateRepo.listSeriesFunds('AM01', '510037', '交付版');
    expect(calls[0].url).toBe(
      `/api/templates/series?companyCode=AM01&fundCode=510037&editionType=${encodeURIComponent('交付版')}`,
    );
  });
  it('saveDraft は PUT /templates/:id/draft にボディごと送り、204 を ok(undefined) に写す', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const req = { templateId: 'AM01_510037_20240710_交付版', html: '<p>x</p>', css: '.a{}' };
    const r = await restTemplateRepo.saveDraft(req);
    expect(isOk(r) && r.value).toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: `/api/templates/${encodeURIComponent(req.templateId)}/draft`,
      method: 'PUT',
      body: req,
    });
  });
  it('getDraft は GET、discardDraft は DELETE、getSampleData / getSyncStatus / generate はそれぞれの経路', async () => {
    const calls = stubFetch(() => json(null));
    await restTemplateRepo.getDraft('t1');
    await restTemplateRepo.discardDraft('t1');
    await restTemplateRepo.getSampleData('510037');
    await restTemplateRepo.getSyncStatus('t1');
    await restTemplateRepo.generate({
      companyCode: 'AM01',
      fundCode: '510037',
      editionType: '交付版',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/templates/t1/draft',
      'DELETE /api/templates/t1/draft',
      'GET /api/funds/510037/sample-data',
      'GET /api/templates/t1/sync-status',
      'POST /api/generate',
    ]);
  });
});

describe('restPartRepo / restHistoryRepo / restNoteRepo / restReviewRepo / restUserRepo', () => {
  it('parts: 分類候補と一覧はクエリ、履歴は GET/POST', async () => {
    const calls = stubFetch(() => json([]));
    await restPartRepo.getPartClassificationOptions({ category: '表紙' });
    await restPartRepo.listParts({});
    await restPartRepo.listPartHistory('t1');
    await restPartRepo.recordPartChange('t1', 'note-a#1', '文言修正');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/parts/classification-options?category=${encodeURIComponent('表紙')}`,
      'GET /api/parts',
      'GET /api/templates/t1/part-history',
      'POST /api/templates/t1/part-history',
    ]);
    expect(calls[3].body).toEqual({ partKey: 'note-a#1', change: '文言修正' });
  });
  it('history: 3 フィード GET、PDF 記録 POST、版一覧、スナップショット(templateId は省略可)', async () => {
    const calls = stubFetch(() => json([]));
    await restHistoryRepo.getEditHistory();
    await restHistoryRepo.getPdfHistory();
    await restHistoryRepo.getCreateHistory();
    await restHistoryRepo.recordPdfExport('t1');
    await restHistoryRepo.listVersions('t1');
    await restHistoryRepo.getSnapshot('h1');
    await restHistoryRepo.getSnapshot('h1', 't1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/history/edit',
      'GET /api/history/pdf',
      'GET /api/history/create',
      'POST /api/history/pdf',
      'GET /api/templates/t1/versions',
      'GET /api/snapshots/h1',
      'GET /api/snapshots/h1?templateId=t1',
    ]);
    expect(calls[3].body).toEqual({ templateId: 't1' });
  });
  it('notes: 追加は replyTo の既定(null)を補い、編集は PATCH、削除は DELETE', async () => {
    const calls = stubFetch(() => json({}));
    await restNoteRepo.listNotes('t1');
    await restNoteRepo.addNote('t1', 'p#1', '本文');
    await restNoteRepo.addNote('t1', 'p#1', '返信', { replyTo: 'n1' });
    await restNoteRepo.updateNote('t1', 'n1', { status: 'resolved' });
    await restNoteRepo.deleteNote('t1', 'n1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/templates/t1/notes',
      'POST /api/templates/t1/notes',
      'POST /api/templates/t1/notes',
      'PATCH /api/templates/t1/notes/n1',
      'DELETE /api/templates/t1/notes/n1',
    ]);
    expect(calls[1].body).toEqual({ pathKey: 'p#1', content: '本文', replyTo: null });
    expect(calls[2].body).toEqual({ pathKey: 'p#1', content: '返信', replyTo: 'n1' });
  });
  it('reviews: 申請 POST、一覧は status フィルタのみクエリ、取得 GET、承認/却下 POST', async () => {
    const calls = stubFetch(() => json({}));
    await restReviewRepo.submitReview({
      templateId: 't1',
      html: '',
      css: '',
      fundCode: 'f',
      origin: 'edit',
    });
    await restReviewRepo.listReviews();
    await restReviewRepo.listReviews({ status: 'pending' });
    await restReviewRepo.getReview('r1');
    await restReviewRepo.approveReview('r1', { comment: 'ok' });
    await restReviewRepo.rejectReview('r1', { comment: 'ng' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/review-requests',
      'GET /api/review-requests',
      'GET /api/review-requests?status=pending',
      'GET /api/review-requests/r1',
      'POST /api/review-requests/r1/approve',
      'POST /api/review-requests/r1/reject',
    ]);
    expect(calls[4].body).toEqual({ comment: 'ok' });
    expect(calls[5].body).toEqual({ comment: 'ng' });
  });
  it('users: 一覧 GET、作成 POST(201 ボディをそのまま返す)、更新 PATCH、リセット POST', async () => {
    const calls = stubFetch(() => json({ user: { id: 'u1' }, temporaryPassword: 'x' }, 201));
    const created = await restUserRepo.createUser({
      username: 'u',
      displayName: 'U',
      role: 'editor',
      disabled: false,
      mustChangePassword: true,
    });
    expect(isOk(created) && created.value.temporaryPassword).toBe('x');
    await restUserRepo.listUsers();
    await restUserRepo.updateUser('u1', { displayName: 'V' });
    await restUserRepo.resetUserPassword('u1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/users',
      'GET /api/users',
      'PATCH /api/users/u1',
      'POST /api/users/u1/reset-password',
    ]);
    expect(calls[2].body).toEqual({ displayName: 'V' });
  });
  it('HTTP 失敗は throw せず err(AppError) に写る(呼び出し側は Result だけを見る)', async () => {
    stubFetch(() => json({ kind: 'not_found', message: '無い' }, 404));
    const r = await restReviewRepo.getReview('nope');
    expect(isErr(r) && r.error.kind).toBe('not_found');
    expect(isErr(r) && r.error.message).toBe('無い');
  });
});
