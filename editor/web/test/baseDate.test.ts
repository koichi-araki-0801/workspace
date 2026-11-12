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
  it.each([
    ['２０２６／０９／３０', '20260930'],
    ['２０２６－９－３', '20260903'],
    ['２０２６０９３０', '20260930'],
  ])('reads full-width digits %s', (raw, v) =>
    expect(parseBaseDateInput(raw)).toEqual({ ok: true, value: v }),
  );
  it.each(['2026930', '202609301', '2026/9-30', '26/09/30', '2026.09.30', 'abc', ''])(
    'rejects format %s',
    (raw) => expect(parseBaseDateInput(raw)).toEqual({ ok: false, reason: 'format' }),
  );
  it('handles leap day boundaries', () => {
    expect(parseBaseDateInput('2024/02/29')).toEqual({ ok: true, value: '20240229' });
    expect(parseBaseDateInput('2026/02/29')).toEqual({ ok: false, reason: 'invalid' });
  });
  it.each([
    ['0000/01/01', '00000101'],
    ['0099-12-31', '00991231'],
  ])('reads year below 100 as is %s', (raw, v) =>
    expect(parseBaseDateInput(raw)).toEqual({ ok: true, value: v }),
  );
  it('rejects Feb 29 of a non-leap year below 100', () =>
    expect(parseBaseDateInput('0001/02/29')).toEqual({ ok: false, reason: 'invalid' }));
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
