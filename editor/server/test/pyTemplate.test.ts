import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference it. `config.ts` と `logger.ts` は
// import 時に env を読むので、置き場をここで一時ディレクトリへ逸らす(作業ツリーへログを書かない)。
const { execFileMock } = vi.hoisted(() => {
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  process.env.LOG_DIR = `${tmpRoot}/editor-pytemplate-test-logs`;
  process.env.TEMPLATES_DIR = `${tmpRoot}/editor-pytemplate-test-templates`;
  return { execFileMock: vi.fn() };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { config } from '../src/config.js';
import {
  GENERATE_QUEUE_FULL_MESSAGE,
  type GenerateAttributes,
  generateTemplate,
} from '../src/generate/pyTemplate';

const attrs: GenerateAttributes = {
  companyCode: 'C1',
  fundCode: 'F1',
  editionType: 'monthly',
  baseDate: '20261001',
};

/** 生成器の子プロセスへ引き継いでよい環境変数(許可リスト + 生成器向けの 3 つ)。 */
const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC',
  'PYTHONUTF8',
  'PYTHONIOENCODING',
  'TEMPLATES_DIR',
]);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** 成功を返す execFile の差し替え。 */
function answerOk(stdout = '<html>ok</html>'): void {
  execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
    cb(null, stdout, '');
    return { on: vi.fn() };
  });
}

