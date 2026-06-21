// =============================================================================
// sproc.ts — ゲートウェイ sproc 呼び出し + SQL エラー→`AppError` 変換 + 行値変換
// =============================================================================
// 各 repository は `callSproc(SP.x, '操作', [...])` を呼ぶ。パラメータは位置指定
// (`@name=?`) でバインドし、値を SQL へ文字列補間しない(インジェクション回避)。
// SQL エラーは `server/db/sproc/*.sql` の THROW 番号規約に従って共有の `AppError`
// 種別へ変換する:
//   50404 → not_found, 50409 / 2627 / 2601 → conflict, 50000 → validation。
import { type AppError, conflict, notFound, unexpected, validation } from '@editor/shared';
import { query } from './pool.js';

export interface Param {
  name: string;
  value: unknown;
}

/** パラメータ要素を作る。`undefined` は `callSproc` が SQL NULL へ正規化する。 */
export const p = (name: string, value: unknown): Param => ({ name, value: value ?? null });

/** ゲートウェイ sproc を `@操作` を先頭にして呼び、結果セットの行を返す。 */
export async function callSproc<T = Record<string, unknown>>(
  proc: string,
  操作: string,
  params: Param[] = [],
): Promise<T[]> {
  const all: Param[] = [{ name: '操作', value: 操作 }, ...params];
  const assigns = all.map((x) => `@${x.name}=?`).join(', ');
  const values = all.map((x) => x.value ?? null);
  try {
    return (await query(`EXEC ${proc} ${assigns}`, values)) as T[];
  } catch (e) {
    throw mapSqlError(e);
  }
}

/** 先頭行、無ければ null(単一行取得ヘルパ)。 */
export function firstRow<T>(rows: T[]): T | null {
  return rows.length > 0 ? rows[0] : null;
}

// ── 1. 行値の変換(driver は SQL 型を Date/Buffer/number で返す) ──

export function asString(v: unknown): string {
  return v == null ? '' : String(v);
}
export function asStringOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
/** SQL bit → boolean(driver は 0/1, true/false のいずれかを返しうる)。 */
export function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}
/** SQL datetime2 → ISO 文字列(driver は Date か string を返しうる)。 */
export function asIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
/** SQL varbinary → Buffer(driver は Buffer/Uint8Array を返す)。 */
export function asBuffer(v: unknown): Buffer | null {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}
export function asNumberOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

// ── 2. エラー変換 ──

function mapSqlError(e: unknown): AppError {
  const num = sqlNumber(e);
  const msg = sqlMessage(e);
  if (num === 50404) return notFound(msg ?? '対象が見つかりません');
  if (num === 50409 || num === 2627 || num === 2601)
    return conflict(msg ?? 'すでに存在するか、競合しています');
  if (num === 50000 || num === 50400) return validation(msg ?? '入力が正しくありません');
  // 未知の SQL/driver 障害: 技術的詳細をユーザーへ漏らさない。
  return unexpected('データベース処理に失敗しました', { cause: e });
}

/** `msnodesqlv8` のエラー形状から SQL エラー番号を抽出する(ベストエフォート)。 */
function sqlNumber(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    for (const key of ['number', 'code', 'sqlstate'] as const) {
      if (typeof o[key] === 'number') return o[key] as number;
    }
    // `msnodesqlv8` は SQL エラーを配列下にネストすることがある。
    const arr = o.odbcErrors ?? o.errors;
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.code === 'number')
      return arr[0].code as number;
  }
  // フォールバック: メッセージから "...(<num>)" や "SQL error <num>" を解析する。
  const m = sqlMessage(e)?.match(/\b(5\d{4}|2627|2601)\b/);
  return m ? Number(m[1]) : undefined;
}

/** ODBC の "[...]" 接頭辞を剥がしてユーザーに見せて安全なメッセージを抽出する。 */
function sqlMessage(e: unknown): string | undefined {
  const raw =
    e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
      ? (e as { message: string }).message
      : undefined;
  if (!raw) return undefined;
  // "[Microsoft][ODBC Driver 17 for SQL Server][SQL Server]<本文>" → <本文>
  const stripped = raw.replace(/^(\[[^\]]*\])+/, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}
