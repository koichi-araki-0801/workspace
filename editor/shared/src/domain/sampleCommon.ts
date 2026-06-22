// =============================================================================
// sampleCommon.ts — パーツ別共通のダミーサンプルデータ(ファンド非依存)
// =============================================================================
// テンプレート作成・プレビューのダミー値を、ファンドごとではなくパーツ(セクション)
// ごとに共通化する。どのファンドでもパーツのレイアウト・行数が一定になり、値は
// 「123,456」「12.3」のような一目でダミーと分かる連番調にそろえる。ファンド固有値
// (`fund.code/name/nickname` と `company.code/name`)と版種(`report.editionType`)は
// `buildSampleData` が呼び出し側のマスタ/ファイル名で上書きする(本定数は placeholder)。
//
// JSON ではなく TS 定数にするのは、`tsc` が `.json` を dist へ emit せず server から
// import 解決できないため。配列の件数は固定で、折り返し・行数の見た目を安定させる。

import type { SampleData } from '../index.js';

export const sampleCommon: SampleData = {
  // 委託会社。code/name は buildSampleData がマスタで上書きする(placeholder)。
  company: { code: 'AM01', name: 'サンプル委託会社' },
  // ファンド。code/name/nickname は buildSampleData が上書きする(placeholder)。
  // それ以外(category や数値)はパーツ別共通のダミー。
  fund: {
    code: '000000',
    name: 'サンプルファンド',
    nickname: 'サンプル愛称',
    category: '追加型投信／内外／資産複合',
    nav: '12,345',
    netAssets: '123,456',
    returnRate: '12.3',
    distribution: '100',
    redemptionNav: '12,345.67',
  },
  // 商品概要。category/方針などはパーツ別共通のダミー文。
  product: {
    category: '追加型投信／内外／資産複合',
    trustPeriod: '2020年1月1日から無期限',
    policy: '投資信託財産の中長期的な成長を目指して運用を行います。',
    mainTarget: 'サンプルマザーファンド',
    distributionPolicy:
      '毎決算時に委託会社が基準価額水準・市況動向などを勘案して分配金額を決定します。',
    investmentLimit: '投資信託証券への投資割合に制限を設けません。株式への直接投資は行いません。',
  },
  // 帳票期。editionType は buildSampleData がファイル名の版種で上書きする(placeholder)。
  report: {
    editionType: '交付版',
    term: '第1期',
    settlementDate: '2025年12月31日',
    period: '2025年1月1日～2025年12月31日',
    termStartNav: '12,000',
    termEndNav: '12,345',
    redemptionDate: '2026年3月31日',
  },
  // 主要投資対象(ループ用・固定3件)。
  mainAssets: [
    { name: 'サンプル マザーファンド1' },
    { name: 'サンプル マザーファンド2' },
    { name: 'サンプル マザーファンド3' },
  ],
  // 基準価額の推移(折れ線用・固定6点)。
  navHistory: [
    { label: '25/1', nav: '12,000' },
    { label: '25/3', nav: '12,100' },
    { label: '25/5', nav: '12,200' },
    { label: '25/7', nav: '12,250' },
    { label: '25/9', nav: '12,300' },
    { label: '25/12', nav: '12,345' },
  ],
  // 組入上位銘柄(表用・固定5件)。country は債券系、asset/ret は資産複合系テンプレが参照。
  holdings: [
    { name: 'サンプル銘柄1', asset: '国内株式', country: '日本', weight: '12.3', ret: '1.2' },
    { name: 'サンプル銘柄2', asset: '先進国株式', country: 'アメリカ', weight: '10.0', ret: '2.3' },
    { name: 'サンプル銘柄3', asset: '先進国債券', country: 'イギリス', weight: '8.0', ret: '3.4' },
    { name: 'サンプル銘柄4', asset: '新興国株式', country: 'その他', weight: '6.0', ret: '4.5' },
    { name: 'サンプル銘柄5', asset: 'コモディティ', country: '日本', weight: '4.0', ret: '5.6' },
  ],
  // 資産配分(円グラフ用・固定4件)。
  allocation: [
    { name: '国内株式', weight: '30.0' },
    { name: '先進国株式', weight: '30.0' },
    { name: '国内債券', weight: '20.0' },
    { name: '先進国債券', weight: '20.0' },
  ],
  // 通貨別配分(債券系テンプレ用・固定4件)。
  currencyAllocation: [
    { name: '米ドル', weight: '40.0' },
    { name: 'ユーロ', weight: '30.0' },
    { name: '円', weight: '20.0' },
    { name: 'その他', weight: '10.0' },
  ],
  // 国別配分(債券系テンプレ用・固定4件)。
  countryAllocation: [
    { name: 'アメリカ', weight: '40.0' },
    { name: 'イギリス', weight: '30.0' },
    { name: 'ドイツ', weight: '20.0' },
    { name: 'その他', weight: '10.0' },
  ],
  // 騰落率の推移(表用・固定3件)。
  performance: [
    { period: '1ヶ月', return: '1.2' },
    { period: '6ヶ月', return: '6.5' },
    { period: '1年', return: '12.3' },
  ],
  // 分配金の推移(毎月決算系テンプレ用・固定3件)。
  distributions: [
    { term: '第1期', date: '2025/4/30', amount: '10' },
    { term: '第2期', date: '2025/8/31', amount: '10' },
    { term: '第3期', date: '2025/12/31', amount: '10' },
  ],
  // 費用明細(表用・固定3件)と合計。
  costs: [
    { item: '(a) 信託報酬', amount: '123', rate: '1.234' },
    { item: '(b) 売買委託手数料', amount: '12', rate: '0.123' },
    { item: '(c) その他費用', amount: '1', rate: '0.012' },
  ],
  costTotal: { amount: '136', rate: '1.369' },
  commentary:
    '当期の基準価額は、各資産の値動きを反映してサンプルの水準で推移しました。本文はパーツ別共通のダミーテキストです。実データはファンドごとに差し替えてご利用ください。',
};
