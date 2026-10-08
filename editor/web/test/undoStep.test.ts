import { describe, expect, it, vi } from 'vitest';
import { undoable } from '@/features/editor/undoStep';

const history = () => ({ beginUndo: vi.fn(), cancelUndo: vi.fn(), commitUndo: vi.fn() });

describe('undoable', () => {
  it('変化があれば 1 手として確定する', () => {
    const h = history();
    expect(undoable(h, () => true)).toBe(true);
    expect(h.beginUndo).toHaveBeenCalledTimes(1);
    expect(h.commitUndo).toHaveBeenCalledTimes(1);
    expect(h.cancelUndo).not.toHaveBeenCalled();
  });
  it('変化が無ければ積まない', () => {
    const h = history();
    expect(undoable(h, () => false)).toBe(false);
    expect(h.cancelUndo).toHaveBeenCalledTimes(1);
    expect(h.commitUndo).not.toHaveBeenCalled();
  });
  it('op が投げたら保留を取り消して投げ直す', () => {
    const h = history();
    expect(() =>
      undoable(h, () => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(h.cancelUndo).toHaveBeenCalledTimes(1);
    expect(h.commitUndo).not.toHaveBeenCalled();
  });
});
