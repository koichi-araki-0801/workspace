// =============================================================================
// render_hash.test.ts — サンプル外の合成入力に対する SVG ハッシュ固定 (特性テスト)
// =============================================================================
// byte-diff (out/_baseline) は samples.json の入力分布しか守らない。mark*** 系ゲートの
// リファクタで「既存サンプルは不変だが未収録の入力で誤発火する」穴を狭めるため、
// スライス数 2〜14 × 名前の長短 × 「その他」有無 + 特殊形 (1強/等分/長単語) の決定的な
// 合成入力を描画し、SVG の SHA256 をスナップショットへ固定する。
// スナップショット更新 (-u) は挙動変更を意図した時だけ許される。
// =============================================================================

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';

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

interface Slice {
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
function syntheticCases(): Record<string, Slice[]> {
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

describe('合成入力の SVG ハッシュ固定 (サンプル外の入力分布)', () => {
  // timeout はルート `vitest run --coverage`(pre-push CI) 併走時の実測を余裕込みで収める値
  // (`final_score.test.ts` と同趣旨)。
  //
  // 2026-08-08 に 300s から拡大した。単独実行は ~172s だが、ルート CI は 5 プロジェクトを
  // 並列に回すため実測で 356s / 463s まで伸び、**上限を超えて落ちた**(しかも道連れで
  // カバレッジ収集が `Unexpected end of JSON input` になり、原因が分かりにくい形で CI が
  // 赤くなる)。ここは配置計算そのものが重い決定的テストで、遅いこと自体は退行ではないので、
  // 上限を並行負荷の実測に合わせる(前例: `leader_invariants` の per-sample timeout 拡大 4d5cbd4)。
  it('全合成ケースの SHA256 がスナップショットと一致する', { timeout: 900_000 }, async () => {
    const hashes: Record<string, string> = {};
    for (const [name, items] of Object.entries(syntheticCases())) {
      const { svg } = await renderPdfStylePieToSvg(items, {});
      hashes[name] = createHash('sha256').update(svg).digest('hex');
    }
    expect(hashes).toMatchSnapshot();
  });
});
