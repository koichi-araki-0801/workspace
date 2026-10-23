// =============================================================================
// htmlApi.dom.test.ts — Worker とメインが共有する HTML 重処理 API の固定
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { createHtmlApi, toAsyncApi } from '@/workers/htmlApi';

describe('createHtmlApi', () => {
  it('パーサを省くと既定の DOMParser で 4 メソッドが動く', () => {
    const api = createHtmlApi();
    const diff = api.buildHtmlDiff('<p id="a">x</p>', '<p id="a">y</p>', '', '');
    expect(diff.pages.length).toBeGreaterThan(0);
    expect(api.toFilled('<p>{{ a }}</p>', { a: 'v' })).toContain('v');
    expect(api.toTemplate('<p>t</p>', { asFragment: true })).toContain('t');
    expect(api.buildHtmlDiffAligned('<p>x</p>', '<p>y</p>', '', '', []).pages).toBeDefined();
  });

  it('渡したパーサを 4 メソッドそれぞれで使う', () => {
    const parser = vi.fn((html: string) => new DOMParser().parseFromString(html, 'text/html'));
    const api = createHtmlApi(parser);
    const calls = () => parser.mock.calls.length;
    const step = (run: () => void): number => {
      const before = calls();
      run();
      return calls() - before;
    };
    expect(step(() => api.buildHtmlDiff('<p>x</p>', '<p>y</p>'))).toBeGreaterThan(0);
    expect(
      step(() => api.buildHtmlDiffAligned('<p>x</p>', '<p>y</p>', '', '', [])),
    ).toBeGreaterThan(0);
    expect(step(() => api.toTemplate('<p>t</p>', { asFragment: true }))).toBeGreaterThan(0);
    expect(step(() => api.toFilled('<p>{{ a }}</p>', { a: 'v' }))).toBeGreaterThan(0);
  });
});

describe('toAsyncApi', () => {
  it('同じ引数で同期 API を呼び、結果を Promise で返す', async () => {
    const api = {
      buildHtmlDiff: vi.fn(() => ({ pages: [] })),
      buildHtmlDiffAligned: vi.fn(() => ({ pages: [] })),
      toTemplate: vi.fn(() => 'tpl'),
      toFilled: vi.fn(() => 'filled'),
    } as unknown as Parameters<typeof toAsyncApi>[0];
    const a = toAsyncApi(api);
    await expect(a.toTemplate('e', { asFragment: true })).resolves.toBe('tpl');
    await expect(a.toFilled('r', {})).resolves.toBe('filled');
    await expect(a.buildHtmlDiff('b', 'a', 'cb', 'ca')).resolves.toEqual({ pages: [] });
    await expect(a.buildHtmlDiffAligned('b', 'a', 'cb', 'ca', [])).resolves.toEqual({ pages: [] });
    expect(api.toTemplate).toHaveBeenCalledWith('e', { asFragment: true });
    expect(api.buildHtmlDiff).toHaveBeenCalledWith('b', 'a', 'cb', 'ca');
  });
});
