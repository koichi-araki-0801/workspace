// =============================================================================
// reportRepo.ts — create_report 連携の集約(値入り HTML の生成と単体 PDF の組版)
// =============================================================================
// ルートはここだけを呼ぶ。会社コードの引き、入口の検査、生成後の git コミットをまとめる。
// 実際のスクリプト起動は `generate/createReport.ts` が担う。
import {
  assertTemplateId,
  type FillResult,
  notFound,
  parseSkeletonFileName,
  parseTemplateFileName,
  REPORT_BUSY_USER,
  REPORT_BUSY_USER_MESSAGE,
  REPORT_COMPANY_UNKNOWN,
  type ReportStatus,
  type SkeletonAttributes,
  skeletonFileName,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { filledExists, listTemplateFiles, readFilledHtml } from '../files/templateFiles.js';
import {
  assertReportEnabled,
  generateFilled,
  generateReportPdf,
} from '../generate/createReport.js';
import { commitAll, ensureRepo, withGitLock } from '../git/gitRepo.js';
import { logger } from '../logger.js';
import { assertNoDocumentExternalRefs } from '../security/externalRefs.js';
import { assertPdfInputRefsContained } from '../security/pdfInputRefs.js';
import { assertTemplateScriptsUnchanged } from '../security/templateScripts.js';
import { PerUserBuildGate } from '../vivliostyle/buildUserQuota.js';
import { assertNoEditingMarkers } from './editingMarkerGate.js';
import type { TemplateRepo } from './templateRepo.js';

export interface ReportRepo {
  status(): ReportStatus;
  listSkeletons(): Promise<SkeletonAttributes[]>;
  fill(id: string, actor: string): Promise<FillResult>;
  buildPdf(id: string, html: string, actor: string): Promise<Buffer>;
}

/** 略称の比較キー。Rep1 の略称は固定長で末尾に空白が付きうる。 */
const companyKey = (code: string): string => code.trimEnd().toLowerCase();

const PDF_WHERE = 'report-pdf';

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

  async function listSkeletons(): Promise<SkeletonAttributes[]> {
    const files = await listTemplateFiles();
    return files.flatMap((f) => {
      const attrs = parseSkeletonFileName(f);
      return attrs ? [attrs] : [];
    });
  }

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

  return {
    status: () => ({ enabled: config.report !== undefined }),
    listSkeletons,
    fill,
    buildPdf,
  };
}
