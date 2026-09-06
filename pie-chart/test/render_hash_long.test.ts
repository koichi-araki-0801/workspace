// =============================================================================
// render_hash_long.test.ts — 合成入力のうち配置計算が重い 2 ケースの SVG ハッシュ固定
// =============================================================================
// 定数表 (`renderHashExpected.ts`) と生成器 (`syntheticCases.ts`) は `render_hash.test.ts` と同じ。
// 分けるのは、この 2 ケースだけで他の 24 ケースの合計を超える時間がかかり、同じファイルに
// 同居させると CI の臨界経路がこのファイルの長さになるため。
// `gen_long_14_other` は正規化 (`|value| > 0` フィルタ) で値 0 の 2 項目が落ちて
// `gen_long_12_other` と同一入力になる (ハッシュも同一)。n=14 のケースが n=12 と同じ分布しか
// 守っていないのはテスト設計の穴だが、`makeItems` を直すと全ケースのハッシュが動くため、
// 期待値の意図的な更新とセットで別途扱う。
// =============================================================================

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import { EXPECTED } from './helpers/renderHashExpected.js';
import { LONG_CASE_NAMES, syntheticCases } from './helpers/syntheticCases.js';

const LONG_CASES = Object.entries(syntheticCases()).filter(([name]) =>
  LONG_CASE_NAMES.includes(name),
);

describe('合成入力の SVG ハッシュ固定 (配置計算が重いケース)', () => {
  // timeout はルート `vitest run --coverage` (4 project 並列) 併走時の実測を余裕込みで収める値
  // (`render_hash.test.ts` と同じ判断・同じ値)。単独では 1 ケース約 4〜5 秒で、カバレッジ実行の
  // オーバーヘッドと並列負荷を掛け合わせても 60 秒には十分な余裕がある。
  it.each(LONG_CASES)(
    '%s の SHA256 が定数表と一致する',
    { timeout: 60_000 },
    async (name, items) => {
      const { svg } = await renderPdfStylePieToSvg(items, {});
      expect(createHash('sha256').update(svg).digest('hex')).toBe(EXPECTED[name]);
    },
  );
});
