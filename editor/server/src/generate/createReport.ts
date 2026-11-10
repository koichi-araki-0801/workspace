// =============================================================================
// createReport.ts — create_report.py の呼び出し(値入り HTML の生成と単体 PDF の組版)
// =============================================================================
// 編集タブの「新しい基準日で開く」(`filled/` の生成)と、単体 PDF(`pdf-input/` → `pdf/`)が使う。
// スクリプトは dataRoot を自分の設定で持つので、editor は引数だけを渡し、出力は決まったパスから読む。
// 起動は `scriptRunner.ts` の部品を共有する(指紋の照合・環境変数の許可リスト・同時実行の枠)。
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertTemplateAttributeToken,
  assertTemplateId,
  type FilledTemplateAttributes,
  parseTemplateFileName,
  REPORT_DISABLED,
  REPORT_OUTPUT_MISSING,
  REPORT_RUN_FAILED,
  REPORT_TIMEOUT,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from '../files/atomic.js';
import { withFileLock } from '../files/fileLock.js';
import { filledExists } from '../files/templateFiles.js';
import { logger } from '../logger.js';
import {
  assertScriptFingerprint,
  runPythonScript,
  ScriptRunError,
  type ScriptSpec,
  withGeneratorSlot,
} from './scriptRunner.js';

/** create_report に作らせるもの。`html` は値入り HTML、`pdf` は単体 PDF。 */
export type ReportMode = 'html' | 'pdf';

/** 失敗時に応答へ出さず、ログへ残す stderr の末尾の長さ。 */
const STDERR_TAIL_CHARS = 2000;

const BASE_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

/** 利用者へそのまま出せる文言と状態コードを持つ Error(`scriptRunner.ts` の `generatorError` と同じ形)。 */
function reportError(
  message: string,
  code: string,
  statusCode: number,
  kind: 'unexpected' | 'not_found' = 'unexpected',
): Error {
  return Object.assign(new Error(message), { kind, code, statusCode });
}

/** `yyyymmdd` を `yyyy-mm-dd` にする。実在しない日付(20230230 など)は 400。 */
export function toIsoBaseDate(yyyymmdd: string): string {
  const m = BASE_DATE_RE.exec(yyyymmdd);
  if (m) {
    const [, y, mo, d] = m;
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    const roundTrips =
      date.getUTCFullYear() === Number(y) &&
      date.getUTCMonth() === Number(mo) - 1 &&
      date.getUTCDate() === Number(d);
    if (roundTrips) {
      return `${y}-${mo}-${d}`;
    }
  }
  throw validation(`基準日が不正です: ${yyyymmdd}`);
}

/**
 * create_report.py の引数を組む。各値はファイル名に使うトークンとして検査する(先頭が `-` の値で
 * フラグに化けるのも、ここで弾く)。
 */
export function reportArgs(
  rep1CompanyCode: string,
  attrs: FilledTemplateAttributes,
  mode: ReportMode,
): string[] {
  return [
    assertTemplateAttributeToken('委託会社コード', rep1CompanyCode),
    assertTemplateAttributeToken('ファンドコード', attrs.fundCode),
    toIsoBaseDate(attrs.baseDate),
    assertTemplateAttributeToken('版種', attrs.editionType),
    mode === 'html' ? '--html-only' : '--pdf-only',
    '--fund-only',
  ];
}

/** 機能が有効なら設定を返す。無効(`config.report` が未設定)なら 404。 */
function requireReport(): ScriptSpec {
  const spec = config.report;
  if (!spec) {
    throw reportError('create_report が設定されていません', REPORT_DISABLED, 404, 'not_found');
  }
  return spec;
}

/** id(`.html` なし)を値入り HTML の属性へ解く。 */
function parseId(id: string): FilledTemplateAttributes {
  const attrs = parseTemplateFileName(`${assertTemplateId(id)}.html`);
  if (!attrs) {
    throw validation(`不正なテンプレート id です: ${id}`);
  }
  return attrs;
}

/** スクリプトを枠の中で走らせ、失敗を `REPORT_TIMEOUT`(504) / `REPORT_RUN_FAILED`(502) へ写す。 */
async function runReport(spec: ScriptSpec, args: string[]): Promise<void> {
  await withGeneratorSlot(async () => {
    await assertScriptFingerprint(spec);
    try {
      await runPythonScript(spec, args);
    } catch (err) {
      if (!(err instanceof ScriptRunError)) {
        throw err;
      }
      logger.error(
        { script: spec.script, args, stderr: err.stderr.slice(-STDERR_TAIL_CHARS) },
        '[report] create_report の実行に失敗しました',
      );
      if (err.timedOut) {
        throw reportError('create_report が制限時間内に終わりませんでした', REPORT_TIMEOUT, 504);
      }
      throw reportError('create_report の実行に失敗しました', REPORT_RUN_FAILED, 502);
    }
  });
}

/** スクリプトが正常終了したのに出力が無いときの失敗(dataRoot の設定違いが典型)。 */
function outputMissing(relative: string): Error {
  return reportError(
    `create_report.py は正常終了しましたが ${relative} がありません。` +
      'create_report の dataRoot の設定が editor と同じか確かめてください',
    REPORT_OUTPUT_MISSING,
    500,
  );
}

/**
 * `filled/<id>.html` を用意する。既にあれば何もしない(承認済みの内容と下書きを守るため)。
 * 同じ id の生成は排他にし、後着は先着の結果をそのまま使う。
 */
export async function generateFilled(
  id: string,
  rep1CompanyCode: string,
): Promise<{ created: boolean }> {
  const spec = requireReport();
  const attrs = parseId(id);
  const args = reportArgs(rep1CompanyCode, attrs, 'html');
  const fileName = `${id}.html`;
  return withFileLock(`report-fill:${id.toLowerCase()}`, async () => {
    if (await filledExists(fileName)) {
      return { created: false };
    }
    await runReport(spec, args);
    if (!(await filledExists(fileName))) {
      throw outputMissing(`filled/${fileName}`);
    }
    return { created: true };
  });
}

/** ファイルを消す。無くてもエラーにしない(後始末で、消す対象が未作成のことがあるため)。 */
async function removeQuietly(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

/**
 * 編集後の HTML を `pdf-input/<id>.html` に置いて組版し、`pdf/<id>.pdf` を読んで返す。
 * 古い PDF を先に消すのは、スクリプトが何も書かずに終わったとき前回の PDF を返さないため。
 * 入力と出力は応答後に消す(未承認の内容を dataRoot に残さない)。
 */
export async function generateReportPdf(
  id: string,
  html: string,
  rep1CompanyCode: string,
): Promise<Buffer> {
  const spec = requireReport();
  const attrs = parseId(id);
  const args = reportArgs(rep1CompanyCode, attrs, 'pdf');
  const input = path.join(config.pdfInputDir, `${id}.html`);
  const output = path.join(config.pdfDir, `${id}.pdf`);
  // Windows はファイル名の大小を区別しない。大小だけ違う id が同じ入出力を共有するので、鍵は小文字にそろえる。
  return withFileLock(`report-pdf:${id.toLowerCase()}`, async () => {
    try {
      await removeQuietly(output);
      await fs.mkdir(config.pdfInputDir, { recursive: true });
      await atomicWrite(input, html);
      await runReport(spec, args);
      try {
        return await fs.readFile(output);
      } catch {
        throw outputMissing(`pdf/${id}.pdf`);
      }
    } finally {
      await removeQuietly(input);
      await removeQuietly(output);
    }
  });
}
