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
  type PairSyncStatus,
  type PairSyncSummary,
  pairedTemplateId,
  parseTemplateFileName,
  templatePairKey,
} from '@editor/shared';
import { readSyncState, writeSyncState } from '../files/syncFiles.js';
import { readTemplateHtml, templateExists } from '../files/templateFiles.js';
import { commitAll, withGitLock } from '../git/gitRepo.js';
import { logger } from '../logger.js';
import { applyConfirmedWrite } from '../repositories/confirmedWrite.js';
import type { PartRepo } from '../repositories/partRepo.js';
import { computePairSync } from './partSync.js';

export interface PairSyncService {
  getPairSyncStatus(templateId: string): Promise<PairSyncStatus>;
  syncPairAfterConfirm(sourceTemplateId: string, actor: string): Promise<PairSyncSummary | null>;
}

export function createPairSyncService(parts: PartRepo): PairSyncService {
  return {
    /**
     * ペア同期の現況(編集画面バナー用)。状態ファイルから未解決競合だけを軽量ビューへ写す。
     * 状態ファイルの破損や読取失敗は「競合なし」へ倒す(バナーは補助情報であり、本流の
     * 編集・承認を止めない。破損の一次対処は次回承認時の同期スキップ警告が担う)。
     */
    async getPairSyncStatus(templateId) {
      const pairId = pairedTemplateId(templateId);
      const attrs = parseTemplateFileName(`${templateId}.html`);
      if (pairId === null || !attrs)
        return { pairTemplateId: null, pairExists: false, conflicts: [] };
      const pairExists = await templateExists(`${pairId}.html`);
      const state = pairExists
        ? await readSyncState(templatePairKey(attrs)).catch(() => null)
        : null;
      const conflicts = state
        ? Object.entries(state.parts).flatMap(([partKey, p]) =>
            p.conflict
              ? [{ partKey, kind: p.conflict.kind, detectedAt: p.conflict.detectedAt }]
              : [],
          )
        : [];
      return { pairTemplateId: pairId, pairExists, conflicts };
    },

    /**
     * 承認確定した `sourceTemplateId` の変更をペアへ自動同期する。ペア対象外の版種・ペア実体
     * 不在なら null(UI は「同期なし」表示)。失敗は throw せず `error` 付き summary で返す。
     */
    async syncPairAfterConfirm(sourceTemplateId, actor) {
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
          parts.listParts({}),
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

        if (result.changed) {
          // 確定ディレクトリへの書込はチョークポイント経由に限る(承認ゲート・帰属検査・
          // 実行コード不変性・snapshot/restore・監査を素通りさせない)。転写先は
          // チョークポイント側が source から再計算して照合するため、ここの `pairId` を
          // 信用させない構造になっている。
          // 同期状態ファイルは「本体書込の成功後」という順序を保ちつつ `afterWrite` で書く。
          // ここが失敗すると本体も元へ戻る = 「転写済みなのに lastSynced が古い」状態を作らない。
          await applyConfirmedWrite({
            kind: 'pair-sync',
            targetTemplateId: pairId,
            sourceTemplateId,
            html: result.targetHtml,
            actor,
            appliedParts: result.applied,
            afterWrite: () => writeSyncState(result.state),
          });
        } else if (result.stateChanged) {
          // 本体を書かない(状態だけ動いた)場合はチョークポイントを通らないので、状態ファイルの
          // コミットだけをここで積む。ベストエフォートは従来どおり。
          await writeSyncState(result.state);
          try {
            await withGitLock(() =>
              commitAll(`同期状態更新: ${pairId} ← ${sourceTemplateId} 実行者=${actor}`, {
                name: actor,
              }),
            );
          } catch (e) {
            logger.warn({ err: e }, 'ペア同期状態の git コミットに失敗しました(状態は保存済み)');
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
    },
  };
}
