// =============================================================================
// config.python.test.ts — 生成器の起動コマンド・指紋・同時実行の上限の解決
// =============================================================================
// `config.ts` は import 時に env と appconfig を読んで値を確定するので、差し替えのたびに
// `vi.resetModules()` してから動的 import する。appconfig は `APP_CONFIG` で一時ファイルを指す
// (リポジトリの `editor/appconfig.json` の有無に結果を左右させない)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PYTHON_BIN, parseScriptSha256, resolvePythonCommand } from '../src/config.js';

type ConfigModule = typeof import('../src/config.js');

const KEYS = [
  'PYTHON_BIN',
  'PY_GENERATE_SCRIPT',
  'PY_GENERATE_SCRIPT_SHA256',
  'GENERATE_MAX_CONCURRENCY',
  'GENERATE_MAX_QUEUE',
  'APP_CONFIG',
  'DATA_ROOT',
] as const;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-config-python-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** env と appconfig を差し替えて `config.ts` を評価し直す(評価後に env は元へ戻す)。 */
async function importConfig(
  env: Partial<Record<(typeof KEYS)[number], string>>,
  appconfig?: unknown,
): Promise<ConfigModule> {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of KEYS) delete process.env[k];
  process.env.DATA_ROOT = path.join(tmp, 'data');
  process.env.APP_CONFIG = path.join(tmp, 'none.json');
  if (appconfig !== undefined) {
    seq += 1;
    const file = path.join(tmp, `appconfig-${seq}.json`);
    fs.writeFileSync(file, JSON.stringify(appconfig), 'utf8');
    process.env.APP_CONFIG = file;
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  try {
    return await import('../src/config.js');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const HEX = 'ab'.repeat(32);

describe('resolvePythonCommand', () => {
  it('何も指定しなければ PATH 上の python を引数なしで使う', () => {
    expect(DEFAULT_PYTHON_BIN).toBe('python');
    expect(
      resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs: undefined }),
    ).toEqual({ bin: 'python', args: [] });
  });

  it('PYTHON_BIN を指定したらそれを使い、引数は付けない', () => {
    expect(
      resolvePythonCommand({
        envBin: 'C:\\Python313\\python.exe',
        fileBin: undefined,
        fileArgs: undefined,
      }),
    ).toEqual({ bin: 'C:\\Python313\\python.exe', args: [] });
  });

  it('appconfig の python.bin だけを指定しても引数は付けない', () => {
    expect(
      resolvePythonCommand({ envBin: undefined, fileBin: 'python3', fileArgs: undefined }),
    ).toEqual({ bin: 'python3', args: [] });
  });

  it('PYTHON_BIN は appconfig の python.bin より優先される', () => {
    expect(
      resolvePythonCommand({ envBin: 'C:\\a\\python.exe', fileBin: 'python3', fileArgs: undefined })
        .bin,
    ).toBe('C:\\a\\python.exe');
  });

  it('appconfig の python.args は既定の python にも PYTHON_BIN にも付く', () => {
    expect(
      resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs: ['-X', 'utf8'] }),
    ).toEqual({ bin: 'python', args: ['-X', 'utf8'] });
    expect(resolvePythonCommand({ envBin: 'py', fileBin: undefined, fileArgs: ['-3.13'] })).toEqual(
      { bin: 'py', args: ['-3.13'] },
    );
  });

  it('返す引数は設定の配列とは別物(呼び出し側が書き換えても設定は変わらない)', () => {
    const fileArgs = ['-X', 'utf8'];
    const { args } = resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs });
    args.push('extra');
    expect(fileArgs).toEqual(['-X', 'utf8']);
  });
});

describe('parseScriptSha256', () => {
  it('未指定は undefined(照合しない)', () => {
    expect(parseScriptSha256(undefined, 'X')).toBeUndefined();
  });

  it('64 桁の 16 進を小文字で返す(certutil の出力の大文字も受ける)', () => {
    expect(parseScriptSha256(` ${HEX.toUpperCase()} `, 'X')).toBe(HEX);
  });

  it.each([
    ['63 桁', HEX.slice(1)],
    ['空白入り', `${HEX.slice(0, 32)} ${HEX.slice(32)}`],
    ['16 進以外', `${HEX.slice(1)}g`],
    ['空文字', ''],
  ])('%s は起動エラー', (_label, value) => {
    expect(() => parseScriptSha256(value, '環境変数 PY_GENERATE_SCRIPT_SHA256')).toThrow(
      /PY_GENERATE_SCRIPT_SHA256.*64 桁の 16 進/s,
    );
  });
});

describe('config.python', () => {
  it('既定は PATH 上の python・引数なし・指紋なし・同時 2・待ち 8', async () => {
    const { config } = await importConfig({});
    expect(config.python.bin).toBe('python');
    expect(config.python.args).toEqual([]);
    expect(config.python.scriptSha256).toBeUndefined();
    expect(config.python.maxConcurrency).toBe(2);
    expect(config.python.maxQueue).toBe(8);
  });

  it('PYTHON_BIN を指定したら args は空', async () => {
    const { config } = await importConfig({ PYTHON_BIN: 'C:\\Python313\\python.exe' });
    expect(config.python.bin).toBe('C:\\Python313\\python.exe');
    expect(config.python.args).toEqual([]);
  });

  it('appconfig の python.args が PYTHON_BIN より優先される', async () => {
    const { config } = await importConfig({ PYTHON_BIN: 'py' }, { python: { args: ['-3.13'] } });
    expect(config.python.args).toEqual(['-3.13']);
  });

  it('PY_GENERATE_SCRIPT_SHA256 は appconfig の python.scriptSha256 より優先される', async () => {
    const { config } = await importConfig(
      { PY_GENERATE_SCRIPT_SHA256: HEX.toUpperCase() },
      { python: { scriptSha256: 'cd'.repeat(32) } },
    );
    expect(config.python.scriptSha256).toBe(HEX);
  });

  it('PY_GENERATE_SCRIPT_SHA256 の形式違反は起動エラー', async () => {
    await expect(importConfig({ PY_GENERATE_SCRIPT_SHA256: 'abc' })).rejects.toThrow(
      /PY_GENERATE_SCRIPT_SHA256/,
    );
  });

  it('appconfig の python.scriptSha256 の形式違反も起動エラー', async () => {
    await expect(importConfig({}, { python: { scriptSha256: 'abc' } })).rejects.toThrow(
      /python\.scriptSha256/,
    );
  });

  it('GENERATE_MAX_* を上書きでき、数値でなければ起動エラー', async () => {
    const { config } = await importConfig({
      GENERATE_MAX_CONCURRENCY: '3',
      GENERATE_MAX_QUEUE: '20',
    });
    expect(config.python.maxConcurrency).toBe(3);
    expect(config.python.maxQueue).toBe(20);
    await expect(importConfig({ GENERATE_MAX_CONCURRENCY: 'two' })).rejects.toThrow(
      /GENERATE_MAX_CONCURRENCY/,
    );
    await expect(importConfig({ GENERATE_MAX_QUEUE: '0' })).rejects.toThrow(/GENERATE_MAX_QUEUE/);
  });
});
