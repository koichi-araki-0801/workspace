// =============================================================================
// runtime/msDriver.ts — msnodesqlv8 を読み込む
// -----------------------------------------------------------------------------
// exe(esbuild の cjs バンドル)では、リテラルの `require('msnodesqlv8')` をバンドラが取り込む。
// ネイティブ部分は `sqlserverv8Shim.cjs` へ差し替わっているので、子プロセスが
// `registerDriverPath` を呼んだ後でなければ読み込めない。開発版(tsx の ESM)には `require` が
// 無いので `createRequire` で node_modules から読む。どちらも単体テストでは通らない分岐なので、
// カバレッジの対象から外せるよう本ファイルに分けている。
// =============================================================================

import { createRequire } from 'node:module';

import type { MsSqlDriver } from '../input/db.js';

/** msnodesqlv8 を読み込む。失敗は素の Error のまま投げる(段階付けは呼び出し側)。 */
export function loadMsSqlDriver(): MsSqlDriver {
  if (typeof require === 'function') {
    return require('msnodesqlv8') as MsSqlDriver;
  }
  return createRequire(import.meta.url)('msnodesqlv8') as MsSqlDriver;
}
