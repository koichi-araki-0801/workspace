// =============================================================================
// searchGuard.ts — 検索ボタンを押させてよいかの判定(`SearchFilters` の活性制御)
// =============================================================================
// 条件を 1 つも選ばずに検索させると、結果も案内も出ないまま押した側だけが「効かない」と
// 受け取る(空状態の文言は「条件を選んで検索してください」のままで変化しない)。押せる／
// 押せないを見た目で示すため、判定をコンポーネントから切り出して単体で固定する。

/** 空白のみの入力は未入力として扱う(見た目が空と区別できないため)。 */
function filled(value: string | undefined): boolean {
  return !!value && value.trim() !== '';
}

/**
 * 検索を実行してよいか。
 *
 * 必須フィールドの指定があるときはそれが全て埋まっていること、無いときは対象
 * フィールドのどれか 1 つでも埋まっていることを条件にする。
 */
export function canSubmitSearch<F extends string>(
  query: Partial<Record<F, string>>,
  fields: readonly F[],
  requiredFields: readonly F[],
): boolean {
  if (requiredFields.length > 0) return requiredFields.every((f) => filled(query[f]));
  return fields.some((f) => filled(query[f]));
}
