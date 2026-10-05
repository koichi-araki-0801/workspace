import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeInputItems,
  resolveInputData,
  resolveInputDataAsync,
  samples,
} from '../src/input/load.js';

// DB ドライバ(msnodesqlv8)は CI/オフラインに無いので db_loader をモックし、
// resolveInputDataAsync の `sql` 経路(行→正規化)だけを検証する。
vi.mock('../src/input/db.js', () => ({
  loadDbItems: vi.fn(async () => [['DB', 7]] as Array<[string, number]>),
}));

const sampleKey = Object.keys(samples)[0];

describe('normalizeInputItems', () => {
  it('[name, value] タプルを正規化する', () => {
    expect(
      normalizeInputItems([
        ['A', 1],
        ['B', 2.5],
      ]),
    ).toEqual([
      { name: 'A', value: 1 },
      { name: 'B', value: 2.5 },
    ]);
  });
  it('{name, value} オブジェクトを正規化する', () => {
    expect(normalizeInputItems([{ name: 'A', value: 1 }])).toEqual([{ name: 'A', value: 1 }]);
  });
  it('name は文字列・value は数値へ強制変換する', () => {
    expect(normalizeInputItems([[10, '3']])).toEqual([{ name: '10', value: 3 }]);
  });
  it('配列でなければ投げる', () => {
    expect(() => normalizeInputItems('x' as unknown)).toThrow(/must be an array/);
  });
  it('要素が想定形でなければ投げる', () => {
    expect(() => normalizeInputItems([42])).toThrow(/Each item/);
    expect(() => normalizeInputItems([{ foo: 1 }])).toThrow(/Each item/);
  });
  it('数値として読めない value は項目名付きで投げる', () => {
    expect(() => normalizeInputItems([{ name: '株式', value: 'abc' }])).toThrow(
      /Non-numeric value for "株式"/,
    );
    expect(() => normalizeInputItems([['債券', 'abc']])).toThrow(/Non-numeric value for "債券"/);
  });
  it('非有限の value (Infinity / NaN) も投げる', () => {
    expect(() => normalizeInputItems([{ name: 'A', value: Number.POSITIVE_INFINITY }])).toThrow(
      /Non-numeric value for "A"/,
    );
    expect(() => normalizeInputItems([['B', Number.NaN]])).toThrow(/Non-numeric value for "B"/);
    expect(() => normalizeInputItems([['C', Number.NEGATIVE_INFINITY]])).toThrow(
      /Non-numeric value for "C"/,
    );
  });
  it('値の欠落 (null / 空文字 / 空白のみ) は 0 と見なさず項目名付きで投げる', () => {
    // `Number(null)` も `Number('')` も `Number('   ')` も 0 なので、欠落した値が
    // 「0.0% のスライス」として無警告で帳票へ載る。xlsx / DB 経路が空欄を明示エラーに
    // するのと揃える。
    expect(() => normalizeInputItems([{ name: '株式', value: null }])).toThrow(
      /Non-numeric value for "株式"/,
    );
    expect(() => normalizeInputItems([['債券', '']])).toThrow(/Non-numeric value for "債券"/);
    expect(() => normalizeInputItems([['現金', '   ']])).toThrow(/Non-numeric value for "現金"/);
    expect(() => normalizeInputItems([{ name: 'REIT', value: undefined }])).toThrow(
      /Non-numeric value for "REIT"/,
    );
  });
  it('数値でも数値文字列でもない value (配列・真偽値・オブジェクト) は投げる', () => {
    // `Number([])` は 0、`Number(false)` は 0、`Number(true)` は 1 になり、JSON の書き損じが
    // 0.0% / 1.0% のスライスとして黙って帳票に載る。
    expect(() => normalizeInputItems([['A', []]])).toThrow(/Non-numeric value for "A"/);
    expect(() => normalizeInputItems([['B', false]])).toThrow(/Non-numeric value for "B"/);
    expect(() => normalizeInputItems([{ name: 'C', value: true }])).toThrow(
      /Non-numeric value for "C"/,
    );
    expect(() => normalizeInputItems([['D', [5]]])).toThrow(/Non-numeric value for "D"/);
    expect(() => normalizeInputItems([['E', {}]])).toThrow(/Non-numeric value for "E"/);
  });
  it('10 進以外の記法の数値文字列は投げる', () => {
    expect(() => normalizeInputItems([['A', '0x1A']])).toThrow(/Non-numeric value for "A"/);
    expect(() => normalizeInputItems([['B', '0b11']])).toThrow(/Non-numeric value for "B"/);
    expect(() => normalizeInputItems([['C', '0o7']])).toThrow(/Non-numeric value for "C"/);
  });
  it('name の欠落 (null / undefined / 空文字 / 空白のみ) は xlsx / DB 経路と同じく投げる', () => {
    expect(() => normalizeInputItems([[null, 1]])).toThrow(/Empty name at item 1/);
    expect(() => normalizeInputItems([{ name: undefined, value: 1 }])).toThrow(
      /Empty name at item 1/,
    );
    expect(() =>
      normalizeInputItems([
        ['A', 1],
        ['', 2],
      ]),
    ).toThrow(/Empty name at item 2/);
    expect(() => normalizeInputItems([['   ', 2]])).toThrow(/Empty name at item 1/);
  });
  it('文字列でも数値でもない name (真偽値・オブジェクト・配列) は投げる', () => {
    expect(() => normalizeInputItems([[true, 1]])).toThrow(/Invalid name at item 1/);
    expect(() => normalizeInputItems([[{}, 1]])).toThrow(/Invalid name at item 1/);
    expect(() => normalizeInputItems([[['A'], 1]])).toThrow(/Invalid name at item 1/);
  });
  it('明示された 0 は従来どおり受理する', () => {
    expect(normalizeInputItems([['A', 0]])).toEqual([{ name: 'A', value: 0 }]);
    expect(normalizeInputItems([['B', '0']])).toEqual([{ name: 'B', value: 0 }]);
  });
  it('数値文字列と空白付き数値は従来どおり通す', () => {
    expect(normalizeInputItems([['A', ' 3.5 ']])).toEqual([{ name: 'A', value: 3.5 }]);
    expect(normalizeInputItems([['B', 0]])).toEqual([{ name: 'B', value: 0 }]);
  });
});

