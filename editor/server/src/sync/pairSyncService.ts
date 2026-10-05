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
// スキップして人間へ返す)。ペアのキーはテンプレート(3 つ区切り)が `会社_ファンド`、値入り HTML
// (4 つ区切り)が `会社_ファンド_基準日` で、状態ファイルは別になる。
//
// CSS も同じ承認の中で写す(`cssSync.ts`)。CSS はテンプレ単位なので、値入り HTML のペアでも
// テンプレのペアでも対象は同じ CSS 2 枚(`…_交付版.css` ⇔ `…_全体版.css`)になる。base は承認の
// 直前の CSS で、呼び出し側(承認)が書く前に読んで渡す(状態の記録は増やさない)。CSS の競合は
// 基準日をまたぐので、値入り HTML の承認でもテンプレのペアキー(`cssSyncPairKey`)の状態ファイルへ書く。

import {
  type PairSyncStatus,
  type PairSyncSummary,
  pairedTemplateId,
  parseAnyTemplateFileName,
  templatePairKey,
} from '@editor/shared';
import { readSyncState, writeSyncState } from '../files/syncFiles.js';
import {
  filledExists,
  readFilledHtml,
  readTemplateCss,
  readTemplateHtml,
  templateExists,
} from '../files/templateFiles.js';
import { commitAll, withGitLock } from '../git/gitRepo.js';
import { logger } from '../logger.js';
import { applyConfirmedWrite, type ConfirmedTarget } from '../repositories/confirmedWrite.js';
import type { PartRepo } from '../repositories/partRepo.js';
import { computeCssSync, cssSyncPairKey } from './cssSync.js';
import { computePairSync, type PairSyncState } from './partSync.js';

