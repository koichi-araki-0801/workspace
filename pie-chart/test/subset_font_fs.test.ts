// =============================================================================
// subset_font_fs.test.ts — `subset-font` へだけ差し込む fs shim の分岐
// -----------------------------------------------------------------------------
// shim が sentinel を **完全一致**でしか受けないことを主張する。前方一致や `endsWith` へ
// 緩めると、攻撃者が sentinel に似たパスを作って SEA アセット読み出し側へ入り込める。
// dev(非 SEA)では SEA アセットが無いので、経路の判別は「どのエラーで落ちるか」で行う:
//   sentinel 一致 -> readSeaAsset(SEA 専用) / 不一致 -> 実 fs(ENOENT 等)。
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import fsShim, { promises as shimPromises } from '../src/runtime/subsetFontFs.js';
import { HB_WASM_SENTINEL } from '../src/runtime/seaRuntime.js';

/** エラーメッセージから「SEA アセット経路へ入ったか」を判定する。 */
async function routeOf(path: string): Promise<'sea' | 'fs'> {
  try {
    await shimPromises.readFile(path);
    return 'fs'; // 実ファイルが読めた = 実 fs へ委譲された
  } catch (err) {
    return /only available inside the packaged executable|not in the allowlist/.test(
      String((err as Error).message),
    )
      ? 'sea'
      : 'fs';
  }
}

describe('subset-font 用 fs shim', () => {
  it('sentinel と完全一致したときだけ SEA アセットへ振り替える', async () => {
    await expect(routeOf(HB_WASM_SENTINEL)).resolves.toBe('sea');
  });

  // sentinel の近傍値。どれか 1 つでも 'sea' になれば完全一致判定が壊れている。
  const nearMisses = [
    `${HB_WASM_SENTINEL} `,
    ` ${HB_WASM_SENTINEL}`,
    `${HB_WASM_SENTINEL}\0extra`,
    HB_WASM_SENTINEL.slice(1), // 先頭 NUL 抜き(実パスとして成立しうる形)
    'pie-chart:hb-subset.wasm',
    'hb-subset.wasm',
  ];
  for (const path of nearMisses) {
    it(`sentinel の近傍値は実 fs へ落とす: ${JSON.stringify(path)}`, async () => {
      await expect(routeOf(path)).resolves.toBe('fs');
    });
  }

  it('通常のパスは実 fs と同じバイト列を返す', async () => {
    const self = fileURLToPath(import.meta.url);
    const viaShim = await shimPromises.readFile(self);
    expect(Buffer.from(viaShim).equals(readFileSync(self))).toBe(true);
  });

  it('既定 export も promises 差し替え済みで、他の fs API は素通し', async () => {
    // `subset-font` は `require('fs').promises` の形で使うので既定 export 側にも要る。
    expect(fsShim.promises.readFile).toBe(shimPromises.readFile);
    expect(fsShim.readFileSync).toBe(readFileSync);
  });
});
