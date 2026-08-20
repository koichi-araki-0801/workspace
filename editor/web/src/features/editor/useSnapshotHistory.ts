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
 * ジェスチャ(inline text 編集 / ハンドル drag)は開始時点では変更が起きるか分からないので、
 * `beginUndo` で開始時の snapshot を保留し、実際に変更があった時だけ `commitUndo` で past へ
 * 積む(無変更なら `cancelUndo`)。開始時に積むと `future` が消え、無変更で終えても Redo が
 * 失われるため、この 2 段構えにする。変更が確実な操作は `pushUndo` で即座に積んでよい。
 *
 * `init.onChange` を渡すと、スタックを変化させる操作(push/undo/redo/commit)のたびに
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
  // `beginUndo` が保留している開始時 snapshot。`T` 自体が null をとりうるのでラップして持つ。
  let pending: { snap: T } | null = null;
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

  /** snapshot を past へ積み、redo 分岐(`future`)を捨てる。 */
  function pushSnapshot(snap: T): void {
    past.push(snap);
    if (past.length > max) past.shift();
    future.length = 0;
    updateFlags();
  }

  /** 変更前の state を capture して即座に積む。変更が確実な操作の直前に呼ぶ。 */
  function pushUndo(): void {
    if (applying) return;
    pushSnapshot(capture());
  }

  /**
   * ジェスチャ開始時の state を保留 capture する。past / future はまだ動かさないので、
   * 無変更で終わっても Redo は残る。`commitUndo` / `cancelUndo` と対で使う。
   */
  function beginUndo(): void {
    if (applying) return;
    pending = { snap: capture() };
  }

  /** 保留中の開始時 snapshot を past へ積む(変更が実際に起きたときだけ呼ぶ)。 */
  function commitUndo(): void {
    if (!pending) return;
    const { snap } = pending;
    pending = null;
    pushSnapshot(snap);
  }

  /** 保留中の開始時 snapshot を捨てる(ジェスチャが無変更で終わったとき)。 */
  function cancelUndo(): void {
    pending = null;
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
    // 末尾から取り出す: `undo` が future へ push するので、末尾が直近に取り消した state。
    applySnap(future.pop() as T);
  }

  /**
   * 現在の undo スタック深さ。「元に戻す」トースト(`useTemplateEditor.ts`)が、操作時点の
   * 深さと押下時点の深さを比べて「その後に別の編集が積まれていないか」を判定するのに使う
   * (別の編集ごと巻き戻す事故を防ぐ)。
   */
  function depth(): number {
    return past.length;
  }

  return { canUndo, canRedo, pushUndo, beginUndo, commitUndo, cancelUndo, undo, redo, depth };
}
