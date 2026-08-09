// =============================================================================
// confirmedWrite.ts — 確定テンプレ実体へ書き込む唯一のモジュール(チョークポイント)
// =============================================================================
// `templatesDir` / `cssDir` へバイト列を書けるのはこのファイルだけである。書込関数を
// `files/templateFiles.ts` の素の export に置くと、承認ゲートを通らない 2 つの
// 呼び出し元(`routes/generate.routes.ts` / `sync/pairSyncService.ts`)が直接叩ける。
// 「唯一の関所」を doc comment ではなくモジュール境界で強制するのが本ファイルの役割で、
// `atomicWrite` と `templatePath`/`cssPath` の組み合わせを持つファイルがここ 1 つで
// あることは `test/confirmedWrite.guard.test.ts` が機械検査する。
//
// 書込は kind に依らず必ず次を通る:
//   1. 名前検査(`assertTemplateFileName`。`templatePath` に内蔵)
//   2. 帰属検査(review-approve = 申告 fundCode と id の一致 / pair-sync = source から
//      再計算したペア id と target の一致。**引数で渡された target を信じない**)
//   3. 実行コード不変性の照合(`security/templateScripts.ts`)
//   4. snapshot → 書込 → 失敗時 restore
//   5. `afterWrite` フック(同期状態ファイル等)。失敗したら本体も restore して rethrow
//   6. git コミット(ベストエフォート)と監査イベント
//
// `pair-sync` の型に `css` フィールドを**作らない**のは意図的である。ペア転写は本体 HTML
// だけを書く経路であり、フィールドを用意すると将来誰かがファンド共有 CSS を承認外で
// 書き換えられるようになる(型で不可能にしておく)。

