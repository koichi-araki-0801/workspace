// =============================================================================
// createPlan.test.ts — 作成可否(版ごとの状態)から、作る版・帯・同意の対象を決める
// =============================================================================
import type { CreatableEditionStatus, CreatableInfo } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { planCreation } from '@/features/templates/viewmodels/createPlan';

const ID_K = 'XX01_950037_交付版';
const ID_Z = 'XX01_950037_全体版';

const info = (...editions: CreatableEditionStatus[]): CreatableInfo => ({
  editions,
  seriesFunds: [],
});
const none = (editionType: string): CreatableEditionStatus => ({ editionType, state: 'none' });
const created = (editionType: string, templateId: string): CreatableEditionStatus => ({
  editionType,
  state: 'created',
  templateId,
});
const pending = (editionType: string): CreatableEditionStatus => ({
  editionType,
  state: 'pendingReview',
});
const working = (editionType: string, templateId: string): CreatableEditionStatus => ({
  editionType,
  state: 'inProgress',
  templateId,
});

describe('planCreation: 版種を選んだとき', () => {
  it('版種を選び、その版が無ければ作る版はその版だけで、帯も同意も要らない', () => {
    const plan = planCreation(info(none('交付版')), '交付版');
    expect(plan.targets).toEqual(['交付版']);
    expect(plan.blocked).toBe(false);
    expect(plan.inProgress).toEqual([]);
    expect(plan.skipNotice).toBeNull();
    expect(plan.blockedNotice).toBeNull();
    expect(plan.consentScope).toBe('交付版');
  });

  it('選んだ版が作成済みなら blocked で、作成済みの版を返す', () => {
    const plan = planCreation(info(created('交付版', ID_K)), '交付版');
    expect(plan.blocked).toBe(true);
    expect(plan.targets).toEqual([]);
    expect(plan.created).toEqual([{ editionType: '交付版', templateId: ID_K }]);
  });

  it('選んだ版が申請中なら blocked', () => {
    const plan = planCreation(info(pending('交付版')), '交付版');
    expect(plan.blocked).toBe(true);
    expect(plan.targets).toEqual([]);
    expect(plan.pendingReview).toEqual(['交付版']);
  });

  it('版種を選び、その版が作業中なら作る版はその版で、作業中に挙げ、同意の対象もその版', () => {
    const plan = planCreation(info(working('交付版', ID_K)), '交付版');
    expect(plan.targets).toEqual(['交付版']);
    expect(plan.blocked).toBe(false);
    expect(plan.inProgress).toEqual([{ editionType: '交付版', templateId: ID_K }]);
    expect(plan.consentScope).toBe('交付版');
    expect(plan.skipNotice).toBeNull();
    expect(plan.blockedNotice).toBeNull();
  });
});

describe('planCreation: 版種を選ばないとき', () => {
  it('版種未選択で両版とも無ければ両版を作り、同意の対象は両方', () => {
    const plan = planCreation(info(none('交付版'), none('全体版')), undefined);
    expect(plan.targets).toEqual(['交付版', '全体版']);
    expect(plan.blocked).toBe(false);
    expect(plan.skipNotice).toBeNull();
    expect(plan.consentScope).toBe('交付版・全体版の両方');
  });

  it('版種未選択で全体版が作成済みなら交付版だけを作り、注記を出す', () => {
    const plan = planCreation(info(none('交付版'), created('全体版', ID_Z)), undefined);
    expect(plan.targets).toEqual(['交付版']);
    expect(plan.blocked).toBe(false);
    expect(plan.skipNotice).toEqual([
      '全体版は作成済みです。交付版だけを作ります。',
      'あとで両版のパーツ同期を行うと、作成済みの全体版との差分が競合として出ることがあります。',
    ]);
    expect(plan.consentScope).toBe('交付版');
  });

  it('版種未選択で交付版が申請中なら全体版だけを作り、注記は「申請中です」', () => {
    const plan = planCreation(info(pending('交付版'), none('全体版')), undefined);
    expect(plan.targets).toEqual(['全体版']);
    expect(plan.skipNotice).toEqual([
      '交付版は申請中です。全体版だけを作ります。',
      'あとで両版のパーツ同期を行うと、申請中の交付版との差分が競合として出ることがあります。',
    ]);
  });

  it('版種未選択で両版とも作れないときは blocked で targets は空、帯の文は状況ごとに変わる', () => {
    const both = planCreation(info(created('交付版', ID_K), created('全体版', ID_Z)), undefined);
    expect(both.blocked).toBe(true);
    expect(both.targets).toEqual([]);
    expect(both.blockedNotice).toBe(
      '交付版・全体版とも作成済みです。直すときは既存のテンプレートを開いてください。',
    );
    expect(both.created).toHaveLength(2);
    expect(both.skipNotice).toBeNull();

    const reviewing = planCreation(info(pending('交付版'), pending('全体版')), undefined);
    expect(reviewing.blocked).toBe(true);
    expect(reviewing.blockedNotice).toBe('交付版・全体版とも承認待ちです。');
    expect(reviewing.created).toEqual([]);

    const mixed = planCreation(info(created('交付版', ID_K), pending('全体版')), undefined);
    expect(mixed.blocked).toBe(true);
    expect(mixed.blockedNotice).toBe('交付版は作成済みです。全体版は承認待ちです。');
    expect(mixed.created).toEqual([{ editionType: '交付版', templateId: ID_K }]);
  });

  it('作業中は作る版に含まれるものだけを返す', () => {
    const plan = planCreation(info(created('交付版', ID_K), working('全体版', ID_Z)), undefined);
    expect(plan.targets).toEqual(['全体版']);
    expect(plan.inProgress).toEqual([{ editionType: '全体版', templateId: ID_Z }]);
    expect(plan.consentScope).toBe('全体版');
  });
});
