// =============================================================================
// reportRepo.ts — create_report 連携の集約(値入り HTML の生成と単体 PDF の組版)
// =============================================================================
// ルートはここだけを呼ぶ。会社コードの引き、入口の検査、生成後の git コミットをまとめる。
// 実際のスクリプト起動は `generate/createReport.ts` が担う。
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  assertTemplateId,
  type FillResult,
  notFound,
  type OfficialPdfStatus,
  parseTemplateFileName,
  REPORT_BUSY_USER,
  REPORT_BUSY_USER_MESSAGE,
  REPORT_COMPANY_UNKNOWN,
  type ReportStatus,
  skeletonFileName,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { filledExists, listTemplateFiles, readFilledHtml } from '../files/templateFiles.js';
import {
  assertReportEnabled,
  buildOfficialPdf,
  generateFilled,
  generateReportPdf,
  officialPdfNotRecorded,
} from '../generate/createReport.js';
import { createOfficialPdfJobs } from '../generate/officialPdfJobs.js';
import {
  authorEmailsSince,
  CREATE_REPORT_AUTHOR_DOMAIN,
  commitAll,
  ensureRepo,
  isAncestorOrSame,
  isPathClean,
  lastCommitFor,
  withGitLock,
} from '../git/gitRepo.js';
import { logger } from '../logger.js';
import { assertNoDocumentExternalRefs } from '../security/externalRefs.js';
import { assertPdfInputRefsContained } from '../security/pdfInputRefs.js';
import { assertTemplateScriptsUnchanged } from '../security/templateScripts.js';
import { PerUserBuildGate } from '../vivliostyle/buildUserQuota.js';
import { assertNoEditingMarkers } from './editingMarkerGate.js';
import type { TemplateRepo } from './templateRepo.js';

export interface ReportRepo {
  status(): ReportStatus;
  fill(id: string, actor: string): Promise<FillResult>;
  buildPdf(id: string, html: string, actor: string): Promise<Buffer>;
  requestOfficialPdf(id: string): Promise<void>;
  officialPdfStatus(id: string): Promise<OfficialPdfStatus>;
  /** 走っている・待っている正式 PDF の組版がすべて終わるまで待つ(テスト用)。 */
  settleOfficialPdfs(): Promise<void>;
}

/** 略称の比較キー。Rep1 の略称は固定長で末尾に空白が付きうる。 */
const companyKey = (code: string): string => code.trimEnd().toLowerCase();

const PDF_WHERE = 'report-pdf';
const OFFICIAL_PDF_WHERE = 'official-pdf';

/** 単体 PDF の人ごとの上限を超えたときの Error(`errorHandler` が 503 と code をそのまま返す)。 */
function reportBusyUserError(): Error {
  return Object.assign(new Error(REPORT_BUSY_USER_MESSAGE), {
    kind: 'unexpected' as const,
    code: REPORT_BUSY_USER,
    statusCode: 503,
  });
}

/** id(4 区切り)の会社略称から Rep1 の委託会社コードを引く。Rep1 に無ければ 400。 */
async function resolveRep1Code(
  templates: Pick<TemplateRepo, 'listCompanies'>,
  companyCode: string,
): Promise<string> {
  const companies = await templates.listCompanies();
  const hit = companies.find((c) => companyKey(c.companyCode) === companyKey(companyCode));
  const code = hit?.rep1CompanyCode.trim();
  if (!code) {
    throw Object.assign(validation(`会社 ${companyCode} の委託会社コードが Rep1 にありません`), {
      code: REPORT_COMPANY_UNKNOWN,
    });
  }
  return code;
}

interface FileStamp {
  mtimeMs: number;
  ino: number;
}

