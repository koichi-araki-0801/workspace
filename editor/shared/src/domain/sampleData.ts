// =============================================================================
// sampleData.ts — 共通ダミー + ファンド固有マスタの合成(プレビュー文脈の組立)
// =============================================================================
// パーツ別共通のダミー(`sampleCommon`)を土台に、ファンド固有値だけを上書きして
// プレビュー/差込用の `SampleData` を組み立てる。固有値は `fund.code/name/nickname`
// と `company.code/name`、版種(`report.editionType`)のみ。これ以外は全ファンドで
// 共通のダミー値になる(パーツのレイアウト・行数が一定になる狙い)。
//
// `web`(local=`funds.json`)と `server`(REST=DB マスタ)の双方から使う純関数。

import type { SampleData } from '../index.js';
import { sampleCommon } from './sampleCommon.js';

/** ファンド固有のマスタ(名称解決の源)。コード以外の名称・会社を持つ。 */
export interface FundMaster {
  /** ファンド名。 */
  name: string;
  /** 愛称(任意)。 */
  nickname?: string;
  /** 委託会社。 */
  company: { code: string; name: string };
}

/** 共通ダミーの深いコピー(呼び出し側の変更が定数へ波及しないように)。 */
function cloneCommon(): SampleData {
  return JSON.parse(JSON.stringify(sampleCommon)) as SampleData;
}

/**
 * 共通ダミーにファンド固有値を上書きした `SampleData` を組み立てる。
 * `master` が無い(未収録ファンド)場合は code のみ差し替え、名称は placeholder のまま。
 * `editionType` を渡すとファイル名由来の版種で `report.editionType` を上書きする。
 */
export function buildSampleData(
  master: FundMaster | undefined,
  fundCode: string,
  editionType?: string,
): SampleData {
  const base = cloneCommon();
  const fund = base.fund as Record<string, unknown>;
  fund.code = fundCode;
  if (master) {
    fund.name = master.name;
    fund.nickname = master.nickname ?? '';
    base.company = { code: master.company.code, name: master.company.name };
  }
  if (editionType) (base.report as Record<string, unknown>).editionType = editionType;
  return base;
}

/**
 * 既存の `SampleData` に版種(ファイル名由来)だけを上書きする。`getSampleData` は
 * ファンド単位(版種を持たない)なので、テンプレを開く文脈(版種が判る)で被せる。
 */
export function applyEdition(sample: SampleData, editionType: string): SampleData {
  const report = (sample.report ?? {}) as Record<string, unknown>;
  return { ...sample, report: { ...report, editionType } };
}
