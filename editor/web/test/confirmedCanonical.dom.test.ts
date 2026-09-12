import { beforeEach, describe, expect, it } from 'vitest';
import { readConfirmedCanonical, writeConfirmedCanonical } from '@/lib/confirmedCanonical';

describe('confirmedCanonical — 確定版正規形の localStorage キャッシュ', () => {
  beforeEach(() => localStorage.clear());

  it('templateId と updatedAt が一致するときだけ返す', () => {
    writeConfirmedCanonical('t1', '2026-09-01T00:00:00.000Z', { html: '<p>a</p>', css: '.a{}' });
    expect(readConfirmedCanonical('t1', '2026-09-01T00:00:00.000Z')).toEqual({
      html: '<p>a</p>',
      css: '.a{}',
    });
    expect(readConfirmedCanonical('t1', '2026-09-02T00:00:00.000Z')).toBeNull();
    expect(readConfirmedCanonical('t2', '2026-09-01T00:00:00.000Z')).toBeNull();
  });

  it('updatedAt が null の版はキャッシュしない(毎回フォールバック)', () => {
    writeConfirmedCanonical('t1', null, { html: 'x', css: '' });
    expect(readConfirmedCanonical('t1', null)).toBeNull();
  });

  it('壊れた JSON は空として扱い、書き込み失敗(quota)は投げない', () => {
    localStorage.setItem('editor:confirmed:v1:local', '{broken');
    expect(readConfirmedCanonical('t1', 'x')).toBeNull();
    const big = 'x'.repeat(6 * 1024 * 1024);
    expect(() => writeConfirmedCanonical('t1', 'x', { html: big, css: '' })).not.toThrow();
  });
});
