# editor テンプレ生成器の起動基盤と旧 editor/data の撤去 — 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 作成タブの「新規作成」が呼ぶ Python の生成器を `py -3.13` で起動し、子プロセスへ渡すものを許可リストに絞り、指紋の照合と同時実行の上限を付け、起動時に Python の版と指紋の設定を知らせる。あわせて旧 `editor/data` 構成の名残を撤去する（この端末の実データはワークスペースの外へ移す）。

**Architecture:** 起動コマンドは `config.python.bin` + `config.python.args`（`resolvePythonCommand`）で決める。`generate/pyTemplate.ts` が子プロセスの環境変数（`generatorEnv`）と生成器へ渡す JSON（明示したキーだけ）を組み、PDF ビルドと同じ受付制御（`BuildAdmissionGate`）の中で指紋を照合してから起動する。起動時の確認は `generate/generatorCheck.ts` に置き、`serve.ts` が待たずに呼ぶ。テスト用の偽の生成器は `fake_generate_template.py` へ改名し、`TEMPLATES_DIR` が無ければ元テンプレ指定をエラーにする。

**Tech Stack:** TypeScript（Node 24 / Fastify / vitest 4）、Python 3.13（偽の生成器）、PowerShell 5.1（offline の事前確認）、Pester 3/4、node:test（ルート scripts）。

**Spec:** `docs/superpowers/specs/2026-10-01-editor-generator-launch-design.md`

## Global Constraints

- 起動コマンドの既定は bin `py`・args `["-3.13"]`。実行ファイルを明示した（env `PYTHON_BIN` または appconfig `python.bin`）ときの args の既定は `[]`。appconfig `python.args` は常に最優先。環境変数 `PYTHON_ARGS` は作らない。
- 呼び出しは `execFile(bin, [...args, script, attrsJson])`。
- 子プロセスへ渡す環境変数は `PATH` `SYSTEMROOT` `TEMP` `TMP` `PATHEXT` `COMSPEC`（親にあるものだけ）と `PYTHONUTF8=1` `PYTHONIOENCODING=utf-8` `TEMPLATES_DIR=<config.templatesDir>` だけ。`process.env` を展開しない。起動時の版確認も同じ環境変数を使う。
- 生成器へ渡す JSON のキーは `companyCode` `fundCode` `editionType` `baseDate`（サーバの現在日 `yyyyMMdd`）と、指定時だけ `basedOnTemplateId`。`isRedemption` などリクエスト本文の他のキーは渡さない。
- 同時実行の上限は `GENERATE_MAX_CONCURRENCY`（既定 2、整数、上限 16）、待ち行列は `GENERATE_MAX_QUEUE`（既定 8、整数、上限 256）。どちらも `envPositiveNumber` を通す。超えたら待たずに HTTP 503、文言は `GENERATE_QUEUE_FULL_MESSAGE`。
- 指紋は env `PY_GENERATE_SCRIPT_SHA256` / appconfig `python.scriptSha256`（env 優先）。64 桁の 16 進以外は起動エラー。大文字は小文字へ正規化する。照合は生成のたび、受付枠を取った後・起動の直前。
- 起動時の版確認は `<bin> <args> -c "import sys; print('%d.%d' % sys.version_info[:2])"`、タイムアウト 10 秒。結果は info / warn のログだけで、起動は止めない。
- テスト用の偽の生成器は `editor/server/scripts/fake_generate_template.py`（`config.python.script` の既定）。
- この端末の `editor/data` は `C:\Users\caads\repo-archives\editor-data-seed-2026-10\` へ移す（消さない）。一覧は移動先の `MANIFEST-sha256.csv`。
- コミットに含めないもの: `docs/editor/editor_手引き.html`、`docs/editor/images/*.png`、`docs/pdf-to-svg/*`、ルート `.gitignore` の既存の未コミット変更（`AGENTS.md` 行の追加）。
- コメント規約（`docs/コメント規約.md`）: なぜを書く。経緯・日付・所見番号は書かない。100 桁。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write <変更ファイル>` を実行する。
- 新規の server ファイルでテストしたものは、ルート `vitest.config.ts` の coverage include に追加し、単体で 85% を満たす。
- 型チェックは `pnpm typecheck:editor`（`@editor/shared` の先行ビルド込み）。
- `offline/` の `.ps1` は UTF-8 BOM・CRLF を保つ。PowerShell 5.1 は git の日本語出力を化かすので、git の確認は Bash で行う。Python の起動は `py -3.13`。
- コミットメッセージに Co-Authored-By・Claude-Session などの署名行を付けない。

## Review Focus

1. 親プロセスに `HTTPS_PFX_PASSPHRASE` や `DB_CONN_EXTRA` があっても、生成器にも起動時の版確認にも渡らないこと（Task 3・Task 6 のテスト）。
2. リクエスト本文に `isRedemption` や未知のキーを足しても生成器へ渡らず、`baseDate` はサーバの現在日で渡ること。`basedOnTemplateId` が規約外ならルートで 400 になり、生成器を起動しないこと（Task 3 のテスト）。
3. `PYTHON_BIN` に絶対パスを指定したとき `-3.13` が付かないこと、appconfig の `python.args` が `PYTHON_BIN` より優先されること、指紋の形式違反（63 桁・空白入り・空文字）が起動エラーになること（Task 2 のテスト）。
4. 指紋の不一致とスクリプトが読めない場合の両方で生成器を起動せずに拒否し、サーバログに残ること（Task 4 のテスト）。
5. 同時 2・待ち 8 の 11 本目が待たずに 503 になり、1 本終わると次が起動し、失敗しても枠が返ること（Task 5 のテスト）。

---

### Task 1: この端末の `editor/data` をワークスペースの外へ移す

**Files:** なし（git 管理外のファイル操作。コミットしない）

この Task の成果物は、移動先に置いた検証済みの一覧 `C:\Users\caads\repo-archives\editor-data-seed-2026-10\MANIFEST-sha256.csv`。Task 9 で保護設定を外す前に、実データを安全な場所へ出しておく。

- [ ] **Step 1: git 管理外であることと移動先が空いていることを確かめる**

Run（Bash）: `cd /c/Users/caads/workspace && git ls-files editor/data | wc -l && ls /c/Users/caads/repo-archives/editor-data-seed-2026-10 2>&1 | head -1`
Expected: `0` と `No such file or directory`。移動先が既にあれば中止して報告する（上書きしない）。

- [ ] **Step 2: 一覧を取り、移し、移した後の一覧と突き合わせる**

PowerShell ツールで実行する:

```powershell
$src = 'C:\Users\caads\workspace\editor\data'
$dst = 'C:\Users\caads\repo-archives\editor-data-seed-2026-10'
$manifestName = 'MANIFEST-sha256.csv'
if (Test-Path -LiteralPath $dst) { throw "移動先が既にあります: $dst" }
function Get-DataManifest([string]$root) {
  $base = (Resolve-Path -LiteralPath $root).ProviderPath.TrimEnd('\') + '\'
  Get-ChildItem -LiteralPath $root -Recurse -File -Force |
    Where-Object { $_.Name -ne $manifestName } |
    Sort-Object FullName |
    ForEach-Object {
      [pscustomobject]@{
        Path   = $_.FullName.Substring($base.Length).Replace('\', '/')
        Size   = $_.Length
        Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
      }
    }
}
$before = @(Get-DataManifest $src)
"移動前: $($before.Count) 件"
Move-Item -LiteralPath $src -Destination $dst
$after = @(Get-DataManifest $dst)
$diff = @(Compare-Object $before $after -Property Path, Size, Sha256)
if ($diff.Count -gt 0) { $diff | Format-Table -AutoSize; throw '移動前後で一覧が一致しません' }
$after | Export-Csv -LiteralPath (Join-Path $dst $manifestName) -NoTypeInformation -Encoding UTF8
"一致: $($after.Count) 件 -> $(Join-Path $dst $manifestName)"
```

Expected: `移動前: 16 件` と `一致: 16 件 -> …\MANIFEST-sha256.csv`（`css` 2・`templates` 3・`templates-filled` 11）。件数が 16 でなくても、前後が一致していれば成功。一致しなければ移動先を消さずに報告する。

- [ ] **Step 3: 移動後の状態を確かめる**

Run（Bash）: `ls /c/Users/caads/workspace/editor/data 2>&1; ls /c/Users/caads/repo-archives/editor-data-seed-2026-10 && wc -l /c/Users/caads/repo-archives/editor-data-seed-2026-10/MANIFEST-sha256.csv`
Expected: 1 行目は `No such file or directory`。移動先に `css` `templates` `templates-filled` `MANIFEST-sha256.csv` があり、CSV は 17 行（見出し + 16 件）。

（コミットはしない。`git status` に変化が無いことだけ確かめる。）

---

### Task 2: config に起動コマンドの分割・指紋・同時実行の上限を足す

**Files:**
- Modify: `editor/server/src/config.ts`（appconfig スキーマの `python` 69-76 行、`envPositiveNumber` の直後に関数群、`config.python` 348-360 行）
- Create: `editor/server/test/config.python.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_PYTHON_BIN = 'py'`、`export const DEFAULT_PYTHON_ARGS: readonly string[]`、`export function resolvePythonCommand(opts: { envBin: string | undefined; fileBin: string | undefined; fileArgs: readonly string[] | undefined }): { bin: string; args: string[] }`、`export function parseScriptSha256(value: string | undefined, source: string): string | undefined`
- Produces: `config.python.args: string[]`、`config.python.scriptSha256: string | undefined`、`config.python.maxConcurrency: number`、`config.python.maxQueue: number`（`bin` / `script` / `timeoutMs` は既存）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/config.python.test.ts`:

```ts
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
import { parseScriptSha256, resolvePythonCommand } from '../src/config.js';

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
  it('何も指定しなければ py -3.13', () => {
    expect(resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs: undefined })).toEqual(
      { bin: 'py', args: ['-3.13'] },
    );
  });

  it('PYTHON_BIN を指定したら引数の既定は空(絶対パスの python.exe を直接指す運用)', () => {
    expect(
      resolvePythonCommand({ envBin: 'C:\\Python313\\python.exe', fileBin: undefined, fileArgs: undefined }),
    ).toEqual({ bin: 'C:\\Python313\\python.exe', args: [] });
  });

  it('appconfig の python.bin だけを指定しても引数の既定は空', () => {
    expect(resolvePythonCommand({ envBin: undefined, fileBin: 'python3', fileArgs: undefined })).toEqual({
      bin: 'python3',
      args: [],
    });
  });

  it('appconfig の python.args は PYTHON_BIN と併用しても優先される', () => {
    expect(resolvePythonCommand({ envBin: 'py', fileBin: undefined, fileArgs: ['-3.13', '-X', 'utf8'] }))
      .toEqual({ bin: 'py', args: ['-3.13', '-X', 'utf8'] });
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
  it('既定は py -3.13・指紋なし・同時 2・待ち 8', async () => {
    const { config } = await importConfig({});
    expect(config.python.bin).toBe('py');
    expect(config.python.args).toEqual(['-3.13']);
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
    const { config } = await importConfig({ GENERATE_MAX_CONCURRENCY: '3', GENERATE_MAX_QUEUE: '20' });
    expect(config.python.maxConcurrency).toBe(3);
    expect(config.python.maxQueue).toBe(20);
    await expect(importConfig({ GENERATE_MAX_CONCURRENCY: 'two' })).rejects.toThrow(
      /GENERATE_MAX_CONCURRENCY/,
    );
    await expect(importConfig({ GENERATE_MAX_QUEUE: '0' })).rejects.toThrow(/GENERATE_MAX_QUEUE/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/config.python.test.ts`
Expected: FAIL（`resolvePythonCommand` / `parseScriptSha256` が export されていない）

- [ ] **Step 3: 実装する**

`config.ts` の appconfig スキーマの `python` を置き換える:

```ts
    python: z
      .object({
        bin: z.string().optional(),
        args: z.array(z.string()).optional(),
        script: z.string().optional(),
        scriptSha256: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
```

`envPositiveNumber` の定義の直後（`const executableBrowser =` の前）に追加:

```ts
/** 生成器を起動する既定のコマンド(リポジトリの方針 `py -3.13`)。 */
export const DEFAULT_PYTHON_BIN = 'py';
export const DEFAULT_PYTHON_ARGS: readonly string[] = ['-3.13'];

