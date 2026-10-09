// =============================================================================
// options.ts — Select / Combobox が受ける選択肢の型と正規化
// =============================================================================

/** 選択肢。文字列は表示名と値が同じ。 */
export type UiOption = string | { label: string; value: string };

/** 文字列の選択肢を `{ label, value }` へ揃える。 */
export function normalizeOptions(options: readonly UiOption[]): { label: string; value: string }[] {
  return options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o));
}
