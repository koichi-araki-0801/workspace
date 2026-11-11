import fs from 'node:fs';
import path from 'node:path';
import {
  REPORT_DISABLED,
  REPORT_OUTPUT_MISSING,
  REPORT_OUTPUT_NOT_PDF,
  REPORT_RUN_FAILED,
  REPORT_TIMEOUT,
} from '@editor/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `config.ts` は import 時に env を読むので、置き場を一時ディレクトリへ逸らす。
const { execFileMock, runIoMock, root } = vi.hoisted(() => {
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  const r = `${tmpRoot}/editor-createreport-test`;
  process.env.LOG_DIR = `${r}/logs`;
  process.env.TEMPLATES_DIR = `${r}/templates`;
  process.env.FILLED_DIR = `${r}/filled`;
  process.env.PENDING_DIR = `${r}/pending`;
  process.env.DATA_ROOT = r;
  process.env.REPORT_SCRIPT = `${r}/report/create_report.py`;
  delete process.env.REPORT_SCRIPT_SHA256;
  delete process.env.REPORT_TIMEOUT_MS;
  return { execFileMock: vi.fn(), runIoMock: vi.fn(), root: r };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
// 標準入出力の起動(`runPythonScriptIo`)は境界で差し替える。execFile と stdin の扱いは scriptRunner の側のテストが持つ。
vi.mock('../src/generate/scriptRunner.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/generate/scriptRunner.js')>()),
  runPythonScriptIo: runIoMock,
}));

import { config } from '../src/config.js';
import {
  buildOfficialPdf,
  generateFilled,
  generateReportPdf,
  reportArgs,
  toIsoBaseDate,
} from '../src/generate/createReport.js';
import { ScriptRunError } from '../src/generate/scriptRunner.js';

const ID = '01281_880008_20231117_交付版';
const ATTRS = {
  companyCode: '01281',
  fundCode: '880008',
  baseDate: '20231117',
  editionType: '交付版',
};

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

/** execFile の最後の引数(コールバック)を、`onRun` のあと成功で呼ぶモックを入れる。 */
function mockRun(onRun: () => void = () => {}): void {
  execFileMock.mockImplementation((...a: unknown[]) => {
    const cb = a[a.length - 1] as Callback;
    onRun();
    setImmediate(() => cb(null, '', ''));
    return { on: vi.fn() };
  });
}

function mockFail(err: Error & { killed?: boolean }, stderr = ''): void {
  execFileMock.mockImplementation((...a: unknown[]) => {
    const cb = a[a.length - 1] as Callback;
    setImmediate(() => cb(err, '', stderr));
    return { on: vi.fn() };
  });
}

const filledFile = path.join(root, 'filled', `${ID}.html`);
const pdfFile = path.join(root, 'pdf', `${ID}.pdf`);

