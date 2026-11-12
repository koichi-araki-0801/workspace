import { describe, expect, it } from 'vitest';
import { findBaseDateCandidate, parseBaseDateInput } from '../src/lib/baseDate';

describe('parseBaseDateInput', () => {
  it.each([
    ['2026/09/30', '20260930'],
    ['2026-09-30', '20260930'],
    ['20260930', '20260930'],
    ['2026/9/30', '20260930'],
    ['2026-9-3', '20260903'],
  ])('reads %s', (raw, v) => expect(parseBaseDateInput(raw)).toEqual({ ok: true, value: v }));
  it.each([' 2026/09/30\r\n', '　2026/09/30', '2026/09/30　'])(
    'trims pasted whitespace %j',
    (raw) => expect(parseBaseDateInput(raw)).toEqual({ ok: true, value: '20260930' }),
  );
  it.each(['2026930', '202609301', '2026/9-30', '26/09/30', '2026.09.30', 'abc', ''])(
    'rejects format %s',
    (raw) => expect(parseBaseDateInput(raw)).toEqual({ ok: false, reason: 'format' }),
  );
  it.each(['2026/02/30', '20261301', '2026-00-10'])('rejects invalid %s', (raw) =>
    expect(parseBaseDateInput(raw)).toEqual({ ok: false, reason: 'invalid' }),
  );
});

describe('findBaseDateCandidate', () => {
  it('matches dashed candidate', () =>
    expect(findBaseDateCandidate('20240517', ['20240710', '2024-05-17'])).toBe('2024-05-17'));
  it('returns undefined when absent', () =>
    expect(findBaseDateCandidate('20261110', ['20240710'])).toBeUndefined());
});
