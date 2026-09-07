// =============================================================================
// restHttp.test.ts — `apiFetch` のエラーボディ照合(kind の信用境界)
// =============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiUrl } from '@/api/rest/http';
import { armUnauthorizedNotice, setUnauthorizedHandler } from '@/lib/sessionExpiry';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch のエラー写像', () => {
  it('正当な kind はそのまま写る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ kind: 'conflict', message: '重複' }), { status: 409 }),
      ),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'conflict', message: '重複' });
  });

  it('未知 kind(`__proto__`)は 404 ならステータス写像で not_found へ倒れる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ kind: '__proto__', message: 'x' }), { status: 404 }),
      ),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('非 JSON ボディはステータス写像へ落ちる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 403 })),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('204 は undefined を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(apiFetch('/x')).resolves.toBeUndefined();
  });
});

describe('apiFetch の要求組み立てと網羅', () => {
  it('apiUrl は /api を前置する', () => {
    expect(apiUrl('/build')).toBe('/api/build');
  });
  it('query の undefined と空文字は付けず、ボディ無しなら Content-Type も付けない', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/x', { query: { a: '1', b: undefined, c: '' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/api/x?a=1`);
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
  });
  it('fetch 自体の失敗(接続不可)は network に写り、cause を保つ', async () => {
    const boom = new TypeError('Failed to fetch');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw boom;
      }),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'network', cause: boom });
  });
  it('401 は 1 回だけセッション切れを通知し、unauthorized で reject する', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(handler).toHaveBeenCalledTimes(1);
    armUnauthorizedNotice();
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(handler).toHaveBeenCalledTimes(2);
    setUnauthorizedHandler(null);
  });
  it('写像表に無いステータス(500)は unexpected、code が文字列でなければ落とす', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unexpected' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ kind: 'validation', message: 'm', code: 7 }), {
            status: 400,
          }),
      ),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({
      kind: 'validation',
      message: 'm',
      code: undefined,
    });
  });
});
