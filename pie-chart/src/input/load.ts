// =============================================================================
// input/load.ts — 入力データの取得と正規化
// -----------------------------------------------------------------------------
// 入力ソースは 4 系統:
//   - sample        : samples.json 内の名前指定
//   - data          : [name, value][] / {name, value}[] の配列直渡し
//   - dataJson      : 同形式の JSON 文字列
//   - xlsx          : Excel ファイル (§1・非同期のみ)
// resolveInputData (同期) は xlsx を扱えない。xlsx を含めて統一的に扱いたい場合は
// resolveInputDataAsync を使う。レンダリング層は外部依存ゼロ方針のため、exceljs 依存は
// 本ファイルへ隔離する。
// =============================================================================

import fsp from 'node:fs/promises';
import ExcelJS from 'exceljs';

import { cellValueAsNumber, parseDecimalText, rowToItem } from './number.js';
import samplesData from '../../samples.json' with { type: 'json' };
import type { Item, Samples } from '../types.js';
import {
  MAX_JSON_BYTES,
  MAX_LABEL_CHARS,
  MAX_RANGE_ROWS,
  MAX_XLSX_BYTES,
  assertLabelXmlSafe,
} from '../limits.js';
// ── 1. Excel(.xlsx) 入力 ────────────────────────────────────────────────────────────
// 仕様: range は必ず 2 列固定 (左=name / 右=value)。ヘッダ行は範囲に含めない。空行はスキップ、
// name 空欄・value 数値変換不可はエラー。
interface ParsedRange {
  startRow: number;
  endRow: number;
  nameCol: number;
  valueCol: number;
}

/** "A" → 1, "Z" → 26, "AA" → 27 のように列文字を 1 始まりインデックスへ */
function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) {
      throw new Error(`Invalid column letter: ${letters}`);
    }
    n = n * 26 + (code - 64);
  }
  return n;
}

/**
 * "A2:B11" 形式のレンジ文字列を {startRow, endRow, nameCol, valueCol} に分解。
 * 列幅は必ず 2 でなければエラー(name + value 固定)。
 */
export function parseRange(rangeText: string): ParsedRange {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(rangeText).trim().toUpperCase());
  if (!m) {
    throw new Error(`Invalid range: "${rangeText}" (expected like "A2:B11")`);
  }
  const [, c1, r1, c2, r2] = m;
  let startCol = colLettersToIndex(c1);
  let endCol = colLettersToIndex(c2);
  let startRow = Number(r1);
  let endRow = Number(r2);
  if (endCol < startCol) [startCol, endCol] = [endCol, startCol];
  if (endRow < startRow) [startRow, endRow] = [endRow, startRow];
  if (endCol - startCol !== 1) {
    throw new Error(`Range must span exactly 2 columns (left=name, right=value): "${rangeText}"`);
  }
  // 列幅だけを見て行数を見ていなかったため、`A1:B99999999` が素通りしていた。
  if (endRow - startRow + 1 > MAX_RANGE_ROWS) {
    throw new Error(
      `Range spans ${endRow - startRow + 1} rows (limit ${MAX_RANGE_ROWS}): "${rangeText}". ` +
        'Narrow the range, or raise the limit with PIE_MAX_RANGE_ROWS=<n>.',
    );
  }
  return { startRow, endRow, nameCol: startCol, valueCol: endCol };
}

/**
 * exceljs のセル値は数式結果やリッチテキストなど複合オブジェクトのことがある。
 * その包みを順に剥がして「素の値」を返す。
 */
function unwrapCellValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'object') {
    if ('result' in value) return unwrapCellValue((value as { result: unknown }).result);
    if ('richText' in value)
      return (value as { richText: Array<{ text: string }> }).richText.map((p) => p.text).join('');
    if ('text' in value) return (value as { text: unknown }).text;
  }
  return value;
}

/**
 * セルがエラー値(`#N/A` / `#DIV/0!` など。数式の結果としてのエラーを含む)ならその表記を、
 * そうでなければ null を返す。exceljs はエラー値を `{ error: '#N/A' }` で表し、そのまま
 * 文字列化すると "[object Object]" という名前のスライスとして黙って帳票に載る。
 */
function cellErrorText(cell: { value: unknown }): string | null {
  const v = unwrapCellValue(cell.value);
  if (typeof v === 'object' && v !== null && 'error' in v) {
    return String((v as { error: unknown }).error);
  }
  return null;
}

