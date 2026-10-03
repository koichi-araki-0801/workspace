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
  process.env.PENDING_DIR = `${tmpRoot}/editor-pytemplate-test-pending`;
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
};

/** 生成器の子プロセスへ引き継いでよい環境変数(許可リスト + 生成器向けのもの)。 */
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
  'PENDING_DIR',
]);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(config.pendingDir, { recursive: true, force: true });
});

const outputPath = (fundCode = 'F1') => path.join(config.pendingDir, `C1_${fundCode}_monthly.html`);

/**
 * 生成器が PENDING_DIR へ書いたことにする。本物の約束どおり一時ファイル → 名前の変更で置く
 * (同じファイルへの上書きは更新時刻が変わらないことがあり、続けて呼ぶと「書かれていない」に見える)。
 */
function writeOutput(html: string, fundCode = 'F1'): void {
  fs.mkdirSync(config.pendingDir, { recursive: true });
  const tmp = `${outputPath(fundCode)}.tmp`;
  fs.writeFileSync(tmp, html, 'utf8');
  fs.renameSync(tmp, outputPath(fundCode));
}

/** 成功を返す execFile の差し替え。出力は PENDING_DIR のファイルで、標準出力は使わない。 */
function answerOk(html = '<html>ok</html>'): void {
  execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
    writeOutput(html);
    cb(null, '<html>標準出力は使わない</html>', '');
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
    expect(env.PENDING_DIR).toBe(config.pendingDir);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('属性 JSON は明示したキーだけで組み、呼び出し元の余計なキーを渡さない', async () => {
    answerOk();
    await generateTemplate({ ...attrs, evil: '<x>' } as GenerateAttributes);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(JSON.parse(args[args.length - 1])).toEqual({
      companyCode: 'C1',
      fundCode: 'F1',
      editionType: 'monthly',
    });
  });

  it('sourceFundCode と isRedemption は指定したときだけ生成器の JSON に入る', async () => {
    answerOk();
    await generateTemplate({ ...attrs, sourceFundCode: '510037', isRedemption: true });
    let args = execFileMock.mock.calls[0][1] as string[];
    expect(JSON.parse(args[args.length - 1])).toEqual({
      companyCode: 'C1',
      fundCode: 'F1',
      editionType: 'monthly',
      sourceFundCode: '510037',
      isRedemption: true,
    });
    execFileMock.mockClear();
    // 2 回目は別の内容を書く(同じ内容を同じ瞬間に書き直すと、この呼び出しで書かれたと見分けられない)。
    answerOk('<html>2</html>');
    await generateTemplate({ ...attrs, isRedemption: false });
    args = execFileMock.mock.calls[0][1] as string[];
    const payload = JSON.parse(args[args.length - 1]);
    expect(payload).not.toHaveProperty('sourceFundCode');
    expect(payload).not.toHaveProperty('isRedemption');
  });

  it('規約外の sourceFundCode は生成器を呼ばずに拒否する(呼び出し元とは独立の防御)', async () => {
    expect(() => generateTemplate({ ...attrs, sourceFundCode: '../x' })).toThrow(
      /不正なコピー元ファンドコード/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
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

    // 書き先はファンドごとに分ける(同じ id だと「この呼び出しで書かれたか」の判定が互いに干渉する)。
    const runs = Array.from({ length: 10 }, (_, i) =>
      generateTemplate({ ...attrs, fundCode: `F${i}` }),
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    // 11 本目: 実行中 2・待ち 8 で満杯。待たずに断り、生成器を起動しない。
    await expect(generateTemplate({ ...attrs, fundCode: 'F10' })).rejects.toMatchObject({
      message: GENERATE_QUEUE_FULL_MESSAGE,
      statusCode: 503,
      code: 'GENERATE_QUEUE_FULL',
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    const fundOf = (i: number) =>
      JSON.parse((execFileMock.mock.calls[i][1] as string[]).at(-1) ?? '{}').fundCode as string;
    writeOutput('<html>1</html>', fundOf(0));
    callbacks[0](null, '', '');
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));

    for (let i = 1; i < 10; i += 1) {
      await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(i));
      writeOutput(`<html>${i + 1}</html>`, fundOf(i));
      callbacks[i](null, '', '');
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
  it('生成器が PENDING_DIR に書いたファイルを返し、標準出力は使わない', async () => {
    answerOk('<html>file</html>');
    await expect(generateTemplate(attrs)).resolves.toBe('<html>file</html>');
    const calledArgs = execFileMock.mock.calls[0][1] as string[];
    expect(calledArgs[calledArgs.length - 1]).toContain('"fundCode":"F1"');
  });

  it('終了コード 0 でもファイルを書かなければ失敗にする', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '<html>標準出力だけ</html>', '');
      return { on: vi.fn() };
    });
    await expect(generateTemplate(attrs)).rejects.toThrow(/書き出していません/);
  });

  it('呼び出し前からある古いファイルを、この呼び出しの出力と取り違えない', async () => {
    writeOutput('<html>前回の生成物</html>');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(outputPath(), old, old);
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '', ''); // 書かずに成功で終わる
      return { on: vi.fn() };
    });
    await expect(generateTemplate(attrs)).rejects.toThrow(/書き出していません/);
    expect(fs.readFileSync(outputPath(), 'utf8')).toBe('<html>前回の生成物</html>'); // 消さない
  });

  it('古いファイルを書き直したなら、その内容を返す', async () => {
    writeOutput('<html>前回の生成物</html>');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(outputPath(), old, old);
    answerOk('<html>新しい生成物</html>');
    await expect(generateTemplate(attrs)).resolves.toBe('<html>新しい生成物</html>');
  });

  it('属性がファイル名のトークンとして不正なら、生成器を呼ばずに拒否する(読み先を pending/ の外へ向けさせない)', () => {
    expect(() => generateTemplate({ ...attrs, fundCode: '../x' })).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects with a wrapped error (including stderr) when the process fails', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('spawn fail'), '', 'stderr detail');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗/);
  });

  it('更新時刻もファイル番号も変わらない書き方でも、内容が変われば書かれたとみなす', async () => {
    // 更新時刻の粒度が粗く、ファイル番号を返さないドライブ(ino が 0)で、同じファイルへ
    // 直に書き直した場合を再現する(時刻を呼び出し前の値へ戻す)。
    writeOutput('<html>前回の生成物</html>');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(outputPath(), old, old);
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      fs.writeFileSync(outputPath(), '<html>新しい生成物</html>', 'utf8');
      fs.utimesSync(outputPath(), old, old);
      cb(null, '', '');
      return { on: vi.fn() };
    });
    await expect(generateTemplate(attrs)).resolves.toBe('<html>新しい生成物</html>');
  });

  it('書かれたものが空、または通常のファイルでなければ失敗にする', async () => {
    answerOk('   ');
    await expect(generateTemplate(attrs)).rejects.toThrow(/空の出力/);
    fs.rmSync(outputPath(), { force: true });
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      fs.mkdirSync(outputPath(), { recursive: true }); // ディレクトリを置く
      cb(null, '', '');
      return { on: vi.fn() };
    });
    await expect(generateTemplate(attrs)).rejects.toThrow(/書き出していません/);
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