/** ファイルの更新時刻とファイル番号。無ければ null(無いこと以外の失敗は区別できないので投げる)。 */
async function fileStamp(file: string): Promise<FileStamp | null> {
  try {
    const s = await lstat(file);
    return { mtimeMs: s.mtimeMs, ino: s.ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * 組版の前後の印から、PDF がこの組版で書き直されたかを決める。前に無ければ、後にあれば書き直し。
 * 比べるのは同じファイルの前後の印なので、サーバとファイルサーバの時計がずれていても効く。
 */
function pdfRewritten(before: FileStamp | null, after: FileStamp | null): boolean {
  if (after === null) {
    return false;
  }
  return before === null || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino;
}

/** id を値入り HTML の属性へ解く(検査済みの id だけを通す)。 */
function parseFilledId(id: string): NonNullable<ReturnType<typeof parseTemplateFileName>> {
  const attrs = parseTemplateFileName(`${assertTemplateId(id)}.html`);
  if (!attrs) {
    throw validation(`不正なテンプレート id です: ${id}`);
  }
  return attrs;
}

export function createReportRepo(templates: Pick<TemplateRepo, 'listCompanies'>): ReportRepo {
  // 単体 PDF の人ごとの上限(実行中 1・待ち 1)。閲覧者にも開いたので、1 人が続けて押して
  // 生成器の共有の枠(全員で数本)を埋めないようにする(`/api/build` の `BUILD_BUSY_USER` と同じ形)。
  const perUser = new PerUserBuildGate(reportBusyUserError);

  async function fill(id: string, actor: string): Promise<FillResult> {
    const attrs = parseFilledId(id);
    assertReportEnabled();
    // 既にあれば開くだけ。DB(会社コード)を見ないので、DB が落ちていても既存の値入り HTML は開ける。
    // 生成側もロックの中で同じ確認をする(ここは DB を照会しないための先回り)。
    if (await filledExists(`${id}.html`)) {
      return { created: false };
    }
    // 元のテンプレート(3 区切り)が確定していなければ、値入りにする元が無い。
    const skeleton = skeletonFileName(attrs);
    const files = await listTemplateFiles();
    if (!files.includes(skeleton)) {
      throw notFound(`テンプレートがありません: ${skeleton}`);
    }
    const rep1 = await resolveRep1Code(templates, attrs.companyCode);
    const result = await generateFilled(id, rep1);
    if (result.created) {
      try {
        await ensureRepo();
        await withGitLock(() => commitAll(`create_report で ${id} を生成`, { name: actor }));
      } catch (err) {
        // 承認と同じくベストエフォート。生成物は保存済みで、次回の `git add -A` で回収される。
        logger.error({ err, id }, 'git コミットに失敗しました(生成した値入り HTML は保存済み)');
      }
    }
    return { created: result.created };
  }

  async function buildPdf(id: string, html: string, actor: string): Promise<Buffer> {
    const attrs = parseFilledId(id);
    // 不変性検査の基準は filled/ の実体。無いまま通すと基準が空になり、任意の script が通りうる。
    if (!(await filledExists(`${id}.html`))) {
      throw notFound(`値入り HTML がありません: ${id}.html`);
    }
    assertNoEditingMarkers(html, id);
    assertNoDocumentExternalRefs(html, '', PDF_WHERE);
    // create_report は相対参照をパスのとおりにファイルとして読むので、資産の置き場の外を拒む。
    assertPdfInputRefsContained(html, PDF_WHERE);
    // 組版は `<script>` を実行しうるので、確定済みの値入り HTML と同じ実行コードだけを通す。
    assertTemplateScriptsUnchanged(await readFilledHtml(`${id}.html`), html, {
      templateId: id,
      where: PDF_WHERE,
    });
    assertReportEnabled();
    return perUser.run(actor, async () => {
      const rep1 = await resolveRep1Code(templates, attrs.companyCode);
      return generateReportPdf(id, html, rep1);
    });
  }

  // 正式 PDF の状態を git の記録から出す問い合わせ。状態の表示と組版の成否の判定が共有する。
  const gitDeps = {
    pdfCommit: (id: string) => lastCommitFor(`pdf/${id}.pdf`),
    filledCommit: (id: string) => lastCommitFor(`filled/${id}.html`),
    isAncestorOrSame,
    filledChangedOnlyByCreateReport: async (id: string, base: string) =>
      (await authorEmailsSince(base, `filled/${id}.html`)).every((e) =>
        e.toLowerCase().endsWith(CREATE_REPORT_AUTHOR_DOMAIN),
      ),
  };

  // 正式 PDF の組版。rep1 は組版の直前に引くので、DB 不通は要求ではなくジョブの失敗になる。
  // 古い PDF は消さない。成否はスクリプトの後に git の記録で決め、失敗しても前回の記録が残る。
  const jobs = createOfficialPdfJobs({
    build: async (id) => {
      const attrs = parseFilledId(id);
      // create_report が読むのは filled/ の実体。単体 PDF と同じ検査をそのファイルにかける。
      const html = await readFilledHtml(`${id}.html`);
      assertNoDocumentExternalRefs(html, '', OFFICIAL_PDF_WHERE);
      assertPdfInputRefsContained(html, OFFICIAL_PDF_WHERE);
      const rep1 = await resolveRep1Code(templates, attrs.companyCode);
      // データのリポジトリは承認や生成のときに初めて作られる。無いまま走らせるとスクリプトは
      // PDF を書くだけで記録できず、成功しても必ず「記録されていない」になる。
      await ensureRepo();
      const pdfFile = path.join(config.pdfDir, `${id}.pdf`);
      const before = await fileStamp(pdfFile);
      await buildOfficialPdf(id, rep1);
      // この組版で PDF が書き直され、記録があり、作業ツリーが記録と一致すれば成功とする。
      // filled が新しくても PDF が同じバイトならスクリプトはコミットを省くので、祖先関係
      // (`stale`)では失敗にしない。その代わり書き直しを見る: 何も書かずに 0 で終わった
      // スクリプトを成功にすると、前に記録した PDF を今の filled から組んだと覚えてしまう。
      // 今の filled から組んだことはジョブが成功時のコミットを覚えて状態に反映する
      // (`officialPdfJobs.ts` の `doneHashes`)。
      const recorded =
        pdfRewritten(before, await fileStamp(pdfFile)) &&
        (await gitDeps.pdfCommit(id)) !== null &&
        (await isPathClean(`pdf/${id}.pdf`));
      if (!recorded) {
        throw officialPdfNotRecorded(id);
      }
    },
    ...gitDeps,
  });

  /** 連携が有効で、値入り HTML があることを確かめる。 */
  async function assertOfficialPdfTarget(id: string): Promise<void> {
    parseFilledId(id);
    assertReportEnabled();
    if (!(await filledExists(`${id}.html`))) {
      throw notFound(`値入り HTML がありません: ${id}.html`);
    }
  }

  async function requestOfficialPdf(id: string): Promise<void> {
    await assertOfficialPdfTarget(id);
    jobs.request(id);
  }

  async function officialPdfStatus(id: string): Promise<OfficialPdfStatus> {
    await assertOfficialPdfTarget(id);
    return jobs.status(id);
  }

  return {
    status: () => ({ enabled: config.report !== undefined }),
    fill,
    buildPdf,
    requestOfficialPdf,
    officialPdfStatus,
    settleOfficialPdfs: () => jobs.settled(),
  };
}