beforeEach(() => {
  execFileMock.mockReset();
  runIoMock.mockReset();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'filled'), { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('toIsoBaseDate', () => {
  it('converts 20231117 to 2023-11-17', () => {
    expect(toIsoBaseDate('20231117')).toBe('2023-11-17');
  });
  it('rejects 20230230 with validation', () => {
    expect(() => toIsoBaseDate('20230230')).toThrowError(/基準日/);
    expect(() => toIsoBaseDate('2023-11-17')).toThrowError(/基準日/);
  });
});

describe('reportArgs', () => {
  it('builds html-only args', () => {
    expect(reportArgs('01281', ATTRS, 'html')).toEqual([
      '01281',
      '880008',
      '2023-11-17',
      '交付版',
      '--html-only',
      '--fund-only',
      '--from-editor',
    ]);
  });
  it('builds official-pdf args without --from-editor', () => {
    expect(reportArgs('01281', ATTRS, 'official-pdf').slice(4)).toEqual([
      '--pdf-only',
      '--fund-only',
    ]);
  });
  it('builds pdf-only args with --from-editor and rejects unsafe tokens', () => {
    expect(reportArgs('01281', ATTRS, 'pdf')).toEqual([
      '01281',
      '880008',
      '2023-11-17',
      '交付版',
      '--pdf-only',
      '--fund-only',
      '--from-editor',
    ]);
    expect(() => reportArgs('../x', ATTRS, 'html')).toThrow();
  });
  it.each([
    ['rep1', () => reportArgs('-x', ATTRS, 'html')],
    ['fund', () => reportArgs('01281', { ...ATTRS, fundCode: '--pdf-only' }, 'html')],
    ['edition', () => reportArgs('01281', { ...ATTRS, editionType: '-版' }, 'html')],
  ])('rejects a %s value starting with - so it cannot become a flag', (_label, run) => {
    expect(run).toThrow(expect.objectContaining({ kind: 'validation' }));
  });
});

describe('generateFilled', () => {
  it('returns created:false and does not spawn when filled exists', async () => {
    fs.writeFileSync(filledFile, 'x');
    await expect(generateFilled(ID, '01281')).resolves.toEqual({ created: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('spawns once for two concurrent calls on the same id', async () => {
    mockRun(() => fs.writeFileSync(filledFile, 'x'));
    const r = await Promise.all([generateFilled(ID, '01281'), generateFilled(ID, '01281')]);
    expect(r.map((x) => x.created)).toEqual([true, false]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.slice(-7)).toEqual([
      '01281',
      '880008',
      '2023-11-17',
      '交付版',
      '--html-only',
      '--fund-only',
      '--from-editor',
    ]);
  });

  it('spawns once for ids that differ only in case', async () => {
    let running = 0;
    let maxRunning = 0;
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as Callback;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      for (const name of ['AB01_880008_20231117_交付版.html', 'ab01_880008_20231117_交付版.html']) {
        fs.writeFileSync(path.join(root, 'filled', name), 'x');
      }
      setTimeout(() => {
        running -= 1;
        cb(null, '', '');
      }, 20);
      return { on: vi.fn() };
    });
    await Promise.all([
      generateFilled('AB01_880008_20231117_交付版', 'R'),
      generateFilled('ab01_880008_20231117_交付版', 'R'),
    ]);
    expect(maxRunning).toBe(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('rejects REPORT_OUTPUT_MISSING when script exits 0 without output', async () => {
    mockRun();
    await expect(generateFilled(ID, '01281')).rejects.toMatchObject({
      code: REPORT_OUTPUT_MISSING,
      statusCode: 500,
      message: expect.stringContaining('dataRoot'),
    });
  });

  it('maps killed process to REPORT_TIMEOUT 504', async () => {
    mockFail(Object.assign(new Error('timeout'), { killed: true }));
    await expect(generateFilled(ID, '01281')).rejects.toMatchObject({
      code: REPORT_TIMEOUT,
      statusCode: 504,
    });
  });

  it('maps other failures to REPORT_RUN_FAILED 502 without stderr in message', async () => {
    mockFail(new Error('exit 1'), 'secret detail');
    const err = await generateFilled(ID, '01281').catch((e: Error) => e);
    expect(err).toMatchObject({ code: REPORT_RUN_FAILED, statusCode: 502 });
    expect((err as Error).message).not.toContain('secret');
  });

  it.each([
    ['failure', REPORT_RUN_FAILED, false],
    ['timeout', REPORT_TIMEOUT, true],
  ])('removes a half-written filled file after a %s', async (_label, code, killed) => {
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as Callback;
      fs.writeFileSync(filledFile, 'partial');
      setImmediate(() => cb(Object.assign(new Error('x'), { killed }), '', ''));
      return { on: vi.fn() };
    });
    await expect(generateFilled(ID, '01281')).rejects.toMatchObject({ code });
    expect(fs.existsSync(filledFile)).toBe(false);
  });

  it('rejects an invalid id with validation', async () => {
    await expect(generateFilled('bad', '01281')).rejects.toMatchObject({ kind: 'validation' });
  });

  it.each([
    'a:b_880008_20231117_交付版',
    '..\\x_880008_20231117_交付版',
    '../x_880008_20231117_交付版',
  ])('rejects unsafe id %s with validation before spawning', async (bad) => {
    await expect(generateFilled(bad, '01281')).rejects.toMatchObject({ kind: 'validation' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects REPORT_DISABLED when config.report is undefined', async () => {
    const saved = config.report;
    (config as { report: unknown }).report = undefined;
    try {
      await expect(generateFilled(ID, '01281')).rejects.toMatchObject({
        code: REPORT_DISABLED,
        statusCode: 404,
      });
    } finally {
      (config as { report: unknown }).report = saved;
    }
  });
});

describe('generateReportPdf', () => {
  it('returns the pdf from stdout and writes nothing to dataRoot', async () => {
    runIoMock.mockResolvedValue(Buffer.from('%PDF-1.4 body'));
    const buf = await generateReportPdf(ID, '<p>x</p>', '01281');
    expect(buf.toString()).toBe('%PDF-1.4 body');
    expect(fs.existsSync(path.join(root, 'pdf'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'pdf-input'))).toBe(false);
    const [, args, input] = runIoMock.mock.calls[0] as [unknown, string[], string];
    expect(args.slice(-3)).toEqual(['--pdf-only', '--fund-only', '--from-editor']);
    expect(input).toBe('<p>x</p>');
  });

  it('rejects stdout that is not a pdf', async () => {
    runIoMock.mockResolvedValue(Buffer.from('not a pdf'));
    await expect(generateReportPdf(ID, '<p>x</p>', '01281')).rejects.toMatchObject({
      code: REPORT_OUTPUT_NOT_PDF,
      statusCode: 502,
      message: expect.stringContaining('--from-editor'),
    });
  });

  it.each([
    ['failure', REPORT_RUN_FAILED, false],
    ['timeout', REPORT_TIMEOUT, true],
  ])('maps a %s to its code', async (_label, code, timedOut) => {
    runIoMock.mockRejectedValue(new ScriptRunError('x', timedOut, 'secret'));
    await expect(generateReportPdf(ID, '<p>x</p>', '01281')).rejects.toMatchObject({
      code,
    });
  });

  it.each(['a:b_880008_20231117_交付版', '..\\x_880008_20231117_交付版'])(
    'rejects unsafe id %s with validation before spawning',
    async (bad) => {
      await expect(generateReportPdf(bad, '<p>x</p>', '01281')).rejects.toMatchObject({
        kind: 'validation',
      });
      expect(runIoMock).not.toHaveBeenCalled();
    },
  );
});

describe('buildOfficialPdf', () => {
  it('removes the old pdf before building, then builds a new one', async () => {
    fs.mkdirSync(path.dirname(pdfFile), { recursive: true });
    fs.writeFileSync(pdfFile, 'old');
    mockRun();
    await expect(buildOfficialPdf(ID, '01281')).rejects.toMatchObject({
      code: REPORT_OUTPUT_MISSING,
    });
    expect(fs.existsSync(pdfFile)).toBe(false);

    mockRun(() => fs.writeFileSync(pdfFile, '%PDF-1.4'));
    await expect(buildOfficialPdf(ID, '01281')).resolves.toBeUndefined();
    expect(fs.readFileSync(pdfFile, 'utf8')).toBe('%PDF-1.4');
    const args = execFileMock.mock.calls[1][1] as string[];
    expect(args.slice(-2)).toEqual(['--pdf-only', '--fund-only']);
  });

  it('maps a failed run to REPORT_RUN_FAILED', async () => {
    mockFail(new Error('exit 3'));
    await expect(buildOfficialPdf(ID, '01281')).rejects.toMatchObject({ code: REPORT_RUN_FAILED });
  });
});
