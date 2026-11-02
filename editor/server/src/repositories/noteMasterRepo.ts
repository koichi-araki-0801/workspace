// =============================================================================
// noteMasterRepo.ts — 注記マスタ sproc の窓口
// =============================================================================
// 注記マスタ sproc の 2 操作(`反映` = upsert、`取得` = ファンド・版種の全行)を包む。
// 注記マスタは仮組テーブルで、実運用の既存注記テーブルへ差し替える前提。差し替えは
// sproc の中身だけで行い、`@操作` と結果列の契約は保つ。このファイルはその契約を
// そのまま写した形なので、差し替えのときに変わらない。
// 列を型へ写すだけで行は選ばない(`注記HTML` が NULL の行を捨てるのはサービスの判断)。
import { asString, asStringOrNull, p, type SprocClient } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';

export interface NoteMasterRow {
  partId: string;
  noteHtml: string | null;
}

export interface NoteMasterRepo {
  upsertNoteMaster(row: {
    partId: string;
    fundCode: string;
    editionType: string;
    noteHtml: string;
    actor: string;
  }): Promise<void>;
  listNoteMasters(fundCode: string, editionType: string): Promise<NoteMasterRow[]>;
}

export function createNoteMasterRepo(sproc: SprocClient): NoteMasterRepo {
  return {
    async upsertNoteMaster(row) {
      await sproc.callSproc(SP.noteMaster, '反映', [
        p('パーツID', row.partId),
        p('ファンドコード', row.fundCode),
        p('版種', row.editionType),
        p('注記HTML', row.noteHtml),
        p('更新者', row.actor),
      ]);
    },

    async listNoteMasters(fundCode, editionType) {
      const rows = await sproc.callSproc(SP.noteMaster, '取得', [
        p('ファンドコード', fundCode),
        p('版種', editionType),
      ]);
      return rows.map((r) => ({
        partId: asString(r.パーツID),
        noteHtml: asStringOrNull(r.注記HTML),
      }));
    },
  };
}
