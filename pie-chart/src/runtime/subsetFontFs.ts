// =============================================================================
// runtime/subsetFontFs.ts — `subset-font` へだけ差し込む fs 薄ラッパ
// -----------------------------------------------------------------------------
// `subset-font/index.js` は `require('fs').promises.readFile(require.resolve(
// 'harfbuzzjs/hb-subset.wasm'))` の 1 経路でのみ外部ファイルを読む。SEA では
// `require.resolve` が `HB_WASM_SENTINEL` を返す(`runtime/seaRuntime.ts`)ので、ここで
// sentinel を SEA アセットへ振り替えれば **wasm をディスクへ出さずに** in-memory で
// 完結する(`%TEMP%` へ展開する案は、書き出し〜読み込みの間に差し替え窓ができるため不採用)。
//
// 差し込みは `scripts/build-exe.mjs` の esbuild plugin が `subset-font/index.js` からの
// `require('fs')` **だけ**をモジュールグラフ上で本モジュールへ向けることで行う。グローバル
// `fs` の monkeypatch はしない(exceljs の xlsx 読み込み等、無関係な経路へ副作用が漏れる)。
// 依存のソース文字列は書き換えない。
//
// dev(tsx)ではこの差し替えが起きないので、本モジュールは経路として存在しない。
// =============================================================================

import * as realFs from 'node:fs';

import { HB_WASM_ASSET_KEY, HB_WASM_SENTINEL, readSeaAsset } from './seaRuntime.js';

type RealReadFile = typeof realFs.promises.readFile;

/**
 * sentinel のときだけ SEA アセットのバイト列を返し、それ以外は実 `fs` へ委譲する。
 * 判定は sentinel との完全一致のみ(前方一致や `endsWith` へ緩めない)。
 */
const readFile = (async (path: unknown, options?: unknown) => {
  if (path === HB_WASM_SENTINEL) {
    return readSeaAsset(HB_WASM_ASSET_KEY);
  }
  return (realFs.promises.readFile as (...args: unknown[]) => Promise<unknown>)(path, options);
}) as unknown as RealReadFile;

export const promises: typeof realFs.promises = { ...realFs.promises, readFile };

// `subset-font` は `require('fs').promises` の形で使うので既定 export も要る。型注釈を
// 省くと構造型が `node:fs` の非公開型(`ReadStreamOptions` 等)を参照して declaration emit が
// 落ちる(TS4082)ため、`typeof realFs` を明示する。
const fsShim: typeof realFs = { ...realFs, promises };

export default fsShim;
