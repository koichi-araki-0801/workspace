// =============================================================================
// build-exe.mjs — pie-chart CLI を単一 exe(Node SEA)へパッケージする
// -----------------------------------------------------------------------------
// 手順:
//   1. esbuild で cli.ts を単一 CJS(build/cli.cjs)へバンドル
//      - samples.json は静的 import なので inline される
//      - msnodesqlv8(ネイティブ optional)と subset-font は external
//   2. sea-config.json を生成 → node --experimental-sea-config で SEA blob を生成
//   3. node 実行体を dist-exe/pie-chart.exe へコピー、既存 Authenticode 署名を剥がし
//      postject で blob を inject
//   4. (Windows)自己署名: sign-exe.ps1 で SHA256 署名し公開証明書(.cer)を書き出す
//   5. 外部参照物を dist-exe へ同梱: fonts/(woff2)・node_modules/(subset-font 依存ツリー)
// 配布物は **dist-exe/ フォルダ一式**(pie-chart.exe + pie-chart-codesign.cer + fonts/ +
// node_modules/)。
//   - フォントと subset-font を exe に埋め込まず外部参照することで、`require.resolve`
//     ('harfbuzzjs/hb-subset.wasm')が実行時 Node 解決で効き、**subset が機能して SVG が
//     小さくなる**(CLI 版と同等)。font.ts の seaExeDir/getSubsetFont と対応。
//   - DB 入力(--sql)を使う場合のみ、別途 msnodesqlv8 を node_modules へ追加する。
// 依存: esbuild / postject(devDependencies)。subset-font 同梱は build 時に npm install
// で取得する(オフライン配布時は [[offline-bundle-distribution]] で含める)。
// =============================================================================

import { execFileSync, execSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  cpSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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

/**
 * PE(exe)から既存の Authenticode 署名(証明書テーブル)を除去する。node.exe は Node 配布元の
 * 署名付きで、postject の blob 注入でそれが壊れ、後段の Set-AuthenticodeSignature が
 * 「有効な Win32 アプリではない」で失敗する。Windows SDK(signtool)無しで除去するため、
 * PE ヘッダの IMAGE_DIRECTORY_ENTRY_SECURITY(index 4)をゼロ化し、末尾の証明書データを切り詰め、
 * オプションヘッダの CheckSum もゼロ化する(ユーザモード exe は CheckSum 検証されない)。
 * 署名が無ければ何もしない。
 */
function stripPeSignature(file) {
  const fd = openSync(file, 'r+');
  try {
    const u32 = (off) => {
      const b = Buffer.alloc(4);
      readSync(fd, b, 0, 4, off);
      return b.readUInt32LE(0);
    };
    const peOff = u32(0x3c); // e_lfanew
    const sig = Buffer.alloc(4);
    readSync(fd, sig, 0, 4, peOff);
    if (sig.toString('latin1') !== 'PE\0\0') throw new Error('not a PE file');
    const magic = (() => {
      const b = Buffer.alloc(2);
      readSync(fd, b, 0, 2, peOff + 24);
      return b.readUInt16LE(0);
    })();
    // データディレクトリの開始: PE32+ は 112, PE32 は 96(オプションヘッダ先頭からの相対)。
    const ddStart = magic === 0x20b ? 112 : 96;
    const secDirOff = peOff + 24 + ddStart + 4 * 8; // index 4 (SECURITY)
    const certOffset = u32(secDirOff); // 証明書テーブルの **ファイルオフセット**
    const certSize = u32(secDirOff + 4);
    if (certOffset === 0 || certSize === 0) return false; // 署名なし
    writeSync(fd, Buffer.alloc(8), 0, 8, secDirOff); // SECURITY ディレクトリをゼロ化
    writeSync(fd, Buffer.alloc(4), 0, 4, peOff + 24 + 64); // CheckSum をゼロ化
    ftruncateSync(fd, certOffset); // 末尾の証明書データを切り詰め
    return true;
  } finally {
    closeSync(fd);
  }
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
  // target は **このビルドを走らせている Node のメジャー版**に追従させる。SEA exe の実体は
  // `process.execPath`(= 実行中の node)をコピーしたものなので、bundle の syntax をその node に
  // 必ず一致させる。24 系開発機なら node24、20 系の古い環境(run.bat 経由)なら node20 が選ばれ、
  // exe 本体とバンドルの想定が常に揃う(従来の node22 ハードコードは node20 ビルドでズレた)。
  target: `node${process.versions.node.split('.')[0]}`,
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

// 4. node 実行体をコピー + 既存署名を除去 ------------------------------------
log(`copying node runtime -> ${exePath}`);
copyFileSync(process.execPath, exePath);
// Node 配布元の Authenticode 署名を先に剥がす(postject で壊れた署名が残ると後段の
// 自己署名が「有効な Win32 アプリではない」で失敗するため)。
if (stripPeSignature(exePath)) {
  log('stripped existing Authenticode signature from node runtime');
}

// 5. postject で blob を inject ----------------------------------------------
const postjectCli = require.resolve('postject/dist/cli.js');
const postjectArgs = [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE];
// macOS のみ Mach-O セグメント名が必要。Windows/Linux では不要。
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
log('injecting blob with postject');
execFileSync(process.execPath, postjectArgs, { stdio: 'inherit' });

// 6. 自己署名(Windows のみ・ベストエフォート) -------------------------------
// postject 注入後が exe への最終変更なので、署名はこの直後に行う(以降 exe は不変)。
// 失敗してもビルドは止めない(未署名でも exe は動作する)。
if (process.platform === 'win32') {
  const certOut = join(distDir, 'pie-chart-codesign.cer');
  try {
    log('self-signing exe (PowerShell Set-AuthenticodeSignature)');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(here, 'sign-exe.ps1'),
        '-ExePath',
        exePath,
        '-CertOut',
        certOut,
      ],
      { stdio: 'inherit' },
    );
  } catch (e) {
    log(`self-sign skipped (exe is still usable, just unsigned): ${e.message}`);
  }
}

// 7. 外部参照物を dist-exe へ同梱 --------------------------------------------
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
