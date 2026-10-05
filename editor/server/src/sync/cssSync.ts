// =============================================================================
// cssSync.ts — ペア同期の CSS 転写(純関数)。転写の結果と競合の持ち越しを決める
// =============================================================================
// 規則の分割と転写は `@editor/shared` の `splitCssRules` / `mergeCssRuleChangesFromBaseline` が
// 正典で、ここは「承認 1 回ぶんの転写結果」と「同期状態ファイルへ残す競合」を組み立てるだけを持つ。
// I/O は `pairSyncService.ts`。

import {
  isValidAnyTemplateId,
  mergeCssRuleChangesFromBaseline,
  parseAnyTemplateFileName,
  sameCssRule,
  splitCssRules,
  templatePairKey,
} from '@editor/shared';

/**
 * CSS の競合の記録先のペアキー。CSS はテンプレ単位で基準日をまたいで共有するので、値入り HTML の
 * 承認でもテンプレのペアキー(`会社_ファンド`)の状態ファイルに記録する。基準日ごとに分けると、
 * 同じ CSS の競合がある基準日の画面にしか出ず、他の基準日の承認では持ち越しも解消もされない。
 */
export function cssSyncPairKey(templateId: string): string | null {
  if (!isValidAnyTemplateId(templateId)) return null;
  const a = parseAnyTemplateFileName(`${templateId}.html`);
  if (!a) return null;
  return templatePairKey({
    companyCode: a.companyCode,
    fundCode: a.fundCode,
    editionType: a.editionType,
  });
}

/** CSS 規則 1 つの未解決の競合(ペア側が版種固有に直してあり、転写を止めた規則)。 */
export interface CssRuleConflict {
  ruleKey: string;
  detectedAt: string;
}

export interface CssSyncInput {
  /** 承認の直前の source の CSS(ファイルの原文)。ペア側の規則が手つかずかの照合に使う。 */
  base: string;
  /**
   * 確定版の CSS を編集画面が読み込んだ直後の形(`next` と同じ書き出し)。変わった規則は
   * これと `next` の差で見る — 原文と `next` を直に比べると、GrapesJS の書き直し(一括指定の
   * 展開・色の正規化・url の引用符)まで変更に見える。
   */
  baseline: string;
  /** 承認の直後の source の CSS。 */
  next: string;
  /** ペア側の今の CSS。 */
  target: string;
  /** 状態ファイルに残っていた未解決の競合。 */
  prev: readonly CssRuleConflict[];
  now: string;
}

export interface CssSyncResult {
  /** 承認で CSS が変わったか(`baseline !== next`)。 */
  ran: boolean;
  /** ペアへ書く CSS。書く必要が無ければ null。 */
  css: string | null;
  /** 写した規則のキー。 */
  applied: string[];
  /** この承認で競合として飛ばした規則のキー。 */
  skipped: string[];
  /** 状態ファイルへ残す未解決の競合(過去分の持ち越し込み)。 */
  conflicts: CssRuleConflict[];
  conflictsChanged: boolean;
}

function ruleTexts(css: string): Map<string, string> {
  return new Map(splitCssRules(css).map((r) => [r.key, r.text]));
}

/** 書式の違い(`sameCssRule` の正規化)を除いて同じ規則か。両方に無ければ同じ、片方だけに無ければ違う。 */
function sameRuleAt(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined ? a === b : sameCssRule(a, b);
}

export function computeCssSync(input: CssSyncInput): CssSyncResult {
  const ran = input.baseline !== input.next;
  const merge = ran
    ? mergeCssRuleChangesFromBaseline(input.base, input.baseline, input.next, input.target)
    : null;
  const css = merge !== null && merge.css !== input.target ? merge.css : null;

  // 競合が解けたか(両版の規則が一致したか、両方から消えたか)は転写後の姿で判定する。
  // 解消の操作(専用 API)は持たず、本文の競合と同じく「次の承認で一致していれば消える」。
  const source = ruleTexts(input.next);
  const after = ruleTexts(css ?? input.target);
  const unresolved = (key: string): boolean => !sameRuleAt(source.get(key), after.get(key));

  const kept = input.prev.filter((c) => unresolved(c.ruleKey));
  const fresh = (merge?.conflicts ?? [])
    .filter((key) => unresolved(key) && !kept.some((c) => c.ruleKey === key))
    .map((ruleKey) => ({ ruleKey, detectedAt: input.now }));
  const conflicts = [...kept, ...fresh];

  return {
    ran,
    css,
    applied: merge?.applied ?? [],
    skipped: merge?.conflicts ?? [],
    conflicts,
    conflictsChanged: JSON.stringify(conflicts) !== JSON.stringify(input.prev),
  };
}
