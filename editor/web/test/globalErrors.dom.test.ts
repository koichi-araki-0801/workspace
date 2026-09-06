// =============================================================================
// globalErrors.test.ts — window error handler の抽出(RO 良性警告の扱い)
// =============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';

function errorEvent(message: string, error?: unknown): ErrorEvent {
  return { message, error } as ErrorEvent;
}

// `lastMessage`(連投抑制)はモジュール内 state なので、テストごとに fresh import して
// 前のテストの抑制状態を持ち越さない。`toasts` も同じ reset サイクルで取り直す
// (別サイクルの参照だと globalErrors が触る配列と食い違う)。
async function freshEnv() {
  vi.resetModules();
  const { toasts } = await import('@/components/ui/toast');
  const { handleWindowError } = await import('@/lib/globalErrors');
  return { toasts, handleWindowError };
}

describe('handleWindowError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ResizeObserver の良性警告は logError され toast は出ない', async () => {
    const { toasts, handleWindowError } = await freshEnv();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handleWindowError(errorEvent('ResizeObserver loop completed with undelivered notifications.'));
    expect(spy).toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it('他エラーは logError と toast の両方が出る', async () => {
    const { toasts, handleWindowError } = await freshEnv();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handleWindowError(errorEvent('unexpected boom', new Error('unexpected boom')));
    expect(spy).toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });

  it('同一メッセージの連投は toast 1 回に抑制される', async () => {
    const { toasts, handleWindowError } = await freshEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handleWindowError(errorEvent('同じエラー', new Error('同じエラー')));
    handleWindowError(errorEvent('同じエラー', new Error('同じエラー')));
    expect(toasts).toHaveLength(1);
  });
});
