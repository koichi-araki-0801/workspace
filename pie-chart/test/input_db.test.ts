import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MsSqlDriver,
  type MsSqlResults,
  buildConnectionString,
  buildSprocStatement,
  callSprocItems,
  checkConnection,
  classifySqlError,
  normalizeConnExtra,
  pickSingleResultSet,
  resolveConnTarget,
  rowsToItems,
} from '../src/input/db.js';
import { DbStageError } from '../src/input/dbStage.js';
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
    expect(buildConnectionString({ database: 'usrap' })).toBe(
      'Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=usrap;Trusted_Connection=yes;',
    );
  });
  it('明示の server / driver / extra を反映する', () => {
    expect(
      buildConnectionString({
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
    expect(buildConnectionString({})).toContain('Database=fromenv;');
  });
  it('database 未指定 (env も無し) は投げる', () => {
    expect(() => buildConnectionString({})).toThrow(/database is required/);
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
      expect(() => buildConnectionString({ database: 'd', server: bad }), bad).toThrow(
        /Invalid server/,
      );
    }
  });
  it('正当な server の形は通す (インスタンス名・ポート・localdb)', () => {
    const good = ['localhost', 'db01\\SQLEXPRESS', 'tcp:10.0.0.1,1433', '(localdb)\\MSSQLLocalDB'];
    for (const ok of good) {
      const build = () => buildConnectionString({ database: 'd', server: ok });
      expect(build, ok).not.toThrow();
      expect(build()).toContain(`Server=${ok};`);
    }
  });
  it('database へのキーワード注入を拒否する', () => {
    for (const bad of ['usrap;FILEDSN=x', 'usrap}', '1db', '']) {
      expect(() => buildConnectionString({ database: bad }), bad).toThrow(
        /Invalid database name|database is required/,
      );
    }
  });
  it('未知の ODBC ドライバ名を拒否する', () => {
    expect(() => buildConnectionString({ database: 'd', driver: 'X};FILEDSN=y' })).toThrow(
      /Unknown ODBC driver/,
    );
    // 部分一致で通ってしまう綴りも拒否する (完全一致の集合メンバシップ)。
    expect(() => buildConnectionString({ database: 'd', driver: 'ODBC Driver 17' })).toThrow(
      /Unknown ODBC driver/,
    );
  });
  it('env 経由の注入も同じく拒否する', () => {
    process.env.DB_SERVER = 'localhost;FILEDSN=x';
    expect(() => buildConnectionString({ database: 'd' })).toThrow(/Invalid server/);
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
    expect(() => buildConnectionString({ database: 'd' })).toThrow(/is not allowed/);
    delete process.env.DB_CONN_EXTRA;
  });
});

describe('resolveConnTarget', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('JSON に記録する server / database を解決済みの値で返す', () => {
    delete process.env.DB_SERVER;
    expect(resolveConnTarget({ database: 'usrap' })).toEqual({
      driver: 'ODBC Driver 17 for SQL Server',
      server: 'localhost',
      database: 'usrap',
      extra: '',
    });
  });
});

const ARGS = { fund: '0331A', baseDate: '20260930', chartType: '資産配分' };

