import { describe, expect, it } from 'vitest';
import { latestBaseDate } from '../src/generate/baseDate.js';

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
