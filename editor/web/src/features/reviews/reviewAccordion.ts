// =============================================================================
// reviewAccordion.ts — 承認タブのアコーディオンで同時に開ける申請数の管理(純関数)
// =============================================================================
// 役割: 1 申請を開くと見た目比較の組版 iframe を 2 面持つ。申請数に比例して開かせると
// 承認者のブラウザが固まるので、同時展開を 2 件に絞り、3 件目を開いたら最も古く開いた
// ものを閉じる。順序は「開いた順」で持つ(配列の先頭が最古)。

export const MAX_EXPANDED = 2;

export function toggleExpanded(expanded: readonly string[], id: string): string[] {
  if (expanded.includes(id)) return expanded.filter((x) => x !== id);
  const next = [...expanded, id];
  return next.length > MAX_EXPANDED ? next.slice(next.length - MAX_EXPANDED) : next;
}
