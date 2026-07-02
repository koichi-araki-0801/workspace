import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDurationMs, dismissToast, toast, toasts } from '@/components/ui/toast';

afterEach(() => {
  vi.useRealTimers();
  toasts.splice(0, toasts.length);
});

describe('toast', () => {
  it('supports the legacy positional signature (variant, durationMs)', async () => {
    vi.useFakeTimers();
    toast('保存しました', 'success', 1000);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.variant).toBe('success');
    expect(toasts[0]?.action).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1000);
    expect(toasts).toHaveLength(0);
  });

  it('supports the options-object signature with an action', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    toast('パーツを削除しました', { action: { label: '元に戻す', onClick }, durationMs: 6000 });
    expect(toasts[0]?.variant).toBe('default');
    expect(toasts[0]?.action?.label).toBe('元に戻す');
    toasts[0]?.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps an options toast visible for its explicit duration', async () => {
    vi.useFakeTimers();
    toast('x', { durationMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(toasts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(toasts).toHaveLength(0);
  });

  it('dismissToast removes only the target toast', () => {
    vi.useFakeTimers();
    toast('a');
    toast('b');
    const first = toasts[0]?.id;
    if (first == null) throw new Error('toast not pushed');
    dismissToast(first);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe('b');
  });
});

describe('defaultDurationMs', () => {
  it('clamps short messages to the 3s floor (legacy behavior)', () => {
    expect(defaultDurationMs('OK')).toBe(3000);
  });

  it('scales with message length between the bounds', () => {
    // 100 chars * 60ms = 6000ms, within [3000, 8000]
    expect(defaultDurationMs('あ'.repeat(100))).toBe(6000);
  });

  it('clamps long messages to the 8s ceiling', () => {
    expect(defaultDurationMs('あ'.repeat(500))).toBe(8000);
  });
});
