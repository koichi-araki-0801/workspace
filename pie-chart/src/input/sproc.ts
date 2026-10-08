// =============================================================================
// input/sproc.ts — ストアド入力の振り分け(開発版 / exe)と db-check の判定
// -----------------------------------------------------------------------------
// 開発版(Node + tsx)は node_modules の msnodesqlv8 をその場で読み込んで呼ぶ。exe は
// ドライバを一時フォルダへ書き出す必要があり、読み込んだ DLL はプロセスが生きている間
// 消せないので、子プロセスに任せる(`runtime/dbChild.ts`)。ストアドを呼ぶ処理と結果の判定は
// どちらも `db.ts` の同じ関数を通る。
// =============================================================================

import fs from 'node:fs';

import { DB_QUERY_TIMEOUT_S } from '../limits.js';
import { type HelperRequest, runDbHelper } from '../runtime/dbChild.js';
import { loadMsSqlDriver } from '../runtime/msDriver.js';
import { isSea } from '../runtime/seaRuntime.js';
import {
  type ConnOpts,
  type MsSqlDriver,
  callSprocItems,
  checkConnection,
  connectionStringFor,
  resolveConnTarget,
} from './db.js';
import { DbStageError, InterruptedError, errorMessage } from './dbStage.js';
import { type SprocArgs, resolveSprocName } from './sprocArgs.js';

interface SprocFetchResult {
  items: Array<[string, number]>;
  server: string;
  database: string;
  proc: string;
}

export interface SprocDeps {
  isSea: () => boolean;
  helper: (
    req: HelperRequest,
    hooks?: { onRunDir?: (dir: string) => void },
  ) => Promise<{ items: Array<[string, number]>; runDir: string }>;
  loadDriver: () => MsSqlDriver;
  timeoutS: number;
  procName: () => string;
  exists: (p: string) => boolean;
}

function defaultDeps(): SprocDeps {
  return {
    isSea,
    helper: (req, hooks) => runDbHelper(req, undefined, hooks),
    loadDriver: loadMsSqlDriver,
    timeoutS: DB_QUERY_TIMEOUT_S,
    procName: () => resolveSprocName(),
    exists: (p) => fs.existsSync(p),
  };
}

function loadDevDriver(deps: SprocDeps): MsSqlDriver {
  try {
    return deps.loadDriver();
  } catch (err) {
    if (err instanceof InterruptedError) throw err;
    throw new DbStageError(
      'load',
      `msnodesqlv8 is not installed or could not be loaded: ${errorMessage(err)}`,
    );
  }
}

/** ストアドを呼んで items と、JSON に記録する接続先を返す。 */
export async function fetchSprocItems(
  args: SprocArgs,
  conn: ConnOpts,
  deps: SprocDeps = defaultDeps(),
): Promise<SprocFetchResult> {
  const target = resolveConnTarget(conn);
  const connectionString = connectionStringFor(target);
  const proc = deps.procName();
  const timeoutMs = deps.timeoutS * 1000;
  const items = deps.isSea()
    ? (await deps.helper({ mode: 'fetch', connectionString, proc, args, timeoutMs })).items
    : await callSprocItems(loadDevDriver(deps), { connectionString, proc, args, timeoutMs });
  return { items, server: target.server, database: target.database, proc };
}

type CheckStage = 'extract' | 'verify' | 'load' | 'connect' | 'cleanup' | 'child';

interface DbCheckLine {
  stage: CheckStage;
  status: 'OK' | 'NG' | 'skipped';
  detail: string;
}

export function formatDbCheckLine(line: DbCheckLine): string {
  return `[db-check] ${line.stage}: ${line.status}${line.detail ? ` — ${line.detail}` : ''}`;
}

/**
 * ドライバを読み込めるか(と、`connect` なら接続できるか)を段階ごとに確かめる。配布先で
 * アプリ制御に止められるかどうかを、ストアドが無くても 1 コマンドで切り分けるため。
 */
export async function runDbCheck(
  opts: { connect: boolean; conn: ConnOpts },
  deps: SprocDeps = defaultDeps(),
): Promise<{ ok: boolean; lines: DbCheckLine[] }> {
  const timeoutMs = deps.timeoutS * 1000;
  const connectionString = opts.connect ? connectionStringFor(resolveConnTarget(opts.conn)) : '';
  const order: CheckStage[] = opts.connect
    ? ['extract', 'verify', 'load', 'connect']
    : ['extract', 'verify', 'load'];
  const lines: DbCheckLine[] = [];

  if (!deps.isSea()) {
    lines.push({ stage: 'extract', status: 'skipped', detail: 'development run' });
    lines.push({ stage: 'verify', status: 'skipped', detail: 'development run' });
    try {
      const driver = loadDevDriver(deps);
      lines.push({ stage: 'load', status: 'OK', detail: '' });
      if (opts.connect) {
        await checkConnection(driver, connectionString, timeoutMs);
        lines.push({ stage: 'connect', status: 'OK', detail: '' });
      }
    } catch (err) {
      if (err instanceof InterruptedError) throw err;
      const e = err instanceof DbStageError ? err : new DbStageError('child', errorMessage(err));
      lines.push({ stage: e.stage as CheckStage, status: 'NG', detail: e.message });
    }
    return { ok: lines.every((l) => l.status !== 'NG'), lines };
  }

  let runDir = '';
  const mode = opts.connect ? 'connect' : 'load';
  try {
    await deps.helper(
      { mode, connectionString, proc: '', args: null, timeoutMs },
      { onRunDir: (dir) => (runDir = dir) },
    );
    for (const stage of order) {
      lines.push({ stage, status: 'OK', detail: stage === 'extract' ? runDir : '' });
    }
  } catch (err) {
    if (err instanceof InterruptedError) throw err;
    const e = err instanceof DbStageError ? err : new DbStageError('child', errorMessage(err));
    const failedAt = order.indexOf(e.stage as CheckStage);
    if (failedAt === -1) {
      lines.push({ stage: 'child', status: 'NG', detail: e.message });
    } else {
      for (let i = 0; i < failedAt; i += 1) {
        lines.push({ stage: order[i], status: 'OK', detail: order[i] === 'extract' ? runDir : '' });
      }
      lines.push({ stage: order[failedAt], status: 'NG', detail: e.message });
    }
  }
  if (runDir) {
    const left = deps.exists(runDir);
    lines.push({ stage: 'cleanup', status: left ? 'NG' : 'OK', detail: left ? runDir : '' });
  }
  return { ok: lines.every((l) => l.status !== 'NG'), lines };
}
