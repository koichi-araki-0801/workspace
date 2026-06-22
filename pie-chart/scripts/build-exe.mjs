// =============================================================================
// build-exe.mjs — pie-chart CLI を単一 exe(Node SEA)へパッケージする
// -----------------------------------------------------------------------------
// 手順:
//   1. esbuild で cli.ts を単一 CJS(build/cli.cjs)へバンドル
//      - samples.json は静的 import なので inline される
//      - msnodesqlv8(ネイティブ optional)と subset-font は external
//   2. sea-config.json を生成 → node --experimental-sea-config で SEA blob を生成
//   3. node 実行体を dist-exe/pie-chart.exe へコピーし postject で blob を inject
//   4. 外部参照物を dist-exe へ同梱: fonts/(woff2)・node_modules/(subset-font 依存ツリー)
// 配布物は **dist-exe/ フォルダ一式**(pie-chart.exe + fonts/ + node_modules/)。
//   - フォントと subset-font を exe に埋め込まず外部参照することで、`require.resolve`
//     ('harfbuzzjs/hb-subset.wasm')が実行時 Node 解決で効き、**subset が機能して SVG が
//     小さくなる**(CLI 版と同等)。font.ts の seaExeDir/getSubsetFont と対応。
//   - DB 入力(--sql)を使う場合のみ、別途 msnodesqlv8 を node_modules へ追加する。
// 依存: esbuild / postject(devDependencies)。subset-font 同梱は build 時に npm install
// で取得する(オフライン配布時は [[offline-bundle-distribution]] で含める)。
// =============================================================================

import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const buildDir = join(root, 'build');
const distDir = join(root, 'dist-exe');
const bundlePath = join(buildDir, 'cli.cjs');
const blobPath = join(buildDir, 'pie-chart.blob');
const seaConfigPath = join(buildDir, 'sea-config.json');
const exeName = process.platform === 'win32' ? 'pie-chart.exe' : 'pie-chart';
const exePath = join(distDir, exeName);

// SEA blob を識別するための fuse(Node 公式ドキュメントの固定値)。
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(msg) {
  console.log(`[build-exe] ${msg}`);
}

// 1. esbuild バンドル ---------------------------------------------------------
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

log('esbuild: bundling cli.ts -> build/cli.cjs');
await build({
  entryPoints: [join(root, 'cli.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // external: ネイティブ optional の msnodesqlv8 と、外部参照する subset-font
  // (バンドルすると harfbuzz wasm の require.resolve が解決できず subset が効かない)。
  external: ['msnodesqlv8', 'subset-font'],
  logLevel: 'info',
});

// 2. sea-config.json(アセット埋込なし。フォントは外部参照) ----------------------
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  ),
);
log('sea-config.json written (assets externalized)');

// 3. SEA blob 生成 ------------------------------------------------------------
log('generating SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

// 4. node 実行体をコピー ------------------------------------------------------
log(`copying node runtime -> ${exePath}`);
copyFileSync(process.execPath, exePath);

// 5. postject で blob を inject ----------------------------------------------
const postjectCli = require.resolve('postject/dist/cli.js');
const postjectArgs = [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE];
// macOS のみ Mach-O セグメント名が必要。Windows/Linux では不要。
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
log('injecting blob with postject');
execFileSync(process.execPath, postjectArgs, { stdio: 'inherit' });

// 6. 外部参照物を dist-exe へ同梱 --------------------------------------------
// (a) フォント woff2 を dist-exe/fonts/ へ。font.ts は SEA 時ここから basename で読む。
log('copying fonts -> dist-exe/fonts');
cpSync(join(root, 'fonts'), join(distDir, 'fonts'), { recursive: true });

// (b) subset-font + 依存ツリーを dist-exe/node_modules/ へ。getSubsetFont が exe 基準で
//     解決し、内部の require.resolve('harfbuzzjs/hb-subset.wasm')が実 Node 解決で効く。
//     pnpm のシンボリックリンク構造を避けるため npm で隔離 install する。版は dev と完全一致
//     させて exe の subset 結果(=SVG バイト)を CLI 版と揃える。
const subsetVersion = createRequire(import.meta.url)('subset-font/package.json').version;
log(`npm install subset-font@${subsetVersion} -> dist-exe/node_modules`);
// execSync(シェル経由)で起動する。Node 24 は execFileSync での .cmd 直接起動を拒否するため。
execSync(
  `npm install "subset-font@${subsetVersion}" --prefix "${distDir}" ` +
    '--omit=dev --no-audit --no-fund --no-package-lock --loglevel=error',
  { stdio: 'inherit' },
);

log(`done: dist-exe/ (${exeName} + fonts/ + node_modules/)`);
