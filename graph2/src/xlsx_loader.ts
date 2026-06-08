// =============================================================================
// xlsx_loader.ts — Excel(.xlsx)から 2 列(name, value)のデータを読み込む
// -----------------------------------------------------------------------------
// 仕様:
//   - range は必ず 2 列固定。左 = name、右 = value
//   - ヘッダ行は範囲に含めない(データ行のみ指定)
//   - 空行(name も value も空)はスキップ
//   - name 空欄、または value が数値変換できない場合はエラー
// レンダリング層は外部依存ゼロ方針だが、入力層のみ例外で exceljs に依存。
// =============================================================================

import ExcelJS from "exceljs";

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
  return { startRow, endRow, nameCol: startCol, valueCol: endCol };
}

/**
 * exceljs のセル値は数式結果やリッチテキストなど複合オブジェクトのことがある。
 * その包みを順に剥がして「素の値」を返す。
 */
function unwrapCellValue(value: any): any {
  if (value == null) return null;
  if (typeof value === "object") {
    if ("result" in value) return unwrapCellValue(value.result);
    if ("richText" in value) return value.richText.map((p: any) => p.text).join("");
    if ("text" in value) return value.text;
  }
  return value;
}

function cellAsText(cell: any): string {
  const v = unwrapCellValue(cell.value);
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** 数値として読めなければ null を返す(カンマ区切りは許容)。 */
function cellAsNumber(cell: any): number | null {
  const v = unwrapCellValue(cell.value);
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface LoadXlsxOpts {
  path: string;
  sheet: string;
  range: string;
}

/**
 * Excel ファイルから [name, value][] を読み出す。
 * 戻り値は data.ts の normalizeInputItems で {name, value} 形式に整形される。
 */
export async function loadXlsxItems({
  path: xlsxPath,
  sheet,
  range,
}: LoadXlsxOpts): Promise<Array<[string, number]>> {
  if (!xlsxPath) throw new Error("xlsx path is required.");
  if (!sheet) throw new Error("sheet name is required.");
  if (!range) throw new Error('range is required (e.g. "A2:B11").');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(sheet);
  if (!ws) {
    const available = wb.worksheets.map((w) => w.name).join(", ");
    throw new Error(`Sheet not found: "${sheet}" (available: ${available})`);
  }

  const { startRow, endRow, nameCol, valueCol } = parseRange(range);
  const items: Array<[string, number]> = [];
  for (let r = startRow; r <= endRow; r += 1) {
    const row = ws.getRow(r);
    const name = cellAsText(row.getCell(nameCol));
    const valueCell = row.getCell(valueCol);
    const value = cellAsNumber(valueCell);
    const valueRaw = unwrapCellValue(valueCell.value);
    const valueIsBlank = valueRaw == null || valueRaw === "";

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
