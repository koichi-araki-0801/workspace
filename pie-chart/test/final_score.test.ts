// =============================================================================
// final_score.test.ts — emit 後 finalScore + modeTags のゴールデン表 (特性テスト)
// =============================================================================
// byte-diff (out/_baseline) は出力完全一致を保証するが、差分が出た時に「どのサンプルの
// どの不具合カテゴリが動いたか」を教えない。本テストは全サンプルの emit 後 finalScore
// (`countDefects` 内訳: clips/crossings/pie/total) と modeTags をスナップショットへ固定し、
// 挙動が変わる変更の影響範囲をカテゴリ単位で局所化する。
// スナップショット更新 (-u) は挙動変更を意図した時だけ許される。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { resolveInputData, samples } from '../src/input/load.js';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';

describe('emit 後 finalScore / modeTags のゴールデン表', () => {
  // timeout はルート `vitest run --coverage`(pre-push CI) 併走時の実測 (~130s。V8 カバレッジ計測 +
  // 他プロジェクト並列で単体実行 ~87s の 1.5-2 倍に伸びる) を余裕込みで収める値。
  it('全サンプルの finalScore と modeTags がスナップショットと一致する', {
    timeout: 300_000,
  }, async () => {
    const table: Record<string, { finalScore?: unknown; modeTags: string[] }> = {};
    for (const name of Object.keys(samples).sort()) {
      const items = resolveInputData({ data: samples[name].items });
      const { diagnostics } = await renderPdfStylePieToSvg(items, {});
      // single-slice チャートは layout を通らないため diagnostics が null になる。
      table[name] = {
        finalScore: diagnostics?.finalScore ?? null,
        modeTags: diagnostics ? [...diagnostics.modeTags] : [],
      };
    }
    expect(table).toMatchSnapshot();
  });
});
