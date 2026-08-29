// =============================================================================
// build-exe.mjs — pie-chart CLI を単一 exe(Node SEA)へパッケージする
// -----------------------------------------------------------------------------
// 手順:
//   1. esbuild で cli.ts を単一 CJS(build/cli.cjs)へバンドル
//      - samples.json は静的 import なので inline される
//      - subset-font とその JS 閉包も**バンドルへ取り込む**
//      - msnodesqlv8(ネイティブ optional)だけは external(バンドル不能)
//   2. sea-config.json を生成(harfbuzz wasm + フォント woff2 + OFL を assets へ)
//      → node --experimental-sea-config で SEA blob を生成
//   3. node 実行体を dist-exe/pie-chart.exe へコピー、既存 Authenticode 署名を剥がし
//      postject で blob を inject
//   4. (Windows)署名: sign-exe.ps1 で SHA256 署名し公開証明書(.cer)を書き出す
// 配布物は **exe 1 個 + .cer + OFL ライセンス + SIGNING-INFO.txt** の 4 点だけで、
// `fonts/` や `node_modules/` の sidecar は作らない。sidecar を置くと、署名の外にある
// 書き込み可能なファイルを実行時に読むことになり、上位ディレクトリへ偽 `subset-font` を
// 置くだけで別ユーザーの exe 内でコードが走る。実行されるものは
// すべて exe の中 = Authenticode 署名の内側に入れる。SEA 側の受け口は
// `src/runtime/seaRuntime.ts`(アセット許可リスト・モジュール解決封鎖)。
//
// ビルドを止めるアサートを 3 つ持つ(壊れたら黙って劣化させず落とす):
//   A. バンドル内に `require.resolve("harfbuzzjs/hb-subset.wasm")` がちょうど 1 回ある
//      = shim が受ける前提が依存の更新で崩れていない
//   B. `scripts/sidecar-pins.json` の版・wasm ハッシュが実解決値と一致する
//      = 依存を上げたら render_hash スナップショットの更新要否に気づける
//   C. Node >= 20.12(sea-config の `assets` / `sea.getAsset` の要件)
// 依存: esbuild / postject(devDependencies)。ビルド時の `npm install` は無い
// (完全オフラインで exe を作れる)。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
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
const pinsPath = join(here, 'sidecar-pins.json');
const signingLocalPath = join(here, 'signing.local.json');

// SEA blob を識別するための fuse(Node 公式ドキュメントの固定値)。
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// 署名が付かない配布物をうっかり配らないよう、既定は署名失敗 = ビルド失敗。開発中の動作確認
// でだけ明示的に外す。
const allowUnsigned = process.argv.slice(2).includes('--allow-unsigned');

function log(msg) {
  console.log(`[build-exe] ${msg}`);
}

function fail(msg) {
  console.error(`[build-exe] ERROR: ${msg}`);
  process.exit(1);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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

// 0. アサート C: Node 版 -------------------------------------------------------
// sea-config の `assets` と `sea.getAsset` は Node 20.12 で入った。旧 Node20 系(build-exe.ps1
// 経路)では `assets` が無視され、**アセットが空のまま exe ができてしまう**ので先に止める。
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 12)) {
    fail(
      `Node ${process.versions.node} does not support SEA assets (needs >= 20.12). ` +
        'Upgrade Node before building the exe.',
    );
  }
}

// 0-b. アサート B: 同梱する依存の版と wasm ハッシュを固定値と突き合わせる ---------
// pnpm ツリーではルートから `harfbuzzjs` を直接引けないので、`subset-font` を基点に解決する。
const subsetFontEntry = require.resolve('subset-font');
const subsetFontVersion = require('subset-font/package.json').version;
const hbWasmPath = createRequire(subsetFontEntry).resolve('harfbuzzjs/hb-subset.wasm');
const hbWasmSha256 = sha256(hbWasmPath);
{
  if (!existsSync(pinsPath)) fail(`missing ${pinsPath}`);
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
  if (pins.subsetFont !== subsetFontVersion) {
    fail(
      `subset-font version mismatch: pinned ${pins.subsetFont} but resolved ` +
        `${subsetFontVersion}. Update scripts/sidecar-pins.json and re-check ` +
        'test/render_hash.test.ts (embedded font bytes may change).',
    );
  }
  if (pins.hbSubsetWasmSha256 !== hbWasmSha256) {
    fail(
      `hb-subset.wasm hash mismatch: pinned ${pins.hbSubsetWasmSha256} but resolved ` +
        `${hbWasmSha256} (${hbWasmPath}). Update scripts/sidecar-pins.json and re-check ` +
        'test/render_hash.test.ts.',
    );
  }
}

