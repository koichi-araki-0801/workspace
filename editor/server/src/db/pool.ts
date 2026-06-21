// =============================================================================
// pool.ts — SQL Server コネクションプール(フェーズ2 REST モード)
// =============================================================================
// `msnodesqlv8` + Windows 統合認証(Integrated auth)で接続する。
// `msnodesqlv8` はネイティブな optional 依存。`createRequire` で遅延ロードする
// ことで、ネイティブバインディングが無い環境でも `local` モードと `tsc` が動く。
// 実際に require されるのは最初のクエリ実行時(REST モード)だけ。
import { createRequire } from 'node:module';
import { config } from '../config.js';
import { logger } from '../logger.js';

const requireCjs = createRequire(import.meta.url);

interface Pool {
  open: () => void;
  on: (event: string, cb: (e: unknown) => void) => void;
  query: (sql: string, params: unknown[], cb: (err: unknown, rows: unknown[]) => void) => void;
}
interface Driver {
  Pool: new (opts: { connectionString: string; ceiling: number }) => Pool;
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  const driver = requireCjs('msnodesqlv8') as Driver; // ネイティブ; REST モードのみ
  const p = new driver.Pool({
    connectionString: config.db.connectionString,
    ceiling: config.db.poolMax,
  });
  p.on('error', (e: unknown) => logger.error({ err: e }, '[db] pool error'));
  p.open();
  pool = p;
  logger.info(`[db] pool opened (${config.db.server}/${config.db.name})`);
  return p;
}

/** パラメータ化ステートメントを実行し、最初の結果セットの行を resolve する。 */
export function query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const p = getPool();
  return new Promise((resolve, reject) => {
    p.query(sql, params, (err: unknown, rows: unknown[]) => {
      if (err) reject(err);
      else resolve((rows ?? []) as Record<string, unknown>[]);
    });
  });
}
