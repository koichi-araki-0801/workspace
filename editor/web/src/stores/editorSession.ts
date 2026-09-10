// =============================================================================
// editorSession.ts — 編集セッション(履歴 + Undo/Redo)の Pinia ストア
// =============================================================================
// 役割: 編集画面の「修正履歴」と Undo/Redo スタックを `EditorView.vue` の外へ持ち上げ、
// `templateId` をキーに保持する。Pinia ストアはシングルトンのため、`/edit/:id` ⇄
// `/preview/:id` の往復で `EditorView` がアンマウント/再マウントされても state が生存し、
// プレビューから戻った時に履歴と Undo/Redo がそのまま継続する。タブ遷移でも破棄しない
// (編集セッションはブラウザタブの寿命)。セッションは「確定保存」で終了し、その時 `clear` で破棄する。

import type { PartHistoryEntry } from '@editor/shared';
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { editorUiKey, undoStacksKey } from '@/lib/storageKeys';

/** Undo/Redo 用の不透明スナップショット(editor の capture と一致: body HTML + CSS)。 */
export interface EditorSnapshot {
  html: string;
  css: string;
}

/**
 * 編集画面の UI 状態。「編集セッションはブラウザタブの寿命」の一部として、プレビュー往復
 * (SPA 遷移)では丸ごと保持する。倍率・表示系だけは `persistUi` で localStorage へも永続し
 * リロード後も戻す。`allowEdit`/`selectedKey` は永続しない(リロード後は安全側の既定へ戻る)。
 */
export interface EditorUiState {
  /** 「編集を許可」トグル(永続しない — リロード後は安全側の既定 OFF)。 */
  allowEdit: boolean;
  /** 赤入れ表示。既定 OFF(ボタンで明示したときだけ差分を出す)。ON/OFF は永続する。 */
  redlineEnabled: boolean;
  paneTab: 'props' | 'comments';
  /** canvas の倍率。null は「まだ決めていない」= 起動時の既定(100%)。 */
  zoom: number | null;
  singlePageMode: boolean;
  currentPage: number;
  showPageGuides: boolean;
  /** 選択パーツの構造キー(永続しない — リロード後は未選択から)。 */
  selectedKey: string | null;
}

export function defaultEditorUiState(): EditorUiState {
  return {
    allowEdit: false,
    redlineEnabled: false,
    paneTab: 'props',
    zoom: null,
    singlePageMode: true,
    currentPage: 0,
    showPageGuides: true,
    selectedKey: null,
  };
}

/** localStorage へ永続する部分だけの形(`allowEdit`/`selectedKey` を除く)。 */
type PersistedUi = Omit<EditorUiState, 'allowEdit' | 'selectedKey'>;
type UiMap = Record<string, PersistedUi>;

/**
 * 永続ミラーから読んだ生値を検証し、型が合わないフィールドだけ既定値へ落とす。手書き編集・
 * 旧バージョンとの互換切れ等で壊れた値(例: `zoom` が文字列)がそのまま `setZoom` 等へ渡ると
 * `NaN` clamp のような実害になるため、hydrate の時点で 1 フィールドずつ検証する。
 */
function sanitizePersistedUi(raw: unknown): Partial<PersistedUi> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const def = defaultEditorUiState();
  const out: Partial<PersistedUi> = {};
  out.zoom = typeof r.zoom === 'number' && Number.isFinite(r.zoom) ? r.zoom : null;
  out.currentPage =
    typeof r.currentPage === 'number' && Number.isInteger(r.currentPage) && r.currentPage >= 0
      ? r.currentPage
      : 0;
  out.redlineEnabled =
    typeof r.redlineEnabled === 'boolean' ? r.redlineEnabled : def.redlineEnabled;
  out.singlePageMode =
    typeof r.singlePageMode === 'boolean' ? r.singlePageMode : def.singlePageMode;
  out.showPageGuides =
    typeof r.showPageGuides === 'boolean' ? r.showPageGuides : def.showPageGuides;
  out.paneTab = r.paneTab === 'props' || r.paneTab === 'comments' ? r.paneTab : def.paneTab;
  return out;
}

