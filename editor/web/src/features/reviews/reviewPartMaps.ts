// =============================================================================
// reviewPartMaps.ts — 承認タブのコメント宛先パーツ(ラベル・ページ index)の算出
// =============================================================================
// 承認タブは編集中でない確定版 HTML の文字列からパーツ構造を読みたいだけ。`DOMParser` で作った
// body を内容の根として、canvas(根は GrapesJS の wrapper)と同じ `partLabelMap` /
// `partPageIndexMap`(`partKey.ts`)へ渡す薄いラッパで、`ReviewTabView.vue` の `loadParts` から
// 呼ぶ(パーツ集合・キー生成規則を二重実装しない)。

import { partLabelMap, partPageIndexMap } from '@/features/editor/partKey';

export interface PartMaps {
  labels: Map<string, string>;
  pages: Map<string, number>;
}

/** HTML 文字列から承認タブのパーツラベル・ページ index マップを作る。空文字は空マップ。 */
export function partMapsFromHtml(html: string): PartMaps {
  if (!html.trim()) return { labels: new Map(), pages: new Map() };
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  return { labels: partLabelMap(body), pages: partPageIndexMap(body) };
}
