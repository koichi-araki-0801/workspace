// =============================================================================
// svg_export/font.ts — フォントサブセット埋込 (TTF/WOFF/WOFF2 → WOFF2)
// -----------------------------------------------------------------------------
// buildFontFaceDefs: cfg.embedFont 時にフォントを subset-font で WOFF2 化 → base64 →
// @font-face <defs> 文字列を返す。usedChars + REQUIRED_FONT_CHARS を合流。
// 失敗時はフルフォントにフォールバック (形式はマジックバイトで判定)。
// プロセス内キャッシュで同条件を再利用。
// SEA(単一 exe)ではフォント woff2 も subset-font(harfbuzz wasm 依存)も **exe へ同梱**する
// (`scripts/build-exe.mjs`)。exe 隣・上位ディレクトリの `fonts/` や `node_modules/` は
// 一切見ない — 署名の外にある書き込み可能なファイルを実行時に読む経路を残さないため。
// SEA での参照は `runtime/seaRuntime.ts` の許可リスト経由に一本化し、失敗時のフォールバックも
// 行わない(下記 `loadFontBuffer` / subset 失敗の分岐を参照)。
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import subsetFontModule from 'subset-font';

import { isSea, readSeaAsset } from '../runtime/seaRuntime.js';
import type { PieLayoutConfig } from '../types.js';

// `subset-font` は `module.exports = fn` の CJS。ESM 既定 import(tsx)と esbuild の
// `__toESM`(SEA バンドル)で形が揃わないため、関数実体をここで 1 回だけ正規化する。
const subsetFont = ((subsetFontModule as unknown as { default?: typeof subsetFontModule })
  .default ?? subsetFontModule) as typeof subsetFontModule;

const FONT_FACE_CACHE = new Map<string, string>();
const FONT_BUFFER_CACHE = new Map<string, Buffer>();
// このファイルは src/svg_export/font.ts に配置されているので、プロジェクトルート
// (pie-chart/) は ../.. に相当する。cfg.embedFontPath が相対パスの場合の解決基点に使う(dev のみ)。
// SEA(単一 exe)では esbuild の cjs 出力で `import.meta.url` が空になり fileURLToPath が
// 投げるため try で握りつぶす(SEA は basename を SEA アセットキーにするので本値は未使用)。
const PROJECT_ROOT = ((): string => {
  try {
    return resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
  } catch {
    return process.cwd();
  }
})();

/**
 * サブセットに常時含める必須文字。数字 / 小数点 / カンマ / % / △ / 空白 / 改行 +
 * 半角カナ全域 (U+FF61–U+FF9F)。
 */
const REQUIRED_FONT_CHARS: Set<string> = (() => {
  const set = new Set('0123456789.,%△ \n');
  for (let cp = 0xff61; cp <= 0xff9f; cp += 1) set.add(String.fromCodePoint(cp));
  return set;
})();

/**
 * フォントのバイト列を読み込む。Node SEA(単一 exe)実行時は **exe へ同梱した SEA アセット**
 * から読む。`cfg.embedFontPath` は外部から任意の値を渡せるため basename をそのままキーに
 * するが、許可リスト外のキーは `readSeaAsset` が拒否する(= 任意ファイルの読み出しにならない)。
 * それ以外(通常の Node/tsx)は `embedFontPath` から解決した絶対パスでディスクから読む。
 */
function loadFontBuffer(absPath: string): Buffer {
  if (isSea()) {
    return readSeaAsset(basename(absPath));
  }
  return readFileSync(absPath);
}

/** バッファ先頭のマジックバイトから @font-face 用の mime/format を判定する。 */
function sniffFontFormat(buf: Buffer): { mime: string; format: string } {
  const magic = buf.toString('latin1', 0, 4);
  if (magic === 'wOF2') return { mime: 'font/woff2', format: 'woff2' };
  if (magic === 'wOFF') return { mime: 'font/woff', format: 'woff' };
  return { mime: 'font/ttf', format: 'truetype' };
}

/**
 * cfg.embedFont が真なら、フォントをサブセット化 → WOFF2 化 → base64 で @font-face
 * 定義を含む <defs><style>...</style></defs> 文字列を返す。
 */
export async function buildFontFaceDefs(
  cfg: PieLayoutConfig,
  usedChars: Iterable<string> | null,
): Promise<string> {
  if (!cfg.embedFont || !cfg.embedFontPath || !cfg.embedFontFamilyName) {
    return '';
  }
  const absPath = isAbsolute(cfg.embedFontPath)
    ? cfg.embedFontPath
    : resolvePath(PROJECT_ROOT, cfg.embedFontPath);

  const charSet = new Set(REQUIRED_FONT_CHARS);
  if (usedChars) {
    for (const ch of usedChars) charSet.add(ch);
  }
  const chars = [...charSet].sort().join('');
  const cacheKey = `${absPath}::${cfg.embedFontFamilyName}::${cfg.fontWeight}::${chars}`;
  if (FONT_FACE_CACHE.has(cacheKey)) {
    return FONT_FACE_CACHE.get(cacheKey)!;
  }

  let buf = FONT_BUFFER_CACHE.get(absPath);
  if (!buf) {
    try {
      buf = loadFontBuffer(absPath);
      FONT_BUFFER_CACHE.set(absPath, buf);
    } catch (err: any) {
      // SEA ではフォントは exe に同梱済みなので、読めない = 配布物が壊れている。@font-face
      // 無しで黙って続行すると壊れた配布物が動いているように見えるため、そのまま投げる。
      if (isSea()) throw err;
      console.warn(
        `[svg_export] embedFont enabled but font not found at ${absPath}: ${err.message}`,
      );
      FONT_FACE_CACHE.set(cacheKey, '');
      return '';
    }
  }

  let subsetBuf: Buffer;
  let mime: string;
  let format: string;
  try {
    subsetBuf = await subsetFont(buf, chars, { targetFormat: 'woff2' });
    mime = 'font/woff2';
    format = 'woff2';
  } catch (err: any) {
    // SEA ではフルフォント fallback を行わない。このフォールバックは「subset-font が
    // 動かなかったこと」を配布先から見えなくする仕掛けで、偽モジュール差し込みや配布物の
    // 破損を検知不能にする。dev は `out/_baseline` の byte-diff が検知するので現行維持。
    if (isSea()) throw err;
    console.warn(`[svg_export] subsetFont failed (${err.message}); falling back to full font`);
    subsetBuf = buf;
    ({ mime, format } = sniffFontFormat(buf));
  }

  const base64 = subsetBuf.toString('base64');
  const css = `@font-face{font-family:"${cfg.embedFontFamilyName}";font-weight:${cfg.fontWeight};font-style:normal;font-display:block;src:url(data:${mime};base64,${base64}) format("${format}");}`;
  const defs = `<defs><style type="text/css"><![CDATA[${css}]]></style></defs>`;
  FONT_FACE_CACHE.set(cacheKey, defs);
  return defs;
}
