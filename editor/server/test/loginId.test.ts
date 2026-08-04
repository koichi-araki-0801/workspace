// =============================================================================
// loginId.test.ts — ログインID 正規形の表駆動テスト
// =============================================================================
// 正規形は「レート制限のキー」と「sproc の引数」の両方へ同じ値が渡ることが前提の設計で、
// DB 側の照合順序(`NVARCHAR(64) COLLATE Japanese_CI_AS` = 大小/幅を無視・末尾空白を
// パディングして比較・65 文字目以降は切り詰め)と一致していなければならない。
// ここでズレると、DB では同じ 1 行に当たる入力が JS では別キーになり、1 アカウントに
// 対して独立した失敗カウンタをいくつでも作れる。
import { describe, expect, it } from 'vitest';
import { canonicalLoginId, LOGIN_ID_MAX_LENGTH } from '../src/auth/loginId.js';

describe('canonicalLoginId', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['admin', 'admin', 'そのまま'],
    ['ADMIN', 'admin', 'CI: 大文字小文字を畳む'],
    ['AdMiN', 'admin', 'CI: 混在も畳む'],
    ['admin   ', 'admin', '末尾空白は = 比較でパディングされるので落とす'],
    ['ａｄｍｉｎ', 'admin', 'width-insensitive: 全角英字は NFKC で畳む'],
    ['admin　', 'admin', '全角空白も NFKC で半角化してから落とす'],
    ['ADMIN０', 'admin0', '全角数字も畳む'],
    ['ﬁle', 'file', 'NFKC の合字展開'],
  ];

  for (const [raw, expected, why] of cases) {
    it(`folds ${JSON.stringify(raw)} into ${JSON.stringify(expected)} (${why})`, () => {
      expect(canonicalLoginId(raw)).toBe(expected);
    });
  }

  // DB は 65 文字目以降を切り詰めるので、そこだけ違う 2 つは同じ行に当たる。
  // 「別キーになる」実装だと、長い ID を送り分けるだけでレート制限を無限に割れる。
  it('truncates at the database column width so long ids collapse together', () => {
    const long = 'a'.repeat(LOGIN_ID_MAX_LENGTH);
    expect(canonicalLoginId(`${long}b`)).toBe(long);
    expect(canonicalLoginId(`${long}zzzz`)).toBe(canonicalLoginId(`${long}b`));
  });

  // 検証前に巨大な username が届いても、正規化のコストが入力長に比例してはいけない
  // (`LoginRequest.username` に長さ制約は無く、実効上限はボディ上限の 8MB)。
  it('bounds the work regardless of how long the raw input is', () => {
    const huge = `admin${'x'.repeat(2_000_000)}`;
    const started = performance.now();
    const out = canonicalLoginId(huge);
    expect(out.length).toBeLessThanOrEqual(LOGIN_ID_MAX_LENGTH);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('never returns something longer than the column width', () => {
    // NFKC は合字展開で伸びうるので、畳んだ後にも上限が効いていること。
    expect(canonicalLoginId('ﬁ'.repeat(LOGIN_ID_MAX_LENGTH)).length).toBe(LOGIN_ID_MAX_LENGTH);
  });
});
