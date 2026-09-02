// =============================================================================
// blockKey.ts — DOM 要素の版を跨ぐ整列アンカー(compare と editor メモで共有)
// =============================================================================
// 役割: 版比較(`features/compare/htmlBlockDiff.ts`)が 2 版のブロックを対応づけるために
// 使う「構造から決定的に決まる安定キー」を、editor のパーツ単位メモ(交付版⇄全体版のペアで
// スレッドを共有)でも再利用するため切り出した純粋ヘルパ。`data-part-id → element id → 先頭 class → tag 名` の
// 優先順で要素のアンカーを決め、兄弟内の重複は出現順 `#n` で一意化する。HTML 構造のみに
// 依存するため、版種/基準日が変わっても同じ構造の要素なら一致する。

/**
 * 要素を持たずにアンカーを決める版。編集キャンバスの赤入れ（`features/editor/redline/`）は
 * GrapesJS のモデル木と定義木を整列させるため、DOM 要素ではなく属性の断片からキーを作る
 * 必要がある。規則は `rawKey` と 1 か所で共有する（片方だけ変わると版を跨ぐ対応づけが崩れる）。
 */
export function rawKeyFromParts(p: {
  partId?: string | null;
  id?: string | null;
  firstClass?: string | null;
  tag: string;
}): string {
  return p.partId || p.id || (p.firstClass ? `.${p.firstClass}` : '') || p.tag.toLowerCase();
}

/** element のアンカー: catalog part id → element id → 先頭 class → tag 名 の順で決める。 */
export function rawKey(el: HTMLElement): string {
  return rawKeyFromParts({
    partId: el.getAttribute('data-part-id'),
    id: el.id,
    firstClass: el.classList[0] ?? null,
    tag: el.tagName,
  });
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
