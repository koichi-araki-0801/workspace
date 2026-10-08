import { describe, expect, it, vi } from 'vitest';

const seaState = vi.hoisted(() => ({ sea: false }));
vi.mock('../src/runtime/seaRuntime.js', () => ({ isSea: () => seaState.sea }));
vi.mock('../src/runtime/dbChild.js', () => ({
  runDbHelper: vi.fn(
    async (_req: unknown, _deps: unknown, hooks?: { onRunDir?: (d: string) => void }) => {
      hooks?.onRunDir?.('Z:\no-such-dir\pie-chart-db\1-x');
      return { items: [['H', 1]], runDir: 'Z:\no-such-dir' };
    },
  ),
}));
vi.mock('../src/runtime/msDriver.js', () => ({
  loadMsSqlDriver: () => ({
    promises: {
      query: async () => ({ meta: [[{ name: 'n' }, { name: 'v' }]], results: [[['D', 2]]] }),
    },
  }),
}));
import type { MsSqlDriver } from '../src/input/db.js';
import { DbStageError } from '../src/input/dbStage.js';
import {
  type SprocDeps,
  fetchSprocItems,
  formatDbCheckLine,
  runDbCheck,
} from '../src/input/sproc.js';

const ARGS = { fund: 'F', baseDate: '20260930', chartType: 'T' };
const CONN = { server: 'db01', database: 'usrap' };

function driver(rows: unknown[][]): MsSqlDriver {
  return {
    promises: {
      query: vi.fn(async () => ({ meta: [[{ name: 'n' }, { name: 'v' }]], results: [rows] })),
    },
  };
}

function deps(over: Partial<SprocDeps> = {}): SprocDeps {
  return {
    isSea: () => false,
    helper: vi.fn(async () => ({ items: [['H', 1]] as Array<[string, number]>, runDir: 'R' })),
    loadDriver: () => driver([['D', 2]]),
    timeoutS: 60,
    procName: () => 'dbo.p',
    exists: () => false,
    ...over,
  };
}

describe('fetchSprocItems', () => {
  it('開発版はその場でドライバを読んで呼ぶ', async () => {
    const res = await fetchSprocItems(ARGS, CONN, deps());
    expect(res).toEqual({ items: [['D', 2]], server: 'db01', database: 'usrap', proc: 'dbo.p' });
  });
  it('開発版でドライバが読めなければ load 段階', async () => {
    const d = deps({
      loadDriver: () => {
        throw new Error("Cannot find module 'msnodesqlv8'");
      },
    });
    await expect(fetchSprocItems(ARGS, CONN, d)).rejects.toMatchObject({ stage: 'load' });
  });
  it('exe は子プロセスに fetch を頼み、タイムアウトをミリ秒で渡す', async () => {
    const d = deps({ isSea: () => true });
    const res = await fetchSprocItems(ARGS, CONN, d);
    expect(res.items).toEqual([['H', 1]]);
    expect(d.helper).toHaveBeenCalledWith({
      mode: 'fetch',
      connectionString:
        'Driver={ODBC Driver 17 for SQL Server};Server=db01;Database=usrap;Trusted_Connection=yes;',
      proc: 'dbo.p',
      args: ARGS,
      timeoutMs: 60000,
    });
  });
});

describe('runDbCheck', () => {
  it('exe で成功したら extract〜cleanup まで OK(connect なし)', async () => {
    const d = deps({
      isSea: () => true,
      helper: vi.fn(async (_req, hooks) => {
        hooks?.onRunDir?.('C:\\T\\pie-chart-db\\1-abcdef');
        return { items: [], runDir: 'C:\\T\\pie-chart-db\\1-abcdef' };
      }),
    });
    const res = await runDbCheck({ connect: false, conn: {} }, d);
    expect(res.ok).toBe(true);
    expect(res.lines.map((l) => `${l.stage}:${l.status}`)).toEqual([
      'extract:OK',
      'verify:OK',
      'load:OK',
      'cleanup:OK',
    ]);
    expect(res.lines[0].detail).toBe('C:\\T\\pie-chart-db\\1-abcdef');
  });
  it('load で止まったら、それより前は OK、load は NG、cleanup も報告する', async () => {
    const d = deps({
      isSea: () => true,
      exists: () => true,
      helper: vi.fn(async (_req, hooks) => {
        hooks?.onRunDir?.('RD');
        throw new DbStageError('load', 'blocked');
      }),
    });
    const res = await runDbCheck({ connect: true, conn: CONN }, d);
    expect(res.ok).toBe(false);
    expect(res.lines.map((l) => `${l.stage}:${l.status}`)).toEqual([
      'extract:OK',
      'verify:OK',
      'load:NG',
      'cleanup:NG',
    ]);
    expect(res.lines[2].detail).toBe('blocked');
  });
  it('child 段階の失敗はそのまま child: NG として出す', async () => {
    const d = deps({
      isSea: () => true,
      helper: vi.fn(async () => {
        throw new DbStageError('child', 'crashed');
      }),
    });
    const res = await runDbCheck({ connect: false, conn: {} }, d);
    expect(res.lines.map((l) => `${l.stage}:${l.status}`)).toEqual(['child:NG']);
  });
  it('開発版は extract / verify を skipped にし、connect まで確かめる', async () => {
    const res = await runDbCheck({ connect: true, conn: CONN }, deps());
    expect(res.ok).toBe(true);
    expect(res.lines.map((l) => `${l.stage}:${l.status}`)).toEqual([
      'extract:skipped',
      'verify:skipped',
      'load:OK',
      'connect:OK',
    ]);
  });
  it('開発版でドライバが読めなければ load: NG', async () => {
    const d = deps({
      loadDriver: () => {
        throw new Error('missing');
      },
    });
    const res = await runDbCheck({ connect: false, conn: {} }, d);
    expect(res.ok).toBe(false);
    expect(res.lines[2]).toMatchObject({ stage: 'load', status: 'NG' });
  });
  it('formatDbCheckLine', () => {
    expect(formatDbCheckLine({ stage: 'load', status: 'NG', detail: 'x' })).toBe(
      '[db-check] load: NG — x',
    );
    expect(formatDbCheckLine({ stage: 'load', status: 'OK', detail: '' })).toBe(
      '[db-check] load: OK',
    );
  });
});

describe('既定の依存(実体を差し替えた状態)', () => {
  it('exe では helper と procName と exists が既定のものを通る', async () => {
    seaState.sea = true;
    try {
      const res = await fetchSprocItems(ARGS, CONN);
      expect(res.items).toEqual([['H', 1]]);
      const check = await runDbCheck({ connect: false, conn: {} });
      expect(check.lines.map((l) => `${l.stage}:${l.status}`)).toEqual([
        'extract:OK',
        'verify:OK',
        'load:OK',
        'cleanup:OK',
      ]);
    } finally {
      seaState.sea = false;
    }
  });
  it('開発版では loadDriver が既定のものを通る', async () => {
    const res = await fetchSprocItems(ARGS, CONN);
    expect(res.items).toEqual([['D', 2]]);
  });
});
