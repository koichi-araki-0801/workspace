// =============================================================================
// htmlBlockDiff.optimize.test.ts — A 最適化(ページスキップ/枝刈り/トークントリム)の
// 出力同一性を担保する回帰テスト
// =============================================================================
// A-3 の `diffTokens` は共通 prefix トリム後に full DP へ渡す。トリム前の素朴な
// full DP(`oldDiffTokens`)と op 列がバイト同一であることを代表コーパス + 決定的乱択で
// 検証する(suffix トリムはタイブレーク差を生むため不採用。本テストがそれを検出した)。
// A-1 の無変更ページスキップは、一部ページだけ変えた複数ページ文書で `buildHtmlDiff` の
// 分類が正しいことを検証する。
import { describe, expect, it } from 'vitest';
import { buildHtmlDiff, type DiffOp, diffTokens, tokenize } from '@/features/compare/htmlBlockDiff';

// ── トリムを行わない素朴な full DP 版。パリティの基準実装。 ──
function oldDiffTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', text: a[i++] });
    } else {
      ops.push({ type: 'ins', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'ins', text: b[j++] });
  return ops;
}

// 決定的 PRNG(mulberry32)。乱択コーパスを再現可能にする。
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('diffTokens parity (A-3 trim)', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['abc', ''],
    ['', 'abc'],
    ['同じ文です', '同じ文です'],
    // 共通 prefix/suffix + 中央変更(トリムが効く代表形)。
    ['売上は 105 パーセント 増加しました', '売上は 112 パーセント 増加しました'],
    ['the quick brown fox', 'the quick red fox'],
    // 全置換(共通なし)。
    ['aaaa', 'bbbb'],
    // 反復トークン(タイブレークが効く)。
    ['a a a a', 'a a a'],
    ['x y x y x', 'x y x'],
  ];

  it('代表コーパスで新旧 op 列が完全一致', () => {
    for (const [s1, s2] of cases) {
      const a = tokenize(s1);
      const b = tokenize(s2);
      expect(diffTokens(a, b).ops).toEqual(oldDiffTokens(a, b));
    }
  });

  it('決定的乱択コーパスで新旧 op 列が完全一致', () => {
    const next = rng(0xc0ffee);
    const alphabet = 'abcd ';
    const randStr = (len: number) =>
      Array.from({ length: len }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    for (let k = 0; k < 2000; k++) {
      const a = tokenize(randStr(Math.floor(next() * 12)));
      const b = tokenize(randStr(Math.floor(next() * 12)));
      expect(diffTokens(a, b).ops).toEqual(oldDiffTokens(a, b));
    }
  });

  it('パリティ対象は上限内(coarse=false)であること', () => {
    // 上のパリティ 2 本が「粗い差分同士の一致」で通ってしまうと無意味になるため、
    // 代表コーパスが full DP を通っていること自体を固定する。
    for (const [s1, s2] of cases) {
      expect(diffTokens(tokenize(s1), tokenize(s2)).coarse).toBe(false);
    }
  });
});

describe('page skip (A-1)', () => {
  // CSS クラス由来の改ページ。各 .page が 1 ページになる。
  const css = '.page { page-break-after: always; }';
  const page = (n: number, body: string) => `<section class="page" id="p${n}">${body}</section>`;
  const build = (pages: string[]) => `<!doctype html><html><body>${pages.join('')}</body></html>`;

  it('一部ページのみ変更 → 変更ページだけ changed、他は same でバイト同一', () => {
    const before = build([
      page(0, '<p>序文</p>'),
      page(1, '<p>金額は 100 万円</p>'),
      page(2, '<p>結び</p>'),
    ]);
    const after = build([
      page(0, '<p>序文</p>'),
      page(1, '<p>金額は 200 万円</p>'),
      page(2, '<p>結び</p>'),
    ]);
    const diff = buildHtmlDiff(before, after, css, css);
    expect(diff.pages).toHaveLength(3);
    expect(diff.changedPageCount).toBe(1);
    // 無変更ページ(高速パス)は全 block same・両ペイン同一。
    for (const i of [0, 2]) {
      expect(diff.pages[i].changed).toBe(false);
      expect(diff.pages[i].blocks.every((b) => b.status === 'same')).toBe(true);
      expect(diff.pages[i].beforeHtml).toBe(diff.pages[i].afterHtml);
    }
    // 変更ページは精密 diff を通り、語句ハイライトが入る。
    expect(diff.pages[1].changed).toBe(true);
    expect(diff.pages[1].afterHtml).toContain('200');
  });

  it('全ページ同一文書は changedPageCount 0(高速パスのみ)', () => {
    const html = build([page(0, '<p>a</p>'), page(1, '<p>b</p>'), page(2, '<p>c</p>')]);
    const diff = buildHtmlDiff(html, html, css, css);
    expect(diff.changedPageCount).toBe(0);
    expect(diff.pages.every((p) => p.blocks.every((b) => b.status === 'same'))).toBe(true);
  });
});
