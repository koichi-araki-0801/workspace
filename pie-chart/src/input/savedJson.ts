// =============================================================================
// input/savedJson.ts — DB から取得した結果を samples 形式の JSON で残す・読み戻す
// =============================================================================
// 取得結果を残すのは、DB に接続できない場所でも同じ図を描き直せるようにするためと、
// `samples.json` へ項目を足すときに貼るだけで済ませるため。形は `samples.json` の 1 項目
// (`{ "<名前>": { description, items } }`)にそろえる。`source` は人が読む記録で、
// 読み戻すときは使わない。`items` には正規化した後の値を入れるので、読み戻して描いた SVG は
// DB から描いた SVG と byte 単位で一致する。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

import type { Item } from '../types.js';
import { formatBaseDateIso, type SprocArgs } from './sprocArgs.js';

interface SavedSource {
  fund: string;
  /** `YYYYMMDD`。 */
  baseDate: string;
  chartType: string;
  /** 取得したローカル時刻(オフセット付き ISO 8601)。 */
  fetchedAt: string;
  server: string;
  database: string;
  proc: string;
}

interface SavedEntry {
  description: string;
  source: SavedSource;
  items: Item[];
}

/** 項目のキー。`samples.json` の他の項目と並べても衝突しにくい、取得条件そのものにする。 */
export function savedEntryKey(args: SprocArgs): string {
  return `${args.fund}_${args.baseDate}_${args.chartType}`;
}

/** ローカル時刻をオフセット付きの ISO 8601 で書く(`toISOString` は UTC に寄せてしまう)。 */
export function formatLocalIso(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function buildSavedJson(
  args: SprocArgs,
  items: Item[],
  conn: { server: string; database: string; proc: string },
  fetchedAt: Date,
): Record<string, SavedEntry> {
  const at = formatLocalIso(fetchedAt);
  return {
    [savedEntryKey(args)]: {
      description:
        `ファンド ${args.fund} / 基準日 ${formatBaseDateIso(args.baseDate)} / ` +
        `種別 ${args.chartType} / 取得 ${at}`,
      source: {
        fund: args.fund,
        baseDate: args.baseDate,
        chartType: args.chartType,
        fetchedAt: at,
        server: conn.server,
        database: conn.database,
        proc: conn.proc,
      },
      items: items.map(({ name, value }) => ({ name, value })),
    },
  };
}

/** 親フォルダを作ってから書く。同じ名前のファイルは上書きする(SVG と同じ扱い)。 */
export function writeSavedJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * 既定の出力先: `--output-file` の拡張子を `.json` に替えたもの。`--output-file` 自体が
 * `.json` だと同じパスになり SVG を上書きするので、出力先の指定を求めて止める。
 */
export function defaultSavedJsonPath(outputFile: string): string {
  const parsed = path.parse(outputFile);
  const candidate = path.join(parsed.dir, `${parsed.name}.json`);
  if (path.resolve(candidate) === path.resolve(outputFile)) {
    throw new Error(
      `--output-file "${outputFile}" ends with .json, so the fetched data would overwrite it; ` +
        'pass --save-json <path>.',
    );
  }
  return candidate;
}

/**
 * データファイルの中身から項目の配列を取り出す。配列なら従来の形式、オブジェクトなら
 * samples 形式とみなす。samples 形式で項目が複数あると、どれを描くか決められないので止める。
 */
export function extractDataItems(parsed: unknown, label: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new Error(
        `${label} is a samples-style object with ${entries.length} entries; ` +
          'it must contain exactly one.',
      );
    }
    const [[key, entry]] = entries;
    const items = (entry as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new Error(`${label}: entry "${key}" has no "items" array.`);
    }
    return items;
  }
  throw new Error(`${label} must be an array of items or a samples-style object.`);
}
