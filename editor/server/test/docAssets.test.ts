// =============================================================================
// docAssets.test.ts — 同梱資産を配信ルートへ「許可した分だけ」置くことの固定
// =============================================================================
// ここは **headless ブラウザが読めるディレクトリへファイルを写す**処理なので、
// 「置けること」と同じ強さで「置けないこと」を主張する。dataRoot は git 作業ツリーで
// テンプレ実体・承認申請・同期状態も同居しており、範囲が広がるとそれらが配信面に載る。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let cssDir: string;
let assetsDir: string;
let dest: string;

/**
 * `config` を temp ディレクトリ向けに差し替えた `stageDocAssets` を読み込む。
 * `limits` は上限値の差し替え(既定は本番値。小さくすると上限の効きを実測できる)。
 */
async function loadStage(
  limits: Partial<Record<'VIVLIO_MAX_ASSET_FILES' | 'VIVLIO_MAX_ASSET_BYTES', number>> = {},
): Promise<(dir: string, opts?: { referenced?: ReadonlySet<string> }) => Promise<Set<string>>> {
  vi.resetModules();
  vi.doMock('../src/config.js', () => ({
    config: { cssDir, assetsDir },
    envPositiveNumber: (name: string, _v: string | undefined, def: number) =>
      limits[name as keyof typeof limits] ?? def,
  }));
  const mod = await import('../src/vivliostyle/docAssets.js');
  return mod.stageDocAssets;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-assets-'));
  cssDir = path.join(root, 'data', 'css');
  assetsDir = path.join(root, 'data', 'assets');
  dest = path.join(root, 'serve');
  await fs.mkdir(dest, { recursive: true });
});

afterEach(async () => {
  vi.doUnmock('../src/config.js');
  vi.resetModules();
  await fs.rm(root, { recursive: true, force: true });
});

const write = async (file: string, body = 'x'): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
};

describe('stageDocAssets — 置けるもの', () => {
  it('css / fonts / js を配信ルート相対の同名 path へ写す', async () => {
    await write(path.join(cssDir, '510037.css'), 'p{color:red}');
    await write(path.join(assetsDir, 'fonts', 'BIZUD.woff2'), 'font');
    await write(path.join(assetsDir, 'js', 'column-width.js'), 'console.log(1)');

    const served = await (await loadStage())(dest);

    expect([...served].sort()).toEqual([
      'css/510037.css',
      'fonts/BIZUD.woff2',
      'js/column-width.js',
    ]);
    expect(await fs.readFile(path.join(dest, 'css', '510037.css'), 'utf8')).toBe('p{color:red}');
    expect(await fs.readFile(path.join(dest, 'js', 'column-width.js'), 'utf8')).toBe(
      'console.log(1)',
    );
  });

  it('サブディレクトリも辿る(fonts/noto/x.woff2)', async () => {
    await write(path.join(assetsDir, 'fonts', 'noto', 'x.woff2'));
    const served = await (await loadStage())(dest);
    expect([...served]).toEqual(['fonts/noto/x.woff2']);
  });

  it('置き場が無い環境でも壊れない(空集合を返す)', async () => {
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
  });

  it('配信ルートに先着の同名ファイルがあれば上書きしない', async () => {
    await write(path.join(cssDir, '510037.css'), 'ours');
    await write(path.join(dest, 'css', '510037.css'), 'theirs');
    const served = await (await loadStage())(dest);
    expect([...served]).toEqual(['css/510037.css']);
    expect(await fs.readFile(path.join(dest, 'css', '510037.css'), 'utf8')).toBe('theirs');
  });
});

