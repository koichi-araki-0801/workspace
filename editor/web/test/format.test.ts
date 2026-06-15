import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDateTimeShort } from '@/lib/format';

describe('formatDateTime', () => {
  it('returns an em dash for empty values', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
  });

  it('formats a valid ISO string to a non-empty localized string', () => {
    const out = formatDateTime('2024-07-10T11:42:00Z');
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('formatDateTimeShort', () => {
  it('returns an em dash for empty values', () => {
    expect(formatDateTimeShort(null)).toBe('—');
    expect(formatDateTimeShort(undefined)).toBe('—');
    expect(formatDateTimeShort('')).toBe('—');
  });

  it('formats a valid ISO string as zero-padded YYYY/MM/DD HH:mm', () => {
    // Assert the shape (TZ-independent) rather than exact local values.
    expect(formatDateTimeShort('2024-07-10T11:42:00Z')).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/,
    );
  });
});
