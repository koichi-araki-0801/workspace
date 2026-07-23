// =============================================================================
// confirm.test.ts — グローバル確認ダイアログの Promise API の回帰テスト
// =============================================================================
// `ConfirmDialog.vue` の capture-resolve 前提(確定ボタンの click 後に bubble してくる
// close を no-op にする)が崩れると「確定が常に false になる」退行を起こすため、
// resolve 済み後の再 resolve が無害であることを重点的に固定する。
import { beforeEach, describe, expect, it } from 'vitest';
import { confirm, confirmState, resolveConfirm } from '../src/components/ui/confirm';

beforeEach(() => {
  confirmState.value = {
    title: '',
    description: undefined,
    confirmLabel: 'OK',
    cancelLabel: 'キャンセル',
    variant: 'default',
    open: false,
    resolve: null,
  };
});

describe('confirm', () => {
  it('開いた状態と既定ラベルを confirmState へ反映する', () => {
    void confirm({ title: '削除しますか?' });
    expect(confirmState.value.open).toBe(true);
    expect(confirmState.value.title).toBe('削除しますか?');
    expect(confirmState.value.confirmLabel).toBe('OK');
    expect(confirmState.value.cancelLabel).toBe('キャンセル');
    expect(confirmState.value.variant).toBe('default');
  });

  it('オプション指定がラベル/variant を上書きする', () => {
    void confirm({
      title: 't',
      description: 'd',
      confirmLabel: '削除',
      cancelLabel: 'やめる',
      variant: 'destructive',
    });
    expect(confirmState.value.description).toBe('d');
    expect(confirmState.value.confirmLabel).toBe('削除');
    expect(confirmState.value.cancelLabel).toBe('やめる');
    expect(confirmState.value.variant).toBe('destructive');
  });

  it('resolveConfirm(true) で true を resolve し、ダイアログを閉じる', async () => {
    const result = confirm({ title: 't' });
    resolveConfirm(true);
    await expect(result).resolves.toBe(true);
    expect(confirmState.value.open).toBe(false);
    expect(confirmState.value.resolve).toBeNull();
  });

  it('resolveConfirm(false)(キャンセル/dismiss)で false を resolve する', async () => {
    const result = confirm({ title: 't' });
    resolveConfirm(false);
    await expect(result).resolves.toBe(false);
    expect(confirmState.value.open).toBe(false);
  });

  it('resolve 済み後の resolveConfirm は no-op(capture-resolve の後続 close を無害化)', async () => {
    const result = confirm({ title: 't' });
    resolveConfirm(true);
    // `reka-ui` の `update:open`(false) 経由で後追いの false が来ても結果は変わらない。
    resolveConfirm(false);
    await expect(result).resolves.toBe(true);
    expect(confirmState.value.open).toBe(false);
  });
});
