// =============================================================================
// scriptRunner.io.test.ts — 標準入出力で起動する runPythonScriptIo
// =============================================================================
// 実プロセスで起動する(Windows は py -3.13、それ以外は python3。`fakeCreateReport.test.ts` と同じ)。
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { tmpRoot } = vi.hoisted(() => {
  const root = `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/editor-scriptrunner-io-test`;
  process.env.LOG_DIR = `${root}/logs`;
  process.env.TEMPLATES_DIR = `${root}/templates`;
  process.env.PENDING_DIR = `${root}/pending`;
  return { tmpRoot: root };
});

import { config } from '../src/config.js';
import {
  runPythonScriptIo,
  SCRIPT_STDOUT_MAX_BYTES,
  ScriptRunError,
  type ScriptSpec,
} from '../src/generate/scriptRunner';

if (process.platform === 'win32') {
  config.python.bin = 'py';
  config.python.args = ['-3.13'];
} else {
  config.python.bin = 'python3';
  config.python.args = [];
}

fs.mkdirSync(tmpRoot, { recursive: true });
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function spec(name: string, source: string): ScriptSpec {
  const script = path.join(tmpRoot, name);
  fs.writeFileSync(script, source);
  return { script, scriptSha256: undefined, timeoutMs: 20_000, label: 'report' };
}

describe('runPythonScriptIo', () => {
  it('echoes stdin to stdout as bytes', async () => {
    const s = spec('echo.py', 'import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n');
    const out = await runPythonScriptIo(s, [], '<p>あ</p>');
    expect(out.toString('utf8')).toBe('<p>あ</p>');
  }, 30_000);

  it('fails when stdout exceeds the limit', async () => {
    const s = spec(
      'big.py',
      `import sys\nsys.stdout.buffer.write(b"x" * ${SCRIPT_STDOUT_MAX_BYTES + 1})\n`,
    );
    const err = await runPythonScriptIo(s, [], '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptRunError);
    expect((err as ScriptRunError).timedOut).toBe(false);
  }, 30_000);

  it('keeps stderr on failure', async () => {
    const s = spec('fail.py', 'import sys\nsys.stderr.write("boom")\nsys.exit(1)\n');
    const err = await runPythonScriptIo(s, [], '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptRunError);
    expect((err as ScriptRunError).stderr).toContain('boom');
  }, 30_000);
});
