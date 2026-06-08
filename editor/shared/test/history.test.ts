import { describe, expect, it } from 'vitest';
import { matchFilter, uniq } from '../src/domain/history';

const entry = (user: string, timestamp: string) => ({ user, timestamp });

describe('uniq', () => {
  it('removes duplicates preserving first-seen order', () => {
    expect(uniq(['b', 'a', 'b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('matchFilter', () => {
  const e = entry('編集太郎', '2026-06-01T12:00:00.000Z');

  it('passes an empty filter', () => {
    expect(matchFilter(e, {}, [])).toBe(true);
  });

  it('filters by user', () => {
    expect(matchFilter(e, { user: '編集太郎' }, [])).toBe(true);
    expect(matchFilter(e, { user: '別人' }, [])).toBe(false);
  });

  it('filters by from/to date range (inclusive)', () => {
    expect(matchFilter(e, { from: '2026-06-01' }, [])).toBe(true);
    expect(matchFilter(e, { from: '2026-06-02' }, [])).toBe(false);
    expect(matchFilter(e, { to: '2026-06-01' }, [])).toBe(true);
    expect(matchFilter(e, { to: '2026-05-31' }, [])).toBe(false);
  });

  it('filters by keyword against haystacks, case-insensitively', () => {
    expect(matchFilter(e, { keyword: 'ABC' }, ['xyzABCdef'])).toBe(true);
    expect(matchFilter(e, { keyword: 'nope' }, ['xyzABCdef'])).toBe(false);
  });
});
