import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// config.ts と logger.ts は import 時に env を読むので、ここで一時ディレクトリへ逸らし、
// 同時実行の枠は 1・待ち 1 にして満杯を作りやすくする。
const { execFileMock, tmpRoot } = vi.hoisted(() => {
  const root = `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/editor-scriptrunner-test`;
  process.env.LOG_DIR = `${root}/logs`;
  process.env.TEMPLATES_DIR = `${root}/templates`;
  process.env.PENDING_DIR = `${root}/pending`;
  process.env.GENERATE_MAX_CONCURRENCY = '1';
  process.env.GENERATE_MAX_QUEUE = '1';
  return { execFileMock: vi.fn(), tmpRoot: root };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { config } from '../src/config.js';
import {
  assertScriptFingerprint,
  GENERATE_QUEUE_FULL_MESSAGE,
  GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
  REPORT_FINGERPRINT_MISMATCH_MESSAGE,
  REPORT_QUEUE_FULL_MESSAGE,
  runPythonScript,
  ScriptRunError,
  type ScriptSpec,
  withGeneratorSlot,
} from '../src/generate/scriptRunner';

type Callback = (
  err: (Error & { killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const spec = (over: Partial<ScriptSpec> = {}): ScriptSpec => ({
  script: path.join(tmpRoot, 'gen', 'src', 'run.py'),
  scriptSha256: undefined,
  timeoutMs: 1234,
  label: 'generator',
  ...over,
});

describe('runPythonScript', () => {
  it('passes python.args, script and args with script dir as cwd', async () => {
    execFileMock.mockImplementation((_b, _a, _o, cb: Callback) => {
      cb(null, '', '');
      return { on: vi.fn() };
    });
    const s = spec();
    await runPythonScript(s, ['a', 'b']);
    const [bin, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; timeout: number },
    ];
    expect(bin).toBe(config.python.bin);
    expect(args).toEqual([...config.python.args, s.script, 'a', 'b']);
    expect(opts.cwd).toBe(path.dirname(s.script));
    expect(opts.timeout).toBe(1234);
  });

  it('rejects with ScriptRunError timedOut=true when killed', async () => {
    execFileMock.mockImplementation((_b, _a, _o, cb: Callback) => {
      cb(Object.assign(new Error('timeout'), { killed: true }), '', 'boom');
      return { on: vi.fn() };
    });
    const err = await runPythonScript(spec(), []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptRunError);
    expect((err as ScriptRunError).timedOut).toBe(true);
    expect((err as ScriptRunError).stderr).toBe('boom');
  });

  it('rejects with timedOut=false on an ordinary failure', async () => {
    execFileMock.mockImplementation((_b, _a, _o, cb: Callback) => {
      cb(new Error('exit 1'), '', '');
      return { on: vi.fn() };
    });
    const err = (await runPythonScript(spec(), []).catch((e: unknown) => e)) as ScriptRunError;
    expect(err.timedOut).toBe(false);
  });
});

describe('assertScriptFingerprint', () => {
  const writeScript = (): ScriptSpec => {
    const s = spec();
    fs.mkdirSync(path.dirname(s.script), { recursive: true });
    fs.writeFileSync(s.script, 'print(1)');
    return s;
  };

  it('rejects GENERATOR_FINGERPRINT_MISMATCH on digest mismatch', async () => {
    const s = { ...writeScript(), scriptSha256: 'deadbeef' };
    await expect(assertScriptFingerprint(s)).rejects.toMatchObject({
      message: GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
      code: 'GENERATOR_FINGERPRINT_MISMATCH',
      statusCode: 500,
    });
  });

  it('uses the create_report wording and log tag for a report spec', async () => {
    const { logger } = await import('../src/logger.js');
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const s = { ...writeScript(), scriptSha256: 'deadbeef', label: 'report' as const };
    await expect(assertScriptFingerprint(s)).rejects.toMatchObject({
      message: REPORT_FINGERPRINT_MISMATCH_MESSAGE,
      code: 'GENERATOR_FINGERPRINT_MISMATCH',
    });
    expect(String(spy.mock.calls[0]?.[1])).toMatch(/^\[report\] /);
    expect(REPORT_FINGERPRINT_MISMATCH_MESSAGE).not.toContain('テンプレート生成器');
    spy.mockRestore();
  });

  it('rejects when the script cannot be read', async () => {
    await expect(assertScriptFingerprint(spec({ scriptSha256: 'x' }))).rejects.toMatchObject({
      code: 'GENERATOR_FINGERPRINT_MISMATCH',
    });
  });

  it('passes when the digest matches', async () => {
    const base = writeScript();
    const sha = createHash('sha256').update('print(1)').digest('hex');
    await expect(assertScriptFingerprint({ ...base, scriptSha256: sha })).resolves.toBeUndefined();
  });

  it('skips when scriptSha256 is undefined', async () => {
    await expect(assertScriptFingerprint(spec())).resolves.toBeUndefined();
  });
});

describe('withGeneratorSlot', () => {
  it('rejects GENERATE_QUEUE_FULL with 503 when queue is full', async () => {
    let release!: () => void;
    const held = withGeneratorSlot(() => new Promise<void>((resolve) => (release = resolve)));
    const waiting = withGeneratorSlot(async () => 1);
    await expect(withGeneratorSlot(async () => 2)).rejects.toMatchObject({
      message: GENERATE_QUEUE_FULL_MESSAGE,
      code: 'GENERATE_QUEUE_FULL',
      statusCode: 503,
    });
    release();
    await held;
    await waiting;
  });

  it('uses the create_report wording when the queue is full for a report run', async () => {
    let release!: () => void;
    const held = withGeneratorSlot(() => new Promise<void>((resolve) => (release = resolve)));
    const waiting = withGeneratorSlot(async () => 1);
    await expect(withGeneratorSlot(async () => 2, 'report')).rejects.toMatchObject({
      message: REPORT_QUEUE_FULL_MESSAGE,
      code: 'GENERATE_QUEUE_FULL',
      statusCode: 503,
    });
    expect(REPORT_QUEUE_FULL_MESSAGE).not.toContain('テンプレート生成');
    release();
    await held;
    await waiting;
  });
});
