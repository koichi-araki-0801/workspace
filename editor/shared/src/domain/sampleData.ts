// =============================================================================
// sampleData.ts — 共通ダミー + ファンド固有マスタの合成(プレビュー文脈の組立)
// =============================================================================
// パーツ別共通のダミー(`sampleCommon`)を土台に、ファンド固有値だけを上書きして
// プレビュー/差込用の `SampleData` を組み立てる。固有値は `fund.code/name/nickname`
// と `company.code/name`、テンプレ属性(`report.editionType`/`report.baseDate`)のみ。
// これ以外は全ファンドで共通のダミー値になる(パーツのレイアウト・行数が一定になる狙い)。
//
// `web`(local=`funds.json`)と `server`(REST=DB マスタ)の双方から使う純関数。

import type { SampleData, TemplateAttributes } from '../index.js';
import { sampleCommon } from './sampleCommon.js';
import { formatBaseDate } from './template.js';

/** ファンド固有のマスタ(名称解決の源)。コード以外の名称・会社を持つ。 */
export interface FundMaster {
  /** ファンド名。 */
  name: string;
  /** 愛称(任意)。 */
  nickname?: string;
  /** 委託会社。 */
  company: { code: string; name: string };
}

/**
 * ファイル名由来でサンプルへ被せるテンプレ属性の部分集合。版種と基準日はファンド単位の
 * サンプル(`getSampleData` / `sampleCommon`)が持たない・持てない値で、テンプレを開く
 * 文脈でだけ判る。
 */
export type SampleTemplateAttributes = Pick<TemplateAttributes, 'editionType' | 'baseDate'>;

/** 共通ダミーの深いコピー(呼び出し側の変更が定数へ波及しないように)。 */
function cloneCommon(): SampleData {
  return JSON.parse(JSON.stringify(sampleCommon)) as SampleData;
}

/**
 * 共通ダミーにファンド固有値を上書きした `SampleData` を組み立てる。
 * `master` が無い(未収録ファンド)場合は code のみ差し替え、名称は placeholder のまま。
 * `attributes` を渡すとファイル名由来の版種・基準日で report を上書きする。
 */
export function buildSampleData(
  master: FundMaster | undefined,
  fundCode: string,
  attributes?: SampleTemplateAttributes,
): SampleData {
  const base = cloneCommon();
  const fund = base.fund as Record<string, unknown>;
  fund.code = fundCode;
  if (master) {
    fund.name = master.name;
    fund.nickname = master.nickname ?? '';
    base.company = { code: master.company.code, name: master.company.name };
  }
  return attributes ? applyTemplateAttributes(base, attributes) : base;
}

/**
 * 既存の `SampleData` にファイル名由来のテンプレ属性(版種・基準日)を上書きする。
 * `getSampleData` はファンド単位(版種・基準日を持たない)なので、テンプレを開く文脈
 * (属性が判る)で被せる。基準日は帳票の表示形式へ整形して `report.baseDate` に入れる
 * (テンプレは `{{ report.baseDate }}` を地の文として差し込む)。
 */
export function applyTemplateAttributes(
  sample: SampleData,
  attrs: SampleTemplateAttributes,
): SampleData {
  const report = (sample.report ?? {}) as Record<string, unknown>;
  return {
    ...sample,
    report: {
      ...report,
      editionType: attrs.editionType,
      baseDate: formatBaseDate(attrs.baseDate),
    },
  };
}
