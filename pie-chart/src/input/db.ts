// =============================================================================
// input/db.ts — SQL Server に SELECT を投げ 2 列(name, value)を読み込む
// -----------------------------------------------------------------------------
// 仕様:
//   - 入力は単一の SELECT 文(複文・非 SELECT は拒否)。
//   - 列解決は xlsx_loader と同じ思想: `nameColumn`/`valueColumn` 指定時は列名で、
//     無指定時は結果セットの先頭 2 列を name/value とみなす(3 列以上はあいまいなので拒否)。
//   - name 空欄・value 数値変換不可は明示エラー、name/value とも空の行はスキップ。
// 接続は editor フェーズ2(`editor/server/src/db/pool.ts`)と同じ msnodesqlv8 +
// ODBC `Trusted_Connection=yes`(Windows 統合認証)パターンを踏襲する。ネイティブな
// optionalDependency のため `createRequire` で**遅延ロード**し、ドライバが無い環境でも
// 他入力(sample/json/xlsx)と `tsc` は動く。レンダリング層の外部依存ゼロ方針は不変で、
// DB 依存は本ファイルに隔離する(input/load.ts の xlsx 節と同列の入力層)。
// =============================================================================

import { createRequire } from 'node:module';

import { isSea } from '../runtime/seaRuntime.js';

// 通常の ESM(tsx)では `require` が無いので createRequire で作る。SEA(esbuild の cjs
// バンドル)の ambient `require` は **builtin 専用**で `msnodesqlv8` を解決できないが、
// `loadDbItems` 冒頭の `isSea()` ガードがそこへ到達させない(exe 版は DB 入力非対応)。
const requireCjs: NodeRequire =
  typeof require === 'function' ? require : createRequire(import.meta.url);

/** msnodesqlv8 のトップレベル one-shot API のうち本ローダが使う部分だけを型付け。 */
interface MsSql {
  query: (
    connectionString: string,
    sql: string,
    params: unknown[],
    cb: (err: unknown, rows: Record<string, unknown>[]) => void,
  ) => void;
}

interface LoadDbOpts {
  /** SELECT 文(単一・複文不可)。 */
  query: string;
  /** 接続先サーバ。未指定は env `DB_SERVER`、既定 `localhost`。 */
  server?: string;
  /** データベース名。未指定は env `DB_NAME`(これも無ければエラー)。 */
  database?: string;
  /** ODBC ドライバ名。未指定は env `DB_ODBC_DRIVER`、既定 `ODBC Driver 17 for SQL Server`。 */
  driver?: string;
  /** name 列の列名(指定時は valueColumn も必須)。無指定なら先頭 2 列を使う。 */
  nameColumn?: string;
  /** value 列の列名(指定時は nameColumn も必須)。 */
  valueColumn?: string;
  /** 追加の接続文字列断片。未指定は env `DB_CONN_EXTRA`。 */
  extra?: string;
}

/**
 * editor の `config.db.connectionString` と同形の ODBC 接続文字列を組み立てる。
 * 認証は Windows 統合認証固定(`Trusted_Connection=yes`)で資格情報は持たない。
 */
export function buildConnectionString(opts: LoadDbOpts): string {
  const driver = opts.driver ?? process.env.DB_ODBC_DRIVER ?? 'ODBC Driver 17 for SQL Server';
  const server = opts.server ?? process.env.DB_SERVER ?? 'localhost';
  const database = opts.database ?? process.env.DB_NAME;
  if (!database) {
    throw new Error('database is required (pass --db-name or set DB_NAME).');
  }
  const extra = opts.extra ?? process.env.DB_CONN_EXTRA ?? '';
  return `Driver={${driver}};Server=${server};Database=${database};Trusted_Connection=yes;${extra}`;
}

/**
 * 単一の SELECT(または CTE の WITH)文だけを許可する安全ガード。末尾セミコロン 1 個は
 * 許容するが、文中のセミコロン(複文)や非 SELECT は拒否する。CLI から任意 SQL を
 * 受け取るため、想定外の更新文・複文をここで弾く。
 */
