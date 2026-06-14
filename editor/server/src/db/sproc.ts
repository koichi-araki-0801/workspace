/**
 * Gateway stored-procedure caller + SQL-error → AppError mapping + row coercion.
 *
 * Every repository calls `callSproc(SP.x, '操作', [...])`. Params are bound
 * positionally (`@name=?`) so values are never interpolated into SQL. SQL
 * errors are translated to the shared {@link AppError} kinds by the THROW
 * number convention in `server/db/sproc/*.sql`:
 *   50404 → not_found, 50409 / 2627 / 2601 → conflict, 50000 → validation.
 */
import { type AppError, conflict, notFound, unexpected, validation } from '@editor/shared';
import { query } from './pool.js';

export interface Param {
  name: string;
  value: unknown;
}

/** Build a param entry; `undefined` is normalized to SQL NULL by callSproc. */
export const p = (name: string, value: unknown): Param => ({ name, value: value ?? null });

/** Call a gateway sproc with `@操作` first, returning the result-set rows. */
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

/** First row or null (read-one helpers). */
export function firstRow<T>(rows: T[]): T | null {
  return rows.length > 0 ? rows[0] : null;
}

// --- row value coercion (driver returns Date/Buffer/number for SQL types) ----

export function asString(v: unknown): string {
  return v == null ? '' : String(v);
}
export function asStringOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
/** SQL bit → boolean (driver may return 0/1, true/false). */
export function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}
/** SQL datetime2 → ISO string (driver may return Date or string). */
export function asIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
/** SQL varbinary → Buffer (driver returns Buffer/Uint8Array). */
export function asBuffer(v: unknown): Buffer | null {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}
export function asNumberOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

// --- error mapping -----------------------------------------------------------

function mapSqlError(e: unknown): AppError {
  const num = sqlNumber(e);
  const msg = sqlMessage(e);
  if (num === 50404) return notFound(msg ?? '対象が見つかりません');
  if (num === 50409 || num === 2627 || num === 2601)
    return conflict(msg ?? 'すでに存在するか、競合しています');
  if (num === 50000 || num === 50400) return validation(msg ?? '入力が正しくありません');
  // Unknown SQL/driver failure: never leak technical detail to the user.
  return unexpected('データベース処理に失敗しました', { cause: e });
}

/** Extract a SQL error number from msnodesqlv8's error shape (best-effort). */
function sqlNumber(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    for (const key of ['number', 'code', 'sqlstate'] as const) {
      if (typeof o[key] === 'number') return o[key] as number;
    }
    // msnodesqlv8 sometimes nests SQL errors under an array.
    const arr = o.odbcErrors ?? o.errors;
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.code === 'number')
      return arr[0].code as number;
  }
  // Fallback: parse "...(<num>)" or "SQL error <num>" from the message.
  const m = sqlMessage(e)?.match(/\b(5\d{4}|2627|2601)\b/);
  return m ? Number(m[1]) : undefined;
}

/** Extract a user-safe message, stripping ODBC "[...]" prefixes. */
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
