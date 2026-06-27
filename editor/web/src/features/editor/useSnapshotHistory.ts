// =============================================================================
// useSnapshotHistory.ts — snapshot 方式の undo/redo composable
// =============================================================================
// 役割: 不透明な state `T` の snapshot を積んで undo/redo を提供する。GrapesJS の
// 詳細を history ロジックから切り離し、`useTemplateEditor.ts` から利用される。

import { ref } from 'vue';

/**
 * 不透明な state `T` に対する snapshot 方式の undo/redo。呼び出し側が現在 state の
 * `capture` 方法と、復元した snapshot の `apply` 方法を渡す。これにより editor の
 * GrapesJS 固有部分を history ロジックから切り離す(かつ単体テスト可能にする)。
 * GrapesJS 自前の UndoManager はプログラム経由の style 書き込みを確実には追えないため、
 * `useTemplateEditor.ts` がこれを使う。
 *
 * snapshot 適用中は `pushUndo` を no-op にするので、`apply` が新たな undo ステップを
 * 誤って記録せずに state を再構築できる。
 *
 * `init` に外部の `past`/`future` 配列を渡すと、それを参照で使う(in-place で push/pop/shift
 * するため呼び出し側のストアにそのまま永続化される)。編集⇄プレビュー往復で Undo/Redo を
 * 維持する `editorSession` ストアがこれを使い、再マウント時に既存スタックから復元する。
 * 未指定なら従来どおりローカル配列で開始する。
 *
 * `init.onChange` を渡すと、スタックを変化させる操作(push/undo/redo/discardLast)のたびに
 * 呼ぶ。`editorSession` ストアがこれで localStorage への永続ミラーを debounce 更新し、
 * リロード後も Undo/Redo を復元できるようにする。初期化時(フラグ復元)には発火しない。
 */
export function useSnapshotHistory<T>(
  capture: () => T,
  apply: (snap: T) => void,
  max = 100,
  init?: { past: T[]; future: T[]; onChange?: () => void },
) {
  const past: T[] = init?.past ?? [];
  const future: T[] = init?.future ?? [];
  const onChange = init?.onChange;
  const canUndo = ref(false);
  const canRedo = ref(false);
  let applying = false;
  // 外部スタックを渡された場合、既存エントリに合わせてフラグを初期化する
  // (再マウント時に Undo/Redo ボタンの活性を復元するため)。初期化中は onChange を抑止する。
  let started = false;
  updateFlags();
  started = true;

  function updateFlags(): void {
    canUndo.value = past.length > 0;
    canRedo.value = future.length > 0;
    if (started) onChange?.();
  }

  /** 変更前の state を capture する。記録対象の変更の直前に呼ぶ。 */
  function pushUndo(): void {
    if (applying) return;
    past.push(capture());
    if (past.length > max) past.shift();
    future.length = 0;
    updateFlags();
  }

  function applySnap(snap: T): void {
    applying = true;
    try {
      apply(snap);
    } finally {
      applying = false;
    }
    updateFlags();
  }

  function undo(): void {
    if (!past.length) return;
    future.push(capture());
    applySnap(past.pop() as T);
  }

  function redo(): void {
    if (!future.length) return;
    past.push(capture());
    applySnap(future.shift() as T);
  }

  /**
   * 直近の `pushUndo` snapshot を捨てる。変更を見込んで snapshot を取った(例: text
   * 編集 / drag 開始)が結果的に no-op だった場合に使い、空のステップを undo stack に
   * 残さないようにする。
   */
  function discardLast(): void {
    past.pop();
    updateFlags();
  }

  return { canUndo, canRedo, pushUndo, undo, redo, discardLast };
}
