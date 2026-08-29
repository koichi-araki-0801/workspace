// =============================================================================
// partNames.ts — 差分行キー → パーツカタログ業務名の突合(精査画面のラベル)
// =============================================================================
// 差分行のキーは `blockKey.ts` の `occurrenceKey`(= `<rawKey>#n`)で、rawKey は
// `data-part-id` を最優先に採る。よって `data-part-id` 付きパーツのキーはカタログの
// パーツ id と一致し、`listParts` の `name`(名称・利用者向け)へ突合できる。承認者は
// 「ページN・パーツM」という機械採番よりパーツの業務名で変更箇所を認知するため、
// 突合できた行だけ業務名で表示する(できない行は現行表記へフォールバック)。
import { isErr, type PartRepository } from '@editor/shared';

/**
 * 差分行キーからカタログ突合用のパーツ id を取り出す。`rawKey` が element id・クラス・
 * タグ名由来のキー(`.class` / 小文字タグ名)はカタログ id ではないので null を返す。
 * カタログ id は `data-part-id` の値で、HTML タグ名と衝突しない語彙(ハイフン区切り等)を
 * 前提にできないため、「`.` 始まりと既知タグ名だけ除外」ではなく **name 表に居るか**を
 * `businessLabel` 側の突合で最終判定する(ここでは明らかな非 id だけ落とす)。
 */
export function partIdFromBlockKey(key: string): string | null {
  const base = key.replace(/#\d+$/, '');
  if (!base || base.startsWith('.')) return null;
  // 小文字英字のみの短い語はタグ名由来の可能性が高いが、確定はできないので通し、
  // name 表との突合(businessLabel)に委ねる。div/table 等の頻出タグだけは明確に落とす。
  const COMMON_TAGS = new Set([
    'div',
    'p',
    'table',
    'section',
    'article',
    'header',
    'footer',
    'ul',
    'ol',
    'figure',
  ]);
  if (COMMON_TAGS.has(base)) return null;
  return base;
}

/**
 * 行の表示ラベル。カタログ名へ突合できたら「<業務名>（N ページ目）」、できなければ
 * 現行の機械採番ラベルをそのまま返す(黙って情報を減らさない)。
 */
export function businessLabel(
  key: string,
  fallbackLabel: string,
  nameById: ReadonlyMap<string, string>,
): string {
  const id = partIdFromBlockKey(key);
  const name = id ? nameById.get(id) : undefined;
  if (!name) return fallbackLabel;
  const page = /ページ(\d+)/.exec(fallbackLabel)?.[1];
  return page ? `${name}（${page} ページ目）` : name;
}

/**
 * カタログ全件から id → 業務名の表を作る。取得失敗は空 Map へ degrade する —
 * ラベルが機械採番へ戻るだけで、精査そのものは止めない(ベストエフォート)。
 */
export async function loadPartNameMap(parts: PartRepository): Promise<ReadonlyMap<string, string>> {
  const res = await parts.listParts({});
  if (isErr(res)) return new Map();
  return new Map(res.value.map((p) => [p.id, p.name]));
}
