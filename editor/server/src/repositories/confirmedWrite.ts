// =============================================================================
// confirmedWrite.ts — 確定テンプレ実体へ書き込む唯一のモジュール(チョークポイント)
// =============================================================================
// `templatesDir` / `filledDir` / `cssDir` へバイト列を書けるのはこのファイルだけである。書込関数を
// `files/templateFiles.ts` の素の export に置くと、承認ゲートを通らない 2 つの
// 呼び出し元(`routes/generate.routes.ts` / `sync/pairSyncService.ts`)が直接叩ける。
// 「唯一の関所」を doc comment ではなくモジュール境界で強制するのが本ファイルの役割で、
// `atomicWrite` と `templatePath`/`filledPath`/`resolveTemplateCssPath` の組み合わせを持つ
// ファイルがここ 1 つであることは `test/confirmedWrite.guard.test.ts` が機械検査する。
//
// 書込は kind に依らず必ず次を通る:
//   1. 名前検査(書込先ごとの形。`assertFileNameFor`、`templatePath` / `filledPath` にも内蔵)
//   2. 帰属検査(CSS の書き先はサーバが id から決める(`cssFileNameOf`)。申請や呼び出し側の値を
//      使わない / pair-sync = source から再計算したペア id と target の一致。**引数で渡された
//      target を信じない**)
//   3. 実行コード不変性の照合(`security/templateScripts.ts`)
//   4. snapshot → 書込 → 失敗時 restore
//   5. `afterWrite` フック(同期状態ファイル等)。失敗したら本体も restore して rethrow
//   6. git コミット(ベストエフォート)と監査イベント
//
// `pair-sync` は CSS も書く(承認前後で変わった規則だけを 3 者比較で当てた結果。`sync/cssSync.ts`)。
// CSS はテンプレ単位で、交付版と全体版は別ファイルなので、本文と同じく写さないと承認した書式の
// 変更が片方の版にしか入らず二重メンテになる。承認外の書き換えにならないのは、写す中身が承認済みの
// 差分だけで、書き先がペア id から決まる(引数でパスを受けない・ペア id は source から再計算する)ため。

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertSkeletonFileName,
  assertTemplateFileName,
  notFound,
  pairedTemplateId,
  type TemplateMeta,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from '../files/atomic.js';
import { deletePending, readPending } from '../files/pendingFiles.js';
import {
  filledPath,
  readFilledHtml,
  readTemplateHtml,
  resolveTemplateCssPath,
  templatePath,
} from '../files/templateFiles.js';
import { commitAll, ensureRepo, withGitLock } from '../git/gitRepo.js';
import { audit, logger } from '../logger.js';
import { assertTemplateScriptsUnchanged } from '../security/templateScripts.js';
import { assertNoEditingMarkers } from './editingMarkerGate.js';
import { fileToMeta } from './templateMeta.js';

// ── 1. module-private な物理書込プリミティブ ──

/** 書込先ごとに受けるファイル名の形を強制する。値入り HTML は 4 つ区切り、テンプレートは 3 つ区切りだけ。 */
function assertFileNameFor(target: ConfirmedTarget, fileName: string): string {
  return target === 'filled' ? assertTemplateFileName(fileName) : assertSkeletonFileName(fileName);
}

const htmlPathOf = (target: ConfirmedTarget, fileName: string): string =>
  target === 'filled' ? filledPath(fileName) : templatePath(fileName);
const htmlDirOf = (target: ConfirmedTarget): string =>
  target === 'filled' ? config.filledDir : config.templatesDir;

async function writeTemplateAndCss(
  target: ConfirmedTarget,
  fileName: string,
  html: string,
  stylePath: string,
  css: string,
): Promise<void> {
  // HTML のパスを先に解決する。不正な名前でディレクトリだけ作られる(片方書けて片方落ちる)
  // 中途半端な状態を避けるため、副作用の前に検査を済ませる。CSS のパスは呼び出し側が解決済み。
  const htmlPath = htmlPathOf(target, fileName);
  await fs.mkdir(htmlDirOf(target), { recursive: true });
  await fs.mkdir(config.cssDir, { recursive: true });
  await atomicWrite(htmlPath, html);
  await atomicWrite(stylePath, css);
}

