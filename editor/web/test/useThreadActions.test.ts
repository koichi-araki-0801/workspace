// =============================================================================
// useThreadActions.test.ts — コメントのスレッド操作(編集・削除確認・解決切替)の回帰テスト
// =============================================================================
import type { PartNoteEntry } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  removeConfirmMessage,
  useThreadActions,
} from '../src/features/editor/comments/useThreadActions';

function entry(over: Partial<PartNoteEntry> = {}): PartNoteEntry {
  return {
    id: 'n1',
    templateId: 't1',
    pathKey: 'p',
    content: '本文',
    createdBy: 'a',
    createdAt: '2026-01-01T00:00:00Z',
    replyTo: null,
    status: 'open',
    ...over,
  } as PartNoteEntry;
}

function setup(replyCount = 0, ok = true) {
  const deps = {
    update: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
    replyCountOf: vi.fn(() => replyCount),
    confirm: vi.fn(async () => ok),
  };
  return { deps, t: useThreadActions(deps) };
}

describe('removeConfirmMessage', () => {
  it('親で返信が無いときは返信に触れない', () => {
    const m = removeConfirmMessage(true, 0);
    expect(m.title).toBe('このコメントを削除しますか？');
    expect(m.description).toBe('削除したコメントは元に戻せません。');
  });
  it('親で返信があるときだけ返信も消えると書く', () => {
    expect(removeConfirmMessage(true, 2).description).toBe(
      '削除したコメントは元に戻せません。返信も一緒に削除されます。',
    );
  });
  it('返信の削除は返信件数にかかわらず返信用の文言', () => {
    const m = removeConfirmMessage(false, 3);
    expect(m.title).toBe('この返信を削除しますか？');
    expect(m.description).toBe('削除した返信は元に戻せません。');
  });
});

describe('useThreadActions', () => {
  it('startEdit で対象と下書きが立ち、commitEdit で update して閉じる', () => {
    const { deps, t } = setup();
    const e = entry();
    t.startEdit(e);
    expect(t.editingKey.value).toBe('t1/n1');
    expect(t.draft.value).toBe('本文');
    t.draft.value = '新';
    t.commitEdit(e);
    expect(deps.update).toHaveBeenCalledWith(e, '新');
    expect(t.editingKey.value).toBeNull();
  });
  it('空白だけの下書きは update せず閉じる', () => {
    const { deps, t } = setup();
    const e = entry();
    t.startEdit(e);
    t.draft.value = '  ';
    t.commitEdit(e);
    expect(deps.update).not.toHaveBeenCalled();
    expect(t.editingKey.value).toBeNull();
  });
  it('cancelEdit は update せず閉じる', () => {
    const { deps, t } = setup();
    t.startEdit(entry());
    t.cancelEdit();
    expect(t.editingKey.value).toBeNull();
    expect(deps.update).not.toHaveBeenCalled();
  });
  it('requestRemove は確認が通ったときだけ remove する(親は返信件数を文言に反映)', async () => {
    const { deps, t } = setup(1, true);
    const e = entry();
    await t.requestRemove(e);
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '削除したコメントは元に戻せません。返信も一緒に削除されます。',
        confirmLabel: '削除する',
        variant: 'destructive',
      }),
    );
    expect(deps.remove).toHaveBeenCalledWith(e);
  });
  it('確認が拒否されたら remove しない', async () => {
    const { deps, t } = setup(0, false);
    await t.requestRemove(entry());
    expect(deps.remove).not.toHaveBeenCalled();
  });
  it('返信の削除は返信件数を問い合わせない', async () => {
    const { deps, t } = setup(5, true);
    await t.requestRemove(entry({ id: 'r1', replyTo: 'n1' }));
    expect(deps.replyCountOf).not.toHaveBeenCalled();
  });
  it('toggleStatus は open と resolved を反転して通知する', () => {
    const { deps, t } = setup();
    const e = entry();
    t.toggleStatus(e);
    expect(deps.setStatus).toHaveBeenCalledWith(e, 'resolved');
    t.toggleStatus(entry({ status: 'resolved' }));
    expect(deps.setStatus).toHaveBeenLastCalledWith(expect.anything(), 'open');
  });
});
