// =============================================================================
// data.ts — 入力データの正規化と解決 (graph/data.js の TS 移植)
// -----------------------------------------------------------------------------
// 入力ソースは 5 系統:
//   - sample        : samples.json 内の名前指定
//   - data          : [name, value][] / {name, value}[] の配列直渡し
//   - dataJson      : 同形式の JSON 文字列
//   - xlsx          : Excel ファイル(xlsx_loader 経由・非同期のみ)
//   - sql           : SQL Server に SELECT を投げて取得(db_loader 経由・非同期のみ)
// resolveInputData (同期) は xlsx / sql を扱えない。これらを含めて統一的に扱いたい
// 場合は resolveInputDataAsync を使う。
// =============================================================================

import { loadDbItems } from './db_loader.js';
import samplesData from '../samples.json' with { type: 'json' };
import { loadXlsxItems } from './xlsx_loader.js';
import type { Item, Samples } from './types.js';

const samples = samplesData as unknown as Samples;
export { samples };

export interface ResolveSyncOpts {
  sample?: string;
  data?: unknown[];
  dataJson?: string;
}

/**
 * 非同期入力ソースの discriminated union。kind ごとに必要なフィールドが型レベルで揃うので、
 * `opts.sheet!` のような非 null 断定を排除できる。CLI 等の入口で「どの入力か」を選んだ時点で
 * 確定する。
 */
export type ResolveAsyncOpts =
  | { kind: 'sample'; sample: string }
  | { kind: 'data'; data: unknown[] }
  | { kind: 'dataJson'; dataJson: string }
  | { kind: 'xlsx'; xlsx: string; sheet: string; range: string }
  | {
      kind: 'sql';
      query: string;
      server?: string;
      database?: string;
      nameColumn?: string;
      valueColumn?: string;
    };

/**
 * 任意形式の項目リストを {name, value} 配列に正規化する。
 * 配列要素は [name, value] タプル形式と {name, value} オブジェクト形式の両方を許容。
 */
export function normalizeInputItems(rawItems: unknown): Item[] {
  if (!Array.isArray(rawItems)) {
    throw new Error('Input data must be an array.');
  }
  return rawItems.map((item: unknown): Item => {
    if (Array.isArray(item) && item.length >= 2) {
      return { name: String(item[0]), value: Number(item[1]) };
    }
    if (typeof item === 'object' && item !== null && 'name' in item && 'value' in item) {
      const obj = item as { name: unknown; value: unknown };
      return { name: String(obj.name), value: Number(obj.value) };
    }
    throw new Error('Each item must be {name, value} or [name, value].');
  });
}

/**
 * 同期版: sample / data / dataJson のいずれか 1 つを必須とする。
 * Excel 入力(xlsx)はここでは扱えない(非同期版を使うこと)。
 */
export function resolveInputData({ sample, data, dataJson }: ResolveSyncOpts): Item[] {
  if (sample) {
    if (!samples[sample]) {
      throw new Error(`Unknown sample: ${sample}`);
    }
    return normalizeInputItems(samples[sample].items);
  }
  if (data) {
    return normalizeInputItems(data);
  }
  if (dataJson) {
    return normalizeInputItems(JSON.parse(dataJson));
  }
  throw new Error('Provide one of: sample, data, dataJson.');
}

/**
 * 非同期版: kind ごとに分岐する。xlsx / sql 以外は resolveInputData に同等のオプションで委譲。
 * CLI 等の入口で「Excel・DB もそれ以外も同じ呼び方にしたい」用途向け。
 */
export async function resolveInputDataAsync(opts: ResolveAsyncOpts): Promise<Item[]> {
  switch (opts.kind) {
    case 'xlsx': {
      const raw = await loadXlsxItems({
        path: opts.xlsx,
        sheet: opts.sheet,
        range: opts.range,
      });
      return normalizeInputItems(raw);
    }
    case 'sql': {
      const raw = await loadDbItems({
        query: opts.query,
        server: opts.server,
        database: opts.database,
        nameColumn: opts.nameColumn,
        valueColumn: opts.valueColumn,
      });
      return normalizeInputItems(raw);
    }
    case 'sample':
      return resolveInputData({ sample: opts.sample });
    case 'data':
      return resolveInputData({ data: opts.data });
    case 'dataJson':
      return resolveInputData({ dataJson: opts.dataJson });
  }
}
