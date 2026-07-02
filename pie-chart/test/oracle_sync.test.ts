// =============================================================================
// oracle_sync.test.ts — verify の複製定数/文字幅 drift ガードの単体テスト (vitest)
// =============================================================================
// `assertOracleSync` は従来 `verify_svg.ts` のモジュール冒頭でのみ走り、CI(typecheck+test)
// には入っていなかった。定数の drift(手動同期忘れ)や glyph_advance テーブル未適用を CI で
// 機械検知できるよう、抽出した `oracle_sync.ts` を直接叩いて「現状の本体と一致している
// (= throw しない)」ことを固定する。SVG 出力には一切触れない。
import { describe, expect, it } from 'vitest';
import { assertOracleSync } from '../src/oracle_sync.js';

describe('assertOracleSync', () => {
  it('複製定数/文字幅分類が本体 (config.ts / svg_geom.visualCharEm) と一致し throw しない', () => {
    expect(() => assertOracleSync()).not.toThrow();
  });
});