/**
 * 生成器を起動する実行ファイルと、スクリプトの前に付ける引数を決める。
 *
 * 実行ファイルを明示した(env `PYTHON_BIN` / appconfig `python.bin`)ときは引数の既定を空にする。
 * 絶対パスの python.exe を直接指す運用で、py ランチャ用の `-3.13` が付くと起動できないため。
 * 引数を env で受けない(`PYTHON_ARGS` を設けない)のは、空白で区切る規則がパスの空白と衝突するため。
 */
export function resolvePythonCommand(opts: {
  envBin: string | undefined;
  fileBin: string | undefined;
  fileArgs: readonly string[] | undefined;
}): { bin: string; args: string[] } {
  const bin = opts.envBin ?? opts.fileBin ?? DEFAULT_PYTHON_BIN;
  const explicitBin = opts.envBin !== undefined || opts.fileBin !== undefined;
  const args = opts.fileArgs ?? (explicitBin ? [] : DEFAULT_PYTHON_ARGS);
  return { bin, args: [...args] };
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * 生成器のスクリプトの指紋(SHA256)を検査して小文字で返す。未指定は `undefined`(照合しない)。
 * 形式違反は起動中止にする。打ち間違いを黙って「照合しない」へ倒すと、守っているつもりの
 * 無防備が残る(`envNumber` と同じ方針)。
 */
export function parseScriptSha256(value: string | undefined, source: string): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (!SHA256_HEX_RE.test(v)) {
    throw new Error(
      `[config] ${source}=${JSON.stringify(value)} は SHA256 の 64 桁の 16 進ではありません。` +
        ' `certutil -hashfile <生成器のスクリプト> SHA256` の出力を指定してください。',
    );
  }
  return v.toLowerCase();
}
```

`config.python` を置き換える（`script` の既定は Task 7 で変える）:

```ts
  /**
   * テンプレート生成器(社内の共有フォルダなどにある既存ツール)。起動は
   * `<bin> <args...> <script> <属性 JSON>`(`generate/pyTemplate.ts`)。
   */
  python: {
    ...resolvePythonCommand({
      envBin: process.env.PYTHON_BIN,
      fileBin: file.python?.bin,
      fileArgs: file.python?.args,
    }),
    script: resolvePath(
      process.env.PY_GENERATE_SCRIPT,
      file.python?.script,
      'server/scripts/generate_template.py',
    ),
    /**
     * 生成器のスクリプトの SHA256。設定すると生成のたびに照合し、食い違えば生成を拒否する
     * (共有フォルダ上の生成器の差し替えに気づくため)。照合できるのは入口のスクリプト 1 本だけ。
     */
    scriptSha256:
      process.env.PY_GENERATE_SCRIPT_SHA256 !== undefined
        ? parseScriptSha256(
            process.env.PY_GENERATE_SCRIPT_SHA256,
            '環境変数 PY_GENERATE_SCRIPT_SHA256',
          )
        : parseScriptSha256(file.python?.scriptSha256, 'appconfig.json の python.scriptSha256'),
    timeoutMs: envPositiveNumber(
      'PY_TIMEOUT_MS',
      process.env.PY_TIMEOUT_MS,
      file.python?.timeoutMs ?? 30000,
      { integer: true, max: 600_000 },
    ),
    /** 同時に起動する生成器の上限。 */
    maxConcurrency: envPositiveNumber(
      'GENERATE_MAX_CONCURRENCY',
      process.env.GENERATE_MAX_CONCURRENCY,
      2,
      { integer: true, max: 16 },
    ),
    /** 生成の待ち行列の上限。超えた要求は待たせずに 503 で返す(`generate/pyTemplate.ts`)。 */
    maxQueue: envPositiveNumber('GENERATE_MAX_QUEUE', process.env.GENERATE_MAX_QUEUE, 8, {
      integer: true,
      max: 256,
    }),
  },
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/config.python.test.ts test/config.paths.test.ts test/config.security.test.ts`
Expected: PASS

Run: `pnpm typecheck:editor`
Expected: エラー 0（`pyTemplate.ts` はまだ `config.python.bin` しか使わないので通る）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/config.ts editor/server/test/config.python.test.ts
git add editor/server/src/config.ts editor/server/test/config.python.test.ts
git commit -m "feat(editor): 生成器の起動コマンドを bin と引数(既定 py -3.13)に分け、指紋と同時実行の上限の設定を足す"
```

---

### Task 3: 生成器へ渡す環境変数・引数・属性を絞る

**Files:**
- Modify: `editor/server/src/generate/pyTemplate.ts`（全面）
- Modify: `editor/server/src/routes/generate.routes.ts`（import、54-79 行、102 行）
- Modify: `editor/server/test/pyTemplate.test.ts`
- Modify: `editor/server/test/generate.routes.test.ts`（17-21 行の生成器の差し替え、`describe` 末尾にテスト 2 件）

**Interfaces:**
- Consumes: `config.python.bin` / `config.python.args` / `config.python.script`、`config.templatesDir`（Task 2）
- Produces: `export interface GenerateAttributes { companyCode: string; fundCode: string; editionType: string; baseDate: string; basedOnTemplateId?: string }`、`export function generatorEnv(): NodeJS.ProcessEnv`、`export function generateTemplate(attrs: GenerateAttributes): Promise<string>`（シグネチャ名は不変、`baseDate` が必須になる）

- [ ] **Step 1: 失敗するテストを書く（pyTemplate）**

`pyTemplate.test.ts` の先頭（`vi.hoisted` から `const attrs` まで）を置き換える:

```ts
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
```

既存の `describe('generateTemplate', …)` はそのまま残す（`attrs` に `baseDate` が入っただけで、既存ケースはそのまま通る）。新しい `describe` は必ず `describe('generateTemplate'` より**前**に置く — 末尾のケースが `vi.doUnmock` で差し替えを外すため、後ろに置いたケースは実プロセスを起動してしまう。

- [ ] **Step 2: 失敗するテストを書く（ルート）**

`generate.routes.test.ts` の生成器の差し替え（17-21 行の `vi.mock('../src/generate/pyTemplate.js', …)`）を置き換える:

```ts
// 生成器(python)と台帳(sproc)は本テストの対象外。台帳は既定で成功させ、孤児検査の
// ときだけ失敗へ切り替える。生成器は「何を渡されたか」だけを観測する。
let sprocFails = false;
const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async (_attrs: unknown) => '<html><body><p>生成物</p></body></html>'),
}));
vi.mock('../src/generate/pyTemplate.js', () => ({ generateTemplate: generateMock }));
```

`describe` の末尾（最後の `it` の後ろ）に追加:

```ts
  it('生成器へは検証済みの属性とサーバの基準日だけを渡す(本文の他のキーは渡らない)', async () => {
    generateMock.mockClear();
    const res = await generate({
      ...validBody,
      basedOnTemplateId: 'AM01_510037_20240710_交付版',
      isRedemption: true,
      evil: '<script>',
    });
    expect(res.statusCode).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toEqual({
      companyCode: 'AM01',
      fundCode: '510037',
      editionType: '交付版',
      baseDate: ymd,
      basedOnTemplateId: 'AM01_510037_20240710_交付版',
    });
  });

  it('規約外の basedOnTemplateId はルートで 400 にし、生成器を呼ばない', async () => {
    generateMock.mockClear();
    const res = await generate({ ...validBody, basedOnTemplateId: '../../outside/x' });
    expect(res.statusCode).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/pyTemplate.test.ts test/generate.routes.test.ts`
Expected: FAIL（`execFile` の args に `config.python.args` が無い、env に `process.env` 全体が入る、属性 JSON に余計なキーが入る、ルートが本文をそのまま渡す）

- [ ] **Step 4: pyTemplate.ts を実装する**

`editor/server/src/generate/pyTemplate.ts` を置き換える:

```ts
// =============================================================================
// pyTemplate.ts — Python テンプレート生成器を child_process で呼び出す
// =============================================================================
// 生成器は社内の共有フォルダなどに置かれた既存ツールで、editor はそのパスを設定
// (`config.python.script`)で指すだけ。子プロセスへ渡すものは「起動に要る環境変数」と
// 「ルートで検証した属性」だけに絞る。`process.env` を丸ごと渡すと、HTTPS のパスフレーズや
// DB 接続の追加文字列を共有上のコードが読める。秘密値だけを削る拒否リストにしないのは、
// 秘密値が増えたときに黙って漏れるため。
import { execFile } from 'node:child_process';
import { assertTemplateId } from '@editor/shared';
import { config } from '../config.js';

/** 生成器へ渡す属性。ルート(`generate.routes.ts`)で検証した値とサーバが決めた基準日だけ。 */
export interface GenerateAttributes {
  companyCode: string;
  fundCode: string;
  editionType: string;
  /** サーバの現在日(`yyyyMMdd`)。ファイル名・台帳の基準日と同じ値を生成器にも見せる。 */
  baseDate: string;
  basedOnTemplateId?: string;
}

/**
 * 親から引き継ぐ環境変数。Windows で py ランチャと Python が動く最小限
 * (`SYSTEMROOT` が無いと Python の乱数・ソケットの初期化が失敗する)。
 */
const INHERITED_ENV_KEYS = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'] as const;

/**
 * 生成器(と起動時の版確認)の子プロセスへ渡す環境変数を組む。`TEMPLATES_DIR` は元テンプレ指定
 * (`basedOnTemplateId`)の読み先で、サーバの本当の置き場(`config.templatesDir`)を必ず渡す。
 */
export function generatorEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Python ツールに UTF-8 出力を強制する(Windows の既定は cp932)。
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.TEMPLATES_DIR = config.templatesDir;
  return env;
}

/** 生成器へ渡す JSON を明示したキーだけで組む(呼び出し元のオブジェクトを素通ししない)。 */
function toGeneratorPayload(attrs: GenerateAttributes): GenerateAttributes {
  return {
    companyCode: attrs.companyCode,
    fundCode: attrs.fundCode,
    editionType: attrs.editionType,
    baseDate: attrs.baseDate,
    ...(attrs.basedOnTemplateId ? { basedOnTemplateId: attrs.basedOnTemplateId } : {}),
  };
}

/**
 * 生成器を呼び出す。属性は JSON 引数で渡し、生成されたテンプレート HTML は stdout から読む
 * (入出力の約束。テスト用の偽物は `config.python.script` の既定)。
 */
export function generateTemplate(attrs: GenerateAttributes): Promise<string> {
  // `basedOnTemplateId` は生成器側で templates ディレクトリと連結して読まれる。ルートでも検査
  // するが、ここを別の呼び出し元から使われても任意ファイルを取り込ませないよう、渡す前に
  // もう一度検査する(Python 側にも basename + 実パス封じ込めの検査がある)。
  if (attrs.basedOnTemplateId) assertTemplateId(attrs.basedOnTemplateId);
  return runGenerator(toGeneratorPayload(attrs));
}

function runGenerator(payload: GenerateAttributes): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python.bin,
      [...config.python.args, config.python.script, JSON.stringify(payload)],
      {
        timeout: config.python.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: generatorEnv(),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`Python生成器の実行に失敗: ${err.message}${stderr ? `\n${stderr}` : ''}`),
          );
          return;
        }
        if (!stdout.trim()) {
          reject(new Error('Python生成器が空の出力を返しました'));
          return;
        }
        resolve(stdout);
      },
    );
    child.on('error', reject);
  });
}
```

