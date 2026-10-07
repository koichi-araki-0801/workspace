// =============================================================================
// textEditFinish.ts — Undo 可能な操作の前にテキスト編集(RTE)を閉じる
// =============================================================================
// 役割: `useGrapes.ts` の `finishTextEdit` の本体。Vue に依存しないよう editor の取得だけを
// 受け取り、単体テストで閉じ終わりの待ち方と同時呼び出しを確かめられるようにする。

import type { Editor } from 'grapesjs';

/**
 * テキスト編集中なら編集を閉じ、入力がモデルへ反映されるまで待つ関数を作る。編集中でなければ
 * すぐ解決する。
 *
 * GrapesJS は編集中の入力を DOM にだけ持ち、モデルへは編集を閉じるとき(`disableEditing` の
 * `syncContent`)に反映する。snapshot はモデルから取るので、閉じる前に操作の `beginUndo` を
 * 呼ぶと追記を含まない開始時点になり、追記が操作の 1 手に混ざる。マウスなら `mousedown` で
 * 先に閉じるが、キーボードでボタンを押すと閉じないので、操作の入口でこれを待つ。
 * `disableEditing` の Promise は反映と `rte:disable` の通知(テキスト編集の確定)が済んで解決する。
 *
 * 閉じている途中の呼び出しには同じ Promise を返す。2 回閉じると `rte:disable` が 2 回出て、
 * 修正履歴にテキストの編集が 2 件残る。閉じる処理が失敗しても操作は続けたいので、失敗でも解決する。
 */
export function createFinishTextEdit(
  getEditor: () => Editor | null | undefined,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const view = getEditor()?.getEditing()?.getView() as
      | { disableEditing?: () => Promise<void> | void }
      | undefined;
    if (!view?.disableEditing) return Promise.resolve();
    let closing: Promise<void> | void;
    try {
      closing = view.disableEditing();
    } catch {
      closing = undefined;
    }
    const done = Promise.resolve(closing)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        inFlight = null;
      });
    inFlight = done;
    return done;
  };
}
