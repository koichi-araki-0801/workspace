// =============================================================================
// config.report.test.ts — create_report 連携の設定(`report`)と作業フォルダの解決
// =============================================================================
// `config.ts` は import 時に env と appconfig を読むので、差し替えのたびに `vi.resetModules()`
// してから動的 import する(`config.python.test.ts` と同じ方式)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GENERATE_QUEUE_FULL,
  GENERATOR_FINGERPRINT_MISMATCH,
  REPORT_COMPANY_UNKNOWN,
  REPORT_DISABLED,
  REPORT_OUTPUT_MISSING,
  REPORT_RUN_FAILED,
  REPORT_TIMEOUT,
} from '@editor/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';

type ConfigModule = typeof import('../src/config.js');

const KEYS = [
  'REPORT_SCRIPT',
  'REPORT_SCRIPT_SHA256',
  'REPORT_TIMEOUT_MS',
  'PDF_INPUT_DIR',
  'PDF_DIR',
  'APP_CONFIG',
  'DATA_ROOT',
] as const;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-config-report-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** env と appconfig を差し替えて `config.ts` を評価し直す(評価後に env は元へ戻す)。 */
async function importConfig(
  env: Partial<Record<(typeof KEYS)[number], string>>,
  appconfig?: unknown,
): Promise<ConfigModule> {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of KEYS) {
    delete process.env[k];
  }
  process.env.DATA_ROOT = path.join(tmp, 'data');
  process.env.APP_CONFIG = path.join(tmp, 'none.json');
  if (appconfig !== undefined) {
    seq += 1;
    const file = path.join(tmp, `appconfig-${seq}.json`);
    fs.writeFileSync(file, JSON.stringify(appconfig), 'utf8');
    process.env.APP_CONFIG = file;
  }
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await import('../src/config.js');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

const HEX = 'ab'.repeat(32);

describe('config.report', () => {
  it('report is undefined when REPORT_SCRIPT and appconfig report.script are absent', async () => {
    const { config } = await importConfig({});
    expect(config.report).toBeUndefined();
  });

  it('appconfig の report.script だけでも有効になり、timeoutMs の既定は 300000', async () => {
    const { config } = await importConfig(
      {},
      { report: { script: 'C:\\tools\\create_report.py' } },
    );
    expect(config.report?.script).toContain('create_report.py');
    expect(config.report?.scriptSha256).toBeUndefined();
    expect(config.report?.timeoutMs).toBe(300_000);
  });

  it('REPORT_SCRIPT env wins over appconfig', async () => {
    const { config } = await importConfig(
      { REPORT_SCRIPT: 'C:\\env\\r.py', REPORT_SCRIPT_SHA256: HEX.toUpperCase() },
      { report: { script: 'C:\\file\\r.py', scriptSha256: 'cd'.repeat(32), timeoutMs: 1000 } },
    );
    expect(config.report?.script).toContain('env');
    expect(config.report?.scriptSha256).toBe(HEX);
    expect(config.report?.timeoutMs).toBe(1000);
  });

  it('rejects malformed report.scriptSha256', async () => {
    await expect(
      importConfig({}, { report: { script: 'r.py', scriptSha256: 'xyz' } }),
    ).rejects.toThrow(/SHA256/);
    await expect(
      importConfig({ REPORT_SCRIPT: 'r.py', REPORT_SCRIPT_SHA256: 'zz' }),
    ).rejects.toThrow(/REPORT_SCRIPT_SHA256/);
  });

  it('rejects report.timeoutMs over 600000', async () => {
    await expect(
      importConfig({}, { report: { script: 'r.py', timeoutMs: 600_001 } }),
    ).rejects.toThrow();
    await expect(
      importConfig({ REPORT_SCRIPT: 'r.py', REPORT_TIMEOUT_MS: '600001' }),
    ).rejects.toThrow(/REPORT_TIMEOUT_MS/);
  });

  it('report の未知キーは起動中止(strict)', async () => {
    await expect(importConfig({}, { report: { script: 'r.py', bogus: 1 } })).rejects.toThrow();
  });
});

describe('config.pdfInputDir / pdfDir', () => {
  it('pdfInputDir defaults to <dataRoot>/pdf-input, pdfDir to <dataRoot>/pdf', async () => {
    const { config } = await importConfig({});
    expect(config.pdfInputDir).toBe(path.join(tmp, 'data', 'pdf-input'));
    expect(config.pdfDir).toBe(path.join(tmp, 'data', 'pdf'));
  });

  it('env が appconfig より優先される', async () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    const c = path.join(tmp, 'c');
    const { config } = await importConfig(
      { PDF_INPUT_DIR: a, PDF_DIR: b },
      { paths: { pdfInputDir: c, pdfDir: c } },
    );
    expect(config.pdfInputDir).toBe(a);
    expect(config.pdfDir).toBe(b);
    const viaFile = await importConfig({}, { paths: { pdfInputDir: c, pdfDir: c } });
    expect(viaFile.config.pdfInputDir).toBe(c);
  });
});

describe('エラーコード定数', () => {
  it('値は名前と同じ文字列', () => {
    expect([
      GENERATE_QUEUE_FULL,
      GENERATOR_FINGERPRINT_MISMATCH,
      REPORT_TIMEOUT,
      REPORT_RUN_FAILED,
      REPORT_OUTPUT_MISSING,
      REPORT_COMPANY_UNKNOWN,
      REPORT_DISABLED,
    ]).toEqual([
      'GENERATE_QUEUE_FULL',
      'GENERATOR_FINGERPRINT_MISMATCH',
      'REPORT_TIMEOUT',
      'REPORT_RUN_FAILED',
      'REPORT_OUTPUT_MISSING',
      'REPORT_COMPANY_UNKNOWN',
      'REPORT_DISABLED',
    ]);
  });
});