// 1. esbuild バンドル ---------------------------------------------------------
// 旧配布物の残骸(fonts/ や node_modules/)が混ざったまま配られないよう、dist-exe は毎回作り直す。
rmSync(buildDir, { recursive: true, force: true });
rmSync(distDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

/**
 * `subset-font/index.js` からの `require('fs')` **だけ**を `src/runtime/subsetFontFs.ts` へ
 * 向ける esbuild plugin。依存のソース文字列は書き換えず、モジュールグラフ上の辺だけを
 * 差し替える。グローバル `fs` の monkeypatch はしない(exceljs の xlsx 読み込みなど
 * 無関係な経路へ副作用が漏れる)。
 */
const subsetFontFsPlugin = {
  name: 'subset-font-fs',
  setup(pluginBuild) {
    const shim = join(root, 'src', 'runtime', 'subsetFontFs.ts');
    const target = resolve(subsetFontEntry);
    pluginBuild.onResolve({ filter: /^fs$/ }, (args) => {
      if (resolve(args.importer) !== target) return null; // 他の importer は既定解決に任せる
      return { path: shim };
    });
  },
};

log('esbuild: bundling src/cli.ts -> build/cli.cjs');
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // target は **このビルドを走らせている Node のメジャー版**に追従させる。SEA exe の実体は
  // `process.execPath`(= 実行中の node)をコピーしたものなので、bundle の syntax をその node に
  // 必ず一致させる。24 系開発機なら node24、20 系の古い環境(npm 直叩き)なら node20 が選ばれ、
  // exe 本体とバンドルの想定が常に揃う(従来の node22 ハードコードは node20 ビルドでズレた)。
  target: `node${process.versions.node.split('.')[0]}`,
  // external はネイティブ optional の msnodesqlv8 のみ。SEA では `loadDbItems` の isSea()
  // ガードが手前で止めるので、この import へは到達しない(exe 版は DB 入力非対応)。
  external: ['msnodesqlv8'],
  plugins: [subsetFontFsPlugin],
  logLevel: 'info',
});

// 1-b. アサート A: wasm の require.resolve がちょうど 1 回残っていること ----------
// `subset-font` が外部を参照する唯一の点で、SEA ではこれを `seaRuntime.resolveSeaRequest`
// が sentinel で受ける。0 回なら依存が読み方を変えた(shim が空振りする)、2 回以上なら
// 想定外の呼び出し元が増えたということなので、どちらもビルドを止める。
{
  const bundleSrc = readFileSync(bundlePath, 'utf8');
  const hits = bundleSrc.match(/require\.resolve\(\s*["']harfbuzzjs\/hb-subset\.wasm["']\s*\)/g);
  const count = hits ? hits.length : 0;
  if (count !== 1) {
    fail(
      `expected exactly 1 require.resolve("harfbuzzjs/hb-subset.wasm") in the bundle, ` +
        `found ${count}. The subset-font wasm shim (src/runtime/seaRuntime.ts) assumes ` +
        'that single call site; re-check the dependency before shipping.',
    );
  }
}

// 2. sea-config.json(実行に要るものはすべて assets として exe へ埋め込む) ---------
// キーは `src/runtime/seaRuntime.ts` の `SEA_ASSET_KEYS` と 1:1。片方だけ増やすと実行時に
// 許可リストで弾かれるので、両方を必ず揃える。
const seaAssets = {
  'hb-subset.wasm': hbWasmPath,
  'BIZUDPGothic-Regular.woff2': join(root, 'fonts', 'BIZUDPGothic-Regular.woff2'),
  'BIZUDPGothic-Bold.woff2': join(root, 'fonts', 'BIZUDPGothic-Bold.woff2'),
  'OFL-BIZUDPGothic.txt': join(root, 'fonts', 'OFL-BIZUDPGothic.txt'),
};
for (const [key, file] of Object.entries(seaAssets)) {
  if (!existsSync(file)) fail(`SEA asset "${key}" not found at ${file}`);
}
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      // assets は useCodeCache / useSnapshot と併用できない(Node の制約)。
      useCodeCache: false,
      useSnapshot: false,
      assets: seaAssets,
    },
    null,
    2,
  ),
);
log(`sea-config.json written (${Object.keys(seaAssets).length} assets embedded)`);

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

