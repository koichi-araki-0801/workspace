// =============================================================================
// noteMasterService.ts — 承認確定パーツの注記マスタ書き戻しと生成時適用
// =============================================================================
// 「特定パーツの修正を、そのファンドの次回作成テンプレへ引き継ぐ」ための 2 段構え:
//   1. 書き戻し(`reflectNoteMasterAfterConfirm`) — 承認直後、`次回反映既定`=`反映` の
//      パーツ HTML をファンド・版種別に注記マスタ(仮組)へ upsert する。
//   2. 適用(`applyNoteMasterToHtml`) — テンプレ新規生成の直後、注記マスタの行を生成 HTML の
//      同一 `data-part-id` パーツへ span 置換で上書きする。生成器(Python、差し替え前提)に
//      依存させないための編集側の適用点。
// どちらもベストエフォート: 書き戻しの失敗は承認を、適用の失敗は生成を止めない
// (`pairSyncService.ts` と同じ方針)。対象宣言の正典はパーツカタログ台帳の `次回反映既定`
// 列のみで、ファンド個別のオーバーライドは持たない(ペア同期の `同期既定` と同じ設計判断)。
// ※ パーツ単位の作業メモ(notes = `notesFile.ts`)とは別物。

import { type NoteMasterReflectSummary, parseTemplateFileName } from '@editor/shared';
import { asString, asStringOrNull, p, type SprocClient } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';
import { readTemplateHtml } from '../files/templateFiles.js';
import { logger } from '../logger.js';
import type { PartRepo } from '../repositories/partRepo.js';
import { applyOps, extractSyncParts } from './partSync.js';

export interface NoteMasterService {
  reflectNoteMasterAfterConfirm(
    templateId: string,
    actor: string,
  ): Promise<NoteMasterReflectSummary | null>;
  applyNoteMasterToHtml(html: string, fundCode: string, editionType: string): Promise<string>;
}

/**
 * この層はパーツカタログ(`parts.listParts`)に加えて注記マスタ sproc も直に呼ぶため、
 * `sproc` と `parts` の両方を受け取る。
 */
export function createNoteMasterService({
  sproc,
  parts,
}: {
  sproc: SprocClient;
  parts: PartRepo;
}): NoteMasterService {
  return {
    /**
     * 承認確定した `templateId` から `次回反映既定`=`反映` のパーツを抽出し、そのファンド・
     * 版種の注記マスタへ upsert する。テンプレ ID が解決できなければ null(UI は表示なし)。
     * 失敗は throw せず `error` 付き summary で返す(承認自体は成立済み)。
     * 書き戻しの契機は「承認」のみ: ペア同期で機械転写された側の版種は、その版種自身が
     * 承認されたときに書き戻す(承認を経ない内容をマスタへ昇格させない)。
     */
    async reflectNoteMasterAfterConfirm(templateId, actor) {
      const attrs = parseTemplateFileName(`${templateId}.html`);
      if (!attrs) return null;

      try {
        const [html, catalog] = await Promise.all([
          readTemplateHtml(`${templateId}.html`),
          parts.listParts({}),
        ]);
        const reflectIds = new Set(
          catalog.filter((c) => c.masterReflectDefault === '反映').map((c) => c.id),
        );
        const updated: string[] = [];
        // 同一 partId が複数出現する場合は文書内の先頭出現(`#1`)を正とする(マスタは
        // 1 パーツ = 1 行のため。注記パーツは実務上 1 回しか現れない想定の安全側規約)。
        for (const part of extractSyncParts(html)) {
          if (!reflectIds.has(part.partId) || !part.key.endsWith('#1')) continue;
          await sproc.callSproc(SP.noteMaster, '反映', [
            p('パーツID', part.partId),
            p('ファンドコード', attrs.fundCode),
            p('版種', attrs.editionType),
            p('注記HTML', part.html),
            p('更新者', actor),
          ]);
          updated.push(part.partId);
        }
        return { updated, error: null };
      } catch (e) {
        logger.warn({ err: e }, '注記マスタへの書き戻しに失敗しました(承認自体は成立)');
        return { updated: [], error: e instanceof Error ? e.message : String(e) };
      }
    },

    /**
     * 生成直後のテンプレ HTML へ、そのファンド・版種の注記マスタ行を適用する。マスタに行が
     * ある `data-part-id` パーツの全出現を span 置換し(同一パーツが複数あればすべて最新化)、
     * 非対象パーツはバイト不変。マスタが空・DB 不達・置換失敗のときは warn だけ残して元の
     * HTML を返す(新規作成をブロックしない)。
     */
    async applyNoteMasterToHtml(html, fundCode, editionType) {
      try {
        const rows = await sproc.callSproc(SP.noteMaster, '取得', [
          p('ファンドコード', fundCode),
          p('版種', editionType),
        ]);
        const masters = new Map<string, string>();
        for (const r of rows) {
          const noteHtml = asStringOrNull(r.注記HTML);
          if (noteHtml !== null) masters.set(asString(r.パーツID), noteHtml);
        }
        if (masters.size === 0) return html;

        const ops = extractSyncParts(html)
          .filter((part) => masters.has(part.partId))
          .map((part, i) => ({
            start: part.start,
            end: part.end,
            // filter 済みなので get は必ず成立するが、型上の undefined は現値で塞ぐ。
            text: masters.get(part.partId) ?? part.html,
            seq: i,
          }));
        return ops.length > 0 ? applyOps(html, ops) : html;
      } catch (e) {
        logger.warn({ err: e }, '注記マスタの生成時適用に失敗しました(未適用のまま生成を続行)');
        return html;
      }
    },
  };
}
