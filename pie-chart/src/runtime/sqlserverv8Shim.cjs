'use strict';
// =============================================================================
// runtime/sqlserverv8Shim.cjs — msnodesqlv8 のネイティブドライバ読み込みの差し替え先
// -----------------------------------------------------------------------------
// msnodesqlv8 は `lib/util.js` の `require('../build/Release/sqlserverv8.node')` の 1 箇所で
// ドライバを読む。exe ではその require を `scripts/build-exe.mjs` の esbuild plugin が本ファイルへ
// 向け、子プロセスが照合済みのパスを `registerDriverPath`(runtime/nativeDriver.ts)で登録して
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
