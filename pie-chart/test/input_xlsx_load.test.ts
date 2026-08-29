// =============================================================================
// input_xlsx_load.test.ts — xlsx 入力経路(loadXlsxItems)の挙動固定
// =============================================================================
// `parseRange` / `cellAsNumber` の純粋関数は `input_xlsx.test.ts` が持つ。本ファイルは
// その上に載る「実ファイルを開いてセルを読む」層を固定する — シート解決・行の走査・
// 空行スキップ・明示エラー(空名 / 非数値 / 0 行)・圧縮後サイズの上限まで。
//
// fixture の .xlsx をリポジトリへ置かず、exceljs でメモリ上に組んで一時ディレクトリへ
// 書き出す(バイナリを増やさない・生成条件がテストの字面に見える)。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveInputDataAsync } from '../src/input/load.js';

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'piechart-xlsx-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * セル値の 2 次元配列から .xlsx を 1 つ書き出し、そのパスを返す。行は 1 始まりで、
 * `null` を渡した行は「空行」(exceljs が Row を作らない)として飛ばす。
 */
async function writeSheet(
  fileName: string,
  sheetName: string,
  rows: Array<Array<unknown> | null>,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((cells, index) => {
    if (cells === null) return;
    const row = ws.getRow(index + 1);
    cells.forEach((value, col) => {
      if (value === null) return;
      row.getCell(col + 1).value = value as ExcelJS.CellValue;
    });
  });
  const filePath = join(work, fileName);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

const xlsxOpts = (xlsx: string, sheet: string, range: string) =>
  ({ kind: 'xlsx', xlsx, sheet, range }) as const;

describe('xlsx 入力の正常系', () => {
  it('range が指す 2 列を [name, value] として読み、空行は飛ばす', async () => {
    const path = await writeSheet('basic.xlsx', 'Sheet1', [
      ['名称', '金額'],
      ['株式', 40],
      null,
      ['債券', '1,234'],
      ['現金', ' 5.5 '],
    ]);
    await expect(resolveInputDataAsync(xlsxOpts(path, 'Sheet1', 'A2:B5'))).resolves.toEqual([
      { name: '株式', value: 40 },
      { name: '債券', value: 1234 },
      { name: '現金', value: 5.5 },
    ]);
  });

  it('range が実データ最終行を超えても、超過分は走査せずに読み切る', async () => {
    // `ws.getRow(r)` と違い `findRow` は存在しない行の Row を実体化しない。指定行数ぶんの
    // 空振りが起きないことは行数上限(`MAX_RANGE_ROWS`)と対で効いている。
    const path = await writeSheet('clamp.xlsx', 'データ', [
      ['見出し', '値'],
      ['A', 1],
      ['B', 2],
    ]);
    await expect(resolveInputDataAsync(xlsxOpts(path, 'データ', 'A2:B9000'))).resolves.toEqual([
      { name: 'A', value: 1 },
      { name: 'B', value: 2 },
    ]);
  });

  it('数式セルは計算結果を、リッチテキストは連結した文字列を読む', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = { richText: [{ text: '国内' }, { text: '株式' }] };
    ws.getCell('B1').value = { formula: 'SUM(1,2)', result: 3 };
    ws.getCell('A2').value = { text: 'ハイパーリンク', hyperlink: 'https://example.invalid/' };
    ws.getCell('B2').value = 7;
    const path = join(work, 'wrapped.xlsx');
    await wb.xlsx.writeFile(path);

    await expect(resolveInputDataAsync(xlsxOpts(path, 'Sheet1', 'A1:B2'))).resolves.toEqual([
      { name: '国内株式', value: 3 },
      { name: 'ハイパーリンク', value: 7 },
    ]);
  });

  it('日付セルの名前は ISO 文字列として読む', async () => {
    const path = await writeSheet('date.xlsx', 'Sheet1', [[new Date(Date.UTC(2026, 7, 20)), 1]]);
    await expect(resolveInputDataAsync(xlsxOpts(path, 'Sheet1', 'A1:B1'))).resolves.toEqual([
      { name: '2026-08-20T00:00:00.000Z', value: 1 },
    ]);
  });
});

describe('xlsx 入力の明示エラー', () => {
  it('シート名が無ければ、存在するシート名を添えて投げる', async () => {
    const path = await writeSheet('sheets.xlsx', '集計', [['A', 1]]);
    await expect(resolveInputDataAsync(xlsxOpts(path, '明細', 'A1:B1'))).rejects.toThrow(
      /Sheet not found: "明細" \(available: 集計\)/,
    );
  });

  it('name 空欄 + value ありは行番号付きで投げる(空行スキップと区別する)', async () => {
    const path = await writeSheet('emptyname.xlsx', 'Sheet1', [
      ['A', 1],
      [null, 2],
    ]);
    await expect(resolveInputDataAsync(xlsxOpts(path, 'Sheet1', 'A1:B2'))).rejects.toThrow(
      /Empty name at row 2\./,
    );
  });

  it('数値として読めない value は、行番号と読めなかった字面を添えて投げる', async () => {
    const path = await writeSheet('nonnumeric.xlsx', 'Sheet1', [
      ['A', 1],
      ['B', '1,23'],
    ]);
    await expect(resolveInputDataAsync(xlsxOpts(path, 'Sheet1', 'A1:B2'))).rejects.toThrow(
      /Non-numeric value at row 2 \(got "1,23"\)\./,
    );
  });

  it('range に 1 行もデータが無ければ投げる(空の SVG を書かない)', async () => {
    const path = await writeSheet('empty.xlsx', 'Sheet1', [['見出し', '値']]);
    await expect(resolveInputDataAsync(xlsxOpts(path, 'Sheet1', 'A2:B5'))).rejects.toThrow(
      /No data rows found in range "A2:B5" of sheet "Sheet1"\./,
    );
  });

  it('path / sheet / range の指定漏れはファイルを開く前に投げる', async () => {
    await expect(resolveInputDataAsync(xlsxOpts('', 'Sheet1', 'A1:B1'))).rejects.toThrow(
      /xlsx path is required/,
    );
    await expect(resolveInputDataAsync(xlsxOpts('book.xlsx', '', 'A1:B1'))).rejects.toThrow(
      /sheet name is required/,
    );
    await expect(resolveInputDataAsync(xlsxOpts('book.xlsx', 'Sheet1', ''))).rejects.toThrow(
      /range is required/,
    );
  });
});

// 上限値は module 読み込み時に env から確定するので、上書きは `resetModules` + 動的 import で
// 行う(4 MiB の .xlsx を実際に組むとテスト自体が上限の実演になる)。
describe('xlsx の圧縮後サイズ上限', () => {
  it('上限超過は実サイズ・上限値・上げ方を添えて、exceljs へ渡す前に投げる', async () => {
    const path = await writeSheet('size.xlsx', 'Sheet1', [['A', 1]]);
    vi.resetModules();
    const previous = process.env.PIE_MAX_XLSX_BYTES;
    process.env.PIE_MAX_XLSX_BYTES = '16';
    try {
      const { resolveInputDataAsync: load } = await import('../src/input/load.js');
      await expect(load(xlsxOpts(path, 'Sheet1', 'A1:B1'))).rejects.toThrow(
        /limit 16.*PIE_MAX_XLSX_BYTES/s,
      );
    } finally {
      if (previous === undefined) delete process.env.PIE_MAX_XLSX_BYTES;
      else process.env.PIE_MAX_XLSX_BYTES = previous;
      vi.resetModules();
    }
  });
});
