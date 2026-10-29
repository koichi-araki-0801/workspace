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
  PartMasterReflectDefault,
  PartSyncDefault,
} from '@editor/shared';
import { asIso, asString, asStringOrNull, type Param, p, type SprocClient } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';

function classParams(q: PartClassificationQuery): Param[] {
  return [
    p('カテゴリ', q.category),
    p('大分類', q.majorClass),
    p('中分類', q.middleClass),
    p('小分類', q.minorClass),
    // 版種が空なら引数ごと省く。全件取得の呼び出し元が `@版種` の無い旧 sproc でも動くようにする。
    ...(q.editionType ? [p('版種', q.editionType)] : []),
    // 委託会社コードも同じ理由で、空なら引数ごと省く。
    ...(q.companyCode ? [p('委託会社コード', q.companyCode)] : []),
  ];
}

export interface PartRepo {
  getPartClassificationOptions(q: PartClassificationQuery): Promise<PartClassificationOptions>;
  listParts(q: PartClassificationQuery): Promise<PartCatalogItem[]>;
}

export function createPartRepo(sproc: SprocClient): PartRepo {
  return {
    async getPartClassificationOptions(q) {
      const rows = await sproc.callSproc(SP.part, '分類候補', classParams(q));
      // 実DBには未使用の分類階層が空文字で入る。空値をSelect候補へ渡すとUIが例外になるため除外し、
      // 前後空白だけが異なる候補も同じ分類としてまとめる。一覧側の分類値は変更しない。
      const pick = (kbn: string) =>
        Array.from(
          new Set(
            rows
              .filter((r) => asString(r.区分) === kbn)
              .map((r) => asString(r.値).trim())
              .filter((value) => value.length > 0),
          ),
        );

      return {
        categories: pick('カテゴリ'),
        majorClasses: pick('大分類'),
        middleClasses: pick('中分類'),
        minorClasses: pick('小分類'),
      };
    },

    async listParts(q) {
      const rows = await sproc.callSproc(SP.part, '一覧', classParams(q));
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
        // 値域は DDL の CHECK([CK_パーツ_同期既定] 等)が保証するため cast で写す。NULL = 未判断。
        syncDefault: asStringOrNull(r.同期既定) as PartSyncDefault | null,
        masterReflectDefault: asStringOrNull(r.次回反映既定) as PartMasterReflectDefault | null,
        targetEdition: asStringOrNull(r.対象版種),
        // CHAR(5) の末尾空白は値でないので落とす。
        companyCode: asStringOrNull(r.委託会社コード)?.trimEnd() ?? null,
      }));
    },
  };
}
