import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertLooksLikeSelect,
  buildConnectionString,
  normalizeConnExtra,
  rowsToItems,
} from '../src/input/db.js';
import { MAX_DB_ROWS } from '../src/limits.js';

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

  // ここからが本題: 接続文字列は `;` 区切りの key=value 列なので、値に `;` を通すと
  // 新しいキーワードの開始になる (FILEDSN で統合認証のチャレンジレスポンスが外部へ出る)。
  it('server へのキーワード注入を拒否する', () => {
    for (const bad of [
      String.raw`localhost;FILEDSN=\\evil.example\s\x.dsn`,
      String.raw`\\evil.example\share`,
      'localhost};Driver={Other',
      'localhost;Trusted_Connection=no;UID=sa;PWD=p',
      'localhost,99999999',
    ]) {
      expect(
        () => buildConnectionString({ query: 'select 1', database: 'd', server: bad }),
        bad,
      ).toThrow(/Invalid server/);
    }
  });
  it('正当な server の形は通す (インスタンス名・ポート・localdb)', () => {
    const good = ['localhost', 'db01\\SQLEXPRESS', 'tcp:10.0.0.1,1433', '(localdb)\\MSSQLLocalDB'];
    for (const ok of good) {
      const build = () => buildConnectionString({ query: 'select 1', database: 'd', server: ok });
      expect(build, ok).not.toThrow();
      expect(build()).toContain(`Server=${ok};`);
    }
  });
  it('database へのキーワード注入を拒否する', () => {
    for (const bad of ['usrap;FILEDSN=x', 'usrap}', '1db', '']) {
      expect(() => buildConnectionString({ query: 'select 1', database: bad }), bad).toThrow(
        /Invalid database name|database is required/,
      );
    }
  });
  it('未知の ODBC ドライバ名を拒否する', () => {
    expect(() =>
      buildConnectionString({ query: 'select 1', database: 'd', driver: 'X};FILEDSN=y' }),
    ).toThrow(/Unknown ODBC driver/);
    // 部分一致で通ってしまう綴りも拒否する (完全一致の集合メンバシップ)。
    expect(() =>
      buildConnectionString({ query: 'select 1', database: 'd', driver: 'ODBC Driver 17' }),
    ).toThrow(/Unknown ODBC driver/);
  });
  it('env 経由の注入も同じく拒否する', () => {
    process.env.DB_SERVER = 'localhost;FILEDSN=x';
    expect(() => buildConnectionString({ query: 'select 1', database: 'd' })).toThrow(
      /Invalid server/,
    );
  });
});

describe('normalizeConnExtra', () => {
  it('許可キーワードは正規形へ書き直す (キーは大小無視)', () => {
    expect(normalizeConnExtra('encrypt=no; TrustServerCertificate = yes ;')).toBe(
      'Encrypt=no;TrustServerCertificate=yes;',
    );
  });
  it('空文字は空のまま', () => {
    expect(normalizeConnExtra('')).toBe('');
  });
  it('許可リスト外のキーワードは投げる', () => {
    for (const bad of ['FILEDSN=\\\\evil\\s\\x.dsn', 'UID=sa', 'Driver={Other}']) {
      expect(() => normalizeConnExtra(bad), bad).toThrow(/is not allowed/);
    }
  });
  it('許可キーワードでも値の形が違えば投げる', () => {
    expect(() => normalizeConnExtra('Encrypt=no}{')).toThrow(/Invalid value/);
    expect(() => normalizeConnExtra('Connection Timeout=abc')).toThrow(/Invalid value/);
  });
  it('key=value の形でない断片は投げる', () => {
    expect(() => normalizeConnExtra('Encrypt')).toThrow(/expected "key=value"/);
  });
  it('DB_CONN_EXTRA 経由でも接続文字列に混ざらない', () => {
    process.env.DB_CONN_EXTRA = 'FILEDSN=\\\\evil\\s\\x.dsn';
    expect(() => buildConnectionString({ query: 'select 1', database: 'd' })).toThrow(
      /is not allowed/,
    );
    delete process.env.DB_CONN_EXTRA;
  });
});

describe('assertLooksLikeSelect', () => {
  it('SELECT を許可する', () => {
    expect(() => assertLooksLikeSelect('SELECT a, b FROM t')).not.toThrow();
  });
  it('WITH (CTE) を許可する', () => {
    expect(() => assertLooksLikeSelect('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
  });
  it('末尾セミコロン 1 個は許容する', () => {
    expect(() => assertLooksLikeSelect('SELECT 1;  ')).not.toThrow();
  });
  it('文中セミコロンは投げる', () => {
    expect(() => assertLooksLikeSelect('SELECT 1; DROP TABLE t')).toThrow(/multiple statements/i);
  });
  it('SELECT / WITH 以外で始まる文は投げる', () => {
    expect(() => assertLooksLikeSelect('UPDATE t SET a=1')).toThrow(/must start with SELECT/);
    expect(() => assertLooksLikeSelect('DELETE FROM t')).toThrow(/must start with SELECT/);
  });
  it('空クエリは投げる', () => {
    expect(() => assertLooksLikeSelect('   ;  ')).toThrow(/empty/);
  });
  // 形式チェックは読み取り専用の**強制ではない**。以下は素通りする — この事実を
  // テストで固定しておかないと、呼び出し側が再び「ガードがあるから安全」と読んでしまう。
  // 書き込みを止めるのは接続アカウントの権限 (db_datareader) であって本関数ではない。
  it('書き込みになりうる形が素通りすることを明示する (境界ではない証拠)', () => {
    for (const writes of [
      'SELECT * INTO dbo.evil FROM sys.objects',
      'WITH c AS (SELECT 1 a) DELETE FROM dbo.t',
      'SELECT 1 DELETE FROM dbo.t',
    ]) {
      expect(() => assertLooksLikeSelect(writes), writes).not.toThrow();
    }
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
  it('行数が MAX_DB_ROWS を超えたら列解決より前に投げる', () => {
    const rows = Array.from({ length: MAX_DB_ROWS + 1 }, (_, i) => ({ n: `A${i}`, v: 1 }));
    expect(() => rowsToItems(rows)).toThrow(
      new RegExp(`returned ${MAX_DB_ROWS + 1} rows \\(limit ${MAX_DB_ROWS}\\)`),
    );
    // 上げ方をメッセージに含める(`limits.ts` の様式)
    expect(() => rowsToItems(rows)).toThrow(/PIE_MAX_DB_ROWS/);
  });
  it('上限ちょうどの行数は通す', () => {
    const rows = Array.from({ length: MAX_DB_ROWS }, (_, i) => ({ n: `A${i}`, v: 1 }));
    expect(rowsToItems(rows)).toHaveLength(MAX_DB_ROWS);
  });
});
