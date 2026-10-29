// =============================================================================
// partKeysText.test.ts — 文言・監査ログに並べるパーツのキーの件数
// =============================================================================
// 最終確定を止める理由(判定バーとサーバの 400)、判定の保存の 400・409、監査ログの `partKeys` は、
// 同じ上限 `MAX_LISTED_PART_KEYS` だけキーを並べ、残りは件数だけにする。
import { describe, expect, it } from 'vitest';
import {
  MAX_LISTED_PART_KEYS,
  partKeysText,
  reviewFinalizationIssues,
} from '../src/html/reviewDiff/editReviewedHtml.js';

const keys = (n: number) => Array.from({ length: n }, (_, i) => `k#${i + 1}`);

describe('partKeysText', () => {
  it('上限は 20 件で、超えた分は件数だけ', () => {
    expect(MAX_LISTED_PART_KEYS).toBe(20);
    expect(partKeysText(keys(20))).toBe(keys(20).join(', '));
    expect(partKeysText(keys(25))).toBe(`${keys(20).join(', ')} ほか5件`);
  });

  it('最終確定を止める理由も同じ上限で並べる', () => {
    const [issue] = reviewFinalizationIssues({
      pendingPartKeys: keys(25),
      unknownDecisionPartKeys: [],
      duplicateDecisionPartKeys: [],
      truncated: false,
    });
    expect(issue).toContain(`${keys(20).join(', ')} ほか5件`);
  });
});
