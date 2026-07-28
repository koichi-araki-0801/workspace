// =============================================================================
// useEditorShortcuts.ts — editor 画面のグローバルキーボードショートカット
// =============================================================================
// 役割: `window` の `keydown` を 1 か所で受け、上部バーのボタンと同じ操作(元に戻す /
// やり直す / 保存 / ズーム / 削除)をキーから起こす。GrapesJS は canvas iframe の
// キー入力を親 document へ転送するため、この 1 リスナで canvas 上の操作も拾える。
// GrapesJS 既定 keymap は `useGrapes.ts` の `init` で撤去済みで、ショートカットの単一
// 情報源はここに集約する。

import { onBeforeUnmount, onMounted } from 'vue';

/** ヘルプ表示用のショートカット 1 件。`keys` は kbd で並べる表示トークン列。 */
interface ShortcutInfo {
  keys: string[];
  label: string;
  /** 代替キーや適用条件の補足(任意)。 */
  note?: string;
}

/**
 * ショートカット一覧(`ShortcutHelpDialog.vue` の表示元)。ハンドラ実装と同じファイルに
 * 置いて単一情報源を保つ — キーの追加/変更時はこの一覧と下の `onKeydown` を必ず揃えること。
 */
export const SHORTCUT_LIST: readonly ShortcutInfo[] = [
  { keys: ['Ctrl/⌘', 'S'], label: '今すぐ保存' },
  { keys: ['Ctrl/⌘', 'Z'], label: '元に戻す' },
  { keys: ['Shift', 'Ctrl/⌘', 'Z'], label: 'やり直す', note: 'Ctrl+Y でも可' },
  { keys: ['Delete'], label: '選択パーツを削除', note: '編集を許可中のみ' },
  { keys: ['Ctrl/⌘', '+'], label: '拡大' },
  { keys: ['Ctrl/⌘', '-'], label: '縮小' },
  { keys: ['Ctrl/⌘', '0'], label: '画面に合わせる' },
  { keys: ['?'], label: 'このヘルプを表示' },
];

/**
 * ショートカットから呼ぶハンドラ群。`can*` は実行可否(無効ならキー既定動作へ委ねる)、
 * `isTextEditing` は canvas の inline text 編集中か(編集中は undo/redo/delete を奪わない)。
 */
interface EditorShortcutHandlers {
  undo: () => void;
  redo: () => void;
  save: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** 全体にフィット(`Ctrl/⌘+0`)。 */
  zoomReset: () => void;
  /** 選択パーツの削除(`Delete`)。 */
  remove: () => void;
  /** ショートカットヘルプの表示(`?`)。未指定ならキーを奪わない。 */
  help?: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** 削除可否(編集許可かつ選択あり)。 */
  canRemove: () => boolean;
  isTextEditing: () => boolean;
}

/** `input` / `textarea` / `select` / contenteditable へフォーカス中か(キーを横取りしない)。 */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * editor 画面のグローバルショートカットを `window` に登録する(mount 中のみ)。
 * 文言は `EditorTopBar.vue` のボタン title(⌘Z 等)と一致させること。
 */
export function useEditorShortcuts(h: EditorShortcutHandlers): void {
  function onKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // ── 1. 編集状態に依らず効く操作(保存 / ズーム) ──
    // 保存はテキスト編集中でも安全。ズームはブラウザ既定ズームを抑止して canvas を操作する。
    if (mod && key === 's') {
      e.preventDefault();
      h.save();
      return;
    }
    if (mod && (key === '=' || key === '+')) {
      e.preventDefault();
      h.zoomIn();
      return;
    }
    if (mod && key === '-') {
      e.preventDefault();
      h.zoomOut();
      return;
    }
    if (mod && key === '0') {
      e.preventDefault();
      h.zoomReset();
      return;
    }

    // ── 2. テキスト編集と競合する操作は、編集中・入力欄フォーカス中は委ねる ──
    // canvas の RTE 編集中(`isTextEditing`)や数値入力欄では、ネイティブの undo/文字削除を活かす。
    if (h.isTextEditing() || isEditableTarget(e.target)) return;

    if (mod && key === 'z' && !e.shiftKey) {
      if (!h.canUndo()) return;
      e.preventDefault();
      h.undo();
      return;
    }
    if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) {
      if (!h.canRedo()) return;
      e.preventDefault();
      h.redo();
      return;
    }
    if (key === 'delete') {
      if (!h.canRemove()) return;
      e.preventDefault();
      h.remove();
      return;
    }
    // `?`(Shift+/)でヘルプ。入力欄・RTE 中は上の早期 return 済みなので文字入力を奪わない。
    if (!mod && key === '?' && h.help) {
      e.preventDefault();
      h.help();
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
}