export interface PairSyncService {
  getPairSyncStatus(templateId: string): Promise<PairSyncStatus>;
  syncPairAfterConfirm(
    sourceTemplateId: string,
    actor: string,
    target: ConfirmedTarget,
    /** 承認の直前の source の CSS。読めなかったときは null(CSS の転写だけを飛ばす)。 */
    opts: { cssBefore: string | null },
  ): Promise<PairSyncSummary | null>;
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
      const attrs = parseAnyTemplateFileName(`${templateId}.html`);
      if (pairId === null || !attrs)
        return { pairTemplateId: null, pairExists: false, conflicts: [], cssConflicts: [] };
      // バナーが問うのは編集タブで開けるペアの有無なので、値入り HTML の側を見る。
      const pairExists = await filledExists(`${pairId}.html`);
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
      // CSS の競合はテンプレ単位の記録先から読む(どの基準日の画面でも、作成タブでも同じものが見える)。
      const cssKey = cssSyncPairKey(templateId);
      const cssState = cssKey ? await readSyncState(cssKey).catch(() => null) : null;
      const cssConflicts = cssState?.css?.conflicts ?? [];
      return { pairTemplateId: pairId, pairExists, conflicts, cssConflicts };
    },

    /**
     * 承認確定した `sourceTemplateId` の変更をペアへ自動同期する。ペア対象外の版種・ペア実体
     * 不在なら null(UI は「同期なし」表示)。失敗は throw せず `error` 付き summary で返す。
     */
    async syncPairAfterConfirm(sourceTemplateId, actor, target, opts) {
      // 読み書きする実体は承認が書いた先と同じに揃える。混ぜると値入り HTML の変更を
      // Jinja スケルトンへ転写する(またはその逆)ことになる。
      const exists = target === 'filled' ? filledExists : templateExists;
      const readHtml = target === 'filled' ? readFilledHtml : readTemplateHtml;
      const pairId = pairedTemplateId(sourceTemplateId);
      if (pairId === null) return null;
      const attrs = parseAnyTemplateFileName(`${sourceTemplateId}.html`);
      const pairAttrs = parseAnyTemplateFileName(`${pairId}.html`);
      if (!attrs || !pairAttrs) return null;
      const pairFile = `${pairId}.html`;
      if (!(await exists(pairFile))) return null;

      // CSS の入力。読めなければ(権限・共有違反など)CSS の転写だけを飛ばし、本文の同期は続ける。
      // 読めない CSS を '' と見なすと、全規則が追加・削除扱いになってペアへ誤って写る。
      const readCssInputs = async (bodyKey: string, state: PairSyncState) => {
        if (opts.cssBefore === null) return null;
        const cssKey = cssSyncPairKey(sourceTemplateId);
        if (cssKey === null) return null;
        try {
          const [next, target] = await Promise.all([
            readTemplateCss(sourceTemplateId),
            readTemplateCss(pairId),
          ]);
          // テンプレのペアの承認では同じファイル。値入り HTML のペアの承認では別のファイルを読む。
          const cssState = cssKey === bodyKey ? state : await readSyncState(cssKey);
          return { base: opts.cssBefore, cssKey, next, target, cssState };
        } catch (e) {
          logger.warn(
            { err: e },
            'ペアの CSS を読めないため CSS の転写を飛ばします(本文の同期は続行)',
          );
          return null;
        }
      };

      try {
        const [sourceHtml, targetHtml, catalog] = await Promise.all([
          readHtml(`${sourceTemplateId}.html`),
          readHtml(pairFile),
          parts.listParts({}),
        ]);
        const bodyKey = templatePairKey(attrs);
        const state = await readSyncState(bodyKey);
        const cssIn = await readCssInputs(bodyKey, state);
        const now = new Date().toISOString();
        const result = computePairSync({
          sourceHtml,
          targetHtml,
          syncDefaults: new Map(catalog.map((p) => [p.id, p.syncDefault ?? null])),
          sourceEdition: attrs.editionType,
          targetEdition: pairAttrs.editionType,
          state,
          now,
        });
        const cssSync =
          cssIn === null
            ? null
            : computeCssSync({
                base: cssIn.base,
                next: cssIn.next,
                target: cssIn.target,
                prev: cssIn.cssState.css?.conflicts ?? [],
                now,
              });
        // `computePairSync` の返す状態は本文のパーツだけを持つ。同じファイルに CSS の競合が
        // あれば(テンプレのペア)持ち越す — CSS を飛ばした承認で記録を消さないため。
        const bodyStateNext: PairSyncState = {
          ...result.state,
          ...(state.css !== undefined ? { css: state.css } : {}),
        };
        // CSS の競合はテンプレのペアキーの状態にだけ載せる(テンプレのペアの承認なら同じファイルを
        // 1 回、値入り HTML なら 2 ファイル)。
        const sameFile = cssIn !== null && cssIn.cssKey === bodyKey;
        const cssStateNext: PairSyncState | null =
          cssIn !== null && cssSync !== null
            ? {
                ...(sameFile ? bodyStateNext : cssIn.cssState),
                css: { conflicts: cssSync.conflicts },
                updatedAt: now,
              }
            : null;
        const cssConflictsChanged = cssSync?.conflictsChanged ?? false;
        const statesChanged = result.stateChanged || cssConflictsChanged;
        const writeStates = async (): Promise<void> => {
          // CSS 側を先に書く。後の本文側が失敗して本体と CSS が元へ戻っても、残る CSS の競合は
          // 「写さなかった規則」だけで、次の承認で両版の一致を見て持ち越すか消すかが決まる
          // (写したことにする記録は残らない)。
          if (sameFile && cssStateNext !== null) {
            if (statesChanged) await writeSyncState(cssStateNext);
            return;
          }
          if (cssConflictsChanged && cssStateNext !== null) await writeSyncState(cssStateNext);
          if (result.stateChanged) await writeSyncState(bodyStateNext);
        };
        const cssToWrite = cssSync?.css ?? null;

        if (result.changed || cssToWrite !== null) {
          // 確定ディレクトリへの書込はチョークポイント経由に限る(承認ゲート・帰属検査・
          // 実行コード不変性・snapshot/restore・監査を素通りさせない)。転写先は
          // チョークポイント側が source から再計算して照合するため、ここの `pairId` を
          // 信用させない構造になっている。本文と CSS を 1 回の確定書込で書く(承認 1 回につき
          // 転写 1 回)。CSS の書き先もチョークポイントが転写先 id から決める。
          // 同期状態ファイルは「本体書込の成功後」という順序を保ちつつ `afterWrite` で書く。
          // ここが失敗すると本体も元へ戻る = 「転写済みなのに lastSynced が古い」状態を作らない。
          await applyConfirmedWrite({
            kind: 'pair-sync',
            target,
            targetTemplateId: pairId,
            sourceTemplateId,
            html: result.targetHtml,
            ...(cssToWrite !== null ? { css: cssToWrite } : {}),
            actor,
            appliedParts: result.applied,
            appliedCssRules: cssSync?.applied ?? [],
            afterWrite: writeStates,
          });
        } else if (statesChanged) {
          // 本体を書かない(状態だけ動いた)場合はチョークポイントを通らないので、状態ファイルの
          // コミットだけをここで積む。ベストエフォートは従来どおり。
          await writeStates();
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
          css: cssSync?.ran ? { applied: cssSync.applied, conflicts: cssSync.skipped } : null,
          error: null,
        };
      } catch (e) {
        logger.warn({ err: e }, 'ペア自動同期に失敗しました(承認自体は成立)');
        return {
          pairTemplateId: pairId,
          applied: [],
          skipped: [],
          css: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
