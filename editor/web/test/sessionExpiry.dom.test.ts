// =============================================================================
// sessionExpiry.test.ts — 401 のグローバル通知が 1 回だけ走ることの回帰テスト
// =============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/api/rest/http';
import { armUnauthorizedNotice, setUnauthorizedHandler } from '@/lib/sessionExpiry';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

/** 常に指定ステータスを返す fetch。 */
function stubStatus(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(status === 204 ? null : '{}', { status })),
  );
}

describe('401 のグローバル通知', () => {
  it('401 が続けて起きても通知は 1 回だけ', async () => {
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);
    stubStatus(401);

    await Promise.allSettled([apiFetch('/a'), apiFetch('/b'), apiFetch('/c')]);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('再武装すると次のセッション切れでまた通知する', async () => {
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);
    stubStatus(401);

    await apiFetch('/a').catch(() => {});
    armUnauthorizedNotice();
    await apiFetch('/b').catch(() => {});
    expect(onExpired).toHaveBeenCalledTimes(2);
  });

  it('401 以外では通知しない', async () => {
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);
    stubStatus(403);

    await apiFetch('/a').catch(() => {});
    expect(onExpired).not.toHaveBeenCalled();
  });
});
