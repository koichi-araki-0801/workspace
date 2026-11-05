// =============================================================================
// input_number.test.ts — DB / JSON 経路が共有する数値解釈(cellValueAsNumber)の固定
// =============================================================================
import { describe, expect, it } from 'vitest';
import { cellValueAsNumber } from '../src/input/number.js';

describe('cellValueAsNumber', () => {
  it('素の数値・数値文字列をそのまま読む', () => {
    expect(cellValueAsNumber(12.5)).toBe(12.5);
    expect(cellValueAsNumber(' 3.5 ')).toBe(3.5);
    expect(cellValueAsNumber('-42')).toBe(-42);
  });
  it('桁区切り位置のカンマは許容する', () => {
    expect(cellValueAsNumber('1,234')).toBe(1234);
    expect(cellValueAsNumber('1,234,567.89')).toBe(1234567.89);
    expect(cellValueAsNumber('-1,000')).toBe(-1000);
  });
  it('桁区切りとして成立しないカンマは null (誤読を避ける)', () => {
    // 3 桁区切りでない位置のカンマは、数値ではなく別の記法(例: 小数点にカンマを使う locale)
    // の可能性が高い。黙って除去すると 1,23 が 123 になり 100 倍の値が帳票へ出る。
    expect(cellValueAsNumber('1,23')).toBeNull();
    expect(cellValueAsNumber('1,2,3')).toBeNull();
    expect(cellValueAsNumber('12,3456')).toBeNull();
    expect(cellValueAsNumber(',123')).toBeNull();
    expect(cellValueAsNumber('1,234,')).toBeNull();
  });
  it('10 進以外の記法 (16 進・2 進・8 進) は null', () => {
    // `Number()` は "0x1A" を 26 と読む。帳票の数値に 16 進表記は無いので、読めない値として扱う。
    expect(cellValueAsNumber('0x1A')).toBeNull();
    expect(cellValueAsNumber('0b11')).toBeNull();
    expect(cellValueAsNumber('0o7')).toBeNull();
    expect(cellValueAsNumber('Infinity')).toBeNull();
  });
  it('符号・小数・指数表記の 10 進数は読む', () => {
    expect(cellValueAsNumber('+1.5')).toBe(1.5);
    expect(cellValueAsNumber('.5')).toBe(0.5);
    expect(cellValueAsNumber('1e3')).toBe(1000);
    expect(cellValueAsNumber('-2.5E-1')).toBe(-0.25);
  });
  it('空・数値以外は null', () => {
    expect(cellValueAsNumber(null)).toBeNull();
    expect(cellValueAsNumber('')).toBeNull();
    // 空白だけのセルは「読めない値」であって 0 ではない(`Number('   ')` は 0 になる)。
    expect(cellValueAsNumber('   ')).toBeNull();
    expect(cellValueAsNumber('abc')).toBeNull();
    expect(cellValueAsNumber(Number.NaN)).toBeNull();
  });
});
