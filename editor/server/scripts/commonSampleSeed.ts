// =============================================================================
// commonSampleSeed.ts — 共通サンプルの seed の行(検証用)
// =============================================================================
// `sampleCommon` のトップレベルのキーを、パーツカタログ seed の分類へ割り振る。同じキーを持つ行は
// 1 つだけ(合成は先勝ちで、重複は警告になる)。本番へは入れない: 本番の値は運用側が本番の変数名で
// 登録する。`gen-seed.ts` が SQL にし、テストが「合成すると `sampleCommon` に戻る」ことを確かめる。
import { type SampleData, sampleCommon } from '@editor/shared';

export interface CommonSampleSeedRow {
  category: string | null;
  major: string | null;
  middle: string | null;
  minor: string | null;
  data: SampleData;
}

/** 分類 4 段 → 持たせるトップレベルのキー。null 4 つは全体共通。 */
const ASSIGNMENTS: readonly {
  cls: readonly [string | null, string | null, string | null, string | null];
  keys: readonly string[];
}[] = [
  { cls: [null, null, null, null], keys: ['company', 'fund', 'report', 'commentary'] },
  { cls: ['ファンドの仕組み', '商品概要', '商品概要の表', '標準'], keys: ['product'] },
  {
    cls: ['ファンドの仕組み', '主要運用対象', '主要運用対象の一覧', '標準'],
    keys: ['mainAssets'],
  },
  { cls: ['運用経過の説明', '基準価額等の推移', '推移グラフ', '標準'], keys: ['navHistory'] },
  { cls: ['運用経過の説明', '期間別騰落率', '騰落率の表', '標準'], keys: ['performance'] },
  { cls: ['運用経過の説明', '分配金の推移', '分配金の表', '標準'], keys: ['distributions'] },
  { cls: ['投資対象ファンドの状況', '資産配分', '配分の表', '標準'], keys: ['allocation'] },
  { cls: ['当ファンドのデータ', '組入上位銘柄', '銘柄の表', '標準'], keys: ['holdings'] },
  {
    cls: ['当ファンドのデータ', '通貨別配分', '配分の表', '標準'],
    keys: ['currencyAllocation'],
  },
  { cls: ['当ファンドのデータ', '国別配分', '配分の表', '標準'], keys: ['countryAllocation'] },
  { cls: ['費用および運用コメント', '費用明細', '費用の表', '標準'], keys: ['costs', 'costTotal'] },
];

export const COMMON_SAMPLE_SEED_ROWS: readonly CommonSampleSeedRow[] = ASSIGNMENTS.map(
  ({ cls, keys }) => ({
    category: cls[0],
    major: cls[1],
    middle: cls[2],
    minor: cls[3],
    data: Object.fromEntries(keys.map((k) => [k, sampleCommon[k]])),
  }),
);