/** UI 状態永続ミラーを読む(壊れていれば空)。 */
function readUiMap(): UiMap {
  try {
    return JSON.parse(localStorage.getItem(editorUiKey()) ?? '{}') as UiMap;
  } catch {
    return {};
  }
}

/** UI 状態永続ミラーを書く。quota 等で失敗しても throw しない(倍率が戻らないだけ)。 */
function writeUiMap(map: UiMap): void {
  try {
    localStorage.setItem(editorUiKey(), JSON.stringify(map));
  } catch {
    /* 諦める(倍率が戻らないだけ) */
  }
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
  /** 画面の UI 状態(倍率・表示系・編集許可・選択)。 */
  ui: EditorUiState;
}

/** localStorage に保持する Undo/Redo の永続ミラー。`Record<templateId, {past, future}>`。 */
type UndoMap = Record<string, { past: EditorSnapshot[]; future: EditorSnapshot[] }>;

// 永続ミラーの深度上限。in-memory は 100 のまま維持し、localStorage へ書く分だけ直近に絞る。
// 1 snapshot は html+css で概ね 30-40KB あり、深く積むと localStorage(約5MB)を圧迫するため。
const UNDO_PERSIST_CAP = 20;

/** Undo 永続ミラーを読む(壊れていれば空)。 */
function readUndoMap(): UndoMap {
  try {
    return JSON.parse(localStorage.getItem(undoStacksKey()) ?? '{}') as UndoMap;
  } catch {
    return {};
  }
}

/** Undo 永続ミラーを書く。quota 等で失敗しても throw せず false を返す(編集を止めない)。 */
function writeUndoMap(map: UndoMap): boolean {
  try {
    localStorage.setItem(undoStacksKey(), JSON.stringify(map));
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
        // `allowEdit`/`selectedKey` は永続ミラーに含まれない(常に既定のまま)。
        ui: { ...defaultEditorUiState(), ...sanitizePersistedUi(readUiMap()[templateId]) },
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
    // future の末尾が次の redo 対象(`useSnapshotHistory` の redo は pop)なので後方を残す。
    const future = sess.undoFuture.slice(-UNDO_PERSIST_CAP);
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
        future: future.slice(-depth),
      };
      if (writeUndoMap(map)) return;
    }
    // ここまで来たら保存は諦める(throw しない)。
  }

  /**
   * 当該テンプレートの UI 状態(倍率・表示系)を localStorage へ永続化する。`allowEdit` と
   * `selectedKey` は除く(リロード後は安全側の既定 OFF・未選択から始める)。
   */
  function persistUi(templateId: string): void {
    const sess = sessions[templateId];
    if (!sess) return;
    const { allowEdit: _allowEdit, selectedKey: _selectedKey, ...rest } = sess.ui;
    const map = readUiMap();
    map[templateId] = rest;
    writeUiMap(map);
  }

  /**
   * Undo/Redo スタックだけを空にする。別タブが残した下書きを破棄して確定版から開いたとき
   * (`loadForEdit` の `discardedStaleDraft`)に呼ぶ — 残すと Undo 1 回で破棄したはずの本文が
   * 戻り、autosave がそれを下書きとして書き戻してしまうため。`useSnapshotHistory` が配列を
   * 参照で握っているので、差し替えずに in-place で空にする。修正履歴と採番はセッションの
   * 記録なので保つ。
   */
  function reset(templateId: string): void {
    const sess = ensure(templateId);
    sess.undoPast.length = 0;
    sess.undoFuture.length = 0;
    persist(templateId); // 永続ミラーも空にする(リロードで再び hydrate されないように)
  }

  /** 編集セッションを破棄する(メニュー復帰での破棄 / 確定保存後)。永続ミラーも消す。 */
  function clear(templateId: string): void {
    delete sessions[templateId];
    const map = readUndoMap();
    if (templateId in map) {
      delete map[templateId];
      writeUndoMap(map); // best-effort(消せなくても実害なし)
    }
    const uiMap = readUiMap();
    if (templateId in uiMap) {
      delete uiMap[templateId];
      writeUiMap(uiMap);
    }
  }

  return { sessions, ensure, persist, persistUi, reset, clear };
});
