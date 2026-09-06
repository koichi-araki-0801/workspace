// =============================================================================
// syntheticCases.ts — render_hash 系テストが共有する合成入力 (サンプル外の入力分布)
// =============================================================================
// スライス数 2〜14 × 名前の長短 × 「その他」有無 + 特殊形 (1強/等分/長単語) の決定的な合成入力。
// `render_hash.test.ts` (軽い 24 ケース) と `render_hash_long.test.ts` (重い 2 ケース) が同じ
// 生成器から取るため、ケースの定義はここ 1 箇所に置く。名前・値を 1 つでも変えると SVG の
// SHA256 (`renderHashExpected.ts`) が動くので、変更は期待値の意図的な更新とセットで行う。
// =============================================================================

const SHORT_NAMES = [
  '円',
  '米ドル',
  'ユーロ',
  '英ポンド',
  '豪ドル',
  '加ドル',
  'スイスフラン',
  '香港ドル',
  '株式',
  '債券',
  '現金',
  'REIT',
  '先物',
  '預金',
] as const;

const LONG_NAMES = [
  'スウェーデンクローナ',
  'ニュージーランド・ドル',
  'オフショア人民元',
  '海外不動産投資信託',
  'ノルウェークローネ',
  '為替ヘッジ付資産',
  'シンガポールドル',
  'インドネシアルピア',
  'メキシコペソ',
  '南アフリカランド',
  'ブラジルレアル',
  'デンマーククローネ',
  'ポーランドズロチ',
  'ハンガリーフォリント',
] as const;

export interface Slice {
  name: string;
  value: number;
}

/**
 * n スライスの決定的な合成入力。値は逓減列 (先頭が大きく末尾が小さい) で、小スライス帯
 * (isSmall/isTiny) を必ず含むように減衰させる。withOther は末尾を「その他」へ置換する。
 */
function makeItems(n: number, style: 'short' | 'long', withOther: boolean): Slice[] {
  const names = style === 'short' ? SHORT_NAMES : LONG_NAMES;
  const items: Slice[] = [];
  let remaining = 100;
  for (let i = 0; i < n; i += 1) {
    // 先頭は残りの 45%、以降も残りの 45% ずつ取る逓減列。末尾は残り全部 (合計 100)。
    const value = i === n - 1 ? remaining : Math.round(remaining * 0.45 * 10) / 10;
    items.push({ name: names[i % names.length], value: Math.round(value * 10) / 10 });
    remaining = Math.round((remaining - value) * 10) / 10;
  }
  if (withOther) items[n - 1] = { ...items[n - 1], name: 'その他' };
  return items;
}

/** 合成ケース一覧 (名前 → 入力)。順序・内容とも決定的。 */
export function syntheticCases(): Record<string, Slice[]> {
  const cases: Record<string, Slice[]> = {};
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]) {
    for (const style of ['short', 'long'] as const) {
      // 「その他」はスライス数が偶数のケースにだけ入れて両パターンを網羅する。
      cases[`gen_${style}_${n}${n % 2 === 0 ? '_other' : ''}`] = makeItems(n, style, n % 2 === 0);
    }
  }
  // 特殊形: 1強 (≥90%)・1強 (80–90%)・等分・長カタカナ単一語ペア。mark*** 系のドミナント帯
  // (<80 / 80–90 / <90) と等分系の境界を跨ぐ。
  cases.gen_dominant_92 = [
    { name: '国内株式', value: 92 },
    { name: '先物', value: 5 },
    { name: 'その他', value: 3 },
  ];
  cases.gen_dominant_85 = [
    { name: '国内債券', value: 85 },
    { name: '現金', value: 9 },
    { name: 'その他', value: 6 },
  ];
  cases.gen_equal_4 = [
    { name: '株式', value: 25 },
    { name: '債券', value: 25 },
    { name: 'REIT', value: 25 },
    { name: '現金', value: 25 },
  ];
  cases.gen_long_pair = [
    { name: 'スウェーデンクローナ', value: 55 },
    { name: 'ハンガリーフォリント', value: 45 },
  ];
  return cases;
}

/**
 * 配置計算が突出して重いケース (n=12 の長名)。`render_hash_long.test.ts` だけが描画し、
 * `render_hash.test.ts` は除外する。`gen_long_14_other` は正規化で値 0 の 2 項目が落ちて
 * `gen_long_12_other` と同一入力になるため、重さもハッシュも同じ。
 */
export const LONG_CASE_NAMES: readonly string[] = ['gen_long_12_other', 'gen_long_14_other'];