- [ ] **Step 5: ルートを直す**

`generate.routes.ts` の `@editor/shared` の import に `assertTemplateId,` を足す（`apiPaths,` の直後）。

`const attributes: TemplateAttributes = {…};` の直後に追加:

```ts
          // 元テンプレ指定も属性と同じくここで検査する。検査済みの値だけを生成器と作成履歴へ渡す。
          const basedOnTemplateId = body.basedOnTemplateId
            ? assertTemplateId(body.basedOnTemplateId)
            : undefined;
```

`await generateTemplate(body),` を置き換える:

```ts
            // 生成器へはリクエスト本文を渡さず、検証済みの属性とサーバの基準日だけを明示して
            // 組む(本文の他のキーが共有上のコードへ流れないようにする)。
            await generateTemplate({
              companyCode: attributes.companyCode,
              fundCode: attributes.fundCode,
              editionType: attributes.editionType,
              baseDate: attributes.baseDate,
              ...(basedOnTemplateId === undefined ? {} : { basedOnTemplateId }),
            }),
```

`await recordCreate(attributes, body.basedOnTemplateId, loginId);` の `body.basedOnTemplateId` を `basedOnTemplateId` に置き換える。

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/pyTemplate.test.ts test/generate.routes.test.ts test/generate.routes.local.test.ts`
Expected: PASS（末尾の「実 execFile 経路」のケースも、`PYTHON_BIN` 指定で args が空になるのでそのまま通る）

Run: `pnpm typecheck:editor`
Expected: エラー 0

- [ ] **Step 7: 実機で許可リストの環境変数だけで py -3.13 が動くことを確かめる**

Run（Bash）:

```bash
cd /c/Users/caads/workspace && node -e "
const {execFile}=require('child_process');
const env={};
for (const k of ['PATH','SYSTEMROOT','TEMP','TMP','PATHEXT','COMSPEC']) if (process.env[k]!==undefined) env[k]=process.env[k];
Object.assign(env,{PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',TEMPLATES_DIR:process.cwd()});
execFile('py',['-3.13','editor/server/scripts/generate_template.py',JSON.stringify({companyCode:'AM01',fundCode:'510037',editionType:'交付版',baseDate:'20261001'})],{env,encoding:'utf8',timeout:20000},(e,o,s)=>{console.log(e?('NG '+e.message+s):('OK '+o.length))});
"
```

Expected: `OK <正の数>`。`NG` なら、どの環境変数が足りないかを調べて報告する（許可リストへ黙って足さない。設計の変更になる）。

- [ ] **Step 8: コミット**

```bash
pnpm exec biome check --write editor/server/src/generate/pyTemplate.ts editor/server/src/routes/generate.routes.ts editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts
git add editor/server/src/generate/pyTemplate.ts editor/server/src/routes/generate.routes.ts editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts
git commit -m "fix(editor): 生成器へは許可した環境変数と検証済みの属性(サーバの基準日を含む)だけを渡す"
```

---

### Task 4: 生成のたびに生成器の指紋を照合する

**Files:**
- Modify: `editor/server/src/generate/pyTemplate.ts`
- Modify: `editor/server/test/pyTemplate.test.ts`（Task 3 で足した `describe` の直後、`describe('generateTemplate'` より前）

**Interfaces:**
- Consumes: `config.python.scriptSha256`（Task 2）
- Produces: `export const GENERATOR_FINGERPRINT_MISMATCH_MESSAGE: string`、内部の `generatorError(message, code, statusCode): Error`（`kind: 'unexpected'`・`code`・`statusCode` を持つ Error。`errorHandler` は `statusCode` を状態コードに、`message` を応答本文に使い、`auditedRethrow` は `message` を監査ログの `error` に残す）

- [ ] **Step 1: 失敗するテストを書く**

`pyTemplate.test.ts` の import に足す:

```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

Task 3 の `describe('生成器の起動のしかた', …)` の直後に追加:

```ts
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
    const { generateTemplate: gen, logger, GENERATOR_FINGERPRINT_MISMATCH_MESSAGE } = await load(
      script,
      'f'.repeat(64),
    );
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/pyTemplate.test.ts`
Expected: FAIL（`GENERATOR_FINGERPRINT_MISMATCH_MESSAGE` が無い、食い違っても起動する）

- [ ] **Step 3: 実装する**

`pyTemplate.ts` の import を置き換える:

```ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertTemplateId } from '@editor/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';
```

`INHERITED_ENV_KEYS` の定義の前に追加:

```ts
/** 指紋が合わないときに利用者へ出す文言(生成器の差し替えは管理者の対応事項)。 */
export const GENERATOR_FINGERPRINT_MISMATCH_MESSAGE =
  'テンプレート生成器の指紋が設定と一致しないため、生成を中止しました。管理者に連絡してください';

/**
 * 利用者へそのまま出せる文言と状態コードを持つ Error。`errorHandler` は `kind` を持つ値の
 * `message` を応答に使い、数値の `statusCode` を状態コードに使う。Error のインスタンスに
 * するのは、`auditedRethrow` が監査ログへ `message` を残すため。
 */
function generatorError(message: string, code: string, statusCode: number): Error {
  return Object.assign(new Error(message), { kind: 'unexpected' as const, code, statusCode });
}

/**
 * 生成器のスクリプトの指紋を照合する(設定が無ければ何もしない)。生成のたびに読むのは、
 * 照合から起動までの間に共有上のスクリプトを差し替えられる幅を狭めるため。読めないときも
 * 拒否する — 照合できない生成器を起動すると、指紋を設定した意味が消える。
 */
async function assertGeneratorFingerprint(): Promise<void> {
  const expected = config.python.scriptSha256;
  if (expected === undefined) return;
  const script = config.python.script;
  let actual: string;
  try {
    actual = createHash('sha256')
      .update(await readFile(script))
      .digest('hex');
  } catch (err) {
    logger.error({ err, script }, '[generate] 生成器のスクリプトを読めず指紋を照合できません — 生成を拒否しました');
    throw generatorError(GENERATOR_FINGERPRINT_MISMATCH_MESSAGE, 'GENERATOR_FINGERPRINT_MISMATCH', 500);
  }
  if (actual !== expected) {
    logger.error({ script, expected, actual }, '[generate] 生成器の指紋が設定と一致しません — 生成を拒否しました');
    throw generatorError(GENERATOR_FINGERPRINT_MISMATCH_MESSAGE, 'GENERATOR_FINGERPRINT_MISMATCH', 500);
  }
}
```

`generateTemplate` の `return runGenerator(toGeneratorPayload(attrs));` を置き換える:

```ts
  const payload = toGeneratorPayload(attrs);
  return (async () => {
    await assertGeneratorFingerprint();
    return runGenerator(payload);
  })();
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/pyTemplate.test.ts test/generate.routes.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/generate/pyTemplate.ts editor/server/test/pyTemplate.test.ts
git add editor/server/src/generate/pyTemplate.ts editor/server/test/pyTemplate.test.ts
git commit -m "feat(editor): 生成器のスクリプトの指紋を生成のたびに照合し、食い違えば生成を拒否してログに残す"
```

---

### Task 5: 生成の同時実行に上限を付ける

**Files:**
- Modify: `editor/server/src/vivliostyle/buildAdmission.ts`（ヘッダコメント、`BuildAdmissionOptions`、コンストラクタ、`acquire`）
- Modify: `editor/server/test/buildAdmission.test.ts`（`describe('BuildAdmissionGate'` の末尾に 1 件）
- Modify: `editor/server/src/generate/pyTemplate.ts`
- Modify: `editor/server/test/pyTemplate.test.ts`（Task 4 の `describe` の直後）

**Interfaces:**
- Consumes: `config.python.maxConcurrency` / `config.python.maxQueue`（Task 2）、`generatorError`（Task 4）
- Produces: `BuildAdmissionOptions.queueFullError?: () => Error`、`export const GENERATE_QUEUE_FULL_MESSAGE: string`

- [ ] **Step 1: 失敗するテストを書く（受付制御）**

`buildAdmission.test.ts` の `describe('BuildAdmissionGate', …)` の末尾に追加:

```ts
  it('queueFullError を渡せば満杯時にその Error を投げる(PDF の文言を流用しない)', async () => {
    const custom = Object.assign(new Error('生成が混み合っています'), { statusCode: 503 });
    const gate = new BuildAdmissionGate({ maxConcurrent: 1, maxQueue: 0, queueFullError: () => custom });
    const running = deferred();
    const a = gate.run(() => running.promise);
    await tick();
    await expect(gate.run(async () => undefined)).rejects.toBe(custom);
    running.resolve();
    await a;
  });
```

- [ ] **Step 2: 失敗するテストを書く（生成）**

`pyTemplate.test.ts` の import を `import { type GenerateAttributes, GENERATE_QUEUE_FULL_MESSAGE, generateTemplate } from '../src/generate/pyTemplate';` に置き換え、Task 4 の `describe('生成器の指紋', …)` の直後に追加:

```ts
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
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => generateTemplate(attrs)));
    // 同時に投げた 12 本のうち、満杯で断られるのは 2 本まで。残りは生成器の失敗として返る。
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(12);
    answerOk();
    await expect(generateTemplate(attrs)).resolves.toBe('<html>ok</html>');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/buildAdmission.test.ts test/pyTemplate.test.ts`
Expected: FAIL（`queueFullError` が無い、`GENERATE_QUEUE_FULL_MESSAGE` が無い、11 本目も起動を待つ）

- [ ] **Step 4: 受付制御に `queueFullError` を足す**

`buildAdmission.ts` のヘッダコメントの最後の段落の後ろに 1 段落足す:

```ts
//
// 生成器(`generate/pyTemplate.ts`)も同じ受付制御を使う。満杯時の Error は呼び出し側が
// `queueFullError` で渡す(文言と状態コードは経路ごとに違う)。
```

`BuildAdmissionOptions` の `maxQueue` の後ろに追加:

```ts
  /** 行列が満杯のときに投げる Error を作る。省略時は PDF ビルドの文言の Error。 */
  queueFullError?: () => Error;
```

クラスのフィールドに `private readonly queueFullError: () => Error;` を足し、コンストラクタの末尾に追加:

```ts
    this.queueFullError = opts.queueFullError ?? (() => new Error(BUILD_QUEUE_FULL_MESSAGE));
```

`acquire` の `return Promise.reject(new Error(BUILD_QUEUE_FULL_MESSAGE));` を `return Promise.reject(this.queueFullError());` に置き換える。

- [ ] **Step 5: 生成器を受付制御の中で起動する**

`pyTemplate.ts` の import に `import { BuildAdmissionGate } from '../vivliostyle/buildAdmission.js';` を足し、`assertGeneratorFingerprint` の定義の後ろに追加:

```ts
/** 生成の待ち行列が満杯のときに利用者へ出す文言(PDF ビルドの満杯時と同じ形)。 */
export const GENERATE_QUEUE_FULL_MESSAGE =
  'テンプレート生成の順番待ちが混み合っています。しばらく待ってから再実行してください';

/**
 * 生成の受付制御。上限が無いと、同時に押された数だけ Python が立ち上がる。満杯なら待たせずに
 * 503 で断る — 待たせると、待つ間ずっと HTTP 接続とリクエストを握り続ける。
 */
const GENERATE_GATE = new BuildAdmissionGate({
  maxConcurrent: config.python.maxConcurrency,
  maxQueue: config.python.maxQueue,
  queueFullError: () => generatorError(GENERATE_QUEUE_FULL_MESSAGE, 'GENERATE_QUEUE_FULL', 503),
});
```

`generateTemplate` の末尾（Task 4 の `return (async () => {…})();`）を置き換える:

```ts
  const payload = toGeneratorPayload(attrs);
  // 指紋の照合は枠を取った後・起動の直前に行う(待ち行列にいる間の差し替えも拾う)。
  return GENERATE_GATE.run(async () => {
    await assertGeneratorFingerprint();
    return runGenerator(payload);
  });
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/buildAdmission.test.ts test/buildWorkerPool.test.ts test/pyTemplate.test.ts test/generate.routes.test.ts`
Expected: PASS。「失敗しても枠を返す」のケースで満杯の断りが 2 本を超えて出るなら、失敗時に `release` されていない（`run` の `finally` を確認する）。

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/server/src/vivliostyle/buildAdmission.ts editor/server/test/buildAdmission.test.ts editor/server/src/generate/pyTemplate.ts editor/server/test/pyTemplate.test.ts
git add editor/server/src/vivliostyle/buildAdmission.ts editor/server/test/buildAdmission.test.ts editor/server/src/generate/pyTemplate.ts editor/server/test/pyTemplate.test.ts
git commit -m "feat(editor): 生成器の同時実行を 2 本・待ち 8 本に制限し、超えた要求は待たずに 503 で返す"
```

---

### Task 6: 起動時に生成器の Python の版と指紋の設定を知らせる

> **追加要件（コントローラ）:** 生成器のスクリプトが偽の生成器（`fake_generate_template.py`）のままなら、起動ログに警告を出す。本番で `PY_GENERATE_SCRIPT` を設定し忘れると、偽物が黙ってテンプレを作るため。判定は `path.basename(config.python.script).toLowerCase() === 'fake_generate_template.py'`。文言は「生成器が偽物（テスト用）のままです。本番では PY_GENERATE_SCRIPT で既存の生成器を指してください」。このタスクのテストに「偽物なら警告が出る・別名なら出ない」の 2 件を足す。


**Files:**
- Create: `editor/server/src/generate/generatorCheck.ts`
- Create: `editor/server/test/generatorCheck.test.ts`
- Modify: `editor/server/src/serve.ts`（import と `startServer` の `warnOnNetworkPlacement();` の直後）
- Modify: `vitest.config.ts`（coverage include の `'editor/server/src/generate/pyTemplate.ts',` の直後）

**Interfaces:**
- Consumes: `generatorEnv()`（Task 3）、`config.python.bin` / `args` / `script` / `scriptSha256`
- Produces: `export const EXPECTED_PYTHON_VERSION = '3.13'`、`export interface StartupLog { info(msg: string): void; warn(msg: string): void }`、`export function checkGeneratorAtStartup(log?: StartupLog): Promise<void>`（reject しない）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/generatorCheck.test.ts`:

```ts
// =============================================================================
// generatorCheck.test.ts — 起動時の生成器 Python の確認(版・起動失敗・指紋未設定の警告)
// =============================================================================
// 実プロセスは起動しない(`execFile` を差し替えて、返り値ごとのログの出し分けを固定する)。
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => {
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  process.env.LOG_DIR = `${tmpRoot}/editor-generator-check-logs`;
  // 既定では指紋を設定済みにして、版の警告だけを観測する。未設定の警告は専用のケースで見る。
  process.env.PY_GENERATE_SCRIPT_SHA256 = 'a'.repeat(64);
  return { execFileMock: vi.fn() };
});
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { config } from '../src/config.js';
import { checkGeneratorAtStartup, EXPECTED_PYTHON_VERSION } from '../src/generate/generatorCheck.js';

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
    expect(args).toEqual([...config.python.args, '-c', expect.stringContaining('sys.version_info')]);
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

  it('3.13 以外なら版を添えて警告する', async () => {
    answer(null, '3.12\n');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/3\.12[\s\S]*3\.13/));
  });

  it('exit 9009(Store のスタブ・py が無い)は起動失敗として警告する', async () => {
    answer(Object.assign(new Error('Command failed: py -3.13 -c ...'), { code: 9009 }), '');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/起動できません[\s\S]*9009/));
  });

  it('実行ファイルが無い(ENOENT)も起動失敗として警告し、reject しない', async () => {
    answer(Object.assign(new Error('spawn py ENOENT'), { code: 'ENOENT' }), '');
    const log = fakeLog();
    await expect(checkGeneratorAtStartup(log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/起動できません[\s\S]*ENOENT/));
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
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/generatorCheck.test.ts`
Expected: FAIL（`generatorCheck.js` が無い）

- [ ] **Step 3: 実装する**

`editor/server/src/generate/generatorCheck.ts`:

```ts
// =============================================================================
// generatorCheck.ts — 起動時に生成器の Python と指紋の設定を 1 回だけ確かめてログへ出す
// =============================================================================
// 生成器を起動できない環境(py ランチャが無い・3.13 が無い・Microsoft Store のスタブに解決
// される)は、最初の「新規作成」まで誰も気づかない。起動ログで先に知らせる。起動は止めない —
// 生成を使わない運用(local・閲覧専用)まで止まるため。
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generatorEnv } from './pyTemplate.js';

/** 生成器が前提とする Python の版(リポジトリの方針 `py -3.13`)。 */
export const EXPECTED_PYTHON_VERSION = '3.13';

const VERSION_PROBE = "import sys; print('%d.%d' % sys.version_info[:2])";
const PROBE_TIMEOUT_MS = 10_000;

/** 確認結果の出力先(既定はサーバのロガー。テストで差し替える)。 */
export interface StartupLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** `<bin> <args> -c <probe>` で版を取る。起動できなければ理由を返す(reject しない)。 */
function probePythonVersion(): Promise<{ version: string } | { failure: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      config.python.bin,
      [...config.python.args, '-c', VERSION_PROBE],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env: generatorEnv() },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          const detail = stderr.trim();
          resolve({
            failure:
              `${err.message}${code === undefined ? '' : ` [code=${String(code)}]`}` +
              `${detail === '' ? '' : ` ${detail}`}`,
          });
          return;
        }
        resolve({ version: stdout.trim() });
      },
    );
    child.on('error', (err) => resolve({ failure: err.message }));
  });
}

/** 生成器の Python の版と指紋の設定を確かめ、結果をログへ出す。 */
export async function checkGeneratorAtStartup(log: StartupLog = logger): Promise<void> {
  const command = [config.python.bin, ...config.python.args].join(' ');
  const probe = await probePythonVersion();
  if ('failure' in probe) {
    log.warn(
      `[generate] 生成器の Python を起動できません(${command}): ${probe.failure} — ` +
        '作成タブの「新規作成」は失敗します。Python 3.13 と py ランチャを入れるか、' +
        'PYTHON_BIN / appconfig の python.bin・python.args を確認してください',
    );
  } else if (probe.version !== EXPECTED_PYTHON_VERSION) {
    log.warn(
      `[generate] 生成器の Python が ${probe.version} です(${command})。` +
        `${EXPECTED_PYTHON_VERSION} を前提にしています — python.args などで版を指定してください`,
    );
  } else {
    log.info(`[generate] 生成器の Python: ${probe.version}(${command})`);
  }
  if (config.python.scriptSha256 === undefined) {
    log.warn(
      `[generate] 生成器の指紋が未設定です(${config.python.script})。共有フォルダ上の生成器を` +
        '使うなら PY_GENERATE_SCRIPT_SHA256 / appconfig の python.scriptSha256 の設定を推奨します',
    );
  }
}
```

`serve.ts` の import に `import { checkGeneratorAtStartup } from './generate/generatorCheck.js';` を足し、`warnOnNetworkPlacement();` の直後に追加:

```ts
  // 生成器の Python と指紋の設定を確かめる。待たない(最大 10 秒の確認で listen を遅らせない)。
  // 結果は警告ログだけで起動は止めない — 生成を使わない運用まで止まるため。
  void checkGeneratorAtStartup();
```

`vitest.config.ts` の coverage include で `'editor/server/src/generate/pyTemplate.ts',` の直後に追加:

```ts
        'editor/server/src/generate/generatorCheck.ts',
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/generatorCheck.test.ts`
Expected: PASS（全 6 件）

Run: `pnpm typecheck:editor`
Expected: エラー 0

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/generate/generatorCheck.ts editor/server/test/generatorCheck.test.ts editor/server/src/serve.ts
git add editor/server/src/generate/generatorCheck.ts editor/server/test/generatorCheck.test.ts editor/server/src/serve.ts vitest.config.ts
git commit -m "feat(editor): 起動時に生成器の Python の版と指紋の設定を確かめ、3.13 でない・起動できない・未設定を警告する"
```

---

### Task 7: 偽の生成器を改名し、元テンプレの読み先を TEMPLATES_DIR だけにする

**Files:**
- Rename: `editor/server/scripts/generate_template.py` → `editor/server/scripts/fake_generate_template.py`（`git mv`）
- Modify: `editor/server/scripts/fake_generate_template.py`（docstring と `based_on` の分岐）
- Create: `editor/server/test/fakeGenerator.test.ts`
- Modify: `editor/server/src/config.ts`（`python.script` の既定）
- Modify: `editor/server/scripts/e2e-rest-server.ts`（27-29 行）
- Modify: `editor/e2e/create.spec.ts`（4 行・36 行のコメント）
- Modify: `editor/server/scripts/pdf-build-worker.mjs`（8 行のコメント）
- Modify: `editor/scripts/offline/python-wheelhouse.ps1`（7 行。ASCII のまま）
- Modify: `editor/appconfig.example.json`（`python.script`。`paths` は Task 9）

**Interfaces:**
- Produces: 偽の生成器の入出力 — argv[1] の JSON（Global Constraints のキー）、stdout に HTML。`basedOnTemplateId` があり `TEMPLATES_DIR` が無ければ exit 2・stderr に `TEMPLATES_DIR`。

- [ ] **Step 1: 改名する**

Run: `git mv editor/server/scripts/generate_template.py editor/server/scripts/fake_generate_template.py`

- [ ] **Step 2: 失敗するテストを書く**

`editor/server/test/fakeGenerator.test.ts`:

```ts
// =============================================================================
// fakeGenerator.test.ts — テスト用の偽の生成器(fake_generate_template.py)の入出力
// =============================================================================
// 実プロセスで起動する(Windows は py -3.13、それ以外は python3)。e2e と local の検証の
// 「新規作成」がこれを通るので、元テンプレの読み先が TEMPLATES_DIR だけであることを固定する。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../scripts/fake_generate_template.py');
const [BIN, BIN_ARGS]: [string, string[]] =
  process.platform === 'win32' ? ['py', ['-3.13']] : ['python3', []];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fake-generator-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ATTRS = { companyCode: 'AM01', fundCode: '510037', editionType: '交付版', baseDate: '20261001' };

function run(
  attrs: Record<string, unknown>,
  extraEnv: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extraEnv };
  for (const key of ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    execFile(
      BIN,
      [...BIN_ARGS, SCRIPT, JSON.stringify(attrs)],
      { encoding: 'utf8', timeout: 20_000, env },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('fake_generate_template.py', () => {
  it('元テンプレ指定が無ければ属性入りのスケルトンを出す', async () => {
    const r = await run(ATTRS, {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('{{ fund.name }}');
    expect(r.stdout).toContain('ファンド: 510037');
  }, 30_000);

  it('元テンプレは TEMPLATES_DIR の <id>.html を読む', async () => {
    const templates = path.join(tmp, 'templates');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'AM01_510037_20240710_交付版.html'), '<p>元テンプレ</p>', 'utf8');
    const r = await run(
      { ...ATTRS, basedOnTemplateId: 'AM01_510037_20240710_交付版' },
      { TEMPLATES_DIR: templates },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('<p>元テンプレ</p>');
  }, 30_000);

  it('TEMPLATES_DIR が無ければ元テンプレ指定はエラー(既定の置き場を黙って読まない)', async () => {
    const r = await run({ ...ATTRS, basedOnTemplateId: 'AM01_510037_20240710_交付版' }, {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('TEMPLATES_DIR');
    expect(r.stdout).toBe('');
  }, 30_000);

  it('置き場の外を指す元テンプレ指定はエラー', async () => {
    const r = await run({ ...ATTRS, basedOnTemplateId: '../outside' }, { TEMPLATES_DIR: tmp });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid basedOnTemplateId');
  }, 30_000);
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/fakeGenerator.test.ts`
Expected: FAIL（「TEMPLATES_DIR が無ければエラー」のケースで、旧 fallback が `editor/data/templates` を探して exit 0 のスケルトンを返す）

- [ ] **Step 4: 偽の生成器を直す**

`fake_generate_template.py` の docstring を置き換える:

```python
"""テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で既存の生成器を指す。

入出力の約束(呼び出し元は editor/server/src/generate/pyTemplate.ts):
- argv[1] は JSON: {companyCode, fundCode, editionType, baseDate, basedOnTemplateId?}
- 生成した Jinja2 テンプレート HTML を stdout へ出す。

basedOnTemplateId があれば、環境変数 TEMPLATES_DIR(サーバが config.templatesDir を渡す)の
<id>.html をそのまま返す。TEMPLATES_DIR が無ければ元テンプレ指定はエラーにする。
"""
```

`if based_on:` の中の `templates_dir = os.environ.get(…)` の 4 行を置き換える:

```python
        templates_dir = os.environ.get("TEMPLATES_DIR")
        if not templates_dir:
            # サーバは必ず TEMPLATES_DIR を渡す。無いのは単独実行か呼び出し元の不備で、既定の
            # 置き場を推測して読むと、別の環境のテンプレを元にした生成物ができてしまう。
            print("TEMPLATES_DIR is required when basedOnTemplateId is given", file=sys.stderr)
            return 2
```

- [ ] **Step 5: 参照を新しい名前へ直す**

- `config.ts` の `python.script` の既定 `'server/scripts/generate_template.py'` を `'server/scripts/fake_generate_template.py'` に置き換える。
- `e2e-rest-server.ts` の 27-29 行（`// 作成タブ(…` から `process.env.PYTHON_BIN ??= …` まで）を置き換える:

```ts
  // 作成タブ(`POST /api/generate`)は生成器を子プロセスで呼ぶ。Windows は既定の `py -3.13`
  // をそのまま使い、py ランチャの無い Linux(CI)だけ python3 を直接指す。
  if (process.platform !== 'win32') process.env.PYTHON_BIN ??= 'python3';
```

- `create.spec.ts` 4 行の `` `server/scripts/generate_template.py` `` を `` テスト用の偽物 `server/scripts/fake_generate_template.py` `` に、36 行の `` `generate_template.py` `` を `` `fake_generate_template.py` `` に置き換える。
- `pdf-build-worker.mjs` 8 行の `` `server/scripts/generate_template.py` `` を `` `server/scripts/fake_generate_template.py` `` に置き換える。
- `python-wheelhouse.ps1` 7 行の `The current generator stub (server/scripts/generate_template.py) uses only the Python` を `The fake generator for tests (server/scripts/fake_generate_template.py) uses only the Python` に置き換える（ASCII のまま。BOM を付けない）。
- `appconfig.example.json` の `"python"` を置き換える:

```json
  "python": {
    "bin": "py",
    "args": ["-3.13"],
    "script": "server/scripts/fake_generate_template.py",
    "timeoutMs": 30000
  },
```

Run: `git grep -n "generate_template\.py" -- editor ':!editor/server/scripts/fake_generate_template.py' | grep -v fake_generate_template`
Expected: 出力なし（`docs/` は Task 10 で直す）

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/fakeGenerator.test.ts test/pyTemplate.test.ts test/config.python.test.ts`
Expected: PASS

Run: `pnpm typecheck:editor`
Expected: エラー 0（`e2e-rest-server.ts` は `tsconfig.tools.json` で検査される）

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/server/src/config.ts editor/server/test/fakeGenerator.test.ts editor/server/scripts/e2e-rest-server.ts editor/e2e/create.spec.ts editor/server/scripts/pdf-build-worker.mjs editor/appconfig.example.json
git add editor/server/scripts/fake_generate_template.py editor/server/scripts/generate_template.py editor/server/test/fakeGenerator.test.ts editor/server/src/config.ts editor/server/scripts/e2e-rest-server.ts editor/e2e/create.spec.ts editor/server/scripts/pdf-build-worker.mjs editor/scripts/offline/python-wheelhouse.ps1 editor/appconfig.example.json
git commit -m "refactor(editor): 仮の生成器をテスト用の偽物として改名し、元テンプレは TEMPLATES_DIR からだけ読む"
```

（`git add` に旧名を含めるのは、`git mv` の削除側を確実にステージするため。）

---

### Task 8: offline の事前確認に `py -3.13` を足す

**Files:**
- Modify: `offline/lib/verify.ps1`（末尾に関数 1 つ）
- Modify: `offline/lib/verify.Tests.ps1`（末尾に `Describe` 1 つ）
- Modify: `offline/setup-offline.ps1`（`$sourceCommit` を表示する 2 行の直後）

**Interfaces:**
- Produces: `function Test-Python313Launcher { param([scriptblock]$Invoke) }` — 終了コード 0 なら `$null`、それ以外は案内文（文字列）を返す。`$Invoke` は終了コードを返すスクリプトブロック（テストで差し替える）。

- [ ] **Step 1: 失敗するテストを書く**

`verify.Tests.ps1` の末尾に追加:

```powershell
Describe 'Test-Python313Launcher（py -3.13 が起動できるか）' {
  It '終了コード 0 なら null（案内なし）' {
    ($null -eq (Test-Python313Launcher -Invoke { 0 })) | Should Be $true
  }
  It 'py が無い(9009)なら Python 3.13 と py ランチャの導入を案内する' {
    Test-Python313Launcher -Invoke { 9009 } | Should Match 'Python 3\.13 と py ランチャを入れてください'
  }
  It '3.13 が入っていない(py が非 0 を返す)ときも同じ案内で、終了コードを添える' {
    Test-Python313Launcher -Invoke { 103 } | Should Match '終了コード: 103'
  }
  It 'setup-offline.ps1 がこの確認を呼ぶ' {
    $setup = [IO.File]::ReadAllText((Join-Path $repoRoot 'offline\setup-offline.ps1'), [Text.Encoding]::UTF8)
    $setup | Should Match 'Test-Python313Launcher'
  }
}
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm run ci:offline`
Expected: FAIL（`Test-Python313Launcher` が見つからない）

- [ ] **Step 3: 実装する**

`verify.ps1` の末尾に追加:

```powershell
# ── 前提ツールの確認: py -3.13 ──
# editor の作成タブ（テンプレ生成器）と docs のビルドは `py -3.13` で Python を起動する。
# 起動できない端末は、setup が成功しても最初の「新規作成」や docs ビルドまで気づかないので、
# setup の時点で案内する。止めはしない（Python を使わない運用もある）。
# -Invoke は終了コードを返すスクリプトブロック（テストで差し替える）。既定は py ランチャの
# 有無を Get-Command で見てから実行する（無い端末で例外にしない）。
function Test-Python313Launcher {
  param(
    [scriptblock]$Invoke = {
      if (-not (Get-Command 'py' -ErrorAction SilentlyContinue)) { return 9009 }
      & py -3.13 -c 'import sys' | Out-Null
      return $LASTEXITCODE
    }
  )
  $code = & $Invoke
  if ($code -eq 0) { return $null }
  return ("Python 3.13 と py ランチャを入れてください（py -3.13 が起動できません。終了コード: $code）。" +
    'editor の作成タブ（テンプレ生成）と docs のビルドが使います。')
}
```

`setup-offline.ps1` の `if ($sourceCommit) { Write-Host "[info] source commit: $sourceCommit" }` の直後に追加:

```powershell
# editor の作成タブと docs のビルドが使う Python の確認（止めずに案内だけ出す）。
$pyNote = Test-Python313Launcher
if ($pyNote) { Write-Warning "[warn] $pyNote" } else { Write-Host '[info] py -3.13 を確認しました。' }
```

3 ファイルとも UTF-8 BOM・CRLF を保つ。Edit で改行が LF になった場合に備えて揃え直す:

Run: `py -3.13 -c "import pathlib,sys; [pathlib.Path(p).write_bytes(pathlib.Path(p).read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')) for p in sys.argv[1:]]" offline/lib/verify.ps1 offline/lib/verify.Tests.ps1 offline/setup-offline.ps1`

Run: `file offline/lib/verify.ps1 offline/lib/verify.Tests.ps1 offline/setup-offline.ps1`
Expected: 3 つとも `UTF-8 (with BOM) text, with CRLF line terminators`

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm run ci:offline`
Expected: PASS（追加の 4 件を含め全件）

Run（PowerShell）: `. .\offline\lib\verify.ps1; Test-Python313Launcher`
Expected: 何も出ない（この端末は py -3.13 が通る = `$null`）

- [ ] **Step 5: コミット**

```bash
git add offline/lib/verify.ps1 offline/lib/verify.Tests.ps1 offline/setup-offline.ps1
git commit -m "feat(offline): setup で py -3.13 が起動できるかを確かめ、できなければ Python 3.13 と py ランチャの導入を案内する"
```

---

### Task 9: 旧 editor/data の移行機能・保護設定・名残を撤去する

**Files:**
- Modify: `editor/scripts/init-data-repo.ps1`（DESCRIPTION の手順 2、82-92 行、120-122 行）
- Modify: `.gitignore`（46-47 行。既存の未コミット変更は含めずにステージする）
- Modify: `biome.json`（16 行）
- Modify: `scripts/clean.mjs`（10-12 行・22-32 行のコメント、34 行の `NEVER_REL`）
- Modify: `scripts/clean.test.mjs`（4-11 行のコメント、24 行、39-43 行）
- Modify: `editor/appconfig.example.json`（`paths`）
- Modify: `editor/web/test/fillJinja.dom.test.ts`（1 行の import、132-161 行）
- Modify: コメント 5 か所 — `editor/server/src/config.ts`（128-134 行）、`editor/shared/src/index.ts`（84 行）、`editor/shared/src/repositories/ReviewRepository.ts`（4 行）、`editor/web/src/lib/formatOutput.ts`（6-7 行）、`editor/web/src/features/preview/services/templatePreviewService.ts`（121 行）
- Modify: `editor/README.md`（24 行のツリー図）

**Interfaces:**
- Consumes: Task 1 の完了（`editor/data` が既に無いこと）
- Produces: なし（撤去のみ）

- [ ] **Step 1: 前提を確かめる**

Run（Bash）: `test ! -e /c/Users/caads/workspace/editor/data && test -f /c/Users/caads/repo-archives/editor-data-seed-2026-10/MANIFEST-sha256.csv && echo ready`
Expected: `ready`。出なければ Task 1 へ戻る（保護設定を外す前に実データを外へ出す）。

- [ ] **Step 2: clean のテストを先に直す（保護領域から editor/data を外す）**

`clean.test.mjs`:
- 4 行の `` `NEVER_REL` (保護 3 領域: editor/data・git-tools・native-prebuilds) `` を `` `NEVER_REL` (保護 2 領域: git-tools・native-prebuilds) `` に置き換える。
- 10 行の `疑似リポジトリを都度組み立て、保護 3 領域それぞれへ` を `疑似リポジトリを都度組み立て、保護 2 領域それぞれへ` に置き換える。
- 24 行を置き換える:

```js
const PROTECTED_RELS = ['git-tools', 'native-prebuilds'];
```

- 26 行の `// 保護 3 領域それぞれの配下に` を `// 保護 2 領域それぞれの配下に` に置き換える。
- `buildFixtureRepo` の「ROOT 以外の cwd」の段落（39-43 行）を置き換える:

```js
  // ROOT 以外の cwd (実運用でよくある起動元。ここから相対解決するとバグを再現する)。
  // `editor` と `scratch` はどちらも中身の無い作業場所として新設する。
  mkdirSync(join(root, 'editor'), { recursive: true });
  mkdirSync(join(root, 'scratch'), { recursive: true });
```

さらに `for (const { label, pick } of CWD_KINDS) { … }` の後ろに 1 件追加:

```js
test('clean.mjs は editor/data を保護領域として扱わない(旧構成の名残を持たない)', () => {
  const src = readFileSync(CLEAN_SRC, 'utf8');
  assert.ok(!src.includes("'editor/data'"), 'NEVER_REL に editor/data が残っている');
});
```

import の `cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync` に `readFileSync` を足す。

Run: `pnpm run test:scripts`
Expected: FAIL（追加した 1 件が `NEVER_REL に editor/data が残っている` で落ちる）

- [ ] **Step 3: clean.mjs から editor/data を外す**

`clean.mjs` 10-12 行を置き換える:

```js
//   - `git clean -Xd` のような「ignore 全消し」はしない。巻き込み事故 (`git-tools` の
//     同梱バイナリ・大容量バンドル) を避けるため、対象は下のキュレーション済みリストに限定する。
```

22-32 行のコメントを置き換える:

```js
// ── 1. 絶対に触れない領域 ──
// 走査で降りず、削除候補にも絶対に入れない。`.git` は履歴、`git-tools` と `native-prebuilds` は
// 同梱バイナリ (git 管理外の重量物。再配布・再取得が要る)。
// 照合は**小文字へ畳んでから** (`isNever*`): Windows のファイルシステムは大文字小文字を
// 保持するだけで区別せず、ネットワークドライブ経由では `Git-Tools` のような別ケーシングが
// 返ることがある。厳密一致だと除外が外れて `--yes` が同梱バイナリを消しうる。
// `NEVER_REL` は**固定文字列**で持つ (`rel()` へは渡さない): `rel()` は `path.relative` で
// 絶対パスを前提とするため、相対文字列を渡すと cwd 基準で解決されてしまい、cwd が ROOT 以外
// (例: `cd editor && node ../scripts/clean.mjs`) だとここの領域が丸ごと外れる。
```

34 行を置き換える:

```js
const NEVER_REL = new Set(['git-tools', 'native-prebuilds']);
```

Run: `pnpm run test:scripts`
Expected: PASS

- [ ] **Step 4: init-data-repo.ps1 から seed コピーと追跡解除の案内を外す**

DESCRIPTION の処理内容を置き換える（12-13 行）:

```text
    2. dataRoot が未初期化なら git init + .gitignore/.gitattributes + 初回コミット。
```

（旧手順 2「既存 editor/data/{templates,css} があれば dataRoot へコピーする(初回移行)。」の行を消し、旧手順 3 を 2 に繰り上げる。）

82-92 行（`# 2. 既存 editor/data の本体…` から対応する `}` まで）を削除し、94 行の `# 3. git リポジトリを初期化する(未初期化のときだけ)。` を `# 2. git リポジトリを初期化する(未初期化のときだけ)。` に置き換える。

末尾の 3 行（`Write-Host '  - 旧 editor/data の追跡解除(任意。ワークスペースで実行):'` とその下 2 行）を削除する。

Run: `head -c 3 editor/scripts/init-data-repo.ps1 | od -An -tx1 && grep -n "editor/data\|seed\|追跡解除" editor/scripts/init-data-repo.ps1`
Expected: `ef bb bf` のみ（grep は出力なし）

Run（PowerShell）: `$t = Join-Path $env:TEMP ('idr-' + [guid]::NewGuid().ToString('N')); & .\editor\scripts\init-data-repo.bat -DataRoot $t; Get-ChildItem $t -Name; Remove-Item $t -Recurse -Force`
Expected: `templates` `filled` `css` `sync` `drafts` `pending` `reviews` `notes` `js` `images` `.gitignore` `.gitattributes` `.git` が並び、エラーが出ない。

- [ ] **Step 5: ルート .gitignore と biome.json から editor/data を外す**

まず既存の未コミット変更を確認する:

Run（Bash）: `cd /c/Users/caads/workspace && git diff .gitignore`
Expected: `+AGENTS.md` の 1 行だけ（この変更はこの計画の対象外。ステージしない）。

作業ツリーの `.gitignore` から次の 2 行を削除する（46-47 行）:

```text
# editor のテンプレ実体(templates/css/drafts)はワークスペース外の dataRoot で git 版管理する
editor/data/
```

`biome.json` の `"!editor/data",` の行を削除する。

`.gitignore` は対象の 2 行の削除だけをステージする（`git add -p` は対話式なので使わない。HEAD の内容から 2 行を除いたものをインデックスへ直接書く）:

```bash
cd /c/Users/caads/workspace
git show HEAD:.gitignore | sed -e '/^# editor のテンプレ実体/d' -e '/^editor\/data\/$/d' > .git/gitignore.staged
blob=$(git hash-object -w .git/gitignore.staged)
git update-index --cacheinfo 100644,"$blob",.gitignore
rm .git/gitignore.staged
git diff --cached .gitignore
git diff .gitignore
```

Expected: `git diff --cached` は `-# editor のテンプレ実体…` と `-editor/data/` の 2 行の削除だけ。`git diff` は `+AGENTS.md` の 1 行だけ。

- [ ] **Step 6: appconfig.example.json の paths を dataRoot だけにする**

`"paths"` を置き換える:

```json
  "paths": {
    "dataRoot": "../../editor-data",
    "tmpDir": ".tmp",
    "logDir": "logs",
    "webDist": "web/dist"
  },
```

Run（Bash）: `cd /c/Users/caads/workspace && env -u DATA_ROOT APP_CONFIG="$(pwd)/editor/appconfig.example.json" pnpm --filter server exec tsx -e "import('./src/config.ts').then(m => console.log(m.config.python.bin, m.config.python.args, m.config.python.script, m.config.templatesDir))"`
Expected: `py [ '-3.13' ] …\fake_generate_template.py …\editor-data\templates`（例の appconfig がスキーマ検証を通る。`APP_CONFIG` は絶対パスで渡す — `pnpm --filter` は cwd を `editor/server` に変えるので、相対パスだと「ファイル無し = {}」として黙って素通りし、確認にならない。`DATA_ROOT=` のように空文字を渡すと置き場が repoRoot に化けるので `env -u` で外す）

- [ ] **Step 7: fillJinja の実データ系統を fixtures 側の最小の代替に置き換える**

1 行の import を `import { readdirSync, readFileSync } from 'node:fs';` に置き換える。

132-161 行（`// fixture テンプレ(上)と REST 検証データ…` のコメントから `describe('data/templates と生成スケルトンの…', …)` の終わりまで）を置き換える:

```ts
// fixture テンプレ(上)と生成器のスケルトンは書きぶりが分岐しており、fixture だけを検査すると
// 生成器だけが参照するキー(`report.baseDate` と `fund.navChange` の符号分岐で実際に起きた)の
// 欠落が素通りする。生成器の書きぶりの最小の代替をここに置き、参照キーがサンプルデータで
// 満たされることを固定する。
const GENERATED_SKELETON_BODY = `<div class="page">
<header class="report-header">
  <h1 class="report-title">{{ fund.name }}</h1>
  <p class="report-meta">基準日: {{ report.baseDate }}　版種: {{ report.editionType }}</p>
</header>
<section class="summary">
  <p class="nav">{{ fund.nav }} 円</p>
  {% if fund.navChange >= 0 %}
  <p class="nav-change up">前日比 +{{ fund.navChange }} 円</p>
  {% else %}
  <p class="nav-change down">前日比 {{ fund.navChange }} 円</p>
  {% endif %}
</section>
<table class="holdings-table"><tbody>
  {% for h in holdings %}
  <tr data-rank="{{ loop.index }}"><td>{{ loop.index }}</td><td>{{ h.name }}</td><td>{{ h.weight }}%</td></tr>
  {% endfor %}
</tbody></table>
<footer class="report-footer"><p>委託会社: {{ company.name }}（{{ company.code }}）</p></footer>
</div>`;

describe('生成スケルトンの参照キーがサンプルで満たされる', () => {
  const funds = fundMaster as Record<string, FundMaster>;

  it('生成器の書きぶり(基準日・前日比の符号分岐): 解釈できない/未定義の Jinja 式が無い', () => {
    const attrs = parseTemplateFileName('AM01_510037_20240710_kr.html');
    expect(attrs).not.toBeNull();
    if (!attrs) return;
    const { diagnostics } = toFilledWithDiagnostics(
      GENERATED_SKELETON_BODY,
      buildSampleData(funds[attrs.fundCode], attrs.fundCode, attrs),
    );
    expect(diagnostics.unsupported).toEqual([]);
    expect(diagnostics.missing).toEqual([]);
  });

  it('defaultSkeleton(local の新規作成雛形): 解釈できない/未定義の Jinja 式が無い', () => {
    const { diagnostics } = toFilledWithDiagnostics(
      defaultSkeleton(),
      buildSampleData(undefined, '000000', { editionType: '交付版', baseDate: '20260101' }),
    );
    expect(diagnostics.unsupported).toEqual([]);
    expect(diagnostics.missing).toEqual([]);
  });
});
```

Run: `pnpm --filter web exec vitest run test/fillJinja.dom.test.ts`
Expected: PASS（「生成器の書きぶり」の 1 件が実行され、スキップは無い）

- [ ] **Step 8: コメントと README の表記を直す**

- `config.ts` 128-134 行の doc コメントの最後の 2 文 `移設は init-data-repo スクリプトが行う(既存 editor/data からの移動)。` を `初期化は init-data-repo スクリプトが行う。` に置き換える（前の文 `env \`DATA_ROOT\` または \`appconfig.json\` の \`paths.dataRoot\` で上書きする。` はそのまま）。
- `shared/src/index.ts` 84 行の `` 確定保存(= 実ファイル `data/templates` + git への反映) `` を `` 確定保存(= 実ファイル `<dataRoot>/templates` + git への反映) `` に置き換える。85 行の `` `data/reviews/` `` も `` `<dataRoot>/reviews/` `` に置き換える。
- `ReviewRepository.ts` 4 行の `` 確定保存(実ファイル `data/templates` + git への反映) `` を `` 確定保存(実ファイル `<dataRoot>/templates` + git への反映) `` に置き換える。
- `formatOutput.ts` 6-7 行の `` 確定版テンプレ(`data/templates`)とファンド CSS `` / `` (`data/css`)は `` を `` 確定版テンプレ(`<dataRoot>/templates`)とファンド CSS `` / `` (`<dataRoot>/css`)は `` に置き換える（100 桁を超えたら折り返す）。
- `templatePreviewService.ts` 121 行の `` 確定保存される `data/templates` が `` を `` 確定保存される `<dataRoot>/templates` が `` に置き換える。
- `editor/README.md` 24 行の `editor/data/     テンプレ(.html) と ファンド毎 CSS（サーバが参照）` を削除し、コードブロックの直後（`> データソースは…` の前）に 1 行足す:

```markdown
テンプレ実体（`.html`）とファンド毎 CSS はリポジトリの外の data リポジトリ（既定 `../../editor-data`、環境変数 `DATA_ROOT`）に置く。初期化は `editor/scripts/init-data-repo.bat`。
```

Run: `git grep -n "editor/data\|data/templates\|data/css" -- editor scripts biome.json .gitignore`
Expected: 出力なし

- [ ] **Step 9: 型・テストを確かめる**

Run: `pnpm typecheck:editor && pnpm run test:scripts && pnpm --filter web exec vitest run test/fillJinja.dom.test.ts && pnpm run check:comments`
Expected: すべて成功

- [ ] **Step 10: コミット**

`.gitignore` は Step 5 でステージ済み（`git add .gitignore` はしない。`AGENTS.md` 行が混ざる）。

```bash
pnpm exec biome check --write editor/appconfig.example.json editor/web/test/fillJinja.dom.test.ts editor/server/src/config.ts editor/shared/src/index.ts editor/shared/src/repositories/ReviewRepository.ts editor/web/src/lib/formatOutput.ts editor/web/src/features/preview/services/templatePreviewService.ts
git add editor/scripts/init-data-repo.ps1 biome.json scripts/clean.mjs scripts/clean.test.mjs editor/appconfig.example.json editor/web/test/fillJinja.dom.test.ts editor/server/src/config.ts editor/shared/src/index.ts editor/shared/src/repositories/ReviewRepository.ts editor/web/src/lib/formatOutput.ts editor/web/src/features/preview/services/templatePreviewService.ts editor/README.md
git diff --cached --stat
git commit -m "chore(editor): 旧 editor/data の初回移行・保護設定・例の設定・表記を撤去する"
```

`git diff --cached --stat` に `.gitignore | 2 --` が含まれ、`AGENTS.md` が `git diff .gitignore` 側に残っていることをコミット前に確かめる。

---

### Task 10: 運用手順書・設計書・OFFLINE.md・README を更新する

**Files:**
- Modify: `docs/editor/src/デプロイ運用手順書.md`（front-matter、設定表の `python.*` 3 行、3.1 節の `[!WARN]`、3.1 節の末尾に 3.2 節を新設）
- Modify: `docs/editor/src/設計書.md`（front-matter、56 行の `[!INFO]`、7.3 節、16.2 節の 1 項目）
- Modify: `docs/editor/承認ワークフロー設計.md`（9 行・233 行）
- Modify: `editor/OFFLINE.md`（36 行、93 行、96 行、110-112 行）
- Modify: `editor/README.md`（158 行、179-180 行）
- Modify: `docs/editor/editor_設計.html`（再生成）

- [ ] **Step 1: 運用手順書を直す**

設定表の `python.bin` / `python.script` / `python.timeoutMs` の 3 行を置き換える:

```markdown
| `python.bin` | 生成器を起動する Python（既定 `py`） | `PYTHON_BIN` |
| `python.args` | `python.bin` の後ろに付ける引数（既定 `["-3.13"]`。`python.bin` か `PYTHON_BIN` を指定したときの既定は空） | （appconfig のみ） |
| `python.script` | テンプレート生成器のスクリプト（既定はテスト用の偽物 `server/scripts/fake_generate_template.py`。本番は既存の生成器を指す） | `PY_GENERATE_SCRIPT` |
| `python.scriptSha256` | 生成器のスクリプトの SHA256（64 桁の 16 進）。設定すると生成のたびに照合し、食い違えば生成を拒否する | `PY_GENERATE_SCRIPT_SHA256` |
| `python.timeoutMs` | 生成タイムアウト | `PY_TIMEOUT_MS` |
| （環境変数のみ） | 同時に起動する生成器の上限（既定 2） | `GENERATE_MAX_CONCURRENCY` |
| （環境変数のみ） | 生成の待ち行列の上限（既定 8。超えた要求は待たずにエラーになる） | `GENERATE_MAX_QUEUE` |
```

3.1 節の `> [!WARN] リポジトリ内に \`editor/data/\` があると、…` の段落を置き換える:

```markdown
> [!WARN] 既存の `editor-data` を移す場合は、先に `.git` ごと共有へコピーしてから `init-data-repo` を実行する（足りないフォルダだけが作られる）。
```

3.1 節の末尾（`詳細と元に戻し方は \`editor/patches/2026-10-fund-images/README.md\` を見る。` の後ろ、`# 4. SQL Server セットアップ` の前）に追加:

```markdown
## 3.2 テンプレート生成器を置く

作成タブの「新規作成」は、既存のテンプレート生成器（Python のスクリプト）を `py -3.13 <スクリプト> <属性の JSON>` として起動する。生成器は editor のリポジトリには含まれず、社内の別サーバ・共有フォルダにある。editor は `python.script`（`PY_GENERATE_SCRIPT`）でそのパスを指す。既定のスクリプトはテスト用の偽物なので、本番では必ず設定する。

置き方:

- 生成器を置くフォルダは、editor サーバの実行アカウントから**読み取り専用**にする。書き込めるのは生成器の保守者だけにする。生成器が出した HTML の JS は承認後は変えられない基準になるので、生成器を書き換えられる人は、サーバの実行アカウントでコードを実行できるのと同じ重みを持つ。
- `dataRoot` の配下には置かない。データの git リポジトリに実行コードが入り、data リポジトリを書ける人が任意のコードを実行できるようになる。
- 生成器の子プロセスへ渡す環境変数は `PATH` `SYSTEMROOT` `TEMP` `TMP` `PATHEXT` `COMSPEC` と、`PYTHONUTF8` `PYTHONIOENCODING` `TEMPLATES_DIR`（元テンプレの読み先。サーバの `paths.templatesDir`）だけ。生成器が他の環境変数（秘密値を含む）を読む前提にはしない。

指紋（SHA256）の設定:

1. 生成器のスクリプトの指紋を取る: `certutil -hashfile \\fileserver\share\generator\generate_template.py SHA256`。2 行目の 64 桁の 16 進が指紋。
2. 環境変数 `PY_GENERATE_SCRIPT_SHA256`（または appconfig の `python.scriptSha256`）に設定し、editor を起動し直す。64 桁の 16 進でなければ起動を中止する。
3. 生成器を更新したら、指紋も取り直して設定し直す。設定し直すまで、生成は「生成器の指紋が設定と一致しない」で拒否され、サーバログと監査ログ（`template.generate` の失敗）に残る。

照合できるのは入口のスクリプト 1 本だけで、そこから読み込まれるモジュールは対象外。モジュールの改ざんは、上の読み取り専用の運用で防ぐ。

起動ログの警告の意味:

| 起動ログ | 意味と対応 |
|---|---|
| `[generate] 生成器の Python: 3.13(py -3.13)` | 正常 |
| `[generate] 生成器の Python を起動できません` | py ランチャか Python 3.13 が無い（終了コード 9009 は Microsoft Store のスタブ）。Python 3.13 と py ランチャを入れるか、`PYTHON_BIN` に python.exe の絶対パスを設定する |
| `[generate] 生成器の Python が 3.12 です` | 3.13 以外の Python で起動している。`python.args` で `-3.13` を指定するか、3.13 の python.exe を `PYTHON_BIN` に設定する |
| `[generate] 生成器の指紋が未設定です` | 指紋を照合していない。共有フォルダ上の生成器を使うなら、上の手順で設定する |

どの警告でも editor は起動する（生成を使わない運用を止めないため）。生成の同時実行は `GENERATE_MAX_CONCURRENCY`（既定 2）、待ち行列は `GENERATE_MAX_QUEUE`（既定 8）で、超えた要求は「テンプレート生成の順番待ちが混み合っています」で返る。
```

front-matter の `version` を `"1.6"` にし、`rev` の末尾に追加:

```yaml
  - 1.6 | 2026-10-01 | テンプレート生成器の起動（py -3.13）・指紋・同時実行の上限の設定と置き方（設定表・3.2 節）
```

- [ ] **Step 2: 設計書を直す**

56 行の `[!INFO]` の `初期化（git init + .gitignore/.gitattributes）と旧 \`editor/data/{templates,css}\` からの初回移行は \`editor/scripts/init-data-repo.bat\` が行う。` を `初期化（git init + .gitignore/.gitattributes）は \`editor/scripts/init-data-repo.bat\` が行う。` に置き換え、同じ段落の `リポジトリ内の \`editor/data/\` は初回移行の seed 元として残る` で始まる文（次の `。` まで）を削除する。

7.3 節の本文（`` `server/src/generate/pyTemplate.ts` が既存 Python 生成器を… `` の段落）を置き換える:

```markdown
`server/src/generate/pyTemplate.ts` が生成器を `execFile(bin, [...args, script, JSON.stringify(attrs)])` で呼び、stdout の HTML を受け取る。既定の起動コマンドは `py -3.13`（`config.python.bin` / `config.python.args`）。生成器そのものは社内の共有フォルダにある既存ツールで、`config.python.script` で指す（既定はテスト用の偽物 `server/scripts/fake_generate_template.py`）。

- 渡すもの: 環境変数は許可リスト（`PATH` `SYSTEMROOT` `TEMP` `TMP` `PATHEXT` `COMSPEC` と `PYTHONUTF8` `PYTHONIOENCODING` `TEMPLATES_DIR`）だけ。属性はルートで検証した `companyCode` `fundCode` `editionType` `basedOnTemplateId?` と、サーバが決めた `baseDate` だけを明示して組む。`process.env` やリクエスト本文を素通ししないのは、秘密値と未検証の値を共有上のコードへ流さないため。
- 指紋: `config.python.scriptSha256` を設定すると、生成のたびにスクリプトの SHA256 を照合し、食い違えば生成を拒否する（サーバログ・監査ログに残る）。
- 同時実行: PDF ビルドと同じ受付制御（`vivliostyle/buildAdmission.ts`）で、同時 2・待ち 8。超えた要求は 503。
- 起動時の確認: `generate/generatorCheck.ts` が Python の版（3.13 か）と指紋の設定の有無を起動ログに出す。警告だけで起動は止めない。

生成器との入出力の約束（argv の JSON を受け、stdout に HTML を出す）は暫定で、作り直しは後日行う。
```

16.2 節の `- **Python 生成器の本番統合**: …` の行を置き換える:

```markdown
- **Python 生成器との入出力の約束**: 生成器の起動（`py -3.13`）・置き方・安全策（環境変数の許可リスト・指紋・同時実行の上限）は整備済み。入出力の約束（stdin/JSON 化、約束の版、生成時点の出力検査）の作り直しが残る（7.3 節）。
```

front-matter の `version` を `"2.7"` にし、`rev` の末尾に追加:

```yaml
  - 2.7 | 2026-10-01 | テンプレート生成器の起動基盤（7.3 節）と旧 editor/data の撤去の反映
```

- [ ] **Step 3: 承認ワークフロー設計を直す**

9 行の `` 実ファイル（`data/templates/<file>.html` + git） `` を `` 実ファイル（`<dataRoot>/templates/<file>.html` + git） `` に、233 行の `` （`data/templates` 非更新を断言） `` を `` （`<dataRoot>/templates` 非更新を断言） `` に置き換える。

- [ ] **Step 4: OFFLINE.md と editor/README.md を直す**

`editor/OFFLINE.md`:
- 36 行を `- **Python 3.13 と py ランチャ**（`/api/generate` の生成器を `py -3.13` で起動する。テスト用の偽の生成器は標準ライブラリのみ）` に置き換える。
- 93 行の `| \`paths.templatesDir\` / \`paths.cssDir\` | \`data/...\` | テンプレ/CSS 配置 |` を `| \`paths.dataRoot\` | \`../../editor-data\` | テンプレ・CSS などの data リポジトリ（各置き場の既定の基準） |` に置き換える。
- 96 行を置き換える:

```markdown
| `python.bin` / `python.args` / `python.script` / `python.scriptSha256` / `python.timeoutMs` | `py` / `["-3.13"]` / `server/scripts/fake_generate_template.py` / なし / 30000 | テンプレート生成器（本番は `python.script` で既存の生成器を指す） |
```

- 110-112 行の対応 env の列挙の `` `PY_GENERATE_SCRIPT` / `PY_TIMEOUT_MS` / `` を `` `PY_GENERATE_SCRIPT` / `PY_GENERATE_SCRIPT_SHA256` / `PY_TIMEOUT_MS` / `GENERATE_MAX_CONCURRENCY` / `GENERATE_MAX_QUEUE` / `` に置き換える（行の折り返しは前後に合わせる）。

`editor/README.md`:
- 158 行の `` （`server/scripts/generate_template.py` を呼ぶ） `` を `` （既定はテスト用の偽物 `server/scripts/fake_generate_template.py` を `py -3.13` で呼ぶ） `` に置き換える。
- 179-180 行を置き換える:

```markdown
| `PYTHON_BIN` | `py`（引数 `-3.13` 付き） | 生成器を起動する Python。指定すると引数の既定は空（絶対パスの python.exe を直接指す） |
| `PY_GENERATE_SCRIPT` | `server/scripts/fake_generate_template.py` | 生成器のスクリプト（既定はテスト用の偽物。本番は既存の生成器を指す） |
| `PY_GENERATE_SCRIPT_SHA256` | なし | 生成器のスクリプトの SHA256。設定すると生成のたびに照合する |
| `GENERATE_MAX_CONCURRENCY` / `GENERATE_MAX_QUEUE` | 2 / 8 | 生成の同時実行と待ち行列の上限 |
```

- [ ] **Step 5: 表記の残りを確かめ、HTML を作り直す**

Run: `git grep -n "editor/data\|data/templates\|data/css\|generate_template\.py" -- . ':!docs/superpowers' ':!.superpowers' ':!*.html' | grep -v fake_generate_template`
Expected: 出力なし

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `[ok] editor/editor_設計.html` を含む出力（`editor_手引き.html` も書き直されることがあるが、コミットしない）

Run: `git grep -c "editor/data\|data/templates\|data/css" -- docs/editor/editor_設計.html`
Expected: 出力なし（0 件）

- [ ] **Step 6: コミット**

```bash
git add "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計書.md" "docs/editor/承認ワークフロー設計.md" "docs/editor/editor_設計.html" editor/OFFLINE.md editor/README.md
git diff --cached --name-only
git commit -m "docs(editor): 生成器の起動・置き方・指紋・同時実行の上限を手順書と設計書に書き、旧 editor/data の記述を外す"
```

`git diff --cached --name-only` に `editor_手引き.html`・`images/*.png`・`docs/pdf-to-svg/*`・`.gitignore` が無いことを確かめてからコミットする（Biome は `.md` を対象にしないので、この Task では Biome を走らせなくてよい）。

---

### Task 11: 全体の検証と実機確認

**Files:** なし（確認のみ。直しが出たら該当 Task のファイルを直して追加コミット）

- [ ] **Step 1: 型・テスト・検査**

Run: `pnpm typecheck:editor && pnpm run test:editor && pnpm run test:scripts && pnpm run check:comments && pnpm run check:canon-summary`
Expected: すべて成功

Run: `pnpm run ci:offline`
Expected: PASS

- [ ] **Step 2: coverage**

Run: `pnpm run test:coverage`
Expected: `pyTemplate.ts`・`generatorCheck.ts`・`config.ts`・`buildAdmission.ts` がそれぞれ 85% 以上で、全体の閾値を満たす

- [ ] **Step 3: editor/data の参照が残っていないこと**

Run: `git grep -n "editor/data\|data/templates\|data/css" -- . ':!docs/superpowers' ':!.superpowers'`
Expected: 出力なし（テストの一時ディレクトリは `path.join(root, 'data', 'templates')` の形で、この文字列には当たらない）

Run（Bash）: `ls /c/Users/caads/workspace/editor/data 2>&1; wc -l /c/Users/caads/repo-archives/editor-data-seed-2026-10/MANIFEST-sha256.csv`
Expected: `No such file or directory` と 17 行

- [ ] **Step 4: 実機 — local モードのサーバで py -3.13 の偽物を通して「新規作成」する**

ここでの「local モード」は、認証を課さないサーバ（`AUTH_REQUIRED=false`。生成ルートの local 分岐）を指す。web の local モード（`VITE_API_MODE=local`）は生成器を呼ばないので、確認は API を直接叩いて行う。

Bash のシェル変数は呼び出しをまたいで残らないので、以下の各コマンドの先頭で `V=/c/Users/caads/AppData/Local/Temp/editor-gen-verify` を定義し直す。

一時の dataRoot を作る（Bash）:

```bash
V=/c/Users/caads/AppData/Local/Temp/editor-gen-verify
rm -rf "$V" && mkdir -p "$V/data/templates" "$V/logs"
printf '<p>元テンプレ確認</p>' > "$V/data/templates/AM01_510037_20240710_交付版.html"
```

サーバを背景で起動する（Bash の `run_in_background`。`DATA_ROOT` は必ず一時の場所へ上書きする — ユーザー環境変数の `DATA_ROOT` が本番の data リポジトリを指していることがある）:

```bash
cd /c/Users/caads/workspace/editor/server && DATA_ROOT="$V/data" GIT_REPO_DIR="$V/data" LOG_DIR="$V/logs" TMP_DIR="$V/tmp" AUTH_REQUIRED=false PORT=24690 pnpm exec tsx src/index.ts
```

起動ログに `[generate] 生成器の Python: 3.13(py -3.13)` と `[generate] 生成器の指紋が未設定です` が出ることを確かめる。

元テンプレ指定なし:

Run: `curl -s -X POST http://localhost:24690/api/generate -H 'content-type: application/json' -d '{"companyCode":"AM01","fundCode":"510037","editionType":"交付版"}' | head -c 400`
Expected: `{"template":{"meta":{"id":"AM01_510037_<今日>_交付版"` で始まり、`html` に `ファンド: 510037` を含む

元テンプレ指定あり:

Run: `curl -s -X POST http://localhost:24690/api/generate -H 'content-type: application/json' -d '{"companyCode":"AM01","fundCode":"510037","editionType":"交付版","basedOnTemplateId":"AM01_510037_20240710_交付版"}' | head -c 400`
Expected: `html` が `<p>元テンプレ確認</p>`（サーバが `TEMPLATES_DIR` に `$V/data/templates` を渡している）

サーバを止める（背景タスクを停止する）。

- [ ] **Step 5: 実機 — 指紋が違えば生成を拒否する**

同じ一時の dataRoot で、`PY_GENERATE_SCRIPT_SHA256` に誤った値を付けて起動し直す:

```bash
cd /c/Users/caads/workspace/editor/server && DATA_ROOT="$V/data" GIT_REPO_DIR="$V/data" LOG_DIR="$V/logs" TMP_DIR="$V/tmp" AUTH_REQUIRED=false PORT=24690 PY_GENERATE_SCRIPT_SHA256=$(printf 'f%.0s' $(seq 64)) pnpm exec tsx src/index.ts
```

Run: `curl -s -w '\n%{http_code}\n' -X POST http://localhost:24690/api/generate -H 'content-type: application/json' -d '{"companyCode":"AM01","fundCode":"510037","editionType":"交付版"}'`
Expected: 本文が `{"kind":"unexpected","message":"テンプレート生成器の指紋が設定と一致しないため、…","code":"GENERATOR_FINGERPRINT_MISMATCH"}`、状態コード `500`。サーバログに `[generate] 生成器の指紋が設定と一致しません`。

Run: `grep -c '"event":"template.generate".*"outcome":"failure".*指紋' "$V/logs/audit.log"`
Expected: 1 以上

続けて正しい指紋で起動し直し（`PY_GENERATE_SCRIPT_SHA256=$(certutil -hashfile editor/server/scripts/fake_generate_template.py SHA256 | sed -n 2p | tr -d ' \r')` を cwd `C:\Users\caads\workspace` で求める）、同じ要求が 200 になり、起動ログに指紋未設定の警告が出ないことを確かめる。サーバを止め、`rm -rf "$V"` で片付ける。

- [ ] **Step 6: 結果を報告する**

失敗した項目は出力をそのまま添えて報告し、成功扱いにしない。`git status` に、この計画の外のファイル（`editor_手引き.html`・`images/*.png`・`docs/pdf-to-svg/*`・`.gitignore` の `AGENTS.md` 行）が未コミットのまま残っていることも確かめる。
