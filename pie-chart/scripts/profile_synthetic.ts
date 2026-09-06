// =============================================================================
// profile_synthetic.ts — 合成入力 1 ケースの描画時間と熱源の呼出回数を出す (開発時の計測)
// -----------------------------------------------------------------------------
// 配置計算の高速化は SVG バイト不変が鉄則で、効いたかどうかは出力からは分からない。ここで
// `perfCounters` (`types.ts`) の回数と壁時計を JSON 1 行で出し、変更前後を比べる。
//   実行: npm run profile:synthetic [ケース名]   (既定 gen_long_12_other)
// ケースは `test/helpers/syntheticCases.ts` の生成器から取る (render_hash 系テストと同一入力)。
// =============================================================================

import { performance } from 'node:perf_hooks';

import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import type { PerfCounters } from '../src/types.js';
import { syntheticCases } from '../test/helpers/syntheticCases.js';

const name = process.argv[2] ?? 'gen_long_12_other';
const items = syntheticCases()[name];
if (!items) {
  console.error(`[profile] 未知のケース名: ${name}`);
  process.exit(1);
}
const perfCounters: PerfCounters = {
  placementBox: 0,
  realLeaderPaths: 0,
  measureRepairVec: 0,
  tryBendGridOn: 0,
};
const t0 = performance.now();
const { svg } = await renderPdfStylePieToSvg(items, { perfCounters });
const seconds = Number(((performance.now() - t0) / 1000).toFixed(2));
console.log(JSON.stringify({ name, seconds, svgBytes: Buffer.byteLength(svg), ...perfCounters }));
