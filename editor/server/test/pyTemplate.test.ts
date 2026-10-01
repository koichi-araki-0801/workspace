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
import { type GenerateAttributes, generateTemplate } from '../src/generate/pyTemplate';

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
