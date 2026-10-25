'use strict';
// =============================================================================
// runtime/sqlserverv8Shim.cjs — msnodesqlv8 のネイティブドライバ読み込みの差し替え先
// -----------------------------------------------------------------------------
// msnodesqlv8 は `lib/util.js` の `require('node-gyp-build')(<パッケージ>)` でドライバを読む。exe では
// `scripts/build-exe.mjs` の esbuild plugin がその `node-gyp-build` を「本ファイルを返す関数」へ
// 差し替え、子プロセスが照合済みのパスを `registerDriverPath`(runtime/nativeDriver.ts)で登録して
// から msnodesqlv8 を読み込む。`process.dlopen` は `Module._resolveFilename` を通らないので、
// SEA のモジュール解決の封鎖(runtime/seaRuntime.ts)とはぶつからない。
// 下のメッセージの `pie-chart:sqlserverv8-shim` は、ビルドが「バンドルに本ファイルがちょうど
// 1 回入った」ことを確かめる印を兼ねる。
// =============================================================================

const file = globalThis[Symbol.for('pie-chart.sqlserverv8.path')];
if (typeof file !== 'string') {
  throw new Error(
    'pie-chart:sqlserverv8-shim: the driver path was not registered before loading msnodesqlv8.',
  );
}
const mod = { exports: {} };
process.dlopen(mod, file);
module.exports = mod.exports;
