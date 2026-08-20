import { describe, expect, it } from 'vitest';
import { cellAsNumber, parseRange } from '../src/input/load.js';

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

describe('cellAsNumber', () => {
  it('素の数値・数値文字列をそのまま読む', () => {
    expect(cellAsNumber({ value: 12.5 })).toBe(12.5);
    expect(cellAsNumber({ value: ' 3.5 ' })).toBe(3.5);
    expect(cellAsNumber({ value: '-42' })).toBe(-42);
  });
  it('桁区切り位置のカンマは許容する', () => {
    expect(cellAsNumber({ value: '1,234' })).toBe(1234);
    expect(cellAsNumber({ value: '1,234,567.89' })).toBe(1234567.89);
    expect(cellAsNumber({ value: '-1,000' })).toBe(-1000);
  });
  it('桁区切りとして成立しないカンマは null (誤読を避ける)', () => {
    // 3 桁区切りでない位置のカンマは、数値ではなく別の記法(例: 小数点にカンマを使う locale)
    // の可能性が高い。黙って除去すると 1,23 が 123 になり 100 倍の値が帳票へ出る。
    expect(cellAsNumber({ value: '1,23' })).toBeNull();
    expect(cellAsNumber({ value: '1,2,3' })).toBeNull();
    expect(cellAsNumber({ value: '12,3456' })).toBeNull();
    expect(cellAsNumber({ value: ',123' })).toBeNull();
    expect(cellAsNumber({ value: '1,234,' })).toBeNull();
  });
  it('空・数値以外は null', () => {
    expect(cellAsNumber({ value: null })).toBeNull();
    expect(cellAsNumber({ value: '' })).toBeNull();
    expect(cellAsNumber({ value: 'abc' })).toBeNull();
    expect(cellAsNumber({ value: Number.NaN })).toBeNull();
  });
});
