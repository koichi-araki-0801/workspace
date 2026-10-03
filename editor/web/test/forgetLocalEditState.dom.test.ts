// =============================================================================
// forgetLocalEditState.dom.test.ts — 作り直した id の、同じタブに残る編集状態を捨てる
// =============================================================================
// 作り直したテンプレートを開いたとき、前の生成物の Undo が残っていると 1 回の Undo で捨てたはずの
// 本文が戻り、autosave がそれを下書きとして書き戻す。下書きの持ち主の記録も前の作業のもの。
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetLocalEditState } from '@/features/templates/services/templateCreationService';
import { draftOwner } from '@/lib/draftOwner';
import { draftOwnerKey, undoStacksKey } from '@/lib/storageKeys';
import { useEditorSessionStore } from '@/stores/editorSession';

const ID = 'AM01_510037_交付版';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});

describe('forgetLocalEditState', () => {
  it('編集セッション(Undo とその永続ミラー)と下書きの持ち主を捨て、他の id には触れない', () => {
    const store = useEditorSessionStore();
    store.ensure(ID).undoPast.push({ html: '<p>前の生成物</p>', css: '' });
    store.persist(ID);
    store.ensure('AM01_510003_交付版').undoPast.push({ html: '<p>別</p>', css: '' });
    store.persist('AM01_510003_交付版');
    draftOwner.claim(ID);

    forgetLocalEditState(ID);

    expect(store.sessions[ID]).toBeUndefined();
    const undo = JSON.parse(localStorage.getItem(undoStacksKey()) ?? '{}');
    expect(undo).not.toHaveProperty(ID);
    expect(undo).toHaveProperty('AM01_510003_交付版');
    expect(JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}')).not.toHaveProperty(ID);
  });
});
