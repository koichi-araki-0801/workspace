import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MsSqlDriver } from '../src/input/db.js';
import { DbStageError, InterruptedError } from '../src/input/dbStage.js';
import {
  type ChildDeps,
  type ChildRequest,
  type ParentDeps,
  RESPONSE_MARKER,
  defaultParentDeps,
  handleChildRequest,
  onInterruptSignals,
  parseChildRequest,
  parseChildResponse,
  runDbChild,
  runDbHelper,
} from '../src/runtime/dbChild.js';
import { sha256Hex } from '../src/runtime/nativeDriver.js';

const ARGS = { fund: 'F', baseDate: '20260930', chartType: 'T' };
const REQ: ChildRequest = {
  mode: 'fetch',
  connectionString: 'CS',
  proc: 'dbo.p',
  args: ARGS,
  timeoutMs: 1000,
  driverPath: 'C:\\x\\sqlserverv8.node',
};

function okDriver(rows: unknown[][]): MsSqlDriver {
  return {
    promises: {
      query: async () => ({ meta: [[{ name: 'n' }, { name: 'v' }]], results: [rows] }),
    },
  };
}

// 子の側の検査は実ファイルで行う: `<親>/<実行ごと>/sqlserverv8.node` を作り、親を許可する。
let childParent: string;
let driverFile: string;
beforeEach(() => {
  childParent = mkdtempSync(join(tmpdir(), 'piechart-child-'));
  const run = join(childParent, '1234-abcdef');
  mkdirSync(run);
  driverFile = join(run, 'sqlserverv8.node');
  writeFileSync(driverFile, 'x');
});
afterEach(() => rmSync(childParent, { recursive: true, force: true }));

function childDeps(over: Partial<ChildDeps> = {}): ChildDeps {
  return {
    expectedSha256: () => 'embedded',
    allowedParent: () => childParent,
    loadDriver: () => okDriver([['A', 1]]),
    verify: () => {},
    register: () => {},
    ...over,
  };
}

