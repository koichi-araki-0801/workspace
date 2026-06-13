/**
 * SQL Server connection pool (phase 2 REST mode) via msnodesqlv8 + Windows
 * Integrated auth.
 *
 * msnodesqlv8 is a NATIVE, optional dependency. It is loaded lazily with
 * `createRequire` so that `local` mode and `tsc` work without the native
 * binding present; it is only required the first time a query runs (REST mode).
 */
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
  const driver = requireCjs('msnodesqlv8') as Driver; // native; REST mode only
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

/** Run a parameterized statement; resolve the first result set's rows. */
export function query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const p = getPool();
  return new Promise((resolve, reject) => {
    p.query(sql, params, (err: unknown, rows: unknown[]) => {
      if (err) reject(err);
      else resolve((rows ?? []) as Record<string, unknown>[]);
    });
  });
}
