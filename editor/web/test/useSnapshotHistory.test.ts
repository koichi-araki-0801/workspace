import { describe, expect, it } from 'vitest';
import { useSnapshotHistory } from '@/features/editor/useSnapshotHistory';

/**
 * Drive the history with a simple mutable `state` string: `capture` reads it,
 * `apply` writes it. This mirrors how useTemplateEditor snapshots html/css.
 */
function setup(max?: number) {
  const box = { state: 'a' };
  const applied: string[] = [];
  const h = useSnapshotHistory(
    () => box.state,
    (s) => {
      box.state = s;
      applied.push(s);
    },
    max,
  );
  return { box, applied, h };
}

describe('useSnapshotHistory', () => {
  it('starts with both flags false', () => {
    const { h } = setup();
    expect(h.canUndo.value).toBe(false);
    expect(h.canRedo.value).toBe(false);
  });

  it('undo/redo are no-ops on empty stacks', () => {
    const { box, applied, h } = setup();
    h.undo();
    h.redo();
    expect(box.state).toBe('a');
    expect(applied).toHaveLength(0);
  });

  it('undo restores the snapshot captured by pushUndo', () => {
    const { box, h } = setup();
    h.pushUndo(); // snapshot 'a'
    box.state = 'b';
    expect(h.canUndo.value).toBe(true);

    h.undo();
    expect(box.state).toBe('a');
    expect(h.canUndo.value).toBe(false);
    expect(h.canRedo.value).toBe(true);
  });

  it('redo re-applies an undone change', () => {
    const { box, h } = setup();
    h.pushUndo();
    box.state = 'b';
    h.undo(); // back to 'a'
    h.redo(); // forward to 'b'
    expect(box.state).toBe('b');
    expect(h.canRedo.value).toBe(false);
    expect(h.canUndo.value).toBe(true);
  });

  it('a new pushUndo clears the redo stack', () => {
    const { box, h } = setup();
    h.pushUndo();
    box.state = 'b';
    h.undo(); // canRedo = true
    h.pushUndo(); // should drop the redo branch
    expect(h.canRedo.value).toBe(false);
  });

  it('does not push while applying (no spurious step during restore)', () => {
    const box = { state: 'a' };
    let captures = 0;
    const h = useSnapshotHistory(
      () => {
        captures++;
        return box.state;
      },
      (s) => {
        box.state = s;
        h.pushUndo(); // re-entrant push from within apply must be ignored
      },
    );
    h.pushUndo();
    box.state = 'b';
    const before = captures;
    h.undo();
    // apply()'s re-entrant pushUndo captured nothing extra and added no step.
    expect(box.state).toBe('a');
    expect(captures).toBe(before + 1); // only the undo()'s own capture of 'b'
    expect(h.canUndo.value).toBe(false);
  });

  it('discardLast drops the last snapshot without restoring', () => {
    const { box, h } = setup();
    h.pushUndo(); // speculative snapshot of 'a'
    box.state = 'b';
    h.discardLast();
    expect(box.state).toBe('b'); // unchanged — no restore
    expect(h.canUndo.value).toBe(false);
  });

  it('caps the past stack at max', () => {
    const { box, h } = setup(2);
    box.state = '1';
    h.pushUndo();
    box.state = '2';
    h.pushUndo();
    box.state = '3';
    h.pushUndo(); // pushes '3'; '1' should be dropped (cap 2)
    box.state = 'x';
    h.undo(); // -> '3'
    h.undo(); // -> '2'
    expect(box.state).toBe('2');
    expect(h.canUndo.value).toBe(false); // only 2 entries were retained
  });
});