export function assertSelectOnly(query: string): void {
  const trimmed = query.trim().replace(/;\s*$/, '').trim();
  if (trimmed === '') {
    throw new Error('Query is empty.');
  }
  if (trimmed.includes(';')) {
    throw new Error('Multiple statements are not allowed (single SELECT only).');
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Only SELECT queries are allowed.');
  }
}

/** 数値として読めなければ null(カンマ区切りは許容)。xlsx_loader と同じ流儀。 */
function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 結果セット(行オブジェクト配列)から name/value 2 列を解決し `[name, value][]` を返す。
 * 戻り値は data.ts の `normalizeInputItems` で `{name, value}` に整形される。
 */
export function rowsToItems(
  rows: Record<string, unknown>[],
  nameColumn?: string,
  valueColumn?: string,
): Array<[string, number]> {
  if (rows.length === 0) {
    throw new Error('Query returned no rows.');
  }
  const cols = Object.keys(rows[0]);

  let nameKey: string;
  let valueKey: string;
  if (nameColumn !== undefined || valueColumn !== undefined) {
    if (nameColumn === undefined || valueColumn === undefined) {
      throw new Error('Specify both name and value columns, or neither.');
    }
    if (!cols.includes(nameColumn)) {
      throw new Error(`Name column not found: "${nameColumn}" (available: ${cols.join(', ')}).`);
    }
    if (!cols.includes(valueColumn)) {
      throw new Error(`Value column not found: "${valueColumn}" (available: ${cols.join(', ')}).`);
    }
    nameKey = nameColumn;
    valueKey = valueColumn;
  } else {
    if (cols.length < 2) {
      throw new Error('Query must return at least 2 columns (name, value).');
    }
    if (cols.length > 2) {
      throw new Error(
        `Query returned ${cols.length} columns; specify name/value columns to disambiguate ` +
          `(available: ${cols.join(', ')}).`,
      );
    }
    [nameKey, valueKey] = cols;
  }

  const items: Array<[string, number]> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const nameRaw = row[nameKey];
    const valueRaw = row[valueKey];
    const name = nameRaw == null ? '' : String(nameRaw).trim();
    const valueIsBlank = valueRaw == null || valueRaw === '';

    if (!name && valueIsBlank) continue;
    if (!name) throw new Error(`Empty name at row ${i + 1}.`);
    const value = toNumber(valueRaw);
    if (value == null) {
      throw new Error(`Non-numeric value at row ${i + 1} (got "${String(valueRaw)}").`);
    }
    items.push([name, value]);
  }
  if (items.length === 0) {
    throw new Error('No usable data rows (all blank).');
  }
  return items;
}

/**
 * SQL Server に SELECT を投げ `[name, value][]` を読み出す。`msnodesqlv8`(ネイティブ
 * optional 依存)を遅延 require し、未導入時は明確なメッセージで失敗する。
 */
export async function loadDbItems(opts: LoadDbOpts): Promise<Array<[string, number]>> {
  // exe 版は DB 入力を非対応とする。ネイティブ `.node` はバンドルできず、外部配置は
  // 「署名の外にあるコードを実行時に読む」ことそのもの(= `runtime/seaRuntime.ts` が閉じた
  // 経路)なので、exe 隣へ msnodesqlv8 を置く運用は復活させない。dev(Node + tsx/CLI)を使う。
  if (isSea()) {
    throw new Error(
      'DB SELECT input (--sql) is not available in the packaged executable. ' +
        'Use the development CLI (Node + tsx) instead.',
    );
  }
  if (!opts.query || !opts.query.trim()) {
    throw new Error('query is required (e.g. "SELECT name, value FROM ...").');
  }
  assertSelectOnly(opts.query);
  const connectionString = buildConnectionString(opts);

  let sql: MsSql;
  try {
    sql = requireCjs('msnodesqlv8') as MsSql;
  } catch {
    throw new Error(
      'msnodesqlv8 is not installed. DB SELECT input needs the native driver ' +
        '(optionalDependency); install it or use a different input source.',
    );
  }

  const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    sql.query(connectionString, opts.query, [], (err, result) => {
      if (err) reject(err);
      else resolve(result ?? []);
    });
  });
  return rowsToItems(rows, opts.nameColumn, opts.valueColumn);
}
