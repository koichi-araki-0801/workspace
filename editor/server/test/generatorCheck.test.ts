// =============================================================================
// generatorCheck.test.ts — 起動時の生成器 Python の確認(版・起動失敗・指紋未設定の警告)
// =============================================================================
// 実プロセスは起動しない(`execFile` を差し替えて、返り値ごとのログの出し分けを固定する)。
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => {
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  process.env.LOG_DIR = `${tmpRoot}/editor-generator-check-logs`;
  process.env.APP_CONFIG = `${tmpRoot}/editor-generator-check-no-appconfig.json`;
  // 既定では指紋を設定済みにして、版の警告だけを観測する。未設定の警告は専用のケースで見る。
  process.env.PY_GENERATE_SCRIPT_SHA256 = 'a'.repeat(64);
  // 既定の生成器は偽物なので、偽物の警告が混ざらないよう別名の本物扱いにしておく。
  process.env.PY_GENERATE_SCRIPT = `${tmpRoot}/real_generator.py`;
  return { execFileMock: vi.fn() };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { config } from '../src/config.js';
import {
  checkGeneratorAtStartup,
  EXPECTED_PYTHON_VERSION,
} from '../src/generate/generatorCheck.js';
import { logger } from '../src/logger.js';

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

function answer(err: Error | null, stdout: string, stderr = ''): void {
  execFileMock.mockImplementation((_bin, _args, _opts, cb: Callback) => {
    cb(err, stdout, stderr);
    return { on: vi.fn() };
  });
}

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn() });

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('checkGeneratorAtStartup', () => {
  it('3.13 なら版を info に出し、警告しない', async () => {
    expect(EXPECTED_PYTHON_VERSION).toBe('3.13');
    answer(null, '3.13\r\n');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('3.13'));
    const [bin, args, opts] = execFileMock.mock.calls[0] as [string, string[], { timeout: number }];
    expect(bin).toBe(config.python.bin);
    expect(args).toEqual([
      ...config.python.args,
      '-c',
      expect.stringContaining('sys.version_info'),
    ]);
    expect(opts.timeout).toBe(10_000);
  });

  it('版確認の子プロセスにも秘密の環境変数を渡さない', async () => {
    vi.stubEnv('HTTPS_PFX_PASSPHRASE', 'pfx-secret');
    answer(null, '3.13\n');
    await checkGeneratorAtStartup(fakeLog());
    const env = (execFileMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.HTTPS_PFX_PASSPHRASE).toBeUndefined();
    expect(env.TEMPLATES_DIR).toBe(config.templatesDir);
  });

  it('3.13 以外なら版を添え、システム PATH が先に探されることを案内して警告する', async () => {
    answer(null, '3.12\n');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/3\.12[\s\S]*3\.13/));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('システム PATH'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('PYTHON_BIN'));
  });

  it('exit 9009(Store の偽物・python が無い)は起動失敗として、PATH の直し方を添えて警告する', async () => {
    answer(Object.assign(new Error('Command failed: python -c ...'), { code: 9009 }), '');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/起動できません[\s\S]*9009/));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ユーザー環境変数 PATH'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('WindowsApps'));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('新しいコマンドプロンプトからサーバを起動し直す'),
    );
  });

  it('実行ファイルが無い(ENOENT)も起動失敗として警告し、reject しない', async () => {
    answer(Object.assign(new Error('spawn py ENOENT'), { code: 'ENOENT' }), '');
    const log = fakeLog();
    await expect(checkGeneratorAtStartup(log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/起動できません[\s\S]*ENOENT/));
  });

  it('タイムアウト(killed)は応答が無いと明示して警告する', async () => {
    answer(Object.assign(new Error('Command failed'), { killed: true }), '');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/起動できません[\s\S]*10 秒以内に応答がありません/),
    );
  });

  it('execFile が同期 throw しても reject せず、ロガーへ警告する', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('The argument must be a string without null bytes');
    });
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      await expect(checkGeneratorAtStartup(fakeLog())).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('起動時確認に失敗しました'));
    } finally {
      spy.mockRestore();
    }
  });

  it('子プロセスの error イベントも起動失敗として警告する', async () => {
    execFileMock.mockImplementation(() => ({
      on: (_event: string, handler: (err: Error) => void) => handler(new Error('spawn EACCES')),
    }));
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/起動できません[\s\S]*EACCES/));
  });

  it('コードの無いエラーでも stderr を添えて起動失敗として警告する', async () => {
    answer(new Error('boom'), '', ' no python \n');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/起動できません[\s\S]*boom no python/),
    );
  });

  it('指紋が未設定なら設定を勧める警告を出す', async () => {
    const saved = process.env.PY_GENERATE_SCRIPT_SHA256;
    delete process.env.PY_GENERATE_SCRIPT_SHA256;
    vi.resetModules();
    try {
      const { checkGeneratorAtStartup: check } = await import('../src/generate/generatorCheck.js');
      answer(null, '3.13\n');
      const log = fakeLog();
      await check(log);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('指紋が未設定'));
    } finally {
      process.env.PY_GENERATE_SCRIPT_SHA256 = saved;
      vi.resetModules();
    }
  });

  it('生成器が偽物(fake_generate_template.py)のままなら警告する', async () => {
    vi.stubEnv('PY_GENERATE_SCRIPT', 'C:\\somewhere\\Fake_Generate_Template.py');
    vi.resetModules();
    try {
      const { checkGeneratorAtStartup: check } = await import('../src/generate/generatorCheck.js');
      answer(null, '3.13\n');
      const log = fakeLog();
      await check(log);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('生成器が偽物'));
    } finally {
      vi.resetModules();
    }
  });

  it('生成器が別名なら偽物の警告を出さない', async () => {
    vi.stubEnv('PY_GENERATE_SCRIPT', 'C:\\somewhere\\generate_template.py');
    vi.resetModules();
    try {
      const { checkGeneratorAtStartup: check } = await import('../src/generate/generatorCheck.js');
      answer(null, '3.13\n');
      const log = fakeLog();
      await check(log);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
    }
  });

  it('PYTHON_BIN が無ければ PATH 上の python を引数なしで確かめ、info にその名前を出す', async () => {
    const saved = process.env.PYTHON_BIN;
    delete process.env.PYTHON_BIN;
    vi.resetModules();
    try {
      const { checkGeneratorAtStartup: check } = await import('../src/generate/generatorCheck.js');
      answer(null, '3.13\n');
      const log = fakeLog();
      await check(log);
      const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe('python');
      expect(args).toEqual(['-c', expect.stringContaining('sys.version_info')]);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('3.13(python)'));
    } finally {
      if (saved !== undefined) process.env.PYTHON_BIN = saved;
      vi.resetModules();
    }
  });
});
