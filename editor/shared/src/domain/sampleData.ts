// =============================================================================
// sampleData.ts — 共通サンプルに Rep1 の実名を被せる(プレビュー文脈の組立)
// =============================================================================
// 全ファンド共通の値(server では DB の共通サンプル、local では `sampleCommon`)を土台に、
// Rep1 から引いた実名だけを上書きして、プレビュー/差込用の `SampleData` を組み立てる。
// 被せる先は `SampleOverlayKeys` のパス(既定 `fund.code` など)で、共通値側の変数名に
// editor が依存しないよう設定で差し替えられる。版種・基準日は `applyTemplateAttributes`。
//
// `web`(local=`funds.json`)と `server`(REST=Rep1 の委託会社・ファンド一覧)の双方から使う純関数。

import type { SampleData, TemplateAttributes } from '../index.js';
import { formatBaseDate } from './template.js';

/** Rep1 から引いた実名。引けなかった項目は undefined のまま残し、共通値を活かす。 */
export interface FundMaster {
  /** ファンド名。 */
  fundName?: string;
  /** 委託会社コード(ファイル名の会社コード = Rep1 の委託会社略称)。 */
  companyCode?: string;
  /** 委託会社名。 */
  companyName?: string;
}

/** 実名を置く先のパス(ドット区切り)。 */
export type SampleOverlayKeys = {
  fundCode: string;
  fundName: string;
  companyCode: string;
  companyName: string;
};

/** 既定の被せ先。共通サンプルの変数名(`fund.code` など)に合わせる。 */
export const DEFAULT_SAMPLE_OVERLAY_KEYS: SampleOverlayKeys = {
  fundCode: 'fund.code',
  fundName: 'fund.name',
  companyCode: 'company.code',
  companyName: 'company.name',
};

/**
 * ファイル名由来でサンプルへ被せるテンプレ属性の部分集合。版種と基準日はテンプレを開く
 * 文脈でだけ判る値で、共通サンプルは持たない。テンプレート(基準日を持たない)を開く
 * 文脈では基準日は無い。
 */
export type SampleTemplateAttributes = Pick<TemplateAttributes, 'editionType' | 'baseDate'>;

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** ドット区切りのパスへ値を置く。途中が object でなければ作る。原型汚染になる語を含むパスは無視する。 */
function setPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split('.');
  if (segments.some((s) => s === '' || FORBIDDEN_SEGMENTS.has(s))) return;
  let cur = root;
  for (const seg of segments.slice(0, -1)) {
    const next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1] as string] = value;
}

/**
 * 共通サンプル(`base`)を複製し、ファンドコードと Rep1 の実名を `keys` のパスへ置いた
 * `SampleData` を返す。`master` が無い・項目が欠ける場合、その項目は共通値のまま。
 * 愛称は Rep1 に無いので被せない。
 */
export function buildSampleData(
  base: SampleData,
  master: FundMaster | undefined,
  fundCode: string,
  keys: SampleOverlayKeys = DEFAULT_SAMPLE_OVERLAY_KEYS,
): SampleData {
  const out = JSON.parse(JSON.stringify(base)) as SampleData;
  setPath(out, keys.fundCode, fundCode);
  if (master?.fundName !== undefined) setPath(out, keys.fundName, master.fundName);
  if (master?.companyCode !== undefined) setPath(out, keys.companyCode, master.companyCode);
  if (master?.companyName !== undefined) setPath(out, keys.companyName, master.companyName);
  return out;
}

/**
 * 既存の `SampleData` にファイル名由来のテンプレ属性(版種・基準日)を上書きする。
 * `getSampleData` は版種・基準日を持たないので、テンプレを開く文脈(属性が判る)で被せる。
 * 基準日は帳票の表示形式へ整形して `report.baseDate` に入れる
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
      // テンプレート(基準日を持たない)を開いているときは、共通サンプルの基準日を差し込み値として残す。
      ...(attrs.baseDate === undefined ? {} : { baseDate: formatBaseDate(attrs.baseDate) }),
    },
  };
}
