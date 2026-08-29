// =============================================================================
// oracle_sync.test.ts — verify の複製定数/文字幅 drift ガードの単体テスト (vitest)
// =============================================================================
// `assertOracleSync` は `verify/svg.ts`(CLI)の起動時に走るが、それだけだと定数の drift
// (手動同期忘れ)や glyph_advance テーブル未適用を CI が検知できない。ここで
// `verify/oracle_sync.ts` を直接叩き「現状の本体と一致している (= throw しない)」ことを
// 固定する。SVG 出力には一切触れない。
import { describe, expect, it } from 'vitest';
import { assertOracleSync } from '../src/verify/oracle_sync.js';

describe('assertOracleSync', () => {
  it('複製定数/文字幅分類が本体 (config.ts / geometry.ts の visualCharEm) と一致し throw しない', () => {
    expect(() => assertOracleSync()).not.toThrow();
  });
});
