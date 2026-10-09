// =============================================================================
// build_pins.test.ts — exe 同梱物の前提が崩れたらここで落とす
// -----------------------------------------------------------------------------
// exe には subset-font の JS 閉包と harfbuzz wasm とフォント woff2 を **すべて埋め込む**
// (`scripts/build-exe.mjs`)。埋め込む以上、次の 3 つは配布前に固定されていなければならない。
//   1. 同梱する依存の版と wasm のハッシュ(= 埋込フォントのサブセット結果 = SVG バイト)
//   2. `subset-font` が外部を参照する唯一の点が 1 箇所であること(shim の前提)
//   3. SEA アセットのキー一覧が実装(seaRuntime)とビルド(build-exe.mjs)で一致すること
// exe ビルドは重いので CI では回さない。代わりに **ビルドしなくても検出できる前提**を
// ここで固定し、依存を上げたときに `test/render_hash.test.ts` の更新要否へ気づけるようにする。
// =============================================================================

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- .mjs のビルド補助に型定義は無い
import { installLayout } from '../scripts/install-layout.mjs';
import { SEA_ASSET_KEYS } from '../src/runtime/seaRuntime.js';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'scripts', 'sidecar-pins.json'), 'utf8'));

// pnpm ツリーではルートから `harfbuzzjs` を直接引けないので `subset-font` を基点に解決する
// (build-exe.mjs と同じ手順であることが重要 — ここで一致してもビルドが別物を掴めば無意味)。
const subsetFontEntry = require.resolve('subset-font');
const hbWasmPath = createRequire(subsetFontEntry).resolve('harfbuzzjs/hb-subset.wasm');

describe('exe 同梱物の固定値', () => {
  it('subset-font の版が pin と一致する', () => {
    expect(require('subset-font/package.json').version).toBe(pins.subsetFont);
  });

  it('hb-subset.wasm の SHA256 が pin と一致する', () => {
    const sha = createHash('sha256').update(readFileSync(hbWasmPath)).digest('hex');
    expect(sha).toBe(pins.hbSubsetWasmSha256);
  });

  // 依存は pnpm だけで入れる(pnpm-lock.yaml が正)。範囲指定のままだと lock を作り直したときに
  // 新しい版(subset-font 2.9 → harfbuzzjs 1.x は `hb-subset.wasm` を exports に出さない)を掴むので、
  // 宣言も pin の版に固定する。
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  it('package.json の subset-font は pin の版に完全固定されている', () => {
    expect(pkg.dependencies['subset-font']).toBe(pins.subsetFont);
  });

  it('msnodesqlv8 の版が pin と一致する', () => {
    expect(require('msnodesqlv8/package.json').version).toBe(pins.msnodesqlv8);
  });

  // pin は Windows x64 / Node 24 用の公式 prebuild のハッシュなので、照合できるのはその .node が
  // 置かれている Windows 端末だけ。Linux の CI ではインストールスクリプトを止めているため .node が
  // 無い。exe のビルドはこの端末種でしか行わず、build-exe.mjs のアサート D も同じ照合をする。
  const driverPath = join(
    dirname(require.resolve('msnodesqlv8/package.json')),
    'build',
    'Release',
    'sqlserverv8.node',
  );
  it.skipIf(process.platform !== 'win32' || !existsSync(driverPath))(
    'Windows ではネイティブドライバの SHA256 が pin と一致する',
    () => {
      const sha = createHash('sha256').update(readFileSync(driverPath)).digest('hex');
      expect(sha).toBe(pins.sqlserverv8NodeSha256);
    },
  );
});