// 6. 埋め込みフォントのライセンス(OFL)を配布物へ 1 本置く -----------------------
// フォントを exe へ埋め込んだので再配布条件を満たすため。exe 単体でも `pie-chart license`
// で同じ本文を出せる(アセットにも入っている)。
copyFileSync(join(root, 'fonts', 'OFL-BIZUDPGothic.txt'), join(distDir, 'OFL-BIZUDPGothic.txt'));

// 7. 署名(Windows のみ・既定は失敗したらビルドも失敗) --------------------------
// postject 注入後が exe への最終変更なので、署名はこの直後に行う(以降 exe は不変)。
// 署名鍵の thumbprint は **明示指定が必須**。ビルドが証明書を暗黙生成すると、端末ごとに
// 同名の別ルート証明書が増えて「どの .cer を配ったか」が追跡不能になる。
if (process.platform === 'win32') {
  const certOut = join(distDir, 'pie-chart-codesign.cer');
  const local = existsSync(signingLocalPath)
    ? JSON.parse(readFileSync(signingLocalPath, 'utf8'))
    : {};
  const thumbprint = process.env.PIECHART_SIGN_THUMBPRINT || local.thumbprint || '';
  const timestampServer = process.env.PIECHART_SIGN_TIMESTAMP || local.timestampServer || '';
  if (!thumbprint) {
    const msg =
      'no signing thumbprint. Create a key once with scripts/new-signing-cert.bat and put ' +
      'its thumbprint into scripts/signing.local.json (gitignored) or the env var ' +
      'PIECHART_SIGN_THUMBPRINT.';
    if (!allowUnsigned) fail(`${msg} Pass --allow-unsigned to build a deliberately unsigned exe.`);
    log(`WARNING: building an UNSIGNED exe — ${msg}`);
  } else {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(here, 'sign-exe.ps1'),
      '-ExePath',
      exePath,
      '-Thumbprint',
      thumbprint,
      '-CertOut',
      certOut,
    ];
    if (timestampServer) args.push('-TimestampServer', timestampServer);
    log('signing exe (PowerShell Set-AuthenticodeSignature)');
    let signOut = '';
    try {
      signOut = execFileSync('powershell.exe', args, {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
      });
    } catch (e) {
      signOut = e.stdout ? String(e.stdout) : '';
      process.stdout.write(signOut);
      if (!allowUnsigned) {
        fail(`signing failed: ${e.message}. Fix the signing key before shipping.`);
      }
      log(`WARNING: signing failed but --allow-unsigned was given: ${e.message}`);
    }
    process.stdout.write(signOut);
    // どの鍵で署名した配布物かを追跡できるよう、sign-exe.ps1 の `SIGN-INFO key=value` 行を
    // そのまま配布物へ残す(verify-dist.ps1 が thumbprint の照合に使う)。
    const info = signOut
      .split(/\r?\n/)
      .filter((l) => l.startsWith('SIGN-INFO '))
      .map((l) => l.slice('SIGN-INFO '.length));
    writeFileSync(
      join(distDir, 'SIGNING-INFO.txt'),
      `${['# pie-chart 配布物の署名情報(scripts/build-exe.mjs が生成)', ...info].join('\r\n')}\r\n`,
      'utf8',
    );
  }
}

log(`done: dist-exe/ (${exeName} + .cer + OFL-BIZUDPGothic.txt + SIGNING-INFO.txt)`);
