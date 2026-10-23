import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeInputItems } from '../src/input/load.js';
import {
  buildSavedJson,
  extractDataItems,
  formatLocalIso,
  resolveSavedJsonPath,
  samePath,
  savedEntryKey,
  writeSavedJson,
} from '../src/input/savedJson.js';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';

const ARGS = { fund: '0331A', baseDate: '20260930', chartType: '資産配分' };
const CONN = { server: 'db01', database: 'usrap', proc: 'dbo.pie_chart_items' };
const work = mkdtempSync(join(tmpdir(), 'piechart-saved-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('savedEntryKey / formatLocalIso', () => {
  it('キーは <ファンド>_<YYYYMMDD>_<種別>', () => {
    expect(savedEntryKey(ARGS)).toBe('0331A_20260930_資産配分');
  });
  it('ローカル時刻をオフセット付きの ISO 8601 で書く', () => {
    expect(formatLocalIso(new Date(2026, 9, 8, 14, 3, 12))).toMatch(
      /^2026-10-08T14:03:12[+-]\d{2}:\d{2}$/,
    );
  });
});

describe('buildSavedJson', () => {
  it('samples.json の 1 項目と同じ形で、source と description を付ける', () => {
    const at = new Date(2026, 9, 8, 14, 3, 12);
    const json = buildSavedJson(ARGS, [{ name: '国内株式', value: 97.8 }], CONN, at);
    const entry = json['0331A_20260930_資産配分'];
    expect(Object.keys(json)).toEqual(['0331A_20260930_資産配分']);
    expect(entry.items).toEqual([{ name: '国内株式', value: 97.8 }]);
    expect(entry.source).toEqual({ ...ARGS, fetchedAt: formatLocalIso(at), ...CONN });
    expect(entry.description).toBe(
      `ファンド 0331A / 基準日 2026-09-30 / 種別 資産配分 / 取得 ${formatLocalIso(at)}`,
    );
  });
});

describe('resolveSavedJsonPath', () => {
  it('既定は --output-file の拡張子を .json に替える(拡張子が無ければ足す)', () => {
    expect(resolveSavedJsonPath(join('out', 'x.svg'), undefined)).toBe(join('out', 'x.json'));
    expect(resolveSavedJsonPath(join('out', 'x'), undefined)).toBe(join('out', 'x.json'));
  });
  it('--save-json を明示すればそれを使う', () => {
    expect(resolveSavedJsonPath(join('out', 'x.svg'), join('d', 'y.json'))).toBe(
      join('d', 'y.json'),
    );
  });
  it('--output-file が .json なら SVG を上書きしないよう別の --save-json を求める', () => {
    expect(() => resolveSavedJsonPath(join('out', 'x.json'), undefined)).toThrow(
      /different --save-json/,
    );
  });
  it('Windows では拡張子の大文字小文字が違っても同じファイルとみなす', () => {
    const out = join('out', 'x.JSON');
    expect(() => resolveSavedJsonPath(out, undefined, 'win32')).toThrow(/different --save-json/);
    expect(resolveSavedJsonPath(out, undefined, 'linux')).toBe(join('out', 'x.json'));
  });
  it('明示した --save-json が --output-file と同じなら止める', () => {
    const out = join('out', 'x.svg');
    expect(() => resolveSavedJsonPath(out, out)).toThrow(/different --save-json/);
    expect(() => resolveSavedJsonPath(out, join('out', 'X.SVG'), 'win32')).toThrow(
      /different --save-json/,
    );
  });
});

describe('samePath', () => {
  it('解決後のパスで比べ、Windows だけ大文字小文字を無視する', () => {
    expect(samePath(join('a', '..', 'b'), 'b', 'linux')).toBe(true);
    expect(samePath('B', 'b', 'linux')).toBe(false);
    expect(samePath('B', 'b', 'win32')).toBe(true);
    expect(samePath('a', 'b')).toBe(false);
  });
});

describe('extractDataItems', () => {
  it('配列はそのまま返す', () => {
    const arr = [{ name: 'A', value: 1 }];
    expect(extractDataItems(arr, 'f')).toBe(arr);
  });
  it('samples 形式は項目がちょうど 1 つなら items を返す', () => {
    expect(extractDataItems({ k: { description: 'd', items: [['A', 1]] } }, 'f')).toEqual([
      ['A', 1],
    ]);
  });
  it('項目が 0 個・2 個以上、items が無い、配列でもオブジェクトでもないならエラー', () => {
    expect(() => extractDataItems({}, 'f')).toThrow(/0 entries/);
    expect(() => extractDataItems({ a: { items: [] }, b: { items: [] } }, 'f')).toThrow(
      /2 entries/,
    );
    expect(() => extractDataItems({ a: { description: 'd' } }, 'f')).toThrow(/no "items" array/);
    expect(() => extractDataItems(42, 'f')).toThrow(/array of items or a samples-style object/);
    expect(() => extractDataItems(null, 'f')).toThrow(/array of items or a samples-style object/);
  });
});

describe('書き出しと描き直し', () => {
  it('保存した JSON から描いた SVG は、元の items から描いた SVG と byte 単位で一致する', async () => {
    const items = normalizeInputItems([
      ['国内株式', '60.5'],
      ['外国株式', 30],
      ['その他', 9.5],
    ]);
    const file = join(work, 'nested', 'x.json');
    writeSavedJson(file, buildSavedJson(ARGS, items, CONN, new Date()));
    const text = readFileSync(file, 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
    const reloaded = normalizeInputItems(extractDataItems(JSON.parse(text), file));
    const a = await renderPdfStylePieToSvg(items, {});
    const b = await renderPdfStylePieToSvg(reloaded, {});
    expect(b.svg).toBe(a.svg);
  });
});