function cellAsText(cell: { value: unknown }): string {
  const v = unwrapCellValue(cell.value);
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/**
 * セルを数値として読む。読めなければ null(規則は `number.ts` の `cellValueAsNumber`。DB 経路と共有)。
 * 行の読み取りは `rowToItem` が同じ規則で行う。テストから直接検証するために公開する。
 * @public
 */
export function cellAsNumber(cell: { value: unknown }): number | null {
  return cellValueAsNumber(unwrapCellValue(cell.value));
}

interface LoadXlsxOpts {
  path: string;
  sheet: string;
  range: string;
}

/**
 * Excel ファイルから [name, value][] を読み出す。
 * 戻り値は本ファイルの `normalizeInputItems` で {name, value} 形式に整形される。
 */
async function loadXlsxItems({
  path: xlsxPath,
  sheet,
  range,
}: LoadXlsxOpts): Promise<Array<[string, number]>> {
  if (!xlsxPath) throw new Error('xlsx path is required.');
  if (!sheet) throw new Error('sheet name is required.');
  if (!range) throw new Error('range is required (e.g. "A2:B11").');

  // exceljs は zip 内の全エントリを無条件展開して JS 文字列へ載せる(必要判定は展開の後)
  // ので、展開の**前**に掛けられる防御は圧縮後のファイルサイズだけ。展開後サイズは残余
  // リスクで、運用条件(信用できない .xlsx を開かない)と併せて初めて成立する
  // — 前提と、上限を上げる代わりに何をすべきかは `limits.ts` の `MAX_XLSX_BYTES` の doc。
  const stat = await fsp.stat(xlsxPath);
  if (stat.size > MAX_XLSX_BYTES) {
    throw new Error(
      `xlsx file is ${stat.size} bytes (limit ${MAX_XLSX_BYTES}): "${xlsxPath}". ` +
        'Raise the limit with PIE_MAX_XLSX_BYTES=<n> if this file is expected.',
    );
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(sheet);
  if (!ws) {
    const available = wb.worksheets.map((w) => w.name).join(', ');
    throw new Error(`Sheet not found: "${sheet}" (available: ${available})`);
  }

  const { startRow, endRow, nameCol, valueCol } = parseRange(range);
  // `ws.getRow(r)` は存在しない行に対して新規 Row を生成して `_rows` へ格納するため、
  // 実データ数行でも指定行数ぶんの Row/Cell が実体化する。`findRow` は生成せず undefined を
  // 返す。加えて実データ最終行でクランプし、空振りのループ自体を短くする。
  const lastRow = Math.max(ws.actualRowCount ?? 0, ws.rowCount ?? 0);
  const scanEnd = lastRow > 0 ? Math.min(endRow, lastRow) : endRow;
  const items: Array<[string, number]> = [];
  for (let r = startRow; r <= scanEnd; r += 1) {
    const row = ws.findRow(r);
    if (!row) continue;
    const nameCell = row.getCell(nameCol);
    const valueCell = row.getCell(valueCol);
    for (const [cell, column] of [
      [nameCell, 'name'],
      [valueCell, 'value'],
    ] as const) {
      const error = cellErrorText(cell);
      if (error !== null) {
        throw new Error(`Excel error value ${error} at row ${r} (${column} column).`);
      }
    }
    const item = rowToItem(cellAsText(nameCell), unwrapCellValue(valueCell.value), r, () =>
      cellAsText(valueCell),
    );
    if (item) items.push(item);
  }
  if (items.length === 0) {
    throw new Error(`No data rows found in range "${range}" of sheet "${sheet}".`);
  }
  return items;
}

// ── 2. 正規化と解決 (公開 API) ────────────────────────────────────────────────────────────
const samples = samplesData as unknown as Samples;
export { samples };

interface ResolveSyncOpts {
  sample?: string;
  data?: unknown[];
  dataJson?: string;
}

/**
 * 非同期入力ソースの discriminated union。kind ごとに必要なフィールドが型レベルで揃うので、
 * `opts.sheet!` のような非 null 断定を排除できる。CLI 等の入口で「どの入力か」を選んだ時点で
 * 確定する。
 */
export type ResolveAsyncOpts =
  | { kind: 'sample'; sample: string }
  | { kind: 'data'; data: unknown[] }
  | { kind: 'dataJson'; dataJson: string }
  | { kind: 'xlsx'; xlsx: string; sheet: string; range: string };

/**
 * 任意形式の項目リストを {name, value} 配列に正規化する。
 * 配列要素は [name, value] タプル形式と {name, value} オブジェクト形式の両方を許容。
 */
export function normalizeInputItems(rawItems: unknown): Item[] {
  if (!Array.isArray(rawItems)) {
    throw new Error('Input data must be an array.');
  }
  // 幅計算(`visualMaxEm`)は 1 文字ずつ加算するループで、配置カスケードの内側から
  // 何度も呼ばれる。切り詰めると出力が黙って変わるのでエラーにする(分類: 明示エラー)。
  const checkName = (name: string): string => {
    if (name.length > MAX_LABEL_CHARS)
      throw new Error(
        `Label is ${name.length} characters (limit ${MAX_LABEL_CHARS}). ` +
          'Shorten it, or raise the limit with PIE_MAX_LABEL_CHARS=<n>.',
      );
    // 全 5 入力経路 + normalizeInputItems 直叩きをここ 1 箇所で覆う。
    assertLabelXmlSafe(name);
    return name;
  };
  // name は文字列か数値だけを受理する。`String()` に任せると null が "null"、真偽値が "true"、
  // オブジェクトが "[object Object]" という名前のスライスになる。欠落(null / undefined /
  // 空文字 / 空白のみ)は xlsx / DB 経路の `Empty name at row N` と同じく明示エラーにする。
  const toName = (raw: unknown, index: number): string => {
    if (raw == null || (typeof raw === 'string' && raw.trim() === ''))
      throw new Error(`Empty name at item ${index + 1}.`);
    if (typeof raw === 'string') return checkName(raw);
    if (typeof raw === 'number' && Number.isFinite(raw)) return checkName(String(raw));
    throw new Error(`Invalid name at item ${index + 1} (got ${JSON.stringify(raw)}).`);
  };
  // value は有限の数値か、10 進の数値文字列だけを受理する。`Number()` に任せると、読めない値は
  // NaN のまま配置計算を走り切り(全項目 0.0%・幅ゼロスライスの SVG が例外なしで出る)、
  // 欠落(null / 空文字 / 空白のみ)・`[]`・`false` は 0 に、`true` は 1 になって、明示された
  // `0` と区別の付かないスライスとして無警告で帳票に載る(分類: 明示エラー)。
  const checkValue = (name: string, raw: unknown): number => {
    const value =
      typeof raw === 'number'
        ? Number.isFinite(raw)
          ? raw
          : null
        : typeof raw === 'string'
          ? parseDecimalText(raw, false)
          : null;
    if (value === null)
      throw new Error(`Non-numeric value for "${name}" (got ${JSON.stringify(raw)}).`);
    return value;
  };
  return rawItems.map((item: unknown, index): Item => {
    if (Array.isArray(item) && item.length >= 2) {
      const name = toName(item[0], index);
      return { name, value: checkValue(name, item[1]) };
    }
    if (typeof item === 'object' && item !== null && 'name' in item && 'value' in item) {
      const obj = item as { name: unknown; value: unknown };
      const name = toName(obj.name, index);
      return { name, value: checkValue(name, obj.value) };
    }
    throw new Error('Each item must be {name, value} or [name, value].');
  });
}

/**
 * 同期版: sample / data / dataJson のいずれか 1 つを必須とする。
 * Excel 入力(xlsx)はここでは扱えない(非同期版を使うこと)。
 */
export function resolveInputData({ sample, data, dataJson }: ResolveSyncOpts): Item[] {
  if (sample) {
    if (!samples[sample]) {
      throw new Error(`Unknown sample: ${sample}`);
    }
    return normalizeInputItems(samples[sample].items);
  }
  if (data) {
    return normalizeInputItems(data);
  }
  if (dataJson) {
    // 上限の単位は byte なので byte で測る(`readJsonFile` と同じ)。`String.length` は UTF-16
    // コード単位数で、日本語だけの JSON は実バイト数の約 1/3 にしか見えず、上限が名前どおりに
    // 効かない。
    const byteLength = Buffer.byteLength(dataJson, 'utf-8');
    if (byteLength > MAX_JSON_BYTES)
      throw new Error(
        `dataJson is ${byteLength} bytes (limit ${MAX_JSON_BYTES}). ` +
          'Raise the limit with PIE_MAX_JSON_BYTES=<n> if this input is expected.',
      );
    return normalizeInputItems(JSON.parse(dataJson));
  }
  throw new Error('Provide one of: sample, data, dataJson.');
}

/**
 * 非同期版: kind ごとに分岐する。xlsx 以外は resolveInputData に同等のオプションで委譲。
 * CLI 等の入口で「Excel もそれ以外も同じ呼び方にしたい」用途向け。
 */
export async function resolveInputDataAsync(opts: ResolveAsyncOpts): Promise<Item[]> {
  switch (opts.kind) {
    case 'xlsx': {
      const raw = await loadXlsxItems({
        path: opts.xlsx,
        sheet: opts.sheet,
        range: opts.range,
      });
      return normalizeInputItems(raw);
    }
    case 'sample':
      return resolveInputData({ sample: opts.sample });
    case 'data':
      return resolveInputData({ data: opts.data });
    case 'dataJson':
      return resolveInputData({ dataJson: opts.dataJson });
  }
}
