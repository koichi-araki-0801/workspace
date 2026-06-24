// =============================================================================
// editorSession.ts — 編集セッション(履歴 + Undo/Redo)の Pinia ストア
// =============================================================================
// 役割: 編集画面の「修正履歴」と Undo/Redo スタックを `EditorView.vue` の外へ持ち上げ、
// `templateId` をキーに保持する。Pinia ストアはシングルトンのため、`/edit/:id` ⇄
// `/preview/:id` の往復で `EditorView` がアンマウント/再マウントされても state が生存し、
// プレビューから戻った時に履歴と Undo/Redo がそのまま継続する。セッションは「メニューへの
// 破棄」または「確定保存」で終了し、その時 `clear` で破棄する。

import type { PartHistoryEntry } from '@editor/shared';
import { defineStore } from 'pinia';
import { reactive } from 'vue';

/** Undo/Redo 用の不透明スナップショット(editor の capture と一致: body HTML + CSS)。 */
export interface EditorSnapshot {
  html: string;
  css: string;
}

/** 1 テンプレートの編集セッション state。編集⇄プレビュー往復を跨いで保持する。 */
export interface EditSession {
  /** canvas component id ごとのセッション内修正履歴(新しい順)。 */
  partHistory: Record<string, PartHistoryEntry[]>;
  /** セッション内履歴エントリ id の採番カウンタ。 */
  seq: number;
  /** Undo スタック(過去スナップショット)。 */
  undoPast: EditorSnapshot[];
  /** Redo スタック(未来スナップショット)。 */
  undoFuture: EditorSnapshot[];
}

/**
 * 編集セッションストア。`templateId` をキーに編集セッション state を保持し、編集画面と
 * プレビュー画面の往復を跨いで履歴/Undo/Redo を維持する。`useTemplateEditor.ts` が
 * `ensure` で結線し、メニュー復帰での破棄(`useTemplateEditor`)と確定保存(`PreviewView`)で
 * `clear` する。
 */
export const useEditorSessionStore = defineStore('editorSession', () => {
  const sessions = reactive<Record<string, EditSession>>({});

  /** 編集セッションを取得する。無ければ空で生成して返す。 */
  function ensure(templateId: string): EditSession {
    if (!sessions[templateId]) {
      sessions[templateId] = { partHistory: {}, seq: 0, undoPast: [], undoFuture: [] };
    }
    // reactive proxy を返す(生 object でなく): partHistory の変更追跡を効かせ、
    // 再 ensure 時も同一 proxy を返して履歴を継続させる。
    return sessions[templateId];
  }

  /** 編集セッションを破棄する(メニュー復帰での破棄 / 確定保存後)。 */
  function clear(templateId: string): void {
    delete sessions[templateId];
  }

  return { sessions, ensure, clear };
});
