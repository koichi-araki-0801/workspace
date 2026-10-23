import { describe, expect, it } from 'vitest';
import { assertRequestedBaseDate, latestBaseDate, todayInTokyo } from '../src/generate/baseDate.js';

// 日本時間 2026-10-23(金)の 0:00 ちょうど。UTC ではまだ前日。
const NOW = new Date('2026-10-22T15:00:00Z');

describe('todayInTokyo', () => {
  it('日本時間の暦日を返し、土日でも金曜へ戻さない', () => {
    expect(todayInTokyo(NOW)).toBe('2026-10-23');
    expect(todayInTokyo(new Date('2026-10-24T03:00:00Z'))).toBe('2026-10-24');
    expect(todayInTokyo(new Date('2026-10-25T03:00:00Z'))).toBe('2026-10-25');
  });
});

describe('assertRequestedBaseDate', () => {
  it.each([
    ['過去日', '2026-10-01'],
    ['日本時間の今日', '2026-10-23'],
    ['土曜(金曜へ戻さない)', '2026-10-17'],
    ['日曜(金曜へ戻さない)', '2026-10-18'],
    ['うるう日', '2024-02-29'],
  ])('%s はそのまま通す', (_, value) => {
    expect(assertRequestedBaseDate(value, NOW)).toBe(value);
  });

  it.each([
    ['日本時間の明日', '2026-10-24'],
    ['存在しない日', '2026-02-30'],
    ['うるう年でない 2/29', '2026-02-29'],
    ['ゼロ埋めなし', '2026-1-5'],
    ['区切りが違う', '2026/10/01'],
    ['空文字', ''],
  ])('%s は validation で拒否する', (_, value) => {
    expect(() => assertRequestedBaseDate(value, NOW)).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });
});

describe('latestBaseDate', () => {
  it.each([
    ['平日の日本時間 23:59 は当日', '2026-10-22T14:59:00Z', '2026-10-22'],
    ['日本時間の 0:00 で翌日になる(UTC ではまだ前日)', '2026-10-22T15:00:00Z', '2026-10-23'],
    ['土曜は直前の金曜', '2026-10-24T03:00:00Z', '2026-10-23'],
    ['日曜は直前の金曜', '2026-10-25T03:00:00Z', '2026-10-23'],
    ['月曜はそのまま', '2026-10-26T03:00:00Z', '2026-10-26'],
    ['月をまたいで金曜へ戻る', '2026-11-01T03:00:00Z', '2026-10-30'],
    ['年をまたいで金曜へ戻る', '2028-01-01T03:00:00Z', '2027-12-31'],
  ])('%s', (_, iso, want) => {
    expect(latestBaseDate(new Date(iso))).toBe(want);
  });

  it('引数を省くと現在時刻から求めた YYYY-MM-DD を返す', () => {
    expect(latestBaseDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
