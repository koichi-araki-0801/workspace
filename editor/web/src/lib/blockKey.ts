// =============================================================================
// blockKey.ts — DOM 要素の版を跨ぐ整列アンカー(compare と editor メモで共有)
// =============================================================================
// 役割: 版比較(`features/compare/htmlBlockDiff.ts`)が 2 版のブロックを対応づけるために
// 使う「構造から決定的に決まる安定キー」を、editor のパーツ単位メモ(会社・ファンド・基準日・版ごとに独立)でも
// 再利用するため切り出した純粋ヘルパ。`data-part-id → element id → 先頭 class → tag 名` の
// 優先順で要素のアンカーを決め、兄弟内の重複は出現順 `#n` で一意化する。HTML 構造のみに
// 依存するため、版種/基準日が変わっても同じ構造の要素なら一致する。

/** element のアンカー: catalog part id → element id → 先頭 class → tag 名 の順で決める。 */
export function rawKey(el: HTMLElement): string {
  return (
    el.getAttribute('data-part-id') ||
    el.id ||
    (el.classList[0] ? `.${el.classList[0]}` : '') ||
    el.tagName.toLowerCase()
  );
}

/** 兄弟 `siblings` の中で `el` が同 `rawKey` の何番目か(1 始まり)を付した一意キー。 */
export function occurrenceKey(el: HTMLElement, siblings: readonly HTMLElement[]): string {
  const base = rawKey(el);
  let n = 0;
  for (const s of siblings) {
    if (rawKey(s) === base) {
      n += 1;
      if (s === el) break;
    }
  }
  return `${base}#${n}`;
}
