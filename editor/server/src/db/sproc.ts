// =============================================================================
// sproc.ts — ゲートウェイ sproc 呼び出し + SQL エラー→`AppError` 変換 + 行値変換
// =============================================================================
// 各 repository は注入された `SprocClient` の `callSproc(SP.x, '操作', [...])` を呼ぶ。
// パラメータは位置指定(`@name=?`)でバインドし、値を SQL へ文字列補間しない
// (インジェクション回避)。実行面は `QueryFn` 1 本に閉じており、本番は `pool.query`、
// テストと rest e2e は in-memory フェイクを渡す。`mapSqlError` を通る経路が 1 本に
// なるので、フェイク側は生 SQL エラー相当(`number` 付き)を throw すればよい。
// SQL エラーは `server/db/sproc/*.sql` の THROW 番号規約に従って共有の `AppError`
// 種別へ変換する:
//   50404 → not_found, 50409 / 2627 / 2601 → conflict, 50000 / 50400 → validation。
// メッセージをユーザーへ転送するのは**自前 THROW の番号だけ**(`mapSqlError` の注記)。
import { type AppError, conflict, notFound, unexpected, validation } from '@editor/shared';
import { query } from './pool.js';

export interface Param {
  name: string;
  value: unknown;
}

/** 結果セットの 1 行。列名は SQL 側の日本語物理名がそのまま来る。 */
export type Row = Record<string, unknown>;

/** sproc の実行面。差し替え点はここ 1 つに限る。 */
export type QueryFn = (sql: string, values: unknown[]) => Promise<Row[]>;

/** repository が受け取る sproc 呼び出し口。 */
export interface SprocClient {
  callSproc<T = Row>(proc: string, 操作: string, params?: Param[]): Promise<T[]>;
}

/** パラメータ要素を作る。`undefined` は `callSproc` が SQL NULL へ正規化する。 */
export const p = (name: string, value: unknown): Param => ({ name, value: value ?? null });

/** 実行面から sproc 呼び出し口を組む。`@操作` を先頭にして呼び、結果セットの行を返す。 */
export function createSprocClient(query: QueryFn): SprocClient {
  return {
    async callSproc<T = Row>(proc: string, 操作: string, params: Param[] = []): Promise<T[]> {
      const all: Param[] = [{ name: '操作', value: 操作 }, ...params];
      const assigns = all.map((x) => `@${x.name}=?`).join(', ');
      const values = all.map((x) => x.value ?? null);
      try {
        return (await query(`EXEC ${proc} ${assigns}`, values)) as T[];
      } catch (e) {
        throw mapSqlError(e);
      }
    },
  };
}

/**
 * 本番の実行面。`pool.query` は最初の呼び出しでプールを開くので、ここでは接続を張らない
 * (`local` モードはネイティブドライバを require しないまま起動できる)。
 */
export const realSproc: SprocClient = createSprocClient((sql, values) => query(sql, values));

/** 注入をまだ受けていない呼び出し元のための別名。注入面が揃った時点で削除する。 */
export const callSproc: SprocClient['callSproc'] = realSproc.callSproc;

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

/**
 * 自前 `THROW` の番号(`server/db/sproc/*.sql` の規約)。**この集合のメッセージだけ**を
 * ユーザーへ転送する。文言は我々が書いた日本語で、内部構造を含まないことが分かっている。
 */
const OWN_THROW_NUMBERS = new Set([50000, 50400, 50404, 50409]);

/**
 * SQL エラー → `AppError`。
 *
 * ⚠ **SQL Server のシステムエラーの生メッセージを転送しないこと。** 2627(PK/一意制約違反)
 * と 2601(一意索引違反)は我々の `THROW` ではなくエンジンが出すもので、本文に制約名・
 * スキーマ修飾のテーブル名・重複キーの値がそのまま入る。ゲートウェイ sproc は DML を
 * TRY/CATCH で包まないので、実際の一意違反はここへ素通しで届く。分類(conflict)だけを
 * 使い、文言は定型文に固定して、原文は `cause`(ログ専用)へ落とす。
 */
function mapSqlError(e: unknown): AppError {
  const num = sqlNumber(e);
  // 自前 THROW 以外は、番号で分類できてもメッセージは使わない。
  const msg = num !== undefined && OWN_THROW_NUMBERS.has(num) ? sqlMessage(e) : undefined;
  if (num === 50404) return notFound(msg ?? '対象が見つかりません');
  if (num === 50409) return conflict(msg ?? 'すでに存在するか、競合しています');
  if (num === 2627 || num === 2601)
    return conflict('すでに存在するか、競合しています', { cause: e });
  if (num === 50000 || num === 50400) return validation(msg ?? '入力が正しくありません');
  // 未知の SQL/driver 障害: 技術的詳細をユーザーへ漏らさない。
  return unexpected('データベース処理に失敗しました', { cause: e });
}

/**
 * `msnodesqlv8` のエラー形状から SQL エラー番号を抽出する(ベストエフォート)。
 *
 * ⚠ **メッセージ本文から番号を拾うフォールバックを戻さないこと。** 本文に `50404` の
 * ような字面が含まれるだけで転送分岐が選ばれる = 「メッセージの中身が、そのメッセージを
 * 転送してよいかを決める」形になり、任意の DB エラー文をユーザーへ出す経路になる
 * (利用者が入れた値がエラー本文へ載る場面は珍しくない)。番号は構造化フィールドからのみ読む。
 */
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
  return undefined;
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
