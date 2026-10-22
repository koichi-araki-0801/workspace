// =============================================================================
// commonSample.ts — 共通サンプルの行(分類ごとの JSON 断片)を 1 つの sample に合成する
// =============================================================================
// SQL Server 2012 は OPENJSON が使えないので、合成は sproc ではなくここで行う。分類は「どの行が
// どのキーを持つか」を管理する単位で、描画の値の切り替えには使わない。したがって同じトップレベルの
// キーは先の行(ID が小さい方)だけを採り、捨てた側を警告に積む。入れ子の中までは混ぜない。
import type { SampleData } from '@editor/shared';

export interface CommonSampleRow {
  id: number;
  category: string | null;
  major: string | null;
  middle: string | null;
  minor: string | null;
  dataJson: string;
}

/** 警告に出す分類の表示。空の段は省き、全部空なら「全体共通」。 */
function classLabel(r: CommonSampleRow): string {
  const parts = [r.category, r.major, r.middle, r.minor].filter((s): s is string => !!s);
  return parts.length > 0 ? parts.join('/') : '全体共通';
}

function parseTopLevel(json: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function mergeCommonSampleRows(rows: readonly CommonSampleRow[]): {
  sample: SampleData;
  warnings: string[];
} {
  const sample: SampleData = {};
  const owner = new Map<string, CommonSampleRow>();
  const warnings: string[] = [];
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const top = parseTopLevel(r.dataJson);
    if (!top) {
      warnings.push(`共通サンプル(${classLabel(r)})は JSON のオブジェクトでないため使いません。`);
      continue;
    }
    for (const [key, value] of Object.entries(top)) {
      const first = owner.get(key);
      if (first) {
        warnings.push(
          `共通サンプルのキー ${key} が重複しています。${classLabel(first)} の値を使い、` +
            `${classLabel(r)} の値は使いません。`,
        );
        continue;
      }
      owner.set(key, r);
      sample[key] = value;
    }
  }
  return { sample, warnings };
}
