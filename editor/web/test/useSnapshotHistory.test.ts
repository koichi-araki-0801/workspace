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

  it('depth() reflects the undo stack size across push/undo/redo', () => {
    const { box, h } = setup();
    expect(h.depth()).toBe(0);
    h.pushUndo();
    box.state = 'b';
    expect(h.depth()).toBe(1);
    h.pushUndo();
    box.state = 'c';
    expect(h.depth()).toBe(2);
    h.undo();
    expect(h.depth()).toBe(1);
    h.redo();
    expect(h.depth()).toBe(2);
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

  // ジェスチャ(テキスト編集 / drag)は開始時点では変更が起きるか分からない。開始時に past へ
  // 積むと future が消え、無変更で終わっても Redo が失われるため、開始は capture だけに留める。
  it('beginUndo は past も future も動かさない', () => {
    const box = { state: 'a' };
    const past: string[] = [];
    const future: string[] = ['z'];
    const h = useSnapshotHistory(
      () => box.state,
      (s) => {
        box.state = s;
      },
      100,
      { past, future },
    );
    h.beginUndo();
    expect(past).toEqual([]);
    expect(future).toEqual(['z']);
    expect(h.canUndo.value).toBe(false);
    expect(h.canRedo.value).toBe(true);
  });

  it('commitUndo で開始時点の snapshot を past へ積み future を捨てる', () => {
    const { box, h } = setup();
    h.beginUndo(); // snapshot 'a'
    box.state = 'b';
    h.commitUndo();
    expect(h.canUndo.value).toBe(true);
    h.undo();
    expect(box.state).toBe('a');
  });

  it('cancelUndo は past も future も動かさない(無変更で終わったジェスチャ)', () => {
    const { box, h } = setup();
    h.pushUndo(); // snapshot 'a'
    box.state = 'b';
    h.undo(); // state='a'、future=['b']
    expect(h.canRedo.value).toBe(true);

    h.beginUndo(); // ジェスチャ開始(結果的に無変更)
    h.cancelUndo();
    expect(h.canRedo.value).toBe(true);
    h.redo();
    expect(box.state).toBe('b');
  });

  // テキスト編集の保留中に別の操作(改ページ・配置の初期化・パーツの追加)が `beginUndo` を
  // 呼んでも、テキスト編集の開始時点を失わず、それ単独の 1 手として戻せること。
  describe('保留中の beginUndo', () => {
    it('保留中の変更を 1 手として確定し、新しい操作と別々に戻せる', () => {
      const { box, h } = setup();
      h.beginUndo(); // テキスト編集の開始 'a'
      box.state = 'b';
      h.beginUndo(); // 新しい操作の開始 'b'
      box.state = 'c';
      h.commitUndo();
      h.commitUndo(); // テキスト編集の終了。確定済みなので積まない
      expect(h.depth()).toBe(2);
      h.undo();
      expect(box.state).toBe('b');
      h.undo();
      expect(box.state).toBe('a');
      expect(h.canUndo.value).toBe(false);
    });

    it('保留中の snapshot が現在と同じなら余分な 1 手を積まない', () => {
      const { box, h } = setup();
      h.beginUndo(); // 'a'
      h.beginUndo(); // 無変更のまま新しい操作
      box.state = 'b';
      h.commitUndo();
      expect(h.depth()).toBe(1);
      h.undo();
      expect(box.state).toBe('a');
      expect(h.canUndo.value).toBe(false);
    });

    it('新しい操作が cancel されてもテキスト編集の 1 手は残る', () => {
      const { box, h } = setup();
      h.beginUndo(); // 'a'
      box.state = 'b';
      h.beginUndo();
      h.cancelUndo();
      expect(h.depth()).toBe(1);
      h.undo();
      expect(box.state).toBe('a');
    });

    it('同じかどうかは init.equals で判定する', () => {
      const box = { state: { html: 'a', css: '' } };
      const h = useSnapshotHistory(
        () => ({ ...box.state }),
        (s) => {
          box.state = s;
        },
        100,
        { past: [], future: [], equals: (a, b) => a.html === b.html && a.css === b.css },
      );
      h.beginUndo();
      h.beginUndo();
      h.cancelUndo();
      expect(h.depth()).toBe(0);
    });
  });

  it('commitUndo は beginUndo なしでは何もしない', () => {
    const { h } = setup();
    h.commitUndo();
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

  // 外部スタック(editorSession ストア由来)を渡すと、その配列を参照で使い、
  // 再マウントでも Undo/Redo が維持される。
  it('uses and mutates the external past/future arrays in place', () => {
    const box = { state: 'a' };
    const past: string[] = [];
    const future: string[] = [];
    const h = useSnapshotHistory(
      () => box.state,
      (s) => {
        box.state = s;
      },
      100,
      { past, future },
    );
    h.pushUndo(); // snapshot 'a'
    box.state = 'b';
    expect(past).toEqual(['a']); // 外部配列がそのまま積まれる
    h.undo();
    expect(box.state).toBe('a');
    expect(future).toEqual(['b']); // redo 用に外部 future へ退避される
  });

  // redo は「直近に undo した分」から戻す(LIFO)。future を先頭から取り出すと、
  // undo を 2 回以上重ねた時に戻る順序が逆転する。
  it('redo replays undone steps in reverse order (LIFO)', () => {
    const box = { state: 'a' };
    const past: string[] = [];
    const future: string[] = [];
    const h = useSnapshotHistory(
      () => box.state,
      (s) => {
        box.state = s;
      },
      100,
      { past, future },
    );
    h.pushUndo(); // snapshot 'a'
    box.state = 'b';
    h.pushUndo(); // snapshot 'b'
    box.state = 'c';

    h.undo();
    expect(box.state).toBe('b');
    h.undo();
    expect(box.state).toBe('a');

    h.redo();
    expect(box.state).toBe('b'); // 直近に取り消した 'b' から戻る
    expect(past).toEqual(['a']);
    h.redo();
    expect(box.state).toBe('c');
    expect(past).toEqual(['a', 'b']);
    expect(future).toEqual([]);
    expect(h.canRedo.value).toBe(false);
  });

  it('restores canUndo/canRedo flags from pre-populated external stacks', () => {
    const box = { state: 'b' };
    // 再マウントを模す: past に既存スナップショットがある状態で生成する。
    const past = ['a'];
    const future: string[] = [];
    const h = useSnapshotHistory(
      () => box.state,
      (s) => {
        box.state = s;
      },
      100,
      { past, future },
    );
    expect(h.canUndo.value).toBe(true); // 既存スタックからフラグを復元
    expect(h.canRedo.value).toBe(false);
    h.undo();
    expect(box.state).toBe('a');
  });
  it('syncFlags() は外部スタックを直接空にした後の活性を追随させる', () => {
    // 別タブの下書きを破棄したとき、`editorSession` ストアが渡した配列を in-place で空に
    // する。フラグは操作時にしか更新されないので、明示的に追随させないと「押せるのに
    // 何も戻らない Undo ボタン」が残る。
    const box = { state: 'b' };
    const past = ['a'];
    const future: string[] = [];
    const h = useSnapshotHistory(
      () => box.state,
      (s) => {
        box.state = s;
      },
      100,
      { past, future },
    );
    expect(h.canUndo.value).toBe(true);
    past.length = 0;
    h.syncFlags();
    expect(h.canUndo.value).toBe(false);
  });
});
