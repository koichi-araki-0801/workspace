import { describe, expect, it, vi } from 'vitest';
import { canvasRoot, measureOrClear } from '@/features/editor/canvasGeometry';

const logError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/appError', () => ({ logError }));

describe('canvasRoot', () => {
  it('editor が無ければ null', () => {
    expect(canvasRoot({ value: undefined })).toBeNull();
    expect(canvasRoot({ value: null })).toBeNull();
  });
  it('wrapper が無い・要素が未描画なら null', () => {
    expect(canvasRoot({ value: { getWrapper: () => undefined } as never })).toBeNull();
    expect(
      canvasRoot({ value: { getWrapper: () => ({ getEl: () => undefined }) } as never }),
    ).toBeNull();
  });
  it('wrapper の要素を返す', () => {
    const el = {} as HTMLElement;
    expect(canvasRoot({ value: { getWrapper: () => ({ getEl: () => el }) } as never })).toBe(el);
  });
});

describe('measureOrClear', () => {
  it('成功時は clear を呼ばない', () => {
    const clear = vi.fn();
    measureOrClear(() => {}, clear);
    expect(clear).not.toHaveBeenCalled();
  });
  it('失敗時は log して clear を呼ぶ', () => {
    const clear = vi.fn();
    measureOrClear(() => {
      throw new Error('x');
    }, clear);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
