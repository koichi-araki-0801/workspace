// =============================================================================
// createReport.ts — create_report.py の呼び出し(値入り HTML の生成と単体 PDF の組版)
// =============================================================================
// 編集タブの「新しい基準日で開く」(`filled/` の生成)、単体 PDF(標準入力で HTML を渡し、標準出力で
// PDF を受ける。dataRoot には何も書かない)、公式 PDF(`filled/` から `pdf/` を作る)が使う。
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
  REPORT_OUTPUT_NOT_PDF,
  REPORT_RUN_FAILED,
  REPORT_TIMEOUT,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { withFileLock } from '../files/fileLock.js';
import { filledExists } from '../files/templateFiles.js';
import { logger } from '../logger.js';
import {
  assertScriptFingerprint,
  runPythonScript,
  runPythonScriptIo,
  ScriptRunError,
  type ScriptSpec,
  withGeneratorSlot,
} from './scriptRunner.js';

/**
 * create_report に作らせるもの。`html` は値入り HTML、`pdf` は単体 PDF(標準入出力)、
 * `official-pdf` は `filled/` から `pdf/` へ作る公式 PDF(editor を通さない単独の形)。
 */
export type ReportMode = 'html' | 'pdf' | 'official-pdf';

/** 失敗時に応答へ出さず、ログへ残す stderr の末尾の長さ。 */
const STDERR_TAIL_CHARS = 2000;

const BASE_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

/** PDF の先頭の印。標準出力がこれで始まらなければ `--from-editor` 非対応の create_report とみなす。 */
const PDF_MAGIC = '%PDF-';

/**
 * editor からの起動に付けるフラグ。付けると HTML は標準入力から受け、PDF は標準出力へ出し、
 * dataRoot への書き込みと git のコミットをしない。付けない形は editor を通さない単独の実行。
 */
const FROM_EDITOR_FLAG = '--from-editor';

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
 * 位置引数に渡す値を検査する。ファイル名に使うトークンとして検め、さらに先頭の `-` を拒む
 * (`--pdf-only` のような値はスクリプトの引数解析でフラグに化ける)。
 */
function argToken(label: string, value: string): string {
  const token = assertTemplateAttributeToken(label, value);
  if (token.startsWith('-')) {
    throw validation(`${label}の先頭に - は使えません: ${value}`);
  }
  return token;
}

const MODE_FLAGS: Record<ReportMode, string[]> = {
  html: ['--html-only', '--fund-only', FROM_EDITOR_FLAG],
  pdf: ['--pdf-only', '--fund-only', FROM_EDITOR_FLAG],
  'official-pdf': ['--pdf-only', '--fund-only'],
};

/** create_report.py の引数を組む。各値は `argToken` で検査する。 */
export function reportArgs(
  rep1CompanyCode: string,
  attrs: FilledTemplateAttributes,
  mode: ReportMode,
): string[] {
  return [
    argToken('委託会社コード', rep1CompanyCode),
    argToken('ファンドコード', attrs.fundCode),
    toIsoBaseDate(attrs.baseDate),
    argToken('版種', attrs.editionType),
    ...MODE_FLAGS[mode],
  ];
}

/**
 * 機能が有効か確かめる。無効(`config.report` が未設定)なら 404(`REPORT_DISABLED`)。
 * 呼び出し側が DB の照会より前に断るために公開する(`reportRepo.ts`)。
 */
export function assertReportEnabled(): void {
  requireReport();
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

/**
 * スクリプトを枠の中で走らせ、失敗を `REPORT_TIMEOUT`(504) / `REPORT_RUN_FAILED`(502) へ写す。
 * `onScriptFailure` はスクリプトが起動後に失敗したとき(書きかけの出力が残りうるとき)だけ呼ぶ。
 */
async function runReport(
  spec: ScriptSpec,
  args: string[],
  onScriptFailure: () => Promise<void> = async () => undefined,
): Promise<void> {
  await runGuarded(spec, args, () => runPythonScript(spec, args), onScriptFailure);
}

/** `runReport` の失敗の写し方を、戻り値のある起動(標準入出力)でも共有する。 */
async function runGuarded<T>(
  spec: ScriptSpec,
  args: string[],
  run: () => Promise<T>,
  onScriptFailure: () => Promise<void> = async () => undefined,
): Promise<T> {
  return withGeneratorSlot(async () => {
    await assertScriptFingerprint(spec);
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ScriptRunError)) {
        throw err;
      }
      logger.error(
        { script: spec.script, args, stderr: err.stderr.slice(-STDERR_TAIL_CHARS) },
        '[report] create_report の実行に失敗しました',
      );
      await onScriptFailure();
      if (err.timedOut) {
        throw reportError('create_report が制限時間内に終わりませんでした', REPORT_TIMEOUT, 504);
      }
      throw reportError('create_report の実行に失敗しました', REPORT_RUN_FAILED, 502);
    }
  }, 'report');
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
    // 起動前に無いことをロックの中で確かめたので、失敗後にあるファイルは今回の書きかけと断定できる。
    // 残すと次回から「既にある」として開かれ、壊れた値入り HTML が正になる。
    await runReport(spec, args, () => removeQuietly(path.join(config.filledDir, fileName)));
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
 * 編集後の HTML を標準入力で渡し、標準出力の PDF を返す。dataRoot には何も書かないので、
 * 共有するファイルが無く、同じ id の実行を直列にする必要も無い(同時実行の枠だけが効く)。
 */
export async function generateReportPdf(
  id: string,
  html: string,
  rep1CompanyCode: string,
): Promise<Buffer> {
  const spec = requireReport();
  const args = reportArgs(rep1CompanyCode, parseId(id), 'pdf');
  const out = await runGuarded(spec, args, () => runPythonScriptIo(spec, args, html));
  if (out.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
    throw reportError(
      'create_report の出力が PDF ではありません。' +
        'create_report.py が --from-editor に対応しているか確かめてください',
      REPORT_OUTPUT_NOT_PDF,
      502,
    );
  }
  return out;
}

/**
 * 公式 PDF を `filled/<id>.html` から作り、`pdf/<id>.pdf` に置く。古い PDF を先に消すのは、
 * スクリプトが何も書かずに終わったとき前回の PDF を成功と取り違えないため。
 * 同じ id の組版は排他にする(`pdf/<id>.pdf` を共有するため)。
 */
export async function buildOfficialPdf(id: string, rep1CompanyCode: string): Promise<void> {
  const spec = requireReport();
  const args = reportArgs(rep1CompanyCode, parseId(id), 'official-pdf');
  const output = path.join(config.pdfDir, `${id}.pdf`);
  // Windows はファイル名の大小を区別しないので、鍵は小文字にそろえる。
  await withFileLock(`report-official:${id.toLowerCase()}`, async () => {
    await removeQuietly(output);
    await runReport(spec, args, () => removeQuietly(output));
    try {
      await fs.access(output);
    } catch {
      throw outputMissing(`pdf/${id}.pdf`);
    }
  });
}
