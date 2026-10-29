// =============================================================================
// createPlan.ts — 作成可否(版ごとの状態)から、作る版・帯・同意の対象を決める(純関数)
// =============================================================================
// 作成タブ Step 2 の表示とボタンの可否は、版種の選択と版ごとの状態(作成済み・申請中・作業中)の
// 組み合わせで決まる。画面に分岐を散らさないよう、ここで 1 つの計画にまとめる。文言は
// 承認済みの画面イメージに揃える(テストもこの文言で固定する)。
import { CREATABLE_EDITIONS, type CreatableInfo } from '@editor/shared';

export interface CreationPlan {
  /** 作る版。版種を選べばその版(作れないときは空)、無ければ作成済み・申請中でない版。 */
  targets: string[];
  /** 作成方法のカードを押せないか(選んだ版が作成済みか申請中、または未選択で両版とも)。 */
  blocked: boolean;
  /** 作成済みの版(「既存の…を開く」用)。 */
  created: { editionType: string; templateId: string }[];
  /** 申請中の版。 */
  pendingReview: string[];
  /** 作る版のうち作業中のもの(「作成中の…を開く」と同意の要否)。 */
  inProgress: { editionType: string; templateId: string }[];
  /** 版種未選択で片方だけ作るときの注記(2 行)。無ければ null。 */
  skipNotice: [string, string] | null;
  /** 版種未選択で両版とも作れないときの帯の文。無ければ null。 */
  blockedNotice: string | null;
  /** 同意文の対象。'交付版' | '全体版' | '交付版・全体版の両方'。 */
  consentScope: string;
}

const BOTH = CREATABLE_EDITIONS.join('・');

/** `editionType` が無ければ版種未選択(両版が対象)。 */
export function planCreation(info: CreatableInfo, editionType: string | undefined): CreationPlan {
  const editions = editionType
    ? info.editions.filter((e) => e.editionType === editionType)
    : info.editions;
  const created = editions.flatMap((e) =>
    e.state === 'created' && e.templateId
      ? [{ editionType: e.editionType, templateId: e.templateId }]
      : [],
  );
  const pendingReview = editions
    .filter((e) => e.state === 'pendingReview')
    .map((e) => e.editionType);
  const targets = editions
    .filter((e) => e.state === 'none' || e.state === 'inProgress')
    .map((e) => e.editionType);
  const inProgress = editions.flatMap((e) =>
    e.state === 'inProgress' && e.templateId
      ? [{ editionType: e.editionType, templateId: e.templateId }]
      : [],
  );
  const blocked = targets.length === 0;
  const consentScope = targets.length > 1 ? `${BOTH}の両方` : (targets[0] ?? '');

  let skipNotice: CreationPlan['skipNotice'] = null;
  let blockedNotice: string | null = null;
  if (!editionType) {
    const skipped = editions.filter((e) => e.state === 'created' || e.state === 'pendingReview');
    if (!blocked && skipped.length > 0) {
      const s = skipped[0];
      const what = s.state === 'created' ? '作成済み' : '申請中';
      skipNotice = [
        `${s.editionType}は${what}です。${targets[0]}だけを作ります。`,
        `あとで両版のパーツ同期を行うと、${what}の${s.editionType}との差分が競合として出ることがあります。`,
      ];
    }
    if (blocked && editions.length > 0) blockedNotice = blockedText(created.length, pendingReview);
  }
  return {
    targets,
    blocked,
    created,
    pendingReview,
    inProgress,
    skipNotice,
    blockedNotice,
    consentScope,
  };
}

/** 版種未選択で両版とも作れないときの帯の文。 */
function blockedText(createdCount: number, pendingReview: string[]): string {
  if (pendingReview.length === 0) {
    return `${BOTH}とも作成済みです。直すときは既存のテンプレートを開いてください。`;
  }
  if (createdCount === 0) return `${BOTH}とも承認待ちです。`;
  const createdEdition = CREATABLE_EDITIONS.find((e) => !pendingReview.includes(e));
  return `${createdEdition}は作成済みです。${pendingReview.join('・')}は承認待ちです。`;
}
