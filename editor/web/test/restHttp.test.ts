// =============================================================================
// restHttp.test.ts — `apiFetch` のエラーボディ照合(kind の信用境界)
// =============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/api/rest/http';

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
