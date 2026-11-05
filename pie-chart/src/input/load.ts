// =============================================================================
// input/load.ts — 入力データの取得と正規化
// -----------------------------------------------------------------------------
// 入力ソースは 3 系統:
//   - sample        : samples.json 内の名前指定
//   - data          : [name, value][] / {name, value}[] の配列直渡し
//   - dataJson      : 同形式の JSON 文字列
// ストアド(DB)入力は `input/sproc.ts` が取得し、CLI がここの `normalizeInputItems` へ渡す。
// =============================================================================

import { parseDecimalText } from './number.js';
import samplesData from '../../samples.json' with { type: 'json' };
import type { Item, Samples } from '../types.js';
import { MAX_JSON_BYTES, MAX_LABEL_CHARS, assertLabelXmlSafe } from '../limits.js';
// ── 1. 正規化と解決 (公開 API) ────────────────────────────────────────────────────────────
const samples = samplesData as unknown as Samples;
export { samples };

interface ResolveSyncOpts {
  sample?: string;
  data?: unknown[];
  dataJson?: string;
}

/**
 * 非同期入力ソースの discriminated union。kind ごとに必要なフィールドが型レベルで揃うので、
 * `opts.sample!` のような非 null 断定を排除できる。CLI 等の入口で「どの入力か」を選んだ時点で
 * 確定する。
 */
export type ResolveAsyncOpts =
  | { kind: 'sample'; sample: string }
  | { kind: 'data'; data: unknown[] }
  | { kind: 'dataJson'; dataJson: string };

/**
 * 任意形式の項目リストを {name, value} 配列に正規化する。
 * 配列要素は [name, value] タプル形式と {name, value} オブジェクト形式の両方を許容。
 */
export function normalizeInputItems(rawItems: unknown): Item[] {
  if (!Array.isArray(rawItems)) {
    throw new Error('Input data must be an array.');
  }
  // 幅計算(`visualMaxEm`)は 1 文字ずつ加算するループで、配置カスケードの内側から
  // 何度も呼ばれる。切り詰めると出力が黙って変わるのでエラーにする(分類: 明示エラー)。
  const checkName = (name: string): string => {
    if (name.length > MAX_LABEL_CHARS) {
      throw new Error(
        `Label is ${name.length} characters (limit ${MAX_LABEL_CHARS}). ` +
          'Shorten it, or raise the limit with PIE_MAX_LABEL_CHARS=<n>.',
      );
    }
    // 全入力経路 + normalizeInputItems 直叩きをここ 1 箇所で覆う。
    assertLabelXmlSafe(name);
    return name;
  };
  // name は文字列か数値だけを受理する。`String()` に任せると null が "null"、真偽値が "true"、
  // オブジェクトが "[object Object]" という名前のスライスになる。欠落(null / undefined /
  // 空文字 / 空白のみ)は DB 経路の `Empty name at row N` と同じく明示エラーにする。
  const toName = (raw: unknown, index: number): string => {
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      throw new Error(`Empty name at item ${index + 1}.`);
    }
    if (typeof raw === 'string') {
      return checkName(raw);
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return checkName(String(raw));
    }
    throw new Error(`Invalid name at item ${index + 1} (got ${JSON.stringify(raw)}).`);
  };
  // value は有限の数値か、10 進の数値文字列だけを受理する。`Number()` に任せると、読めない値は
  // NaN のまま配置計算を走り切り(全項目 0.0%・幅ゼロスライスの SVG が例外なしで出る)、
  // 欠落(null / 空文字 / 空白のみ)・`[]`・`false` は 0 に、`true` は 1 になって、明示された
  // `0` と区別の付かないスライスとして無警告で帳票に載る(分類: 明示エラー)。
  const checkValue = (name: string, raw: unknown): number => {
    const value =
      typeof raw === 'number'
        ? Number.isFinite(raw)
          ? raw
          : null
        : typeof raw === 'string'
          ? parseDecimalText(raw, false)
          : null;
    if (value === null) {
      throw new Error(`Non-numeric value for "${name}" (got ${JSON.stringify(raw)}).`);
    }
    return value;
  };
  return rawItems.map((item: unknown, index): Item => {
    if (Array.isArray(item) && item.length >= 2) {
      const name = toName(item[0], index);
      return { name, value: checkValue(name, item[1]) };
    }
    if (typeof item === 'object' && item !== null && 'name' in item && 'value' in item) {
      const obj = item as { name: unknown; value: unknown };
      const name = toName(obj.name, index);
      return { name, value: checkValue(name, obj.value) };
    }
    throw new Error('Each item must be {name, value} or [name, value].');
  });
}

/**
 * 同期版: sample / data / dataJson のいずれか 1 つを必須とする。
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
    // 上限の単位は byte なので byte で測る(`readJsonFile` と同じ)。`String.length` は UTF-16
    // コード単位数で、日本語だけの JSON は実バイト数の約 1/3 にしか見えず、上限が名前どおりに
    // 効かない。
    const byteLength = Buffer.byteLength(dataJson, 'utf-8');
    if (byteLength > MAX_JSON_BYTES) {
      throw new Error(
        `dataJson is ${byteLength} bytes (limit ${MAX_JSON_BYTES}). ` +
          'Raise the limit with PIE_MAX_JSON_BYTES=<n> if this input is expected.',
      );
    }
    return normalizeInputItems(JSON.parse(dataJson));
  }
  throw new Error('Provide one of: sample, data, dataJson.');
}

/**
 * 非同期版: kind ごとに resolveInputData へ同等のオプションで委譲する。
 */
export async function resolveInputDataAsync(opts: ResolveAsyncOpts): Promise<Item[]> {
  switch (opts.kind) {
    case 'sample':
      return resolveInputData({ sample: opts.sample });
    case 'data':
      return resolveInputData({ data: opts.data });
    case 'dataJson':
      return resolveInputData({ dataJson: opts.dataJson });
  }
}
