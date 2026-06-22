// =============================================================================
// build-exe.mjs — pie-chart CLI を単一 exe(Node SEA)へパッケージする
// -----------------------------------------------------------------------------
// 手順:
//   1. esbuild で cli.ts を単一 CJS(build/cli.cjs)へバンドル
//      - samples.json は静的 import なので inline される
//      - msnodesqlv8 はネイティブ optional のため external(DB 入力使用時のみ実行時 require)
//   2. sea-config.json を生成(フォント woff2 を SEA アセットとして埋込)
//   3. node --experimental-sea-config で SEA blob を生成
//   4. node 実行体を dist-exe/pie-chart.exe へコピー
//   5. postject で blob を inject(NODE_SEA_BLOB)
// 出力: pie-chart/dist-exe/pie-chart.exe(描画機能で自己完結。DB 入力のみ別途
// msnodesqlv8 を exe 隣へ配置する必要がある)。
// 依存: esbuild / postject(devDependencies)。オフライン配布時は両者を
// バンドルへ含める必要がある([[offline-bundle-distribution]])。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  // ネイティブ optional 依存。バンドルせず実行時 require に委ねる(未導入なら明確なエラー)。
  external: ['msnodesqlv8'],
  logLevel: 'info',
});

// 2. sea-config.json(フォントをアセット埋込) ---------------------------------
const fontsDir = join(root, 'fonts');
const assets = {
  'BIZUDPGothic-Regular.woff2': join(fontsDir, 'BIZUDPGothic-Regular.woff2'),
  'BIZUDPGothic-Bold.woff2': join(fontsDir, 'BIZUDPGothic-Bold.woff2'),
};
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      // codeCache は cjs バンドル + アセットと相性問題が出ることがあるため無効化する。
      useCodeCache: false,
      useSnapshot: false,
      assets,
    },
    null,
    2,
  ),
);
log('sea-config.json written (fonts embedded as assets)');

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

log(`done: ${exePath}`);