/** 呼び出しを記録し、指定した結果か例外を返すフェイクのドライバ。 */
function fakeDriver(result: MsSqlResults | Error) {
  const calls: unknown[][] = [];
  const driver: MsSqlDriver = {
    promises: {
      query: async (...args) => {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { driver, calls };
}

const twoCols = [{ name: 'name' }, { name: 'value' }];

describe('buildSprocStatement', () => {
  it('パラメータ名つきの EXEC を組み立て、値は ? で受ける', () => {
    expect(buildSprocStatement('dbo.pie_chart_items')).toBe(
      'EXEC dbo.pie_chart_items @ファンドコード=?, @基準日=?, @グラフ種別=?',
    );
  });
});

describe('pickSingleResultSet', () => {
  it('列の無いセット(件数だけのもの)は無視する', () => {
    const rows = [['A', 1]];
    expect(pickSingleResultSet({ meta: [[], twoCols, []], results: [[], rows, []] })).toBe(rows);
  });
  it('列のあるセットが 0 個・2 個以上なら query 段階のエラー', () => {
    expect(() => pickSingleResultSet({ meta: [[]], results: [[]] })).toThrow(
      /no result set with columns/,
    );
    try {
      pickSingleResultSet({ meta: [twoCols, twoCols], results: [[], []] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DbStageError);
      expect((e as DbStageError).stage).toBe('query');
      expect((e as DbStageError).message).toMatch(/2 result sets with columns/);
    }
  });
  it('列が 2 列でなければ列名つきでエラー', () => {
    const meta = [[{ name: 'a' }, { name: 'b' }, { name: 'c' }]];
    expect(() => pickSingleResultSet({ meta, results: [[]] })).toThrow(/3 columns.*a, b, c/);
  });
});

describe('rowsToItems', () => {
  it('先頭 2 列を name / value として読む', () => {
    expect(
      rowsToItems([
        ['国内株式', 60.5],
        ['外国株式', '30'],
      ]),
    ).toEqual([
      ['国内株式', 60.5],
      ['外国株式', 30],
    ]);
  });
  it('桁区切りの文字列は読み、空行は飛ばし、名前だけ空の行はエラー', () => {
    expect(
      rowsToItems([
        ['A', '1,234.5'],
        [null, null],
        ['B', 1],
      ]),
    ).toEqual([
      ['A', 1234.5],
      ['B', 1],
    ]);
    expect(() => rowsToItems([[null, 3]])).toThrow(/Empty name at row 1/);
  });
  it('0 行・全行空・上限超えは query 段階のエラー', () => {
    expect(() => rowsToItems([])).toThrow(/returned no rows/);
    expect(() => rowsToItems([[null, null]])).toThrow(/all blank/);
    const many = Array.from({ length: MAX_DB_ROWS + 1 }, (_, i) => [`n${i}`, 1]);
    expect(() => rowsToItems(many)).toThrow(/limit/);
  });
});

describe('classifySqlError', () => {
  it('SQLSTATE 08 / 28 / IM002 は connect、それ以外は query', () => {
    const mk = (sqlstate: string) => Object.assign(new Error('x'), { sqlstate });
    expect(classifySqlError(mk('08001')).stage).toBe('connect');
    expect(classifySqlError(mk('28000')).stage).toBe('connect');
    expect(classifySqlError(mk('IM002')).stage).toBe('connect');
    expect(classifySqlError(mk('42000')).stage).toBe('query');
    expect(classifySqlError(mk('42000')).message).toBe('x (SQLSTATE 42000)');
    expect(classifySqlError(new Error('plain')).stage).toBe('query');
  });
  it('DbStageError はそのまま返す', () => {
    const e = new DbStageError('load', 'y');
    expect(classifySqlError(e)).toBe(e);
  });
});

describe('callSprocItems', () => {
  it('EXEC 文・値の順序・timeoutMs・raw を渡し、items を返す', async () => {
    const { driver, calls } = fakeDriver({ meta: [twoCols], results: [[['A', 1]]] });
    const items = await callSprocItems(driver, {
      connectionString: 'CS',
      proc: 'dbo.p',
      args: ARGS,
      timeoutMs: 60000,
    });
    expect(items).toEqual([['A', 1]]);
    expect(calls).toEqual([
      [
        'CS',
        'EXEC dbo.p @ファンドコード=?, @基準日=?, @グラフ種別=?',
        ['0331A', '20260930', '資産配分'],
        { timeoutMs: 60000, raw: true },
      ],
    ]);
  });
  it('ドライバの例外は SQLSTATE で段階を振り分ける', async () => {
    const err = Object.assign(new Error('login failed'), { sqlstate: '28000' });
    const { driver } = fakeDriver(err);
    await expect(
      callSprocItems(driver, { connectionString: 'CS', proc: 'p', args: ARGS, timeoutMs: 1 }),
    ).rejects.toMatchObject({ stage: 'connect' });
  });
  it('行の変換で出た素の Error も query 段階にする', async () => {
    const { driver } = fakeDriver({ meta: [twoCols], results: [[['A', 'abc']]] });
    await expect(
      callSprocItems(driver, { connectionString: 'CS', proc: 'p', args: ARGS, timeoutMs: 1 }),
    ).rejects.toMatchObject({ stage: 'query' });
  });
});

describe('checkConnection', () => {
  it('SELECT 1 を投げ、失敗は connect 段階にする', async () => {
    const ok = fakeDriver({ meta: [[{ name: '' }]], results: [[[1]]] });
    await checkConnection(ok.driver, 'CS', 5000);
    expect(ok.calls[0]).toEqual(['CS', 'SELECT 1', [], { timeoutMs: 5000, raw: true }]);
    const bad = fakeDriver(Object.assign(new Error('nope'), { sqlstate: '42000' }));
    await expect(checkConnection(bad.driver, 'CS', 5000)).rejects.toMatchObject({
      stage: 'connect',
    });
  });
});
