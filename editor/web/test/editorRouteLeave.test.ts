import { ok } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import { confirmState, resolveConfirm } from '@/components/ui/confirm';
import { leaveAfterSave } from '@/features/editor/leaveGuard';
import { useAutosave } from '@/features/editor/useAutosave';

describe('leaveAfterSave', () => {
  it('debounce 待ちの変更を 1 回保存してから離れる', async () => {
    const save = vi.fn(async () => ok(undefined));
    const autosave = useAutosave(save, 60_000);
    autosave.trigger();
    const ask = vi.fn(async () => true);

    expect(await leaveAfterSave(autosave.flush, {}, ask)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it('保存済みなら何も保存せず確認も出さずに離れる', async () => {
    const save = vi.fn(async () => ok(undefined));
    const autosave = useAutosave(save, 60_000);
    const ask = vi.fn(async () => true);

    expect(await leaveAfterSave(autosave.flush, {}, ask)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('保存に失敗したら「離れる / 留まる」を確かめ、留まるなら離れない', async () => {
    const ask = vi.fn(async () => false);

    expect(await leaveAfterSave(async () => false, {}, ask)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '変更を保存できませんでした',
        confirmLabel: '離れる',
        cancelLabel: '留まる',
        variant: 'destructive',
      }),
    );
  });

  it('保存に失敗しても「離れる」を選べば離れる', async () => {
    const ask = vi.fn(async () => true);

    expect(await leaveAfterSave(async () => false, {}, ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('既定ではアプリの確認ダイアログで確かめる', async () => {
    const leaving = leaveAfterSave(async () => false);
    await vi.waitFor(() => expect(confirmState.value.open).toBe(true));
    expect(confirmState.value.confirmLabel).toBe('離れる');
    resolveConfirm(false);
    expect(await leaving).toBe(false);
  });

  it('ログイン画面へ移されるときは、保存を試みたうえで結果によらず確認せずに離れる', async () => {
    const flush = vi.fn(async () => false);
    const ask = vi.fn(async () => false);

    expect(await leaveAfterSave(flush, { toLogin: true }, ask)).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });
});