describe('生成器の起動のしかた', () => {
  it('bin と args の後ろにスクリプトと属性 JSON を並べる', async () => {
    answerOk();
    await generateTemplate(attrs);
    const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe(config.python.bin);
    expect(args).toEqual([...config.python.args, config.python.script, expect.any(String)]);
  });

  it('子プロセスには許可した環境変数だけを渡し、秘密値は渡さない', async () => {
    vi.stubEnv('HTTPS_PFX_PASSPHRASE', 'pfx-secret');
    vi.stubEnv('DB_CONN_EXTRA', 'Password=db-secret');
    vi.stubEnv('SOME_FUTURE_SECRET', 'future-secret');
    answerOk();
    await generateTemplate(attrs);
    const env = (execFileMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    for (const key of Object.keys(env)) expect(ALLOWED_ENV_KEYS.has(key)).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(/secret/);
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.TEMPLATES_DIR).toBe(config.templatesDir);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('属性 JSON は明示したキーだけで組み、呼び出し元の余計なキーを渡さない', async () => {
    answerOk();
    await generateTemplate({ ...attrs, isRedemption: true, evil: '<x>' } as GenerateAttributes);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(JSON.parse(args[args.length - 1])).toEqual({
      companyCode: 'C1',
      fundCode: 'F1',
      editionType: 'monthly',
      baseDate: '20261001',
    });
  });

  it('元テンプレ指定は basedOnTemplateId として渡す', async () => {
    answerOk();
    await generateTemplate({ ...attrs, basedOnTemplateId: 'AM01_510037_20240710_交付版' });
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(JSON.parse(args[args.length - 1]).basedOnTemplateId).toBe('AM01_510037_20240710_交付版');
  });
});

describe('生成器の指紋', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fingerprint-'));
  const script = path.join(dir, 'generator.py');
  fs.writeFileSync(script, 'print("<html></html>")\n', 'utf8');
  const sha = createHash('sha256').update(fs.readFileSync(script)).digest('hex');

  /** 指紋とスクリプトを差し替えて pyTemplate を読み直す(config は import 時に値を確定する)。 */
  async function load(scriptPath: string, sha256: string | undefined) {
    vi.stubEnv('PY_GENERATE_SCRIPT', scriptPath);
    const saved = process.env.PY_GENERATE_SCRIPT_SHA256;
    if (sha256 === undefined) delete process.env.PY_GENERATE_SCRIPT_SHA256;
    else process.env.PY_GENERATE_SCRIPT_SHA256 = sha256;
    vi.resetModules();
    try {
      const mod = await import('../src/generate/pyTemplate.js');
      const { logger } = await import('../src/logger.js');
      return { ...mod, logger };
    } finally {
      if (saved === undefined) delete process.env.PY_GENERATE_SCRIPT_SHA256;
      else process.env.PY_GENERATE_SCRIPT_SHA256 = saved;
    }
  }

  afterEach(() => vi.resetModules());

  it('一致すれば起動する', async () => {
    const { generateTemplate: gen } = await load(script, sha);
    answerOk();
    await expect(gen(attrs)).resolves.toBe('<html>ok</html>');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('食い違えば起動せずに拒否し、サーバログに残す', async () => {
    const {
      generateTemplate: gen,
      logger,
      GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
    } = await load(script, 'f'.repeat(64));
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    answerOk();
    await expect(gen(attrs)).rejects.toMatchObject({
      message: GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
      kind: 'unexpected',
      code: 'GENERATOR_FINGERPRINT_MISMATCH',
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ script, expected: 'f'.repeat(64), actual: sha }),
      expect.stringContaining('指紋'),
    );
  });

  it('指紋を設定したのにスクリプトが読めなければ拒否する(照合できない = 起動しない)', async () => {
    const { generateTemplate: gen, logger } = await load(path.join(dir, 'missing.py'), sha);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    answerOk();
    await expect(gen(attrs)).rejects.toMatchObject({ code: 'GENERATOR_FINGERPRINT_MISMATCH' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('未設定なら照合しない(スクリプトが無くても読みに行かない)', async () => {
    const { generateTemplate: gen } = await load(path.join(dir, 'missing.py'), undefined);
    answerOk();
    await expect(gen(attrs)).resolves.toBe('<html>ok</html>');
  });

  it('照合はその都度行う(1 回目の後にスクリプトが変われば 2 回目は拒否)', async () => {
    const changing = path.join(dir, 'changing.py');
    fs.writeFileSync(changing, 'print(1)\n', 'utf8');
    const first = createHash('sha256').update(fs.readFileSync(changing)).digest('hex');
    const { generateTemplate: gen, logger } = await load(changing, first);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    answerOk();
    await expect(gen(attrs)).resolves.toBe('<html>ok</html>');
    fs.writeFileSync(changing, 'print(2)\n', 'utf8');
    await expect(gen(attrs)).rejects.toMatchObject({ code: 'GENERATOR_FINGERPRINT_MISMATCH' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('生成の同時実行の上限', () => {
  type Callback = (err: Error | null, stdout: string, stderr: string) => void;

  it('同時 2・待ち 8 を超えた要求は待たずに 503 で断り、1 本終わると次が起動する', async () => {
    expect(config.python.maxConcurrency).toBe(2);
    expect(config.python.maxQueue).toBe(8);
    const callbacks: Callback[] = [];
    execFileMock.mockImplementation((_bin, _args, _opts, cb: Callback) => {
      callbacks.push(cb);
      return { on: vi.fn() };
    });

    const runs = Array.from({ length: 10 }, () => generateTemplate(attrs));
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    // 11 本目: 実行中 2・待ち 8 で満杯。待たずに断り、生成器を起動しない。
    await expect(generateTemplate(attrs)).rejects.toMatchObject({
      message: GENERATE_QUEUE_FULL_MESSAGE,
      statusCode: 503,
      code: 'GENERATE_QUEUE_FULL',
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    callbacks[0](null, '<html>1</html>', '');
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));

    for (let i = 1; i < 10; i += 1) {
      await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(i));
      callbacks[i](null, `<html>${i + 1}</html>`, '');
    }
    await expect(Promise.all(runs)).resolves.toHaveLength(10);
  });

  it('生成器が失敗しても枠を返す(失敗が続いても詰まらない)', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb: Callback) => {
      cb(new Error('exit 1'), '', '');
      return { on: vi.fn() };
    });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => generateTemplate(attrs)),
    );
    // 同時に投げた 12 本のうち、満杯で断られるのは 2 本まで。残りは生成器の失敗として返る。
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(12);
    answerOk();
    await expect(generateTemplate(attrs)).resolves.toBe('<html>ok</html>');
  });
});

describe('generateTemplate', () => {
  it('resolves with stdout and passes the attributes as a JSON arg', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '<html>ok</html>', '');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).resolves.toBe('<html>ok</html>');

    const calledArgs = execFileMock.mock.calls[0][1] as string[];
    expect(calledArgs[calledArgs.length - 1]).toContain('"fundCode":"F1"');
  });

  it('rejects with a wrapped error (including stderr) when the process fails', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('spawn fail'), '', 'stderr detail');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗/);
  });

  it('rejects when the generator returns empty output', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '   ', '');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/空の出力/);
  });

  it('basedOnTemplateId は生成器へ渡す前に検査し、規約外なら Python を起動しない', () => {
    // 検査は Promise 化する前(関数本体の同期部分)で行われるため、失敗は reject ではなく
    // 同期 throw になる。
    expect(() => generateTemplate({ ...attrs, basedOnTemplateId: '../etc/passwd' })).toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('基にする id が規約内なら引数として渡る', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '<html/>', '');
      return { on: vi.fn() };
    });

    await generateTemplate({ ...attrs, basedOnTemplateId: 'AM01_510037_20240710_交付版' });

    const calledArgs = execFileMock.mock.calls[0][1] as string[];
    expect(calledArgs[calledArgs.length - 1]).toContain('AM01_510037_20240710_交付版');
  });

  it('stderr が空の失敗は message だけで組む(末尾に改行を足さない)', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('exit 1'), '', '');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗: exit 1$/);
  });

  // 他のケースは `execFile` を差し替えているため、引数の組み立てが実 API を通るかは見ていない。
  // ここだけ差し替えを外し、存在しない実行ファイルで「失敗の形」が保たれることを確かめる。
  // `vi.doUnmock` はファイル末尾まで効くので、このケースは必ず最後に置く(後ろへケースを足すと
  // `execFile` の差し替えが外れたまま実プロセスを起動する)。
  it('実行ファイルが無ければ Python 生成器の失敗として包んで投げる(実 execFile 経路)', async () => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    vi.stubEnv('PYTHON_BIN', 'このコマンドは存在しません');
    const { generateTemplate: real } = await import('../src/generate/pyTemplate.js');
    await expect(real(attrs)).rejects.toThrow(/Python生成器の実行に失敗/);
    // 差し替えが外れていなければ、直前のケースの実装が同じ文言で reject して素通りする。
    // 実プロセスを通ったことを、差し替え側が呼ばれていないことで確かめる。
    expect(execFileMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