describe('resolveInputData', () => {
  it('data から解決する', () => {
    expect(resolveInputData({ data: [['A', 1]] })).toEqual([{ name: 'A', value: 1 }]);
  });
  it('dataJson から解決する', () => {
    expect(resolveInputData({ dataJson: '[["A", 1], ["B", 2]]' })).toEqual([
      { name: 'A', value: 1 },
      { name: 'B', value: 2 },
    ]);
  });
  it('既知の sample から解決する', () => {
    const items = resolveInputData({ sample: sampleKey });
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(typeof items[0].name).toBe('string');
    expect(typeof items[0].value).toBe('number');
  });
  it('未知の sample は投げる', () => {
    expect(() => resolveInputData({ sample: '__no_such_sample__' })).toThrow(/Unknown sample/);
  });
  it('入力が無ければ投げる', () => {
    expect(() => resolveInputData({})).toThrow(/Provide one of/);
  });
});

describe('resolveInputDataAsync', () => {
  it('sample / data / dataJson を委譲する', async () => {
    await expect(resolveInputDataAsync({ kind: 'data', data: [['A', 1]] })).resolves.toEqual([
      { name: 'A', value: 1 },
    ]);
    await expect(
      resolveInputDataAsync({ kind: 'dataJson', dataJson: '[["B", 2]]' }),
    ).resolves.toEqual([{ name: 'B', value: 2 }]);
    const fromSample = await resolveInputDataAsync({ kind: 'sample', sample: sampleKey });
    expect(fromSample.length).toBeGreaterThan(0);
  });
  it('sql 経路は db_loader の行を正規化して返す', async () => {
    await expect(
      resolveInputDataAsync({ kind: 'sql', query: 'SELECT name, value FROM t', database: 'd' }),
    ).resolves.toEqual([{ name: 'DB', value: 7 }]);
  });
});

// PowerShell 5.1 の `Out-File -Encoding utf8` / `Set-Content -Encoding utf8` は先頭に BOM を
// 書く。`JSON.parse` は BOM を不正な先頭文字として拒否するので、CLI の読み込みで剥がす。
// CLI 経由の検査なので実プロセスで確認する(input_limits.test.ts と同じ tsx 起動の型)。
describe('--data-file の UTF-8 BOM', () => {
  it('BOM 付きの JSON ファイルを読める', () => {
    const root = resolve(fileURLToPath(import.meta.url), '..', '..');
    const work = mkdtempSync(join(tmpdir(), 'piechart-bom-'));
    try {
      const dataFile = join(work, 'bom.json');
      const body = JSON.stringify([
        ['株式', 60],
        ['債券', 40],
      ]);
      writeFileSync(dataFile, `\uFEFF${body}`, 'utf-8');
      const outputFile = join(work, 'out.svg');
      execFileSync(
        process.execPath,
        [
          join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          join(root, 'src', 'cli.ts'),
          'one',
          '--data-file',
          dataFile,
          '--output-file',
          outputFile,
        ],
        { cwd: root, stdio: 'pipe', encoding: 'utf8' },
      );
      expect(readFileSync(outputFile, 'utf-8')).toContain('<svg');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
