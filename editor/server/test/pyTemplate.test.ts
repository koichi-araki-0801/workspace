import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference it. `config.ts` と `logger.ts` は
// import 時に env を読むので、置き場をここで一時ディレクトリへ逸らす(作業ツリーへログを書かない)。
const { execFileMock, genRoot } = vi.hoisted(() => {
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  const root = `${tmpRoot}/editor-pytemplate-test-gen`;
  process.env.LOG_DIR = `${tmpRoot}/editor-pytemplate-test-logs`;
  process.env.TEMPLATES_DIR = `${tmpRoot}/editor-pytemplate-test-templates`;
  process.env.PENDING_DIR = `${tmpRoot}/editor-pytemplate-test-pending`;
  process.env.PY_GENERATE_SCRIPT = `${root}/template/src/build.py`;
  delete process.env.PY_GENERATE_SCRIPT_SHA256;
  delete process.env.GENERATE_MAX_OUTPUT_FILES;
  delete process.env.PY_TIMEOUT_MS;
  return { execFileMock: vi.fn(), genRoot: root };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { config } from '../src/config.js';
import { generatorLogPath } from '../src/generate/generatorLog.js';
import {
  GENERATE_QUEUE_FULL_MESSAGE,
  GENERATED_EDITIONS,
  type GenerateAttributes,
  generateTemplates,
  generatorArgs,
  generatorOutputDir,
  removeGeneratedFiles,
} from '../src/generate/pyTemplate';

const BASE = '2026-10-23';
const attrs: GenerateAttributes = {
  companyCode: 'C1',
  rep1CompanyCode: '00001',
  fundCode: 'F1',
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
]);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(genRoot, { recursive: true, force: true });
});

type Callback = (err: Error | null, stdout: string, stderr: string) => void;
type Opts = { cwd: string; timeout: number; env: Record<string, string> };

/** execFile の引数から、生成器の起動位置(script)と位置引数を取り出す。 */
function splitCall(args: string[], opts: Opts) {
  const si = args.findIndex((a) => path.isAbsolute(a) && path.dirname(a) === opts.cwd);
  return { script: args[si], pos: args.slice(si + 1) };
}

/**
 * 生成器が output/ にファイルを置き、log/ に `[OUTPUT]` 行を追記したことにする。ファイルは
 * 一時ファイル → 名前の変更で置く(同じ名前への上書きで更新時刻が変わらない取り違えを避ける)。
 */
function produce(
  call: { script: string; pos: string[] },
  files: Record<string, string>,
  logNames: string[] = Object.keys(files),
): void {
  const outDir = path.join(path.dirname(path.dirname(call.script)), 'output');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, html] of Object.entries(files)) {
    const tmp = path.join(outDir, `${name}.tmp`);
    fs.writeFileSync(tmp, html, 'utf8');
    fs.renameSync(tmp, path.join(outDir, name));
  }
  const log = generatorLogPath(call.script, call.pos[0], call.pos[1], call.pos[2]);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, `${logNames.map((n) => `[OUTPUT] ${n}`).join('\n')}\n`, 'utf8');
}

/** 作成画面のファンドの両版を、ファンドコードに応じた中身で用意する。 */
function bothEditions(fund = 'F1', company = 'C1'): Record<string, string> {
  return {
    [`${company}_${fund}_交付版.html`]: `<html>${fund}交付</html>`,
    [`${company}_${fund}_全体版.html`]: `<html>${fund}全体</html>`,
  };
}

/** 成功を返す execFile の差し替え。 */
function answerWith(make: (call: { script: string; pos: string[] }) => Record<string, string>) {
  execFileMock.mockImplementation((_bin, args: string[], opts: Opts, cb: Callback) => {
    const call = splitCall(args, opts);
    produce(call, make(call));
    cb(null, '<html>標準出力は使わない</html>', '');
    return { on: vi.fn() };
  });
}

function answerOk(): void {
  answerWith((call) => bothEditions(call.pos[1]));
}

function answerRaw(
  fn: (call: { script: string; pos: string[] }) => void,
  err: Error | null = null,
  stderr = '',
) {
  execFileMock.mockImplementation((_bin, args: string[], opts: Opts, cb: Callback) => {
    fn(splitCall(args, opts));
    cb(err, '', stderr);
    return { on: vi.fn() };
  });
}

