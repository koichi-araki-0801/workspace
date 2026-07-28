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
import { K } from '@/api/local/store';

/** Undo/Redo 用の不透明スナップショット(editor の capture と一致: body HTML + CSS)。 */
export interface EditorSnapshot {
  html: string;
  css: string;
}

/** 1 テンプレートの編集セッション state。編集⇄プレビュー往復を跨いで保持する。 */
interface EditSession {
  /** パーツ構造キー(`partKey`)ごとのセッション内修正履歴(新しい順)。 */
  partHistory: Record<string, PartHistoryEntry[]>;
  /** セッション内履歴エントリ id の採番カウンタ。 */
  seq: number;
  /** Undo スタック(過去スナップショット)。 */
  undoPast: EditorSnapshot[];
  /** Redo スタック(未来スナップショット)。 */
  undoFuture: EditorSnapshot[];
}

/** localStorage に保持する Undo/Redo の永続ミラー。`Record<templateId, {past, future}>`。 */
type UndoMap = Record<string, { past: EditorSnapshot[]; future: EditorSnapshot[] }>;

// 永続ミラーの深度上限。in-memory は 100 のまま維持し、localStorage へ書く分だけ直近に絞る。
// 1 snapshot は html+css で概ね 30-40KB あり、深く積むと localStorage(約5MB)を圧迫するため。
const UNDO_PERSIST_CAP = 20;

/** Undo 永続ミラーを読む(壊れていれば空)。 */
function readUndoMap(): UndoMap {
  try {
    return JSON.parse(localStorage.getItem(K.undoStacks) ?? '{}') as UndoMap;
  } catch {
    return {};
  }
}

/** Undo 永続ミラーを書く。quota 等で失敗しても throw せず false を返す(編集を止めない)。 */
function writeUndoMap(map: UndoMap): boolean {
  try {
    localStorage.setItem(K.undoStacks, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/**
 * 編集セッションストア。`templateId` をキーに編集セッション state を保持し、編集画面と
 * プレビュー画面の往復を跨いで履歴/Undo/Redo を維持する。`useTemplateEditor.ts` が
 * `ensure` で結線し、メニュー復帰での破棄(`useTemplateEditor`)と確定保存(`PreviewView`)で
 * `clear` する。Undo/Redo は加えて localStorage へ debounce 永続化し、リロード後も復元する
 * (`persist`/`ensure` の hydrate)。
 */
export const useEditorSessionStore = defineStore('editorSession', () => {
  const sessions = reactive<Record<string, EditSession>>({});

  /** 編集セッションを取得する。無ければ Undo 永続ミラーから hydrate して生成する。 */
  function ensure(templateId: string): EditSession {
    if (!sessions[templateId]) {
      // 永続ミラーから Undo/Redo を同期で流し込む(`useSnapshotHistory` が参照を読む前に確定)。
      const e = readUndoMap()[templateId];
      sessions[templateId] = {
        partHistory: {},
        seq: 0,
        undoPast: e?.past ?? [],
        undoFuture: e?.future ?? [],
      };
    }
    // reactive proxy を返す(生 object でなく): partHistory の変更追跡を効かせ、
    // 再 ensure 時も同一 proxy を返して履歴を継続させる。
    return sessions[templateId];
  }

  /**
   * 当該テンプレートの Undo/Redo を localStorage へ best-effort で永続化する。深度を
   * `UNDO_PERSIST_CAP` に絞り、quota 時は他テンプレートを LRU(キー挿入順の古い側)で間引いて
   * 再試行、なお不足なら自身の深度を半減させる。最後まで失敗しても黙って諦める(編集は止めない)。
   */
  function persist(templateId: string): void {
    const sess = sessions[templateId];
    if (!sess) return;
    const past = sess.undoPast.slice(-UNDO_PERSIST_CAP);
    // future[0] が次の redo 対象なので前方を残す。
    const future = sess.undoFuture.slice(0, UNDO_PERSIST_CAP);
    const map = readUndoMap();
    delete map[templateId]; // 削除→再追加でキー順の末尾=最近使用に置く(LRU 用)。
    map[templateId] = { past, future };
    if (writeUndoMap(map)) return;

    // quota: 他テンプレートを古い側から間引いて再試行する。
    for (const k of Object.keys(map).filter((k) => k !== templateId)) {
      delete map[k];
      if (writeUndoMap(map)) return;
    }
    // 自身だけでも入らない: 深度を半減させながら再試行する。
    let depth = past.length;
    while (depth > 0) {
      depth = Math.floor(depth / 2);
      map[templateId] = {
        past: past.slice(-depth),
        future: future.slice(0, depth),
      };
      if (writeUndoMap(map)) return;
    }
    // ここまで来たら保存は諦める(throw しない)。
  }

  /** 編集セッションを破棄する(メニュー復帰での破棄 / 確定保存後)。永続ミラーも消す。 */
  function clear(templateId: string): void {
    delete sessions[templateId];
    const map = readUndoMap();
    if (templateId in map) {
      delete map[templateId];
      writeUndoMap(map); // best-effort(消せなくても実害なし)
    }
  }

  return { sessions, ensure, persist, clear };
});
