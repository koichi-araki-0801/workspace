import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSelectOnly, buildConnectionString, rowsToItems } from '../src/db_loader.js';

describe('buildConnectionString', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    // process.env への代入は文字列強制される(undefined 代入は "undefined" になる)ため
    // 既定値検証では delete で確実に未設定にする。
    delete process.env.DB_SERVER;
    delete process.env.DB_NAME;
    delete process.env.DB_ODBC_DRIVER;
    delete process.env.DB_CONN_EXTRA;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('既定ドライバ・サーバ + 明示 database で Trusted_Connection を付ける', () => {
    expect(buildConnectionString({ query: 'select 1', database: 'usrap' })).toBe(
      'Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=usrap;Trusted_Connection=yes;',
    );
  });
  it('明示の server / driver / extra を反映する', () => {
    expect(
      buildConnectionString({
        query: 'select 1',
        server: 'db01',
        database: 'd',
        driver: 'ODBC Driver 18 for SQL Server',
        extra: 'Encrypt=no;',
      }),
    ).toBe(
      'Driver={ODBC Driver 18 for SQL Server};Server=db01;Database=d;Trusted_Connection=yes;Encrypt=no;',
    );
  });
  it('database が無ければ env DB_NAME を使う', () => {
    process.env.DB_NAME = 'fromenv';
    expect(buildConnectionString({ query: 'select 1' })).toContain('Database=fromenv;');
  });
  it('database 未指定 (env も無し) は投げる', () => {
    expect(() => buildConnectionString({ query: 'select 1' })).toThrow(/database is required/);
  });
});

describe('assertSelectOnly', () => {
  it('SELECT を許可する', () => {
    expect(() => assertSelectOnly('SELECT a, b FROM t')).not.toThrow();
  });
  it('WITH (CTE) を許可する', () => {
    expect(() => assertSelectOnly('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
  });
  it('末尾セミコロン 1 個は許容する', () => {
    expect(() => assertSelectOnly('SELECT 1;  ')).not.toThrow();
  });
  it('複文 (文中セミコロン) は投げる', () => {
    expect(() => assertSelectOnly('SELECT 1; DROP TABLE t')).toThrow(/Multiple statements/);
  });
  it('非 SELECT は投げる', () => {
    expect(() => assertSelectOnly('UPDATE t SET a=1')).toThrow(/Only SELECT/);
    expect(() => assertSelectOnly('DELETE FROM t')).toThrow(/Only SELECT/);
  });
  it('空クエリは投げる', () => {
    expect(() => assertSelectOnly('   ;  ')).toThrow(/empty/);
  });
});

describe('rowsToItems', () => {
  it('無指定なら先頭 2 列を name/value とする', () => {
    expect(
      rowsToItems([
        { 区分: '株式', 比率: 60 },
        { 区分: '債券', 比率: 40 },
      ]),
    ).toEqual([
      ['株式', 60],
      ['債券', 40],
    ]);
  });
  it('列名指定で name/value を選ぶ (列順非依存)', () => {
    const rows = [{ id: 1, label: 'A', pct: 30 }];
    expect(rowsToItems(rows, 'label', 'pct')).toEqual([['A', 30]]);
  });
  it('カンマ区切り数値・数値文字列を変換する', () => {
    expect(rowsToItems([{ n: 'X', v: '1,234' }])).toEqual([['X', 1234]]);
  });
  it('name/value とも空の行はスキップする', () => {
    expect(
      rowsToItems([
        { n: 'A', v: 1 },
        { n: '', v: null },
      ]),
    ).toEqual([['A', 1]]);
  });
  it('行が無ければ投げる', () => {
    expect(() => rowsToItems([])).toThrow(/no rows/);
  });
  it('片方の列名だけ指定は投げる', () => {
    expect(() => rowsToItems([{ a: 'A', b: 1 }], 'a')).toThrow(/both name and value/);
  });
  it('指定した列名が無ければ投げる', () => {
    expect(() => rowsToItems([{ a: 'A', b: 1 }], 'x', 'b')).toThrow(/Name column not found/);
    expect(() => rowsToItems([{ a: 'A', b: 1 }], 'a', 'y')).toThrow(/Value column not found/);
  });
  it('列が 1 つしか無ければ投げる', () => {
    expect(() => rowsToItems([{ only: 'A' }])).toThrow(/at least 2 columns/);
  });
  it('3 列以上で列名無指定は投げる', () => {
    expect(() => rowsToItems([{ a: 1, b: 2, c: 3 }])).toThrow(/specify name\/value columns/);
  });
  it('name 空欄 (value あり) は投げる', () => {
    expect(() => rowsToItems([{ n: '', v: 5 }])).toThrow(/Empty name/);
  });
  it('value が数値変換不可なら投げる', () => {
    expect(() => rowsToItems([{ n: 'A', v: 'abc' }])).toThrow(/Non-numeric value/);
  });
  it('全行が空ならエラー (使える行ゼロ)', () => {
    expect(() => rowsToItems([{ n: '', v: '' }])).toThrow(/No usable data rows/);
  });
});
