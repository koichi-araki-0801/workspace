// =============================================================================
// comboboxFilter.ts — Combobox の絞り込み(コードの前方一致 + 表示名の部分一致)
// =============================================================================

type Option = { label: string; value: string };

/** 値(コード)の前方一致、または表示名の部分一致で絞る。大文字小文字は区別しない。空入力は全件。 */
export function filterComboboxOptions(options: Option[], query: string): Option[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) => o.value.toLowerCase().startsWith(q) || o.label.toLowerCase().includes(q),
  );
}
