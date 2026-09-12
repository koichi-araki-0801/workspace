import { describe, expect, it } from 'vitest';
import { shouldMeasureCanonical } from '@/features/editor/confirmedCanonicalGate';

describe('shouldMeasureCanonical', () => {
  it('作成経路では測らない(確定版そのものが無い)', () => {
    expect(shouldMeasureCanonical(true, false, false)).toBe(false);
  });

  it('既にキャッシュがあれば測らない', () => {
    expect(shouldMeasureCanonical(false, true, false)).toBe(false);
  });

  it('確定版の quiet load が失敗した直後は測らない(draft 自身から作ると自動 discard を招く)', () => {
    expect(shouldMeasureCanonical(false, false, true)).toBe(false);
  });

  it('編集経路・キャッシュ無し・quiet load 失敗も無しなら測ってよい', () => {
    expect(shouldMeasureCanonical(false, false, false)).toBe(true);
  });
});
