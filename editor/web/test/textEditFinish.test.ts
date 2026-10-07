import type { Editor } from 'grapesjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  afterTextEdit,
  createFinishTextEdit,
  FINISH_TEXT_EDIT_TIMEOUT_MS,
  notifyWhenStuck,
  TEXT_EDIT_STUCK_MESSAGE,
} from '@/features/editor/textEditFinish';

// =============================================================================
// textEditFinish.test.ts — Undo 可能な操作の前にテキスト編集(RTE)を閉じる関数
// =============================================================================
// 操作の `beginUndo` は、編集中の入力がモデルへ反映された後でないと、追記を含まない snapshot を
// 取る。閉じ終わり(GrapesJS の `disableEditing` の解決)まで待つこと、`disableEditing` を 1 回の
// 編集につき 1 回しか呼ばないこと(`rte:disable` が 2 回出ると修正履歴にテキストの編集が 2 件
// 残る)、閉じられなければ false を返して操作を取りやめさせることを確かめる。

/**
 * `getEditing()` が編集中の component を返す偽 editor。`disableEditing` の Promise は `close`
 * (編集を閉じて解決)/ `fail`(閉じずに失敗)で手動で決着させる。
 */
function fakeEditor(editingNow = true) {
  let editing = editingNow;
  let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const disableEditing = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  const ed = {
    getEditing: () => (editing ? { getView: () => ({ disableEditing }) } : undefined),
  } as unknown as Editor;
  return {
    ed,
    disableEditing,
    close: () => {
      editing = false;
      settle?.resolve();
    },
    fail: () => settle?.reject(new Error('x')),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createFinishTextEdit', () => {
  it('編集中でなければ disableEditing を呼ばずに true で解決する', async () => {
    const f = fakeEditor(false);
    expect(await createFinishTextEdit(() => f.ed)()).toBe(true);
    expect(f.disableEditing).not.toHaveBeenCalled();
  });

  it('editor が無ければ true で解決する', async () => {
    expect(await createFinishTextEdit(() => null)()).toBe(true);
  });

  it('編集中なら disableEditing が解決するまで待ち、閉じたら true', async () => {
    const f = fakeEditor();
    let result: boolean | null = null;
    const p = createFinishTextEdit(() => f.ed)().then((r) => {
      result = r;
    });
    await Promise.resolve();
    expect(f.disableEditing).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    f.close();
    await p;
    expect(result).toBe(true);
  });

  it('閉じている途中にもう一度呼ばれても、disableEditing は 1 回で同じ完了を待つ', async () => {
    const f = fakeEditor();
    const finishTextEdit = createFinishTextEdit(() => f.ed);
    const a = finishTextEdit();
    const b = finishTextEdit();
    f.close();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(f.disableEditing).toHaveBeenCalledTimes(1);
  });

  it('disableEditing が失敗して編集が開いたままなら false', async () => {
    const f = fakeEditor();
    const p = createFinishTextEdit(() => f.ed)();
    f.fail();
    expect(await p).toBe(false);
  });

  it('disableEditing が同期で例外を投げたら false で、決着後の呼び出しでは閉じ直す', async () => {
    const disableEditing = vi.fn(() => {
      throw new Error('x');
    });
    const ed = {
      getEditing: () => ({ getView: () => ({ disableEditing }) }),
    } as unknown as Editor;
    const finishTextEdit = createFinishTextEdit(() => ed);
    expect(await finishTextEdit()).toBe(false);
    expect(await finishTextEdit()).toBe(false);
    expect(disableEditing).toHaveBeenCalledTimes(2);
  });

  // 閉じる処理が解決しないまま待ち続けると、以後の操作がすべて黙って止まる。打ち切った後も
  // `disableEditing` を呼び直さない — 遅れて解決したとき `rte:disable` が 2 回出る。
  it('解決しなければ上限時間で false を返し、呼び直さずに遅れた解決を待ち直す', async () => {
    vi.useFakeTimers();
    const f = fakeEditor();
    const finishTextEdit = createFinishTextEdit(() => f.ed);
    let result: boolean | null = null;
    const p = finishTextEdit().then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(FINISH_TEXT_EDIT_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(result).toBe(false);

    const again = finishTextEdit();
    expect(f.disableEditing).toHaveBeenCalledTimes(1);
    f.close();
    expect(await again).toBe(true);
    expect(f.disableEditing).toHaveBeenCalledTimes(1);
  });
});

describe('afterTextEdit', () => {
  it('テキスト編集を閉じ終えてから操作を走らせ、引数を渡す', async () => {
    const order: string[] = [];
    let close: () => void = () => {};
    const finish = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          close = () => {
            order.push('closed');
            r(true);
          };
        }),
    );
    const op = vi.fn((n: number) => {
      order.push(`op ${n}`);
    });
    const p = afterTextEdit(finish, op)(3);
    await Promise.resolve();
    expect(op).not.toHaveBeenCalled();
    close();
    await p;
    expect(order).toEqual(['closed', 'op 3']);
  });

  it('閉じられなかったら操作を走らせない', async () => {
    const op = vi.fn();
    await afterTextEdit(() => Promise.resolve(false), op)();
    expect(op).not.toHaveBeenCalled();
  });
});

describe('notifyWhenStuck', () => {
  it('閉じられなかったら知らせて false、閉じたら知らせずに true', async () => {
    const notify = vi.fn();
    expect(await notifyWhenStuck(() => Promise.resolve(false), notify)()).toBe(false);
    expect(notify).toHaveBeenCalledWith(TEXT_EDIT_STUCK_MESSAGE);
    notify.mockClear();
    expect(await notifyWhenStuck(() => Promise.resolve(true), notify)()).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  // 上限で打ち切って開いたままなら、操作は Undo も変更も積まずに取りやめ、利用者へ知らせる。
  it('上限時間で打ち切って編集が開いたままなら、操作を走らせず知らせる', async () => {
    vi.useFakeTimers();
    const f = fakeEditor();
    const notify = vi.fn();
    const op = vi.fn();
    const p = afterTextEdit(
      notifyWhenStuck(
        createFinishTextEdit(() => f.ed),
        notify,
      ),
      op,
    )();
    await vi.advanceTimersByTimeAsync(FINISH_TEXT_EDIT_TIMEOUT_MS);
    await p;
    expect(op).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(TEXT_EDIT_STUCK_MESSAGE);
  });
});