describe('handleChildRequest(子の側)', () => {
  it('照合 → 登録 → 読み込み → ストアド呼び出しの順に進み、items を返す', async () => {
    const order: string[] = [];
    const res = await handleChildRequest(
      { ...REQ, driverPath: driverFile },
      childDeps({
        verify: () => order.push('verify'),
        register: () => order.push('register'),
        loadDriver: () => {
          order.push('load');
          return okDriver([['A', 1]]);
        },
      }),
    );
    expect(order).toEqual(['verify', 'register', 'load']);
    expect(res).toEqual({ ok: true, items: [['A', 1]] });
  });
  it('読み込みの失敗は load 段階にし、アプリ制御のヒントを付ける', async () => {
    const res = await handleChildRequest(
      { ...REQ, driverPath: driverFile },
      childDeps({
        loadDriver: () => {
          throw new Error('The specified module could not be found.');
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, stage: 'load' });
    expect((res as { message: string }).message).toMatch(/AppLocker/);
  });
  it('照合の失敗は verify 段階のまま返す', async () => {
    const res = await handleChildRequest(
      { ...REQ, driverPath: driverFile },
      childDeps({
        verify: () => {
          throw new DbStageError('verify', 'mismatch');
        },
      }),
    );
    expect(res).toEqual({ ok: false, stage: 'verify', message: 'mismatch' });
  });
  it('load モードは読み込めた時点で成功', async () => {
    expect(
      await handleChildRequest(
        { ...REQ, driverPath: driverFile, mode: 'load', args: null },
        childDeps(),
      ),
    ).toEqual({
      ok: true,
      items: [],
    });
  });
  it('connect モードは SELECT 1 まで確かめる', async () => {
    const query = vi.fn(async () => ({ meta: [], results: [] }));
    const res = await handleChildRequest(
      { ...REQ, driverPath: driverFile, mode: 'connect', args: null },
      childDeps({ loadDriver: () => ({ promises: { query } }) }),
    );
    expect(res).toEqual({ ok: true, items: [] });
    expect(query).toHaveBeenCalledWith('CS', 'SELECT 1', [], { timeoutMs: 1000, raw: true });
  });
  it('検証には要求ではなく埋め込みのハッシュを使う', async () => {
    const verify = vi.fn();
    await handleChildRequest(
      { ...REQ, driverPath: driverFile, driverSha256: 'from-request' } as ChildRequest,
      childDeps({ verify }),
    );
    expect(verify).toHaveBeenCalledWith(driverFile, 'embedded');
  });
  it('埋め込みのハッシュが無ければ verify 段階で止まる', async () => {
    const loadDriver = vi.fn();
    const res = await handleChildRequest(
      { ...REQ, driverPath: driverFile },
      childDeps({ expectedSha256: () => '', loadDriver }),
    );
    expect(res).toMatchObject({ ok: false, stage: 'verify' });
    expect(loadDriver).not.toHaveBeenCalled();
  });
  it('許可された親の外・深さの違う場所・別名のファイルは読み込まない', async () => {
    const direct = join(childParent, 'sqlserverv8.node');
    writeFileSync(direct, 'x');
    const deep = join(childParent, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const deepFile = join(deep, 'sqlserverv8.node');
    writeFileSync(deepFile, 'x');
    const other = join(childParent, '1234-abcdef', 'other.node');
    writeFileSync(other, 'x');
    for (const driverPath of [direct, deepFile, other, join(childParent, 'nothing.node')]) {
      const loadDriver = vi.fn();
      const res = await handleChildRequest({ ...REQ, driverPath }, childDeps({ loadDriver }));
      expect(res).toMatchObject({ ok: false, stage: 'verify' });
      expect((res as { message: string }).message).toMatch(/outside the working folder/);
      expect(loadDriver).not.toHaveBeenCalled();
    }
  });
  it('許可された親のフォルダ自体が無ければ working folder not found', async () => {
    const loadDriver = vi.fn();
    const res = await handleChildRequest(
      { ...REQ, driverPath: driverFile },
      childDeps({ allowedParent: () => join(childParent, 'missing'), loadDriver }),
    );
    expect(res).toMatchObject({ ok: false, stage: 'verify' });
    expect((res as { message: string }).message).toMatch(/working folder not found/);
    expect(loadDriver).not.toHaveBeenCalled();
  });
  it('照合・登録には検査した実体のパスを渡す', async () => {
    const verify = vi.fn();
    const register = vi.fn();
    await handleChildRequest({ ...REQ, driverPath: driverFile }, childDeps({ verify, register }));
    const real = realpathSync(driverFile);
    expect(verify).toHaveBeenCalledWith(real, 'embedded');
    expect(register).toHaveBeenCalledWith(real);
  });
  it('fetch なのに args が無ければ child 段階', async () => {
    expect(
      await handleChildRequest({ ...REQ, driverPath: driverFile, args: null }, childDeps()),
    ).toMatchObject({
      ok: false,
      stage: 'child',
    });
  });
});

describe('parseChildRequest / parseChildResponse', () => {
  it('要求の形を検査する', () => {
    expect(parseChildRequest(JSON.stringify(REQ))).toEqual(REQ);
    expect(() => parseChildRequest('{"mode":"drop"}')).toThrow(/mode/);
    expect(() => parseChildRequest('not json')).toThrow();
  });
  it('応答は印の付いた行だけを読む(他の出力が混ざっても取り違えない)', () => {
    const stdout = [
      'warning: something printed to stdout',
      `${RESPONSE_MARKER}${JSON.stringify({ ok: true, items: [['A', 1]] })}`,
      '',
    ].join('\n');
    expect(parseChildResponse(stdout)).toEqual({ ok: true, items: [['A', 1]] });
  });
  it('印の付いた行が無い・形が違うなら投げる', () => {
    expect(() => parseChildResponse('{"ok":true,"items":[]}')).toThrow(/no response/);
    expect(() => parseChildResponse(`${RESPONSE_MARKER}{"ok":"yes"}`)).toThrow(/invalid/);
  });
});

describe('runDbChild', () => {
  it('stdin の要求を処理し、印付きの 1 行を書いて終了コードを返す', async () => {
    let out = '';
    const code = await runDbChild(
      Readable.from([JSON.stringify({ ...REQ, driverPath: driverFile })]),
      (s) => (out += s),
      childDeps(),
    );
    expect(code).toBe(0);
    expect(parseChildResponse(out)).toEqual({ ok: true, items: [['A', 1]] });
  });
  it('要求が壊れていれば child 段階で 1 を返す', async () => {
    let out = '';
    const code = await runDbChild(Readable.from(['{']), (s) => (out += s), childDeps());
    expect(code).toBe(1);
    expect(parseChildResponse(out)).toMatchObject({ ok: false, stage: 'child' });
  });
});

// ── 親の側 ──

/** 子プロセスの代わり。stdin に書かれた要求を記録し、指定どおりに応答して閉じる。 */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  received = '';
  constructor() {
    super();
    this.stdin.on('data', (c) => (this.received += c));
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
  respond(stdout: string, code: number, stderr = ''): void {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    setImmediate(() => this.emit('close', code));
  }
}

describe('runDbHelper(親の側)', () => {
  let parentDir: string;
  const bytes = Buffer.from('driver');
  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'piechart-helper-'));
  });
  afterEach(() => rmSync(parentDir, { recursive: true, force: true }));

  function deps(child: FakeChild, over: Partial<ParentDeps> = {}): ParentDeps {
    return {
      spawn: () => child as unknown as ChildProcess,
      execPath: 'pie-chart.exe',
      parentDir,
      driverBytes: () => bytes,
      driverSha256: sha256Hex(bytes),
      graceMs: 50,
      onSignal: () => () => {},
      warn: () => {},
      ...over,
    };
  }
  const HREQ = {
    mode: 'fetch' as const,
    connectionString: 'CS',
    proc: 'p',
    args: ARGS,
    timeoutMs: 60000,
  };

  it('成功したら items を返し、フォルダを消している', async () => {
    const child = new FakeChild();
    let runDir = '';
    const p = runDbHelper(HREQ, deps(child), { onRunDir: (d) => (runDir = d) });
    await new Promise((r) => setImmediate(r));
    child.respond(`${RESPONSE_MARKER}${JSON.stringify({ ok: true, items: [['A', 1]] })}\n`, 0);
    const res = await p;
    expect(res.items).toEqual([['A', 1]]);
    expect(res.runDir).toBe(runDir);
    expect(existsSync(runDir)).toBe(false);
    const sent = JSON.parse(child.received);
    expect(sent.driverPath).toBe(join(runDir, 'sqlserverv8.node'));
    expect(sent).not.toHaveProperty('driverSha256');
  });
  it('子のエラー応答は段階付きで投げ、フォルダは消す', async () => {
    const child = new FakeChild();
    let runDir = '';
    const p = runDbHelper(HREQ, deps(child), { onRunDir: (d) => (runDir = d) });
    await new Promise((r) => setImmediate(r));
    child.respond(
      `${RESPONSE_MARKER}${JSON.stringify({ ok: false, stage: 'connect', message: 'no' })}\n`,
      1,
    );
    await expect(p).rejects.toMatchObject({ stage: 'connect', message: 'no' });
    expect(existsSync(runDir)).toBe(false);
  });
  it('応答が無く異常終了したら child 段階で stderr の末尾を添える', async () => {
    const child = new FakeChild();
    const p = runDbHelper(HREQ, deps(child));
    await new Promise((r) => setImmediate(r));
    child.respond('', 3221225477, 'native crash detail');
    await expect(p).rejects.toThrow(/exited with code 3221225477[\s\S]*native crash detail/);
  });
  it('タイムアウト＋猶予を過ぎたら子を止め、child 段階で投げる', async () => {
    const child = new FakeChild();
    let runDir = '';
    const p = runDbHelper({ ...HREQ, timeoutMs: 20 }, deps(child), {
      onRunDir: (d) => (runDir = d),
    });
    await expect(p).rejects.toThrow(/did not finish within 70 ms/);
    expect(child.killed).toBe(true);
    expect(existsSync(runDir)).toBe(false);
  });
  it('Ctrl+C を受けたら子を止め、フォルダを消してから InterruptedError', async () => {
    const child = new FakeChild();
    let fire: () => void = () => {};
    let runDir = '';
    const p = runDbHelper(HREQ, deps(child, { onSignal: (h) => ((fire = h), () => {}) }), {
      onRunDir: (d) => (runDir = d),
    });
    await new Promise((r) => setImmediate(r));
    fire();
    await expect(p).rejects.toBeInstanceOf(InterruptedError);
    expect(child.killed).toBe(true);
    expect(existsSync(runDir)).toBe(false);
  });
  it('子の stdin が error を出しても落ちず、close で決着してフォルダを消す', async () => {
    const child = new FakeChild();
    let runDir = '';
    const p = runDbHelper(HREQ, deps(child), { onRunDir: (d) => (runDir = d) });
    await new Promise((r) => setImmediate(r));
    child.stdin.emit('error', new Error('write EPIPE'));
    child.stdout.emit('error', new Error('boom'));
    child.stderr.emit('error', new Error('boom'));
    child.respond('', 1);
    await expect(p).rejects.toMatchObject({ stage: 'child' });
    expect(existsSync(runDir)).toBe(false);
  });
  it('子を起動できなければ child 段階', async () => {
    const child = new FakeChild();
    const p = runDbHelper(HREQ, deps(child));
    await new Promise((r) => setImmediate(r));
    child.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toMatchObject({ stage: 'child' });
  });
  it('DB 機能なしでビルドした exe(ハッシュが空)は extract 段階で止まる', async () => {
    const child = new FakeChild();
    await expect(runDbHelper(HREQ, deps(child, { driverSha256: '' }))).rejects.toThrow(
      /without DB support/,
    );
  });
  it('書き出し先のフォルダが消えていたら extract で止まり、後片付けの警告は出さない', async () => {
    const child = new FakeChild();
    const warn = vi.fn();
    const p = runDbHelper(HREQ, deps(child, { warn }), {
      onRunDir: (d) => rmSync(d, { recursive: true, force: true }),
    });
    await expect(p).rejects.toMatchObject({ stage: 'extract' });
    // removeRunDir は存在しないフォルダに対して null を返す(force: true)ので警告しない。
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('onInterruptSignals / defaultParentDeps', () => {
  it('SIGINT と SIGBREAK に付け、外すと元の個数に戻る', () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGBREAK')];
    const off = onInterruptSignals(() => {});
    expect(process.listenerCount('SIGINT')).toBe(before[0] + 1);
    expect(process.listenerCount('SIGBREAK')).toBe(before[1] + 1);
    off();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGBREAK')]).toEqual(before);
  });
  it('既定の依存は現在の exe・30 秒の猶予・DB 無しのハッシュ(空)を指す', () => {
    const d = defaultParentDeps();
    expect(d.execPath).toBe(process.execPath);
    expect(d.graceMs).toBe(30000);
    expect(d.driverSha256).toBe('');
    expect(d.onSignal).toBe(onInterruptSignals);
  });
  it('既定の spawn / driverBytes / warn が動く(exe の外では driverBytes は投げる)', async () => {
    const d = defaultParentDeps();
    const child = d.spawn(process.execPath, ['-v']);
    const code = await new Promise((r) => child.once('close', r));
    expect(code).toBe(0);
    expect(() => d.driverBytes()).toThrow();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    d.warn('x');
    expect(spy).toHaveBeenCalledWith('x');
    spy.mockRestore();
  });
});
