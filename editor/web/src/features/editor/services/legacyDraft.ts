// =============================================================================
// legacyDraft.ts — 読み込めない旧形式の下書きを見分ける
// =============================================================================
// 作成タブの往復の印は HTML コメントの範囲の印で持ち、要素の属性で持つ旧形式は読まない。
// 旧形式の if は採用した枝しか持たず、退避した原文も壊れている場合があるので、新形式へ変換しても
// 結果を信用できない。読めない下書きは黙って使わず、破棄して利用者へ知らせる。
import { findEditingMarkers, MARKER_ATTRS } from '@editor/shared';

/** 旧形式の属性名。`jinjaMask.ts` の `LEGACY_ATTR_SELECTOR` と同じ集合(テストが突き合わせる)。 */
export const LEGACY_DRAFT_ATTRS: readonly string[] = [
  MARKER_ATTRS.jinjaOpen,
  MARKER_ATTRS.jinjaClose,
  MARKER_ATTRS.jinjaBlock,
  MARKER_ATTRS.jinjaLoopClone,
];

export const LEGACY_DRAFT_MESSAGE =
  '旧い形式の下書きは読み込めないため破棄し、確定版から開き直しました。編集をやり直してください。';

/**
 * `edition` は下書きの元になった本文の種類。編集タブ(`filled`)の本文は本番と同じく印を持たないので、
 * 印が 1 個でもあれば旧い fixture から作った下書きである。作成タブ(`template`)は新形式の印を正当に持つ。
 */
export function isLegacyDraft(draftHtml: string, edition: 'filled' | 'template'): boolean {
  const hits = findEditingMarkers(draftHtml);
  if (edition === 'filled') return hits.length > 0;
  return hits.some((h) => LEGACY_DRAFT_ATTRS.some((a) => h.marker === `attr:${a}`));
}
