import fs from 'node:fs';
import path from 'node:path';
import {
  REPORT_DISABLED,
  REPORT_OUTPUT_MISSING,
  REPORT_RUN_FAILED,
  REPORT_TIMEOUT,
} from '@editor/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `config.ts` は import 時に env を読むので、置き場を一時ディレクトリへ逸らす。
const { execFileMock, root } = vi.hoisted(() => {
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  const r = `${tmpRoot}/editor-createreport-test`;
  process.env.LOG_DIR = `${r}/logs`;
  process.env.TEMPLATES_DIR = `${r}/templates`;
  process.env.FILLED_DIR = `${r}/filled`;
  process.env.PENDING_DIR = `${r}/pending`;
  process.env.PDF_INPUT_DIR = `${r}/pdf-input`;
  process.env.PDF_DIR = `${r}/pdf`;
  process.env.REPORT_SCRIPT = `${r}/report/create_report.py`;
  delete process.env.REPORT_SCRIPT_SHA256;
  delete process.env.REPORT_TIMEOUT_MS;
  return { execFileMock: vi.fn(), root: r };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { config } from '../src/config.js';
import {
  generateFilled,
  generateReportPdf,
  reportArgs,
  toIsoBaseDate,
} from '../src/generate/createReport.js';

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
const inputFile = path.join(root, 'pdf-input', `${ID}.html`);

beforeEach(() => {
  execFileMock.mockReset();
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of ['filled', 'pdf', 'pdf-input']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
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
    ]);
  });
  it('builds pdf-only args and rejects unsafe tokens', () => {
    expect(reportArgs('01281', ATTRS, 'pdf')[4]).toBe('--pdf-only');
    expect(() => reportArgs('../x', ATTRS, 'html')).toThrow();
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
    expect(args.slice(-6)).toEqual([
      '01281',
      '880008',
      '2023-11-17',
      '交付版',
      '--html-only',
      '--fund-only',
    ]);
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
  it('deletes stale pdf before running', async () => {
    fs.writeFileSync(pdfFile, 'old');
    mockRun();
    await expect(generateReportPdf(ID, '<p>x</p>', '01281')).rejects.toMatchObject({
      code: REPORT_OUTPUT_MISSING,
    });
  });

  it('returns the pdf and removes pdf-input and pdf files after success', async () => {
    mockRun(() => {
      expect(fs.readFileSync(inputFile, 'utf8')).toBe('<p>x</p>');
      fs.writeFileSync(pdfFile, '%PDF-1.4');
    });
    const buf = await generateReportPdf(ID, '<p>x</p>', '01281');
    expect(buf.toString()).toBe('%PDF-1.4');
    expect(fs.existsSync(inputFile)).toBe(false);
    expect(fs.existsSync(pdfFile)).toBe(false);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.slice(-2)).toEqual(['--pdf-only', '--fund-only']);
  });

  it.each(['a:b_880008_20231117_交付版', '..\\x_880008_20231117_交付版'])(
    'rejects unsafe id %s with validation before spawning',
    async (bad) => {
      await expect(generateReportPdf(bad, '<p>x</p>', '01281')).rejects.toMatchObject({
        kind: 'validation',
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it('serializes two concurrent runs for the same id', async () => {
    let running = 0;
    let maxRunning = 0;
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as Callback;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      fs.writeFileSync(pdfFile, '%PDF-1.4');
      setTimeout(() => {
        running -= 1;
        cb(null, '', '');
      }, 20);
      return { on: vi.fn() };
    });
    await Promise.all([
      generateReportPdf(ID, '<p>a</p>', '01281'),
      generateReportPdf(ID, '<p>b</p>', '01281'),
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });

  it('serializes runs for ids that differ only in case', async () => {
    let running = 0;
    let maxRunning = 0;
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as Callback;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      for (const name of ['AB01_880008_20231117_交付版.pdf', 'ab01_880008_20231117_交付版.pdf']) {
        fs.writeFileSync(path.join(root, 'pdf', name), '%PDF-1.4');
      }
      setTimeout(() => {
        running -= 1;
        cb(null, '', '');
      }, 20);
      return { on: vi.fn() };
    });
    await Promise.all([
      generateReportPdf('AB01_880008_20231117_交付版', '<p>a</p>', 'R'),
      generateReportPdf('ab01_880008_20231117_交付版', '<p>b</p>', 'R'),
    ]);
    expect(maxRunning).toBe(1);
  });

  it('removes input and pdf when the run fails after writing a pdf', async () => {
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as Callback;
      fs.writeFileSync(pdfFile, 'partial');
      setImmediate(() => cb(new Error('exit 1'), '', ''));
      return { on: vi.fn() };
    });
    await expect(generateReportPdf(ID, '<p>x</p>', '01281')).rejects.toMatchObject({
      code: REPORT_RUN_FAILED,
    });
    expect(fs.existsSync(inputFile)).toBe(false);
    expect(fs.existsSync(pdfFile)).toBe(false);
  });

  it('removes the input even when the run fails', async () => {
    mockFail(new Error('exit 1'));
    await expect(generateReportPdf(ID, '<p>x</p>', '01281')).rejects.toMatchObject({
      code: REPORT_RUN_FAILED,
    });
    expect(fs.existsSync(inputFile)).toBe(false);
  });
});