/** テンプレ本体だけの単ファイル書込(CSS を渡さないペア同期)。 */
async function writeTemplateHtml(
  target: ConfirmedTarget,
  fileName: string,
  html: string,
): Promise<void> {
  const htmlPath = htmlPathOf(target, fileName);
  await fs.mkdir(htmlDirOf(target), { recursive: true });
  await atomicWrite(htmlPath, html);
}

/**
 * 書込前の 1 ファイルの状態。`absent`(元から無かった)を `unknown`(読めなかった)と
 * **区別する**のが要点で、混ぜると新規作成が途中で失敗したときに補償できない — 承認を
 * 通していない実体が確定ディレクトリに残り、そのまま一覧に載る。
 */
type FileSnapshot = { state: 'content'; text: string } | { state: 'absent' } | { state: 'unknown' };

interface Snapshot {
  html: FileSnapshot;
  css: FileSnapshot;
}

/** ロールバックできるよう、現在の状態(内容 / 不存在 / 不明)を読む。 */
async function snapshotCurrent(
  target: ConfirmedTarget,
  fileName: string,
  stylePath: string | null,
): Promise<Snapshot> {
  const read = async (p: string): Promise<FileSnapshot> => {
    try {
      return { state: 'content', text: await fs.readFile(p, 'utf8') };
    } catch (e) {
      // ENOENT だけが「元から無かった」。他の読み取り失敗(権限・共有違反)は内容が
      // 分からないだけなので、消しにいかず手を触れない側へ倒す。
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? { state: 'absent' } : { state: 'unknown' };
    }
  };
  return {
    html: await read(htmlPathOf(target, fileName)),
    css: stylePath === null ? { state: 'unknown' } : await read(stylePath),
  };
}

/** 先に読んだ状態へ復元する(書込失敗時の補償 = compensation)。 */
async function restoreTemplateAndCss(
  target: ConfirmedTarget,
  fileName: string,
  stylePath: string | null,
  prev: Snapshot,
): Promise<void> {
  const restore = async (snap: FileSnapshot, resolve: () => string): Promise<void> => {
    if (snap.state === 'content') await atomicWrite(resolve(), snap.text);
    else if (snap.state === 'absent') await fs.rm(resolve(), { force: true });
  };
  await restore(prev.html, () => htmlPathOf(target, fileName));
  if (stylePath !== null) await restore(prev.css, () => stylePath);
}

// ── 2. 公開 API ──

/**
 * 書込先。`filled` = 値入り HTML(編集タブの承認)、`template` = Jinja スケルトン(作成タブの
 * 承認)。申請の `origin` から `reviewRepo.targetOfOrigin` が決め、ペア同期は承認と同じ先へ書く。
 */
export type ConfirmedTarget = 'filled' | 'template';

/**
 * 確定書込の操作。discriminated union にして「どの経路からの書込か」を型で明示し、
 * 監査へもそのまま載せる(capability 引数。宣言であって強制ではないが、監査で追える)。
 */
export type ConfirmedWriteOp =
  | {
      kind: 'review-approve';
      target: ConfirmedTarget;
      templateId: string;
      html: string;
      css: string;
      author: string;
      commitMessage: string;
    }
  | {
      kind: 'pair-sync';
      target: ConfirmedTarget;
      /** 転写先。source から再計算した値と一致しなければ拒否する(引数を信じない)。 */
      targetTemplateId: string;
      sourceTemplateId: string;
      html: string;
      /** ペアの CSS(承認で変わった規則だけを当てた結果)。省略時は CSS に触れない。 */
      css?: string;
      actor: string;
      appliedParts: readonly string[];
      /** 写した CSS 規則のキー(コミットメッセージと監査に件数を残す)。 */
      appliedCssRules?: readonly string[];
      /**
       * 本体書込の直後に走らせる追加の永続化(同期状態ファイル)。ここが失敗したら
       * 本体も元へ戻す — 「転写済みなのに lastSynced が古い」状態は次回同期で偽競合を作る。
       */
      afterWrite?: () => Promise<void>;
    };