import fs from 'node:fs/promises';
import {
  assertTemplateFileName,
  notFound,
  pairedTemplateId,
  parseTemplateFileName,
  type TemplateMeta,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from '../files/atomic.js';
import { deletePending, readPending } from '../files/pendingFiles.js';
import { cssPath, readTemplateHtml, templatePath } from '../files/templateFiles.js';
import { commitAll, ensureRepo, withGitLock } from '../git/gitRepo.js';
import { audit, logger } from '../logger.js';
import { assertTemplateScriptsUnchanged } from '../security/templateScripts.js';
import { fileToMeta } from './templateMeta.js';

// ── 1. module-private な物理書込プリミティブ ──

async function writeTemplateAndCss(
  fileName: string,
  html: string,
  fundCode: string,
  css: string,
): Promise<void> {
  // 先に両方のパスを解決する。不正な名前でディレクトリだけ作られる(片方書けて片方落ちる)
  // 中途半端な状態を避けるため、副作用の前に検査を済ませる。
  const htmlPath = templatePath(fileName);
  const stylePath = cssPath(fundCode);
  await fs.mkdir(config.templatesDir, { recursive: true });
  await fs.mkdir(config.cssDir, { recursive: true });
  await atomicWrite(htmlPath, html);
  await atomicWrite(stylePath, css);
}

/** テンプレ本体だけの単ファイル書込(ペア同期。CSS はファンド単位共有なので触らない)。 */
async function writeTemplateHtml(fileName: string, html: string): Promise<void> {
  const htmlPath = templatePath(fileName);
  await fs.mkdir(config.templatesDir, { recursive: true });
  await atomicWrite(htmlPath, html);
}

interface Snapshot {
  html: string | null;
  css: string | null;
}

/** ロールバックできるよう、現在のバイト列を読む(存在しない/規約外は null)。 */
async function snapshotCurrent(fileName: string, fundCode: string | null): Promise<Snapshot> {
  const read = async (resolve: () => string): Promise<string | null> => {
    let p: string;
    try {
      p = resolve();
    } catch {
      return null;
    }
    return fs
      .readFile(p, 'utf8')
      .then((s) => s as string | null)
      .catch(() => null);
  };
  return {
    html: await read(() => templatePath(fileName)),
    css: fundCode === null ? null : await read(() => cssPath(fundCode)),
  };
}

/** 先に読んだバイト列を復元する(書込失敗時の補償 = compensation)。 */
async function restoreTemplateAndCss(
  fileName: string,
  fundCode: string | null,
  prev: Snapshot,
): Promise<void> {
  if (prev.html !== null) await atomicWrite(templatePath(fileName), prev.html);
  if (prev.css !== null && fundCode !== null) await atomicWrite(cssPath(fundCode), prev.css);
}

// ── 2. 公開 API ──

/**
 * 確定書込の操作。discriminated union にして「どの経路からの書込か」を型で明示し、
 * 監査へもそのまま載せる(capability 引数。宣言であって強制ではないが、監査で追える)。
 */
export type ConfirmedWriteOp =
  | {
      kind: 'review-approve';
      templateId: string;
      fundCode: string;
      html: string;
      css: string;
      author: string;
      commitMessage: string;
    }
  | {
      kind: 'pair-sync';
      /** 転写先。source から再計算した値と一致しなければ拒否する(引数を信じない)。 */
      targetTemplateId: string;
      sourceTemplateId: string;
      html: string;
      actor: string;
      appliedParts: readonly string[];
      /**
       * 本体書込の直後に走らせる追加の永続化(同期状態ファイル)。ここが失敗したら
       * 本体も元へ戻す — 「転写済みなのに lastSynced が古い」状態は次回同期で偽競合を作る。
       */
      afterWrite?: () => Promise<void>;
    };

/**
 * 実行コード不変性の基準となる HTML を返す。確定ファイル → pending(生成器の出力)の順で
 * 探し、どちらも無ければ空文字。空文字を基準にすると「実行コードを 1 つも持てない」に
 * 倒れる(fail-closed)。**確定を先に見る順序が契約**で、逆にすると pending を書ける者が
 * 基準そのものを差し替えられる。
 */
export async function baselineTemplateHtml(templateId: string): Promise<string> {
  const fileName = `${templateId}.html`;
  const confirmed = await readTemplateHtml(fileName);
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
  const fileName = assertTemplateFileName(`${templateId}.html`);
  const attrs = parseTemplateFileName(fileName);

  // ── 帰属検査 ──
  const fundCode = op.kind === 'review-approve' ? op.fundCode : null;
  if (op.kind === 'review-approve') {
    // CSS はファンド単位の共有ファイル。申請が持つ `fundCode` が id の示すファンドと
    // 食い違うと、別ファンドの共有 CSS を上書きできてしまうため一致を要求する。
    if (attrs?.fundCode !== op.fundCode) {
      throw validation(
        `ファンドコードがテンプレート id と一致しません: ${op.fundCode} (id=${templateId})`,
      );
    }
  } else {
    // 転写先は source から再計算する。呼び出し側の計算結果に載った pairId を信じると、
    // そこを操作するだけで無関係な確定テンプレへ書けてしまう。
    const expected = pairedTemplateId(op.sourceTemplateId);
    if (expected === null || expected !== op.targetTemplateId) {
      throw validation(
        `ペア同期の転写先が source のペアと一致しません: ${op.targetTemplateId} ` +
          `(source=${op.sourceTemplateId})`,
      );
    }
  }

  // ── 実行コード不変性 ──
  // 承認者は実行結果しか見ない運用なので、JS が変わっていないことはシステムが保証する。
  // 基準は復号後の実体に対して取る(チップの中身は信じない)。
  assertTemplateScriptsUnchanged(await baselineTemplateHtml(templateId), op.html, {
    templateId,
    where: op.kind,
  });

  await ensureRepo();
  const prev = await snapshotCurrent(fileName, fundCode);

  // 復元(補償)の失敗は握りつぶさない: 復元も同じ rename なので、書込を失敗させた
  // 共有違反(dataRoot がネットワークドライブのときは別クライアント起因でも起きる)が
  // 続いていると復元ごと失敗し、「HTML は新版・CSS は旧版」の不整合が**黙って**確定する。
  // 直せなかったことをエラーログと監査に残し、元の例外はそのまま呼び出し側へ返す。
  const restoreOrReport = async (): Promise<void> => {
    try {
      await restoreTemplateAndCss(fileName, fundCode, prev);
    } catch (restoreErr) {
      logger.error(
        { err: restoreErr, templateId },
        '確定書込のロールバックに失敗しました(テンプレ本体と CSS が不整合の可能性。要確認)',
      );
      audit({
        event: 'template.confirmedWrite',
        outcome: 'failure',
        actor: op.kind === 'review-approve' ? op.author : op.actor,
        resource: { templateId, kind: op.kind },
        detail: { rollbackFailed: true },
      });
    }
  };

  try {
    if (op.kind === 'review-approve') {
      await writeTemplateAndCss(fileName, op.html, op.fundCode, op.css);
    } else {
      await writeTemplateHtml(fileName, op.html);
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

  const commitMessage =
    op.kind === 'review-approve'
      ? op.commitMessage
      : `同期: ${op.targetTemplateId} ← ${op.sourceTemplateId} ` +
        `(${op.appliedParts.length} パーツ) 実行者=${op.actor}`;
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
      resource: { templateId, kind: op.kind },
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
        ? { templateId, kind: op.kind }
        : { templateId, kind: op.kind, sourceTemplateId: op.sourceTemplateId },
    detail:
      op.kind === 'pair-sync' ? { appliedParts: op.appliedParts.length } : { fundCode: fundCode },
  });

  if (op.kind === 'review-approve') {
    // 確定へ昇格したので生成時の未確定実体は捨てる(ベストエフォート)。
    await deletePending(templateId).catch(() => {});
  }

  const meta = await fileToMeta(fileName);
  if (!meta) throw notFound(`テンプレートが見つかりません: ${templateId}`);
  return meta;
}
