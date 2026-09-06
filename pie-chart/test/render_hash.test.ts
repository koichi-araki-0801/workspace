// =============================================================================
// render_hash.test.ts — サンプル外の合成入力に対する SVG ハッシュ固定 (特性テスト)
// =============================================================================
// byte-diff (out/_baseline) は samples.json の入力分布しか守らない。mark*** 系ゲートの
// リファクタで「既存サンプルは不変だが未収録の入力で誤発火する」穴を狭めるため、
// `syntheticCases.ts` の決定的な合成入力を描画し、SVG の SHA256 を `renderHashExpected.ts` の
// 定数表と突き合わせる。定数表の更新は挙動変更を意図した時だけ許される。
// 配置計算が突出して重い 2 ケース (`LONG_CASE_NAMES`) は `render_hash_long.test.ts` に分け、
// ここは残り 24 ケースをケース単位の `it` にする (1 ケースの失敗が他のケースを隠さない)。
// =============================================================================

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import { EXPECTED } from './helpers/renderHashExpected.js';
import { LONG_CASE_NAMES, syntheticCases } from './helpers/syntheticCases.js';

const ALL_CASES = Object.entries(syntheticCases());
const LIGHT_CASES = ALL_CASES.filter(([name]) => !LONG_CASE_NAMES.includes(name));

describe('合成入力の SVG ハッシュ固定 (サンプル外の入力分布)', () => {
  it('定数表のケース名と生成ケース名の集合が一致する (脱落・綴り違いを検出する)', () => {
    const generated = ALL_CASES.map(([name]) => name).sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(generated);
    expect(generated).toHaveLength(26);
    for (const name of LONG_CASE_NAMES) expect(generated).toContain(name);
    expect(LIGHT_CASES).toHaveLength(24);
  });

  // timeout はルート `vitest run --coverage` (4 project 並列) 併走時の実測を余裕込みで収める値。
  // 配置計算そのものが重い決定的テストで、遅いこと自体は退行ではないので上限は並行負荷の実測に
  // 合わせる (`final_score.test.ts` と同じ判断)。
  it.each(LIGHT_CASES)(
    '%s の SHA256 が定数表と一致する',
    { timeout: 60_000 },
    async (name, items) => {
      const { svg } = await renderPdfStylePieToSvg(items, {});
      expect(createHash('sha256').update(svg).digest('hex')).toBe(EXPECTED[name]);
    },
  );
});