describe('stageDocAssets — 置けないもの(迂回入力)', () => {
  it('許可外の拡張子は写さない', async () => {
    // `.ps1` / `.json` / `.html` は資産ではない。特に dataRoot 直下の運用ファイルが
    // 配信面へ載ると、テンプレの JS から読み出せる位置に置かれることになる。
    await write(path.join(cssDir, 'notes.json'), '{}');
    await write(path.join(assetsDir, 'js', 'run.ps1'), 'evil');
    await write(path.join(assetsDir, 'fonts', 'secret.pfx'), 'key');
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
    await expect(fs.stat(path.join(dest, 'js', 'run.ps1'))).rejects.toThrow();
  });

  it('置き場ごとに許可拡張子が違う(js を fonts へ置いても写らない)', async () => {
    await write(path.join(assetsDir, 'fonts', 'x.js'), 'evil');
    await write(path.join(cssDir, 'x.js'), 'evil');
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
  });

  it('assetsDir 直下(fonts/js の外)のファイルは写らない', async () => {
    await write(path.join(assetsDir, 'loose.js'), 'evil');
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
  });

  it('シンボリックリンクは辿らない(置き場の外を配信ルートへ引き込めない)', async () => {
    const secret = path.join(root, 'outside', 'secret.css');
    await write(secret, 'SECRET');
    await fs.mkdir(path.join(assetsDir, 'js'), { recursive: true });
    await fs.mkdir(cssDir, { recursive: true });
    try {
      await fs.symlink(secret, path.join(cssDir, 'linked.css'), 'file');
    } catch {
      // Windows は開発者モードでないと symlink を作れない。作れない環境ではこの
      // 迂回自体が成立しないので、検査対象が無い状態として扱う。
      return;
    }
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
    await expect(fs.stat(path.join(dest, 'css', 'linked.css'))).rejects.toThrow();
  });

  it('ディレクトリのシンボリックリンクも辿らない', async () => {
    const outside = path.join(root, 'outside2');
    await write(path.join(outside, 'secret.css'), 'SECRET');
    await fs.mkdir(cssDir, { recursive: true });
    try {
      await fs.symlink(outside, path.join(cssDir, 'sub'), 'dir');
    } catch {
      return;
    }
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
  });

  // 戻り値は `inlineCss` が `<link>`/`<script src>` を残すかの判断に使う。実体が無いのに
  // 集合へ載せると 404 を作り、`@vivliostyle/core` のページ分割が中断する。よって「写せた
  // つもり」で載せてはならず、判定は例外の種類ではなく**配信ルートの実体**で行う。
  it('配信ルート側の同名がディレクトリなら配信集合へ載せない(実体で判定する)', async () => {
    await write(path.join(cssDir, '510037.css'), 'ours');
    await fs.mkdir(path.join(dest, 'css', '510037.css'), { recursive: true });
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(0);
  });

  // 深さ・件数・バイト数の上限は「壊れた置き場でも配信ルートが膨らまない」ための安全弁。
  // 上限が効いていることを実測しないと、既定値を書いただけの飾りになる。
  it('深すぎるツリーは辿らない(リンクの輪・異常な深さで走査が止まらなくなるのを防ぐ)', async () => {
    await write(path.join(assetsDir, 'fonts', 'a', 'b', 'c', 'd', 'shallow.woff2'));
    await write(path.join(assetsDir, 'fonts', 'a', 'b', 'c', 'd', 'e', 'deep.woff2'));
    const served = await (await loadStage())(dest);
    expect([...served]).toEqual(['fonts/a/b/c/d/shallow.woff2']);
  });

  it('件数上限を超えた分は写さない', async () => {
    await write(path.join(cssDir, 'a.css'));
    await write(path.join(cssDir, 'b.css'));
    const served = await (await loadStage({ VIVLIO_MAX_ASSET_FILES: 1 }))(dest);
    expect(served.size).toBe(1);
  });

  it('合計バイト上限を超えた分は写さない', async () => {
    await write(path.join(cssDir, 'a.css'), 'x'.repeat(64));
    const served = await (await loadStage({ VIVLIO_MAX_ASSET_BYTES: 8 }))(dest);
    expect(served.size).toBe(0);
  });
});

/** `config` を temp 向けに差し替えた `resolveServedAssetSource` を読み込む。 */
async function loadResolve(): Promise<(rel: string) => Promise<string | undefined>> {
  vi.resetModules();
  vi.doMock('../src/config.js', () => ({
    config: { cssDir, assetsDir },
    envPositiveNumber: (_n: string, _v: string | undefined, def: number) => def,
  }));
  const mod = await import('../src/vivliostyle/docAssets.js');
  return mod.resolveServedAssetSource;
}

