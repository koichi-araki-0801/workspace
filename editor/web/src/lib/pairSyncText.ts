// =============================================================================
// pairSyncText.ts — ペア同期の競合バナーと承認直後の通知の文言
// =============================================================================
// 本文(パーツ)と書式(CSS 規則)の競合は同じ同期状態ファイルに記録され、同じ画面に出す。
// 文言の組み立てを画面から切り出し、パーツだけのときの文言を変えないことをテストで固定する。
import { EDITION_SYNC_PAIRS, type PairSyncStatus, type PairSyncSummary } from '@editor/shared';

const MAX_LABEL = 40;

const UNMATCHABLE_NOTE =
  '照合不可の書式は、ペアの CSS が編集画面を通っていない書き方のため写せませんでした。' +
  'ペアも編集画面で開いて申請・承認すると、次から照合できます。';

type PartConflict = PairSyncStatus['conflicts'][number];

/** パーツの競合 1 件の項目。削除系は、消した側の版種で書く(相手の版種は版種の入れ替え)。 */
function partConflictLabel(c: PartConflict): string {
  const { deletedIn } = c;
  if (!deletedIn) return `${c.partKey}〔${c.kind}〕`;
  if (c.kind === 'ペア側削除') return `${c.partKey}〔${deletedIn}で削除〕`;
  if (c.kind === 'ペア側削除・ソース変更') {
    const other = EDITION_SYNC_PAIRS[deletedIn];
    return other
      ? `${c.partKey}〔${deletedIn}で削除・${other}で変更〕`
      : `${c.partKey}〔${c.kind}〕`;
  }
  return `${c.partKey}〔${c.kind}〕`;
}

/**
 * CSS 規則のキー(`splitCssRules` の JSON 配列: 入れ子の前置き・識別子・2 番目以降の出現番号)を
 * 画面向けに整える。キーの形は shared が正典なので、読めない形は手を加えずに出す。
 */
export function cssRuleLabel(key: string): string {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return key;
  }
  if (!Array.isArray(parts) || parts.length === 0) return key;
  const last = parts.at(-1);
  const nth = typeof last === 'number' ? last : null;
  const names = (nth === null ? parts : parts.slice(0, -1)).filter(
    (p): p is string => typeof p === 'string',
  );
  const text = names.join(' ');
  const short = text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text;
  return nth === null ? short : `${short}（${nth} 番目）`;
}

/** 編集画面のバナー。競合が無ければ null。 */
export function pairSyncConflictText(s: PairSyncStatus | null): string | null {
  if (!s) return null;
  const n = s.conflicts.length;
  const m = s.cssConflicts.length;
  if (n === 0 && m === 0) return null;
  const what =
    m === 0
      ? `${n} 件のパーツ`
      : n === 0
        ? `書式の規則 ${m} 件`
        : `${n} 件のパーツと書式の規則 ${m} 件`;
  const items = [
    ...s.conflicts.map(partConflictLabel),
    ...s.cssConflicts.map(
      (c) => `書式 ${cssRuleLabel(c.ruleKey)}${c.kind === '照合不可' ? '〔照合不可〕' : ''}`,
    ),
  ];
  const note = s.cssConflicts.some((c) => c.kind === '照合不可') ? UNMATCHABLE_NOTE : '';
  return `ペア（${s.pairTemplateId}）と ${what}が競合しています（自動同期停止中）: ${items.join('、')}${note ? `。${note}` : ''}`;
}

/** 承認直後の通知。何も起きなければ null。 */
export function pairSyncResultText(
  sync: PairSyncSummary | null | undefined,
): { text: string; variant: 'error' | 'default' } | null {
  if (!sync) return null;
  if (sync.error) {
    return {
      text: `ペア(${sync.pairTemplateId})への自動同期に失敗しました: ${sync.error}`,
      variant: 'error',
    };
  }
  const cssApplied = sync.css?.applied.length ?? 0;
  const skipped = sync.skipped.length + (sync.css?.conflicts.length ?? 0);
  if (sync.applied.length === 0 && cssApplied === 0 && skipped === 0) return null;
  const cssNote = cssApplied > 0 ? `・書式 ${cssApplied} 規則` : '';
  const skippedNote = skipped > 0 ? `・スキップ ${skipped} 件(要確認)` : '';
  return {
    text: `ペア ${sync.pairTemplateId} へ ${sync.applied.length} パーツ${cssNote}を自動同期しました${skippedNote}`,
    variant: 'default',
  };
}