describe('generatorArgs', () => {
  it('Rep1 コードを前後の空白を除いて、ファンド・基準日の順に並べる', () => {
    expect(
      generatorArgs({ ...attrs, rep1CompanyCode: ' 00001 ', fundCode: '910024' }, BASE),
    ).toEqual(['00001', '910024', BASE]);
  });

  it('コピー元だけ・償還だけ・両方で後ろの位置引数が変わる', () => {
    expect(generatorArgs({ ...attrs, sourceFundCode: 'S1' }, BASE)).toEqual([
      '00001',
      'F1',
      BASE,
      'S1',
    ]);
    expect(generatorArgs({ ...attrs, isRedemption: true }, BASE)).toEqual([
      '00001',
      'F1',
      BASE,
      '',
      '1',
    ]);
    expect(generatorArgs({ ...attrs, sourceFundCode: 'S1', isRedemption: true }, BASE)).toEqual([
      '00001',
      'F1',
      BASE,
      'S1',
      '1',
    ]);
  });

  it('規約外のトークンは validation で拒否する', () => {
    const bad = (a: Partial<GenerateAttributes>) =>
      expect(() => generatorArgs({ ...attrs, ...a }, BASE)).toThrowError(
        expect.objectContaining({ kind: 'validation' }),
      );
    bad({ rep1CompanyCode: 'a_b' });
    bad({ rep1CompanyCode: '  ' });
    bad({ sourceFundCode: '../x' });
    bad({ fundCode: '../x' });
    bad({ companyCode: 'a/b' });
    expect(() => generatorArgs(attrs, '../x')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });
});

describe('生成器の起動のしかた', () => {
  it('bin と args の後ろにスクリプトと位置引数を並べ、cwd とタイムアウトを渡す', async () => {
    answerOk();
    await generateTemplates({ ...attrs, sourceFundCode: 'S1' }, BASE);
    const [bin, args, opts] = execFileMock.mock.calls[0] as [string, string[], Opts];
    expect(bin).toBe(config.python.bin);
    expect(args).toEqual([
      ...config.python.args,
      config.python.script,
      ...generatorArgs({ ...attrs, sourceFundCode: 'S1' }, BASE),
    ]);
    expect(opts.cwd).toBe(path.dirname(config.python.script));
    expect(opts.timeout).toBe(300000);
  });

  it('子プロセスには許可した環境変数だけを渡し、秘密値と PENDING_DIR は渡さない', async () => {
    vi.stubEnv('HTTPS_PFX_PASSPHRASE', 'pfx-secret');
    vi.stubEnv('DB_CONN_EXTRA', 'Password=db-secret');
    vi.stubEnv('SOME_FUTURE_SECRET', 'future-secret');
    answerOk();
    await generateTemplates(attrs, BASE);
    const env = (execFileMock.mock.calls[0][2] as Opts).env;
    for (const key of Object.keys(env)) expect(ALLOWED_ENV_KEYS.has(key)).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(/secret/);
    expect(env).not.toHaveProperty('PENDING_DIR');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.TEMPLATES_DIR).toBe(config.templatesDir);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('規約外の Rep1 コード・sourceFundCode は生成器を呼ばずに拒否する', () => {
    expect(() => generateTemplates({ ...attrs, rep1CompanyCode: 'a_b' }, BASE)).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
    expect(() => generateTemplates({ ...attrs, sourceFundCode: '../x' }, BASE)).toThrow(
      /不正なコピー元ファンドコード/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('出力フォルダは script の 1 つ上の階層の output/', () => {
    expect(generatorOutputDir()).toBe(
      path.join(path.dirname(path.dirname(path.resolve(config.python.script))), 'output'),
    );
    expect(GENERATED_EDITIONS).toEqual(['交付版', '全体版']);
  });
});

describe('生成器の指紋', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fingerprint-'));
  const script = path.join(dir, 'src', 'generator.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
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
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('一致すれば起動する', async () => {
    const { generateTemplates: gen } = await load(script, sha);
    answerOk();
    await expect(gen(attrs, BASE)).resolves.toHaveLength(2);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('食い違えば起動せずに拒否し、サーバログに残す', async () => {
    const {
      generateTemplates: gen,
      logger,
      GENERATOR_FINGERPRINT_MISMATCH_MESSAGE,
    } = await load(script, 'f'.repeat(64));
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    answerOk();
    await expect(gen(attrs, BASE)).rejects.toMatchObject({
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
    const { generateTemplates: gen, logger } = await load(path.join(dir, 'src', 'missing.py'), sha);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    answerOk();
    await expect(gen(attrs, BASE)).rejects.toMatchObject({
      code: 'GENERATOR_FINGERPRINT_MISMATCH',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('未設定なら照合しない(スクリプトが無くても読みに行かない)', async () => {
    const { generateTemplates: gen } = await load(path.join(dir, 'src', 'missing.py'), undefined);
    answerOk();
    await expect(gen(attrs, BASE)).resolves.toHaveLength(2);
  });

  it('照合はその都度行う(1 回目の後にスクリプトが変われば 2 回目は拒否)', async () => {
    const changing = path.join(dir, 'src', 'changing.py');
    fs.writeFileSync(changing, 'print(1)\n', 'utf8');
    const first = createHash('sha256').update(fs.readFileSync(changing)).digest('hex');
    const { generateTemplates: gen, logger } = await load(changing, first);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    answerOk();
    await expect(gen(attrs, BASE)).resolves.toHaveLength(2);
    fs.writeFileSync(changing, 'print(2)\n', 'utf8');
    await expect(gen(attrs, BASE)).rejects.toMatchObject({
      code: 'GENERATOR_FINGERPRINT_MISMATCH',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('生成の同時実行の上限', () => {
  it('同時 2・待ち 8 を超えた要求は待たずに 503 で断り、1 本終わると次が起動する', async () => {
    expect(config.python.maxConcurrency).toBe(2);
    expect(config.python.maxQueue).toBe(8);
    const pending: { call: { script: string; pos: string[] }; cb: Callback }[] = [];
    execFileMock.mockImplementation((_bin, args: string[], opts: Opts, cb: Callback) => {
      pending.push({ call: splitCall(args, opts), cb });
      return { on: vi.fn() };
    });
    const finish = (i: number) => {
      const { call, cb } = pending[i];
      produce(call, bothEditions(call.pos[1]));
      cb(null, '', '');
    };

    const runs = Array.from({ length: 10 }, (_, i) =>
      generateTemplates({ ...attrs, fundCode: `F${i}` }, BASE),
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    // 11 本目: 実行中 2・待ち 8 で満杯。待たずに断り、生成器を起動しない。
    await expect(generateTemplates({ ...attrs, fundCode: 'F10' }, BASE)).rejects.toMatchObject({
      message: GENERATE_QUEUE_FULL_MESSAGE,
      statusCode: 503,
      code: 'GENERATE_QUEUE_FULL',
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    finish(0);
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));
    for (let i = 1; i < 10; i += 1) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(i));
      finish(i);
    }
    await expect(Promise.all(runs)).resolves.toHaveLength(10);
  });

  it('生成器が失敗しても枠を返す(失敗が続いても詰まらない)', async () => {
    answerRaw(() => undefined, new Error('exit 1'));
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => generateTemplates(attrs, BASE)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(12);
    answerOk();
    await expect(generateTemplates(attrs, BASE)).resolves.toHaveLength(2);
  });
});

describe('generateTemplates の取り込み', () => {
  it('両版を書けば交付版・全体版の順で返し、html は書いた中身', async () => {
    answerOk();
    const files = await generateTemplates(attrs, BASE);
    expect(files.map((f) => f.fileName)).toEqual(['C1_F1_交付版.html', 'C1_F1_全体版.html']);
    expect(files.map((f) => f.html)).toEqual(['<html>F1交付</html>', '<html>F1全体</html>']);
    expect(files[0].attributes).toEqual({
      companyCode: 'C1',
      fundCode: 'F1',
      editionType: '交付版',
    });
    expect(files[0].path).toBe(path.join(generatorOutputDir(), 'C1_F1_交付版.html'));
  });

  it('組入先は選択ファンドの 2 版の後ろにファイル名順で並ぶ', async () => {
    answerWith(() => ({
      ...bothEditions('Z9'),
      ...bothEditions('F1'),
      ...bothEditions('A2'),
    }));
    const files = await generateTemplates(attrs, BASE);
    expect(files.map((f) => f.fileName)).toEqual([
      'C1_F1_交付版.html',
      'C1_F1_全体版.html',
      'C1_A2_交付版.html',
      'C1_A2_全体版.html',
      'C1_Z9_交付版.html',
      'C1_Z9_全体版.html',
    ]);
  });

  it('起動前からあるログの行のファイルは返さない', async () => {
    const script = config.python.script;
    const log = generatorLogPath(script, '00001', 'F1', BASE);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, '[OUTPUT] C1_OLD_交付版.html\n', 'utf8');
    // 前回分の OLD は今回の追記に載らない(ファイルは output/ に残っていてもよい)。
    answerRaw((call) =>
      produce(
        call,
        { ...bothEditions('F1'), 'C1_OLD_交付版.html': 'x' },
        Object.keys(bothEditions('F1')),
      ),
    );
    const files = await generateTemplates(attrs, BASE);
    expect(files.map((f) => f.fileName)).toEqual(['C1_F1_交付版.html', 'C1_F1_全体版.html']);
  });

  it('ログに載っていないが書かれたファイルは返さない', async () => {
    execFileMock.mockImplementation((_b, args: string[], opts: Opts, cb: Callback) => {
      produce(
        splitCall(args, opts),
        { ...bothEditions('F1'), 'C1_X_交付版.html': 'x' },
        Object.keys(bothEditions('F1')),
      );
      cb(null, '', '');
      return { on: vi.fn() };
    });
    const files = await generateTemplates(attrs, BASE);
    expect(files).toHaveLength(2);
  });

  it('前回の失敗で同じ中身のファイルが残っていても、書き直されれば返す', async () => {
    const outDir = generatorOutputDir();
    fs.mkdirSync(outDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    for (const [name, html] of Object.entries(bothEditions())) {
      fs.writeFileSync(path.join(outDir, name), html, 'utf8');
      fs.utimesSync(path.join(outDir, name), old, old);
    }
    answerOk();
    await expect(generateTemplates(attrs, BASE)).resolves.toHaveLength(2);
  });

  it('更新時刻もファイル番号も変わらない書き方でも、内容が変われば書かれたとみなす', async () => {
    const outDir = generatorOutputDir();
    fs.mkdirSync(outDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    for (const name of Object.keys(bothEditions())) {
      fs.writeFileSync(path.join(outDir, name), '<html>前回</html>', 'utf8');
      fs.utimesSync(path.join(outDir, name), old, old);
    }
    answerRaw((call) => {
      for (const [name, html] of Object.entries(bothEditions())) {
        fs.writeFileSync(path.join(outDir, name), html, 'utf8');
        fs.utimesSync(path.join(outDir, name), old, old);
      }
      produce({ ...call }, {}, Object.keys(bothEditions()));
    });
    await expect(generateTemplates(attrs, BASE)).resolves.toHaveLength(2);
  });
});

describe('generateTemplates の全体の失敗', () => {
  const run = (a = attrs) => generateTemplates(a, BASE);

  it('終了コードが 0 でなければ stderr を含めて失敗にする', async () => {
    answerRaw(() => undefined, new Error('exit 1'), 'stderr detail');
    await expect(run()).rejects.toThrow(/Python生成器の実行に失敗: exit 1\nstderr detail/);
  });

  it('stderr が空の失敗は message だけで組む', async () => {
    answerRaw(() => undefined, new Error('exit 1'));
    await expect(run()).rejects.toThrow(/Python生成器の実行に失敗: exit 1$/);
  });

  it('ログが書かれていなければ実行ログの失敗として返す', async () => {
    answerRaw(() => undefined);
    await expect(run()).rejects.toThrow(/実行ログ/);
  });

  it('ログにあるのに書かれていない(起動前から変わっていない・無い)ファイルは失敗', async () => {
    const outDir = generatorOutputDir();
    fs.mkdirSync(outDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    const name = 'C1_F1_交付版.html';
    fs.writeFileSync(path.join(outDir, name), 'x', 'utf8');
    fs.utimesSync(path.join(outDir, name), old, old);
    answerRaw((call) => produce({ ...call }, {}, [name, 'C1_F1_全体版.html']));
    await expect(run()).rejects.toThrow(/Python生成器が .*書き出していません/);
  });

  it.each([
    ['スラッシュ', 'sub/C1_F1_全体版.html'],
    ['バックスラッシュ', 'sub\\C1_F1_全体版.html'],
    ['..', '..C1_F1_全体版.html'],
    ['4 つ区切り', 'C1_F1_20260101_全体版.html'],
    ['3 つ区切りでない', 'C1_全体版.html'],
  ])('ログの名前が不正(%s)なら失敗にする', async (_label, bad) => {
    answerRaw((call) =>
      produce({ ...call }, bothEditions(), [...Object.keys(bothEditions()), bad]),
    );
    await expect(run()).rejects.toThrow(/Python生成器の出力名/);
  });

  it('通常のファイルでなければ(フォルダ)失敗にする', async () => {
    answerRaw((call) => {
      produce({ ...call }, bothEditions());
      const dirName = path.join(generatorOutputDir(), 'C1_G1_交付版.html');
      fs.mkdirSync(dirName, { recursive: true });
      produce({ ...call }, {}, ['C1_G1_交付版.html']);
    });
    await expect(run()).rejects.toThrow(/Python生成器.*通常のファイルではありません/);
  });

  it('会社(略称)が違えば失敗にし、大文字小文字と末尾空白は同じとみなす', async () => {
    answerWith((c) => bothEditions(c.pos[1], 'OTHER'));
    await expect(run()).rejects.toThrow(/Python生成器.*会社/);
    answerWith((c) => bothEditions(c.pos[1], 'c1'));
    await expect(run()).resolves.toHaveLength(2);
  });

  it.each([
    ['末尾空白の会社', 'C1 _F1_交付版.html'],
    ['コロン(代替データストリーム)', 'C1_F1_交付版.html:x.html'],
    ['制御文字', 'C1_F1_交付版.html'],
  ])('名前の検査は厳密で、%s を含む名前は全体の失敗にする', async (_label, bad) => {
    answerRaw((call) =>
      produce({ ...call }, bothEditions(), [...Object.keys(bothEditions()), bad]),
    );
    await expect(run()).rejects.toThrow(/Python生成器の出力名/);
  });

  it('版種が 交付版・全体版 以外なら(組入先でも)全体の失敗にする', async () => {
    answerWith((c) => ({ ...bothEditions(c.pos[1]), 'C1_G1_月次.html': '<html>g</html>' }));
    await expect(run()).rejects.toThrow(/Python生成器の出力の版種/);
  });

  it('大文字小文字違いで同じファイルを重ねて挙げても 1 本として数える', async () => {
    answerRaw((call) =>
      produce({ ...call }, bothEditions(), [...Object.keys(bothEditions()), 'c1_f1_交付版.html']),
    );
    await expect(run()).resolves.toHaveLength(2);
  });

  it('作成画面のファンドの全体版が無ければ失敗にする', async () => {
    answerWith(() => ({ 'C1_F1_交付版.html': '<html>a</html>' }));
    await expect(run()).rejects.toThrow(/Python生成器.*全体版/);
  });

  it('作成画面のファンドの交付版が無ければ失敗にする', async () => {
    answerWith(() => ({ 'C1_F1_全体版.html': '<html>a</html>' }));
    await expect(run()).rejects.toThrow(/Python生成器.*交付版/);
  });

  it('本数が GENERATE_MAX_OUTPUT_FILES を超えれば失敗にする', async () => {
    vi.stubEnv('GENERATE_MAX_OUTPUT_FILES', '3');
    vi.resetModules();
    const { generateTemplates: gen } = await import('../src/generate/pyTemplate.js');
    answerWith(() => ({ ...bothEditions('F1'), ...bothEditions('G1') }));
    await expect(gen(attrs, BASE)).rejects.toThrow(/Python生成器.*上限/);
    answerWith(() => ({ ...bothEditions('F1'), 'C1_G1_交付版.html': '<html>g</html>' }));
    await expect(gen(attrs, BASE)).resolves.toHaveLength(3);
  });

  it('空のファイル(空白だけも含む)は失敗にする', async () => {
    answerWith(() => ({ 'C1_F1_交付版.html': '<html>a</html>', 'C1_F1_全体版.html': '  \n ' }));
    await expect(run()).rejects.toThrow(/Python生成器.*空/);
  });
});

describe('removeGeneratedFiles', () => {
  it('返したファイルを消し、既に無いファイルは無視する', async () => {
    answerOk();
    const files = await generateTemplates(attrs, BASE);
    fs.rmSync(files[0].path);
    await removeGeneratedFiles(files);
    expect(fs.existsSync(files[1].path)).toBe(false);
  });

  it('ENOENT 以外の失敗は投げる', async () => {
    const dir = path.join(generatorOutputDir(), 'sub.html');
    fs.mkdirSync(dir, { recursive: true });
    await expect(
      removeGeneratedFiles([
        {
          fileName: 'sub.html',
          attributes: { companyCode: 'a', fundCode: 'b', editionType: 'c' },
          html: '',
          path: dir,
        },
      ]),
    ).rejects.toThrow();
  });
});

describe('実 execFile 経路', () => {
  // 他のケースは `execFile` を差し替えているため、引数の組み立てが実 API を通るかは見ていない。
  // ここだけ差し替えを外し、存在しない実行ファイルで「失敗の形」が保たれることを確かめる。
  // `vi.doUnmock` はファイル末尾まで効くので、このケースは必ず最後に置く。
  it('実行ファイルが無ければ Python 生成器の失敗として包んで投げる', async () => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    vi.stubEnv('PYTHON_BIN', 'このコマンドは存在しません');
    const { generateTemplates: real } = await import('../src/generate/pyTemplate.js');
    await expect(real(attrs, BASE)).rejects.toThrow(/Python生成器の実行に失敗/);
    expect(execFileMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
