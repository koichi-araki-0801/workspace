// =============================================================================
// sea_localdb.test.ts — 配布 exe でストアドを呼ぶ受入テスト(LocalDB があるときだけ)
// -----------------------------------------------------------------------------
// 単体テストはドライバをフェイクにしているので、実際のドライバ・ODBC・SQL Server を通す
// 経路はここだけで確かめる。この端末の (localdb)\MSSQLLocalDB に使い捨ての DB を作り、
// テスト用のストアドを入れて、完成した exe から呼ぶ。終わったら DB を DROP する。
// 実行条件: PIECHART_SEA_TEST=1、dist-exe/pie-chart.exe(DB 機能つき)、sqllocaldb。
// =============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'dist-exe', 'pie-chart.exe');
const hasLocalDb = spawnSync('sqllocaldb', ['info'], { stdio: 'ignore' }).status === 0;
const enabled = process.env.PIECHART_SEA_TEST === '1' && existsSync(exe) && hasLocalDb;

const SERVER = '(localdb)\\MSSQLLocalDB';
const DB = `piechart_sproc_test_${process.pid}`;
const conn = (db: string) =>
  `Driver={ODBC Driver 17 for SQL Server};Server=${SERVER};Database=${db};Trusted_Connection=yes;`;

interface Sql {
  promises: { query(c: string, s: string, p?: unknown[]): Promise<unknown> };
}

const PROCS = [
  // 正常: NOCOUNT を付けず、件数だけの結果(INSERT)を含む。
  `CREATE PROCEDURE dbo.pie_chart_items @ファンドコード nvarchar(64), @基準日 nvarchar(8), @グラフ種別 nvarchar(64) AS
   BEGIN
     DECLARE @t TABLE (name nvarchar(100), value decimal(9, 1));
     INSERT INTO @t VALUES (N'国内株式', 60.5), (N'外国株式', 30.0), (N'その他', 9.5);
     SELECT name, value FROM @t
     WHERE @ファンドコード = N'F001' AND @基準日 = N'20260930' AND @グラフ種別 = N'資産配分'
     ORDER BY value DESC;
   END`,
  `CREATE PROCEDURE dbo.two_sets @ファンドコード nvarchar(64), @基準日 nvarchar(8), @グラフ種別 nvarchar(64) AS
   BEGIN SET NOCOUNT ON; SELECT 1 AS a, 2 AS b; SELECT N'x' AS name, 1 AS value; END`,
  // メッセージは ASCII: msnodesqlv8 が日本語のサーバメッセージを誤って復号するため(既知の制約)。
  `CREATE PROCEDURE dbo.throws @ファンドコード nvarchar(64), @基準日 nvarchar(8), @グラフ種別 nvarchar(64) AS
   BEGIN THROW 50000, N'sproc test failure', 1; END`,
  // 40 行: 取得はできるが描画の項目数上限(32)を超える。
  `CREATE PROCEDURE dbo.too_many @ファンドコード nvarchar(64), @基準日 nvarchar(8), @グラフ種別 nvarchar(64) AS
   BEGIN SET NOCOUNT ON;
     SELECT TOP 40 CONCAT(N'項目', ROW_NUMBER() OVER (ORDER BY (SELECT 1))) AS name, 1 AS value
     FROM sys.all_objects;
   END`,
];

describe.skipIf(!enabled)('配布 exe でストアドを呼ぶ(LocalDB)', () => {
  let sql: Sql;
  let work: string;
  const runDirRoot = join(tmpdir(), 'pie-chart-db');
  const listRunDirs = () => (existsSync(runDirRoot) ? readdirSync(runDirRoot).sort() : []);

  beforeAll(async () => {
    sql = require('msnodesqlv8') as Sql;
    await sql.promises.query(conn('master'), `CREATE DATABASE [${DB}]`);
    for (const proc of PROCS) await sql.promises.query(conn(DB), proc);
    work = mkdtempSync(join(tmpdir(), 'piechart-localdb-'));
  }, 120_000);

  afterAll(async () => {
    if (work) rmSync(work, { recursive: true, force: true });
    if (sql) {
      await sql.promises.query(
        conn('master'),
        `ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}];`,
      );
    }
  }, 120_000);

  function runExe(proc: string, out: string) {
    return spawnSync(
      exe,
      [
        'one',
        '--fund',
        'F001',
        '--base-date',
        '2026-09-30',
        '--chart-type',
        '資産配分',
        '--output-file',
        out,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DB_SERVER: SERVER, DB_NAME: DB, PIE_DB_PROC: proc },
      },
    );
  }

  it('SVG と JSON を出し、JSON から描き直すと同じ SVG になり、フォルダを残さない', () => {
    const before = listRunDirs();
    const svg = join(work, 'ok.svg');
    const r = runExe('dbo.pie_chart_items', svg);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(readFileSync(join(work, 'ok.json'), 'utf8'));
    const entry = json['F001_20260930_資産配分'];
    expect(entry.items).toEqual([
      { name: '国内株式', value: 60.5 },
      { name: '外国株式', value: 30 },
      { name: 'その他', value: 9.5 },
    ]);
    expect(entry.source).toMatchObject({
      server: SERVER,
      database: DB,
      proc: 'dbo.pie_chart_items',
    });
    const svg2 = join(work, 'ok2.svg');
    execFileSync(exe, ['one', '--data-file', join(work, 'ok.json'), '--output-file', svg2]);
    expect(readFileSync(svg2, 'utf8')).toBe(readFileSync(svg, 'utf8'));
    expect(listRunDirs()).toEqual(before);
  });

  it('列のある結果セットが 2 つなら query エラー', () => {
    const r = runExe('dbo.two_sets', join(work, 'two.svg'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[db:query\].*2 result sets with columns/);
  });

  it('THROW したら query エラーでメッセージが伝わる', () => {
    const r = runExe('dbo.throws', join(work, 'throw.svg'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[db:query\].*sproc test failure/);
  });

  it('描画で失敗しても(項目数の上限)、取得した JSON は残る', () => {
    const r = runExe('dbo.too_many', join(work, 'many.svg'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Too many items: 40/);
    expect(existsSync(join(work, 'many.json'))).toBe(true);
    expect(existsSync(join(work, 'many.svg'))).toBe(false);
  });

  it('接続できなければ connect エラー', () => {
    const r = spawnSync(
      exe,
      [
        'one',
        '--fund',
        'F001',
        '--base-date',
        '20260930',
        '--chart-type',
        'x',
        '--output-file',
        join(work, 'c.svg'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DB_SERVER: 'no-such-host-piechart',
          DB_NAME: DB,
          DB_CONN_EXTRA: 'Login Timeout=3;',
        },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[db:connect\]/);
    // 存在しないホストへの接続は、ドライバの再試行で 16 秒ほどかかる。
  }, 60_000);
});
