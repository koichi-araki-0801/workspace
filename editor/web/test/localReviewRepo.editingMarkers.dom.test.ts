// =============================================================================
// localReviewRepo.editingMarkers.dom.test.ts — local の申請・承認で往復用の印を拒否する
// =============================================================================
// server の関所(`editingMarkerGate.ts`)の local 版。申請の入口(`submitReview`)と承認の唯一の
// 書き込み点(`putContentOverrides`)の両方で止まることを確かめる。
import { isErr, isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localReviewRepo } from '@/api/local/reviewRepo';
import { K } from '@/api/local/store';

const CHIP = '<p><span data-jinja="e3sgYSB9fQ==">1</span></p>';
const EDIT_ID = 'AM01_510037_20240710_交付版';

beforeEach(() => localStorage.clear());

describe('local の申請・承認の編集用の印', () => {
  it.each([
    ['create', 'AM01_510037_交付版'],
    ['edit', EDIT_ID],
  ] as const)('%s 経路で印が残っていれば validation で拒否する', async (origin, templateId) => {
    const res = await localReviewRepo.submitReview({ templateId, html: CHIP, css: '', origin });
    expect(isErr(res) && res.error.kind).toBe('validation');
    expect(isErr(res) && res.error.message).toContain('編集用の印');
  });

  it('プレビュー文書(filledHtml)に印があっても拒否する', async () => {
    const res = await localReviewRepo.submitReview({
      templateId: EDIT_ID,
      html: '<p>値</p>',
      filledHtml: CHIP,
      css: '',
      origin: 'edit',
    });
    expect(isErr(res) && res.error.kind).toBe('validation');
  });

  it('編集経路の印の無い申請は通る(fixture の値入り HTML は印なし)', async () => {
    const res = await localReviewRepo.submitReview({
      templateId: EDIT_ID,
      html: '<p>値</p>',
      css: '',
      origin: 'edit',
    });
    expect(isErr(res)).toBe(false);
  });

  it.each([
    ['create', 'AM01_510037_交付版'],
    ['edit', EDIT_ID],
  ] as const)('関所の前に積まれた印入りの申請(%s)は、承認の書き込み点で止まる', async (origin, templateId) => {
    const login = await localAuthRepo.login({ username: 'admin', password: 'admin' });
    expect(isOk(login)).toBe(true);
    const sub = await localReviewRepo.submitReview({
      templateId,
      html: '<p>値</p>',
      css: '',
      origin,
    });
    expect(isOk(sub)).toBe(true);
    if (!isOk(sub)) return;
    // 入口の関所が入る前に積まれた申請を模し、保存済みの本文だけを印入りへ差し替える。
    const stored = JSON.parse(localStorage.getItem(K.reviews) ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    stored[sub.value.id] = { ...stored[sub.value.id], html: CHIP };
    localStorage.setItem(K.reviews, JSON.stringify(stored));
    const before = {
      html: localStorage.getItem(K.htmlOverride),
      filled: localStorage.getItem(K.filledOverride),
      css: localStorage.getItem(K.cssOverride),
    };

    const res = await localReviewRepo.approveReview(sub.value.id, {});
    expect(isErr(res) && res.error.kind).toBe('validation');
    expect(localStorage.getItem(K.htmlOverride)).toBe(before.html);
    expect(localStorage.getItem(K.filledOverride)).toBe(before.filled);
    expect(localStorage.getItem(K.cssOverride)).toBe(before.css);
    // 申請も処理済みにならない(反映と同じ tx で巻き戻る)。
    const got = await localReviewRepo.getReview(sub.value.id);
    expect(isOk(got) && got.value.status).toBe('pending');
  });
});
