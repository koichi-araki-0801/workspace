// =============================================================================
// confirmedHtml.test.ts — 対象ごとに読む先が分かれること
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { readConfirmedHtml } from '../src/files/confirmedHtml.js';

vi.mock('../src/files/templateFiles.js', () => ({
  readFilledHtml: vi.fn(async (f: string) => `filled:${f}`),
  readTemplateHtml: vi.fn(async (f: string) => `template:${f}`),
}));

describe('readConfirmedHtml', () => {
  it('filled は値入り HTML、template はスケルトンを読む', async () => {
    expect(await readConfirmedHtml('filled', 'a.html')).toBe('filled:a.html');
    expect(await readConfirmedHtml('template', 'a.html')).toBe('template:a.html');
  });
});