describe('subset-font の外部参照が shim の前提どおりであること', () => {
  const src = readFileSync(subsetFontEntry, 'utf8');

  it('wasm の require.resolve はちょうど 1 箇所', () => {
    // 0 箇所なら読み方が変わって shim が空振りする。2 箇所以上なら想定外の呼び出し元が増えた。
    // どちらも「SEA で wasm が読めず、フルフォントへ静かに落ちる」事故に直結する。
    const hits = src.match(/require\.resolve\(\s*["']harfbuzzjs\/hb-subset\.wasm["']\s*\)/g);
    expect(hits?.length ?? 0).toBe(1);
  });

  it("外部ファイル読み出しは require('fs') 経由のみ", () => {
    // esbuild plugin は `subset-font/index.js` からの `require('fs')` だけを差し替える。
    // `node:fs` や `fs/promises` へ変わると差し替えが当たらなくなる。
    expect(src).toMatch(/require\(\s*['"]fs['"]\s*\)/);
    expect(src).not.toMatch(/require\(\s*['"]node:fs['"]\s*\)/);
    expect(src).not.toMatch(/require\(\s*['"]fs\/promises['"]\s*\)/);
  });
});

describe('msnodesqlv8 のドライバ読み込みが shim の前提どおりであること', () => {
  const pkgDir = dirname(require.resolve('msnodesqlv8/package.json'));
  const libDir = join(pkgDir, 'lib');

  it('ネイティブドライバの require は lib/util.js の 1 箇所だけ', () => {
    // 0 箇所なら読み方が変わって plugin が空振りし、2 箇所以上なら差し替え漏れが出る。
    const hits = readdirSync(libDir)
      .filter((f) => f.endsWith('.js'))
      .flatMap((f) =>
        (
          readFileSync(join(libDir, f), 'utf8').match(
            /require\(\s*['"][^'"]*sqlserverv8\.node['"]\s*\)/g,
          ) ?? []
        ).map(() => f),
      );
    expect(hits).toEqual(['util.js']);
  });
});

describe('SEA アセットのキー一覧', () => {
  it('seaRuntime の許可リストと build-exe.mjs の assets が一致する', () => {
    // 片方だけ増やすと実行時に許可リストで弾かれる(= 配布してから気づく)。DB ドライバは
    // --no-db でなければ seaAssets へ後から足すので、そのキーも拾う。
    const buildSrc = readFileSync(join(root, 'scripts', 'build-exe.mjs'), 'utf8');
    const block = buildSrc.match(/const seaAssets = \{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    const keys = [...(block?.[1] ?? '').matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
    const dbKey = buildSrc.match(/const DB_DRIVER_ASSET = '([^']+)';/)?.[1];
    expect(dbKey).toBe('sqlserverv8.node');
    expect(new Set([...keys, dbKey])).toEqual(new Set(SEA_ASSET_KEYS));
  });

  it('埋め込む実ファイルが揃っている', () => {
    // フォントと OFL はリポジトリの fonts/ から、wasm は依存ツリーから取る。
    for (const name of ['BIZUDPGothic-Regular.woff2', 'BIZUDPGothic-Bold.woff2']) {
      expect(readFileSync(join(root, 'fonts', name)).byteLength).toBeGreaterThan(0);
    }
    expect(readFileSync(join(root, 'fonts', 'OFL-BIZUDPGothic.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE',
    );
    expect(readFileSync(hbWasmPath).byteLength).toBeGreaterThan(0);
  });
});

describe('sidecar を復活させないこと', () => {
  const buildSrc = readFileSync(join(root, 'scripts', 'build-exe.mjs'), 'utf8');
  // 行コメントは落として**実コード**だけを見る(コメントで sidecar の経緯を説明できるように)。
  const buildCode = buildSrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

  it('ビルドが dist-exe へ fonts/ や node_modules/ を作らない', () => {
    // 配布物に sidecar が居ると、署名の外にある書き換え可能なファイルを実行時に読む経路が
    // 戻る。ビルドスクリプトに install / ディレクトリコピーを足させない。
    expect(buildCode).not.toMatch(/\bnpm\s+install\b/);
    expect(buildCode).not.toMatch(/cpSync\s*\(/);
    expect(buildCode).not.toMatch(/execSync\s*\(/);
  });

  it('subset-font を external にしない(= バンドルへ取り込む)', () => {
    // `external: noDb ? [...] : []` のように条件式になっているので、その行全体を見る。
    const external = buildCode.match(/external:([^\n]*)/);
    expect(external).not.toBeNull();
    expect(external?.[1]).not.toContain('subset-font');
  });
});

describe('依存を npm で入れる経路を持たないこと', () => {
  // 依存は pnpm-lock.yaml どおりに pnpm で入れる。npm の lock や overrides、npm を呼ぶ入口が
  // あると、pnpm の検査(開発機・CI)の外で別の版を掴む経路が残る(実際に別環境で subset-font 2.9 を
  // 掴んで exe のビルドが止まった)。
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('package-lock.json が無い', () => {
    expect(existsSync(join(root, 'package-lock.json'))).toBe(false);
  });

  it('package.json に npm だけが読む overrides が無い', () => {
    expect(pkg.overrides).toBeUndefined();
    expect(pkg['//overrides']).toBeUndefined();
  });

  const ps1Files = readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.ps1'));
  const batFiles = readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.bat'));
  // PowerShell のコメント(`<# ... #>` ブロックと行頭 `#`)を落として実コードだけを見る。
  const stripPsComments = (src: string): string =>
    src
      .replace(/<#[\s\S]*?#>/g, '')
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  // バッチのコメント(行頭 `rem`(大小区別なし)と `::`)を落として実コードだけを見る。
  const stripBatComments = (src: string): string =>
    src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(rem\b|::)/i.test(l))
      .join('\n');

  it('走査対象の .ps1 / .bat が存在する(空なら検査自体が空振りしている)', () => {
    expect(ps1Files).toContain('build-exe.ps1');
    expect(batFiles).toContain('build-exe.bat');
  });

  for (const name of ps1Files) {
    it(`${name}: npm / npx を呼ばない`, () => {
      const code = stripPsComments(readFileSync(join(root, 'scripts', name), 'utf8'));
      expect(code).not.toMatch(/\bnp[mx]\b/i);
    });
  }

  for (const name of batFiles) {
    it(`${name}: npm / npx を呼ばない`, () => {
      const code = stripBatComments(readFileSync(join(root, 'scripts', name), 'utf8'));
      expect(code).not.toMatch(/\bnp[mx]\b/i);
    });
  }

  it('build-exe.ps1 は DB 機能を外さない(--no-db を固定で付けない)', () => {
    const code = stripPsComments(readFileSync(join(root, 'scripts', 'build-exe.ps1'), 'utf8'));
    expect(code).toMatch(/build-exe\.mjs/);
    expect(code).not.toMatch(/--no-db/);
  });
});

describe('npm で入れ直された node_modules を見分けること', () => {
  // npm はリンクではなく実体のフォルダで入れる。pnpm は `node_modules/<名前>` をストアへのリンク
  // (Windows ではジャンクション)にする。build-exe.mjs はこの差で npm の構成を見つけて止める。
  const tmp = mkdtempSync(join(tmpdir(), 'pie-chart-layout-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('リンクなら pnpm、実体のフォルダなら npm、無ければ missing', () => {
    const real = join(tmp, 'real');
    mkdirSync(join(real, 'node_modules', 'subset-font'), { recursive: true });
    expect(installLayout(real)).toBe('npm');

    const linked = join(tmp, 'linked');
    mkdirSync(join(linked, 'node_modules'), { recursive: true });
    symlinkSync(
      join(real, 'node_modules', 'subset-font'),
      join(linked, 'node_modules', 'subset-font'),
      'junction',
    );
    expect(installLayout(linked)).toBe('pnpm');

    expect(installLayout(join(tmp, 'none'))).toBe('missing');
  });

  it('このリポジトリの pie-chart は pnpm の構成', () => {
    expect(installLayout(root)).toBe('pnpm');
  });
});
