// =============================================================================
// pairSyncService.ts — 承認直後に走る交付版⇄全体版 パーツ自動同期(I/O 編成)
// =============================================================================
// 呼び出し元は承認ワークフローの `approveReview`(`reviewRepo.ts`)のみ。承認で実ファイルへ
// 反映された source テンプレを読み直し、純関数エンジン(`partSync.ts`)の計算結果に従って
// ペアのテンプレ本体と同期状態(`syncFiles.ts`)を書き、独立の git コミットを積む。
//
// ベストエフォート方針: 同期のどの失敗も承認自体は成立させる(呼び出し側は throw を受けず
// `PairSyncSummary.error` で UI へ伝える)。転写内容は「承認済みの内容と同一パーツの機械的な
// 転写」なので追加の承認ゲートは設けない(設計判断。両側変更などの競合はエンジンが
// スキップして人間へ返す)。

import {
  type PairSyncSummary,
  pairedTemplateId,
  parseTemplateFileName,
  templatePairKey,
} from '@editor/shared';
import { readSyncState, writeSyncState } from '../files/syncFiles.js';
import { readTemplateHtml, templateExists, writeTemplateHtml } from '../files/templateFiles.js';
import { commitAll, withGitLock } from '../git/gitRepo.js';
import { logger } from '../logger.js';
import { listParts } from '../repositories/partRepo.js';
import { computePairSync } from './partSync.js';

/**
 * 承認確定した `sourceTemplateId` の変更をペアへ自動同期する。ペア対象外の版種・ペア実体
 * 不在なら null(UI は「同期なし」表示)。失敗は throw せず `error` 付き summary で返す。
 */
export async function syncPairAfterConfirm(
  sourceTemplateId: string,
  actor: string,
): Promise<PairSyncSummary | null> {
  const pairId = pairedTemplateId(sourceTemplateId);
  if (pairId === null) return null;
  const attrs = parseTemplateFileName(`${sourceTemplateId}.html`);
  const pairAttrs = parseTemplateFileName(`${pairId}.html`);
  if (!attrs || !pairAttrs) return null;
  const pairFile = `${pairId}.html`;
  if (!(await templateExists(pairFile))) return null;

  try {
    const [sourceHtml, targetHtml, catalog] = await Promise.all([
      readTemplateHtml(`${sourceTemplateId}.html`),
      readTemplateHtml(pairFile),
      listParts({}),
    ]);
    const state = await readSyncState(templatePairKey(attrs));
    const result = computePairSync({
      sourceHtml,
      targetHtml,
      syncDefaults: new Map(catalog.map((p) => [p.id, p.syncDefault ?? null])),
      sourceEdition: attrs.editionType,
      targetEdition: pairAttrs.editionType,
      state,
      now: new Date().toISOString(),
    });

    if (result.changed) await writeTemplateHtml(pairFile, result.targetHtml);
    if (result.changed || result.stateChanged) {
      await writeSyncState(result.state);
      // 承認コミットとは分けた独立コミットにし、「どの承認からの転写か」を履歴で追える
      // メッセージにする。失敗は applyConfirmedSave と同じくベストエフォート(warn のみ)。
      try {
        await withGitLock(() =>
          commitAll(
            `同期: ${pairId} ← ${sourceTemplateId} (${result.applied.length} パーツ) 実行者=${actor}`,
            { name: actor },
          ),
        );
      } catch (e) {
        logger.warn({ err: e }, 'ペア同期の git コミットに失敗しました(転写ファイルは保存済み)');
      }
    }
    return {
      pairTemplateId: pairId,
      applied: result.applied,
      skipped: result.skipped,
      error: null,
    };
  } catch (e) {
    logger.warn({ err: e }, 'ペア自動同期に失敗しました(承認自体は成立)');
    return {
      pairTemplateId: pairId,
      applied: [],
      skipped: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
