import type { Editor } from 'grapesjs';
import { describe, expect, it, vi } from 'vitest';
import { createFinishTextEdit } from '@/features/editor/textEditFinish';

// =============================================================================
// textEditFinish.test.ts — Undo 可能な操作の前にテキスト編集(RTE)を閉じる関数
// =============================================================================
// 操作の `beginUndo` は、編集中の入力がモデルへ反映された後でないと、追記を含まない snapshot を
// 取る。閉じ終わり(GrapesJS の `disableEditing` の解決)まで待つこと、同時に呼ばれても閉じる
// 処理を 1 回にすること(`rte:disable` が 2 回出ると修正履歴にテキストの編集が 2 件残る)を確かめる。

/** `getEditing()` が編集中の component を返す偽 editor。`disableEditing` は手動で解決する。 */
function fakeEditor(editingNow: boolean) {
  let resolve: () => void = () => {};
  const disableEditing = vi.fn(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  let editing = editingNow;
  const ed = {
    getEditing: () => (editing ? { getView: () => ({ disableEditing }) } : undefined),
  } as unknown as Editor;
  return {
    ed,
    disableEditing,
    finish: () => {
      editing = false;
      resolve();
    },
  };
}

describe('createFinishTextEdit', () => {
  it('編集中でなければ disableEditing を呼ばずにすぐ解決する', async () => {
    const f = fakeEditor(false);
    await createFinishTextEdit(() => f.ed)();
    expect(f.disableEditing).not.toHaveBeenCalled();
  });

  it('editor が無ければすぐ解決する', async () => {
    await expect(createFinishTextEdit(() => null)()).resolves.toBeUndefined();
  });

  it('編集中なら disableEditing が解決するまで待つ', async () => {
    const f = fakeEditor(true);
    let done = false;
    const p = createFinishTextEdit(() => f.ed)().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(f.disableEditing).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    f.finish();
    await p;
    expect(done).toBe(true);
  });

  it('閉じている途中にもう一度呼ばれても、閉じる処理は 1 回で同じ完了を待つ', async () => {
    const f = fakeEditor(true);
    const finishTextEdit = createFinishTextEdit(() => f.ed);
    const a = finishTextEdit();
    const b = finishTextEdit();
    f.finish();
    await Promise.all([a, b]);
    expect(f.disableEditing).toHaveBeenCalledTimes(1);
  });

  it('disableEditing が失敗しても操作を止めない(解決する)', async () => {
    const disableEditing = vi.fn(() => Promise.reject(new Error('x')));
    const ed = {
      getEditing: () => ({ getView: () => ({ disableEditing }) }),
    } as unknown as Editor;
    await expect(createFinishTextEdit(() => ed)()).resolves.toBeUndefined();
  });

  it('disableEditing が同期で例外を投げても解決し、次の呼び出しで閉じ直せる', async () => {
    const disableEditing = vi.fn(() => {
      throw new Error('x');
    });
    const ed = {
      getEditing: () => ({ getView: () => ({ disableEditing }) }),
    } as unknown as Editor;
    const finishTextEdit = createFinishTextEdit(() => ed);
    await expect(finishTextEdit()).resolves.toBeUndefined();
    await finishTextEdit();
    expect(disableEditing).toHaveBeenCalledTimes(2);
  });
});
