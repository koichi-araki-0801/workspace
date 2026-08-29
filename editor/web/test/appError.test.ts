import { notFound } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, toUserMessage } from '@/lib/appError';

afterEach(() => vi.restoreAllMocks());

describe('toUserMessage', () => {
  it('returns an AppError message verbatim', () => {
    expect(toUserMessage(notFound('テンプレートが見つかりません'), 'fallback')).toBe(
      'テンプレートが見つかりません',
    );
  });

  it('falls back for non-AppError values', () => {
    expect(toUserMessage(new Error('raw'), 'ユーザー向け文言')).toBe('ユーザー向け文言');
    expect(toUserMessage('weird', 'fb')).toBe('fb');
  });
});

describe('logError', () => {
  it('always logs (AppError formatted with kind, cause)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError(notFound('x', { cause: new Error('inner') }));
    logError(new Error('plain'));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