/**
 * 実行コード不変性の基準となる HTML を返す。確定版(`target='filled'` は値入り HTML、
 * `target='template'` はテンプレート)→ pending の順に探し、どれも無ければ空文字。
 * 値入り HTML とテンプレートは id の形が違うので、互いの置き場は読まない。
 * 空文字を基準にすると「実行コードを 1 つも持てない」に倒れる(fail-closed)。
 * **確定を先に見る順序が契約**で、逆にすると pending を書ける者が基準そのものを差し替えられる。
 */
export async function baselineTemplateHtml(
  templateId: string,
  target: ConfirmedTarget,
): Promise<string> {
  const fileName = `${templateId}.html`;
  const confirmed =
    target === 'filled' ? await readFilledHtml(fileName) : await readTemplateHtml(fileName);
  if (confirmed !== '') return confirmed;
  const pending = await readPending(templateId);
  return pending?.html ?? '';
}

/**
 * 確定テンプレ実体への唯一の書込口。承認(`approveReview`)とペア同期
 * (`syncPairAfterConfirm`)以外から呼んではならない。
 */
export async function applyConfirmedWrite(op: ConfirmedWriteOp): Promise<TemplateMeta> {
  const templateId = op.kind === 'review-approve' ? op.templateId : op.targetTemplateId;
  const fileName = assertFileNameFor(op.target, `${templateId}.html`);

  // ── 帰属検査 ──
  // CSS の書き先はサーバが id から決める(review-approve は承認する文書、pair-sync は下で検査する
  // 転写先)。申請や呼び出し側が書き先を名乗る形にすると、別テンプレの CSS を上書きできてしまう。
  // 綴り違いが 2 つあればここで止まる(`resolveTemplateCssPath`)。
  if (op.kind === 'pair-sync') {
    // 転写先は source から再計算する。呼び出し側の計算結果に載った pairId を信じると、
    // そこを操作するだけで無関係な確定テンプレへ書けてしまう。CSS のパス解決より先に置く。
    const expected = pairedTemplateId(op.sourceTemplateId);
    if (expected === null || expected !== op.targetTemplateId) {
      throw validation(
        `ペア同期の転写先が source のペアと一致しません: ${op.targetTemplateId} ` +
          `(source=${op.sourceTemplateId})`,
      );
    }
  }
  const cssText = op.css;
  let stylePath: string | null = null;
  if (cssText !== undefined) {
    stylePath = await resolveTemplateCssPath(templateId);
    if (stylePath === null) throw validation(`CSS の名前を id から決められません: ${templateId}`);
  }

  // ── 往復用の印 ──
  // 書き先(テンプレート / 値入り HTML)も経路(承認 / ペア転写)も問わない。申請の入口を
  // すり抜けた本文(関所の導入前に積まれた申請を含む)を確定ファイルへ焼き付けない最後の関所。
  assertNoEditingMarkers(op.html, templateId);

  // ── 実行コード不変性 ──
  // 承認者は実行結果しか見ない運用なので、JS が変わっていないことはシステムが保証する。
  // 基準は復号後の実体に対して取る(チップの中身は信じない)。
  assertTemplateScriptsUnchanged(await baselineTemplateHtml(templateId, op.target), op.html, {
    templateId,
    where: op.kind,
  });

  await ensureRepo();
  const prev = await snapshotCurrent(op.target, fileName, stylePath);

  // 復元(補償)の失敗は握りつぶさない: 復元も同じ rename なので、書込を失敗させた
  // 共有違反(dataRoot がネットワークドライブのときは別クライアント起因でも起きる)が
  // 続いていると復元ごと失敗し、「HTML は新版・CSS は旧版」の不整合が**黙って**確定する。
  // 直せなかったことをエラーログと監査に残し、元の例外はそのまま呼び出し側へ返す。
  const restoreOrReport = async (): Promise<void> => {
    try {
      await restoreTemplateAndCss(op.target, fileName, stylePath, prev);
    } catch (restoreErr) {
      logger.error(
        { err: restoreErr, templateId },
        '確定書込のロールバックに失敗しました(テンプレ本体と CSS が不整合の可能性。要確認)',
      );
      audit({
        event: 'template.confirmedWrite',
        outcome: 'failure',
        actor: op.kind === 'review-approve' ? op.author : op.actor,
        resource: { templateId, kind: op.kind, target: op.target },
        detail: { rollbackFailed: true },
      });
    }
  };

  try {
    if (stylePath !== null && cssText !== undefined) {
      await writeTemplateAndCss(op.target, fileName, op.html, stylePath, cssText);
    } else {
      await writeTemplateHtml(op.target, fileName, op.html);
    }
  } catch (e) {
    await restoreOrReport();
    throw e;
  }

  if (op.kind === 'pair-sync' && op.afterWrite) {
    try {
      await op.afterWrite();
    } catch (e) {
      await restoreOrReport();
      throw e;
    }
  }

  const cssRules = op.kind === 'pair-sync' ? (op.appliedCssRules?.length ?? 0) : 0;
  const commitMessage =
    op.kind === 'review-approve'
      ? op.commitMessage
      : `同期: ${op.targetTemplateId} ← ${op.sourceTemplateId} ` +
        `(${op.appliedParts.length} パーツ${cssRules > 0 ? `・書式 ${cssRules} 規則` : ''}) ` +
        `実行者=${op.actor}`;
  const author = op.kind === 'review-approve' ? op.author : op.actor;
  try {
    await withGitLock(() => commitAll(commitMessage, { name: author }));
  } catch (e) {
    // コミット失敗はベストエフォート(承認自体は成立させる)。確定ファイルは作業ツリーに
    // 残り、次回保存時の `git add` で回収される。ただし「承認のたび 1 コミット」という
    // 版管理の前提が崩れた事実は黙らせない: dataRoot がネットワークドライブ上にあると
    // タイムアウト・他クライアントの index.lock で**恒常的に**ここへ落ちうるため、
    // error ログ + 監査イベントで運用者が気付ける形にする(warn だと日常ノイズに沈む)。
    logger.error({ err: e, templateId }, 'git コミットに失敗しました(確定ファイルは保存済み)');
    audit({
      event: 'template.confirmedWrite',
      outcome: 'failure',
      actor: author,
      resource: { templateId, kind: op.kind, target: op.target },
      detail: { gitCommitFailed: true },
    });
  }

  audit({
    event: 'template.confirmedWrite',
    outcome: 'success',
    actor: author,
    // 転写先 id が監査行に残らないと「どのファイルが機械的に書き換わったか」を後から
    // 追えない(ペア同期の監査はこれまで source しか持っていなかった)。
    resource:
      op.kind === 'review-approve'
        ? { templateId, kind: op.kind, target: op.target }
        : {
            templateId,
            kind: op.kind,
            target: op.target,
            sourceTemplateId: op.sourceTemplateId,
          },
    detail:
      op.kind === 'pair-sync'
        ? { appliedParts: op.appliedParts.length, appliedCssRules: cssRules }
        : { cssFile: stylePath === null ? null : path.basename(stylePath) },
  });

  if (op.kind === 'review-approve' && op.target === 'template') {
    // Jinja スケルトンが確定へ昇格したので生成時の未確定実体は捨てる(ベストエフォート)。
    // `filled` 側の承認では消さない — 値入り HTML が確定しても pending の骨組みは
    // まだ `templatesDir` へ昇格しておらず、消すと編集タブの一覧(確定 + pending)から
    // その id が丸ごと消える。
    await deletePending(templateId).catch(() => {});
  }

  const meta = await fileToMeta(fileName, op.target);
  if (!meta) throw notFound(`テンプレートが見つかりません: ${templateId}`);
  return meta;
}
