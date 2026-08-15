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
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

describe('SEA アセットのキー一覧', () => {
  it('seaRuntime の許可リストと build-exe.mjs の assets が一致する', () => {
    // 片方だけ増やすと実行時に許可リストで弾かれる(= 配布してから気づく)。
    const buildSrc = readFileSync(join(root, 'scripts', 'build-exe.mjs'), 'utf8');
    const block = buildSrc.match(/const seaAssets = \{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    const keys = [...(block?.[1] ?? '').matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
    expect(new Set(keys)).toEqual(new Set(SEA_ASSET_KEYS));
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
    // 戻る(root A4 / P008)。ビルドスクリプトに install / ディレクトリコピーを足させない。
    expect(buildCode).not.toMatch(/npm install/);
    expect(buildCode).not.toMatch(/cpSync\s*\(/);
    expect(buildCode).not.toMatch(/execSync\s*\(/);
  });

  it('subset-font を external にしない(= バンドルへ取り込む)', () => {
    const external = buildCode.match(/external:\s*\[([^\]]*)\]/);
    expect(external).not.toBeNull();
    expect(external?.[1]).not.toContain('subset-font');
  });
});

describe('ビルド入口スクリプト(scripts/*.ps1 / *.bat)が lockfile 無視の install をしないこと', () => {
  // README が「ダブルクリック入口」として案内する build-exe.bat → build-exe.ps1 は、
  // コード署名鍵を持つ端末で走る。lockfile を消してから範囲指定のまま `npm` の install を
  // すると、レジストリへ差し込まれた新版の lifecycle script がその端末で実行される
  // (npm は pnpm の `allowBuilds` に相当する既定の抑止を持たない)。上の sidecar ガードは
  // build-exe.mjs 本文しか読んでおらず、運用が実際に使う .ps1 経路が検査の外に残っていた
  // (P023/F12)— ここで scripts/ 配下の全 .ps1 / .bat へ同じ禁止語を機械強制する
  // (.bat は現状 .ps1 ランチャの薄いラッパのみだが、直接 npm を書く変種が今後増えても
  // 同じ検査に自動で乗る)。
  // 禁止語 denylist には限界がある(`npm i` のような変種は通る)。主防御はここではなく
  // `verify-dist.ps1` の配布物閉包検査で、本検査はビルド端末側の入口を狭める補助。
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
    expect(ps1Files.length).toBeGreaterThan(0);
    expect(ps1Files).toContain('build-exe.ps1');
    expect(batFiles.length).toBeGreaterThan(0);
    expect(batFiles).toContain('build-exe.bat');
  });

  const checkNoUnsafeInstall = (name: string, code: string): void => {
    // `npm install` は「その時点のレジストリ最新で解決 + script 実行」の複合で、
    // どちらの性質も署名端末では受け入れられない。
    expect(code).not.toMatch(/npm\s+install\b/i);
    // lockfile の削除(や再生成)は integrity 固定の無効化と等価。コミット済みを正とする。
    expect(code).not.toMatch(/package-lock/i);
    // npm ci を呼ぶなら lifecycle script の一律不実行までセットで。
    for (const m of code.matchAll(/npm\s+ci\b[^\n]*/gi)) {
      expect(m[0], `${name}: ${m[0]}`).toContain('--ignore-scripts');
    }
  };

  for (const name of ps1Files) {
    it(`${name}: npm install / lockfile 削除を含まず、npm ci は --ignore-scripts 付き`, () => {
      checkNoUnsafeInstall(
        name,
        stripPsComments(readFileSync(join(root, 'scripts', name), 'utf8')),
      );
    });
  }

  for (const name of batFiles) {
    it(`${name}: npm install / lockfile 削除を含まず、npm ci は --ignore-scripts 付き`, () => {
      checkNoUnsafeInstall(
        name,
        stripBatComments(readFileSync(join(root, 'scripts', name), 'utf8')),
      );
    });
  }
});
