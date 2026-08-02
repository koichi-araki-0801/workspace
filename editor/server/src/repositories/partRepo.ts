// =============================================================================
// partRepo.ts — パーツカタログ集約のサーバ(REST)実装(エディタ左ペイン)
// =============================================================================
// パーツの HTML スニペットは小さな参照系マスタデータで DB に保持する。パーツの
// 変更履歴はファイル監査ログ(`logs/history/part.jsonl`)にあり、`historyRepo.ts` の
// `listPartHistory` から参照する。
import type {
  PartCatalogItem,
  PartClassificationOptions,
  PartClassificationQuery,
  PartSyncDefault,
} from '@editor/shared';
import { asIso, asString, asStringOrNull, callSproc, type Param, p } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';

function classParams(q: PartClassificationQuery): Param[] {
  return [
    p('カテゴリ', q.category),
    p('大分類', q.majorClass),
    p('中分類', q.middleClass),
    p('小分類', q.minorClass),
  ];
}

export async function getPartClassificationOptions(
  q: PartClassificationQuery,
): Promise<PartClassificationOptions> {
  const rows = await callSproc(SP.part, '分類候補', classParams(q));
  const pick = (kbn: string) =>
    rows.filter((r) => asString(r.区分) === kbn).map((r) => asString(r.値));
  return {
    categories: pick('カテゴリ'),
    majorClasses: pick('大分類'),
    middleClasses: pick('中分類'),
    minorClasses: pick('小分類'),
  };
}

export async function listParts(q: PartClassificationQuery): Promise<PartCatalogItem[]> {
  const rows = await callSproc(SP.part, '一覧', classParams(q));
  return rows.map((r) => ({
    id: asString(r.パーツID),
    classification: {
      category: asString(r.カテゴリ),
      majorClass: asString(r.大分類),
      middleClass: asString(r.中分類),
      minorClass: asString(r.小分類),
    },
    name: asString(r.名称),
    description: asString(r.説明),
    usageNotes: asString(r.使用上の注意),
    updatedAt: asIso(r.更新日時),
    updatedBy: asStringOrNull(r.更新者),
    content: asString(r.内容HTML),
    // 値域は DDL の CHECK([CK_パーツ_同期既定])が保証するため cast で写す。NULL = 未判断。
    syncDefault: asStringOrNull(r.同期既定) as PartSyncDefault | null,
  }));
}
