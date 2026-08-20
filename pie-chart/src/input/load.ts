// =============================================================================
// input/load.ts — 入力データの取得と正規化
// -----------------------------------------------------------------------------
// 入力ソースは 5 系統:
//   - sample        : samples.json 内の名前指定
//   - data          : [name, value][] / {name, value}[] の配列直渡し
//   - dataJson      : 同形式の JSON 文字列
//   - xlsx          : Excel ファイル (§1・非同期のみ)
//   - sql           : SQL Server に SELECT を投げて取得 (input/db.ts 経由・非同期のみ)
// resolveInputData (同期) は xlsx / sql を扱えない。これらを含めて統一的に扱いたい
// 場合は resolveInputDataAsync を使う。レンダリング層は外部依存ゼロ方針のため、
// exceljs 依存は本ファイルへ、msnodesqlv8 (ネイティブ・遅延ロード) は input/db.ts へ隔離する
// (db を別ファイルに保つのは、テストの module モック境界とネイティブ依存の隔離のため)。
// =============================================================================

import fsp from 'node:fs/promises';
import ExcelJS from 'exceljs';

import { loadDbItems } from './db.js';
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

function cellAsText(cell: { value: unknown }): string {
  const v = unwrapCellValue(cell.value);
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** 桁区切りとして成立するカンマ入り数値(`1,234` / `-1,234,567.89`)。 */
const GROUPED_NUMBER_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * 数値として読めなければ null を返す。カンマは**桁区切りとして成立する位置にある時だけ**
 * 許容する。全カンマを無条件に除去すると `1,23`(小数点にカンマを使う locale の 1.23)が
 * 123 に、`1,2,3` が 123 になり、100 倍の値が無警告で帳票へ載る。読めない値は null にして
 * 呼び出し側の明示エラー(`Non-numeric value at row N`)へ倒す。空白だけのセルも「読めない値」
 * — `Number('   ')` は 0 なので、素通しすると値の欠落が 0.0% のスライスとして帳票に載る。
 */
export function cellAsNumber(cell: { value: unknown }): number | null {
  const v = unwrapCellValue(cell.value);
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = String(v).trim();
  if (text === '') return null;
  const normalized = GROUPED_NUMBER_RE.test(text) ? text.replace(/,/g, '') : text;
  if (normalized.includes(',')) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
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
    const name = cellAsText(row.getCell(nameCol));
    const valueCell = row.getCell(valueCol);
    const value = cellAsNumber(valueCell);
    const valueRaw = unwrapCellValue(valueCell.value);
    const valueIsBlank = valueRaw == null || valueRaw === '';

    if (!name && valueIsBlank) continue;
    if (!name) throw new Error(`Empty name at row ${r}.`);
    if (value == null) {
      throw new Error(`Non-numeric value at row ${r} (got "${cellAsText(valueCell)}").`);
    }
    items.push([name, value]);
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
  | { kind: 'xlsx'; xlsx: string; sheet: string; range: string }
  | {
      kind: 'sql';
      query: string;
      server?: string;
      database?: string;
      nameColumn?: string;
      valueColumn?: string;
    };

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
  // 数値化できない値を `Number()` の結果 (NaN) のまま通すと、配置計算は総和 NaN・角度 NaN で
  // 走り切り、全項目 0.0%・幅ゼロスライスの SVG が例外なしで出る。xlsx 経路 (`loadXlsxItems`)
  // と同じく、読めない値はここで明示エラーにする(分類: 明示エラー)。
  // 値の**欠落**(null / undefined / 空文字 / 空白のみ)は NaN にならず 0 になるので、
  // `Number()` の前に落とす — 素通しすると「0.0% のスライス」として無警告で帳票に載り、
  // 明示された `0` と区別が付かなくなる(明示の `0` は従来どおり受理する)。
  const checkValue = (name: string, raw: unknown): number => {
    if (raw == null || (typeof raw === 'string' && raw.trim() === ''))
      throw new Error(`Non-numeric value for "${name}" (got ${JSON.stringify(raw)}).`);
    const value = Number(raw);
    if (!Number.isFinite(value))
      throw new Error(`Non-numeric value for "${name}" (got ${JSON.stringify(raw)}).`);
    return value;
  };
  return rawItems.map((item: unknown): Item => {
    if (Array.isArray(item) && item.length >= 2) {
      const name = checkName(String(item[0]));
      return { name, value: checkValue(name, item[1]) };
    }
    if (typeof item === 'object' && item !== null && 'name' in item && 'value' in item) {
      const obj = item as { name: unknown; value: unknown };
      const name = checkName(String(obj.name));
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
 * 非同期版: kind ごとに分岐する。xlsx / sql 以外は resolveInputData に同等のオプションで委譲。
 * CLI 等の入口で「Excel・DB もそれ以外も同じ呼び方にしたい」用途向け。
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
    case 'sql': {
      const raw = await loadDbItems({
        query: opts.query,
        server: opts.server,
        database: opts.database,
        nameColumn: opts.nameColumn,
        valueColumn: opts.valueColumn,
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
