import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/input/load.js';

describe('parseRange', () => {
  it('"A2:B11" を分解する (左=name, 右=value)', () => {
    expect(parseRange('A2:B11')).toEqual({ startRow: 2, endRow: 11, nameCol: 1, valueCol: 2 });
  });
  it('小文字・空白を許容する', () => {
    expect(parseRange('  c5:d9  ')).toEqual({ startRow: 5, endRow: 9, nameCol: 3, valueCol: 4 });
  });
  it('行・列が逆順でも正規化する', () => {
    expect(parseRange('B11:A2')).toEqual({ startRow: 2, endRow: 11, nameCol: 1, valueCol: 2 });
  });
  it('複数文字列 (AA 等) を扱う', () => {
    expect(parseRange('Z1:AA3')).toEqual({ startRow: 1, endRow: 3, nameCol: 26, valueCol: 27 });
  });
  it('書式不正は投げる', () => {
    expect(() => parseRange('A2B11')).toThrow(/Invalid range/);
    expect(() => parseRange('foo')).toThrow(/Invalid range/);
  });
  it('2 列でなければ投げる', () => {
    expect(() => parseRange('A2:C11')).toThrow(/exactly 2 columns/);
    expect(() => parseRange('A2:A11')).toThrow(/exactly 2 columns/);
  });
});