// 「その場で 1 本配る」経路(previewHost / 親の fetch)の解決器。`stageDocAssets` と
// 同じ許可リスト・深さ・リンク拒否を共有していることを、置く側と同じ強さで固定する。
describe('resolveServedAssetSource — 引けるもの / 引けないもの', () => {
  it('許可リスト配下の実体を絶対パスで返す', async () => {
    await write(path.join(cssDir, '510037.css'), 'p{}');
    await write(path.join(assetsDir, 'js', 'column-width.js'), 'ok()');
    const resolve = await loadResolve();
    expect(await resolve('css/510037.css')).toBe(path.join(cssDir, '510037.css'));
    expect(await resolve('js/column-width.js')).toBe(path.join(assetsDir, 'js', 'column-width.js'));
  });

  it('実体が無い / 許可外拡張子 / 未知の置き場 / `..` セグメントは undefined', async () => {
    await write(path.join(assetsDir, 'js', 'secret.env'), 'TOKEN');
    await write(path.join(root, 'outside.js'), 'LEAK');
    const resolve = await loadResolve();
    expect(await resolve('js/missing.js')).toBeUndefined();
    expect(await resolve('js/secret.env')).toBeUndefined();
    expect(await resolve('templates/x.js')).toBeUndefined();
    expect(await resolve('js/../../outside.js')).toBeUndefined();
    expect(await resolve('outside.js')).toBeUndefined();
  });

  it('深さ上限を超えるパスは引けない(stageDocAssets の走査と同じ物差し)', async () => {
    await write(path.join(assetsDir, 'fonts', 'a', 'b', 'c', 'd', 'e', 'deep.woff2'));
    const resolve = await loadResolve();
    expect(await resolve('fonts/a/b/c/d/e/deep.woff2')).toBeUndefined();
  });

  it('経路上のシンボリックリンクは拒む(ファイル)', async () => {
    const secret = path.join(root, 'outside', 'secret.css');
    await write(secret, 'SECRET');
    await fs.mkdir(cssDir, { recursive: true });
    try {
      await fs.symlink(secret, path.join(cssDir, 'linked.css'), 'file');
    } catch {
      // Windows は開発者モードでないと symlink を作れない(上の stage 側テストと同じ扱い)。
      return;
    }
    const resolve = await loadResolve();
    expect(await resolve('css/linked.css')).toBeUndefined();
  });

  it('経路上のシンボリックリンクは拒む(ディレクトリ)', async () => {
    const outside = path.join(root, 'outside2');
    await write(path.join(outside, 'secret.woff2'), 'SECRET');
    await fs.mkdir(path.join(assetsDir, 'fonts'), { recursive: true });
    try {
      await fs.symlink(outside, path.join(assetsDir, 'fonts', 'sub'), 'dir');
    } catch {
      return;
    }
    const resolve = await loadResolve();
    expect(await resolve('fonts/sub/secret.woff2')).toBeUndefined();
  });
});

// ── 参照されたものだけを置く ──
// 全件配置は (a) 単一ファンドのビルドの配信ルートへ他ファンドの CSS が載り、文書が
// `<link href="css/<他ファンド>.css">` と書けば解決してしまう (b) 共通フォント一式が
// PDF 1 本ごと・プレビュー起動ごとに丸ごとコピーされる、の 2 つを生む。
describe('stageDocAssets — referenced を渡すと参照されたものだけ置く', () => {
  it('他ファンドの CSS は配信ルートへ載らない', async () => {
    await write(path.join(cssDir, '510037.css'), 'p{color:red}');
    await write(path.join(cssDir, '510155.css'), 'p{color:blue}');
    const served = await (await loadStage())(dest, { referenced: new Set(['css/510037.css']) });
    expect([...served]).toEqual(['css/510037.css']);
    await expect(fs.stat(path.join(dest, 'css', '510155.css'))).rejects.toThrow();
  });

  it('参照 CSS が引くフォントは連鎖して置く(1 段では足りない形を潰す)', async () => {
    await write(
      path.join(cssDir, '510037.css'),
      '@font-face{font-family:BIZ;src:url(../fonts/BIZUD.woff2) format("woff2")}',
    );
    await write(path.join(assetsDir, 'fonts', 'BIZUD.woff2'), 'font');
    await write(path.join(assetsDir, 'fonts', 'unused.woff2'), 'font');
    const served = await (await loadStage())(dest, { referenced: new Set(['css/510037.css']) });
    expect([...served].sort()).toEqual(['css/510037.css', 'fonts/BIZUD.woff2']);
  });

  it('参照が 1 つも無ければ何も置かない', async () => {
    await write(path.join(cssDir, '510037.css'), 'p{}');
    await write(path.join(assetsDir, 'fonts', 'BIZUD.woff2'), 'font');
    const served = await (await loadStage())(dest, { referenced: new Set() });
    expect(served.size).toBe(0);
  });

  it('参照にあっても許可リストの外(拡張子違反)は置かない', async () => {
    await write(path.join(cssDir, 'notes.json'), '{}');
    const served = await (await loadStage())(dest, { referenced: new Set(['css/notes.json']) });
    expect(served.size).toBe(0);
  });

  it('referenced 省略は従来どおり全件(zip 展開物のように文書が事前に判らない配信ルート用)', async () => {
    await write(path.join(cssDir, '510037.css'), 'p{}');
    await write(path.join(cssDir, '510155.css'), 'p{}');
    const served = await (await loadStage())(dest);
    expect(served.size).toBe(2);
  });
});
