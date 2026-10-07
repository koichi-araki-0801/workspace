// =============================================================================
// textEditFinish.ts — Undo 可能な操作の前にテキスト編集(RTE)を閉じる
// =============================================================================
// 役割: `useGrapes.ts` の `finishTextEdit` の本体と、操作をその後ろへ回す `afterTextEdit`。
// Vue に依存しないよう editor の取得だけを受け取り、単体テストで閉じ終わりの待ち方・同時
// 呼び出し・上限時間・操作の順序を確かめられるようにする。

import type { Editor } from 'grapesjs';

/**
 * 閉じ終わりを待つ上限(ms)。GrapesJS の閉じる処理は microtask だけで終わるので、ふだんは
 * これに届かない。同期を取るための待ち時間ではなく、閉じる処理が解決しない異常時に操作を
 * 黙って止めないための打ち切り。イベント待ちとして十分に長くとる。
 */
export const FINISH_TEXT_EDIT_TIMEOUT_MS = 5000;

/**
 * テキスト編集中なら編集を閉じ、入力がモデルへ反映されるまで待つ関数を作る。編集中でなければ
 * すぐ解決する。
 *
 * GrapesJS は編集中の入力を DOM にだけ持ち、モデルへは編集を閉じるとき(`disableEditing` の
 * `syncContent`)に反映する。snapshot はモデルから取るので、閉じる前に操作の `beginUndo` を
 * 呼ぶと追記を含まない開始時点になり、追記が操作の 1 手に混ざる。マウスなら `mousedown` で
 * 先に閉じるが、キーボードでボタンを押すと閉じないので、操作の入口でこれを待つ。
 *
 * GrapesJS を上げるときの確認点: `disableEditing` は `ComponentTextView` の `@private` API で、
 * `getView()` の型(`ComponentView`)には無いのでキャストして呼んでいる。また、その Promise が
 * `rte:disable` の通知(`grapesEvents.ts` がテキスト編集を確定する)→ `syncContent`(モデルへの
 * 反映)の後で解決するという順序に依存している(0.23.6 の `grapes.mjs` で確認)。どちらかが
 * 変わると、操作の snapshot が追記を含まなくなる。
 *
 * 閉じている途中の呼び出しには同じ Promise を返す。2 回閉じると `rte:disable` が 2 回出て、
 * 修正履歴にテキストの編集が 2 件残る。閉じる処理が失敗しても、`timeoutMs` を過ぎても解決しなくても、
 * 操作は続けたいので解決する。
 */
export function createFinishTextEdit(
  getEditor: () => Editor | null | undefined,
  timeoutMs = FINISH_TEXT_EDIT_TIMEOUT_MS,
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const done = Promise.race([
      Promise.resolve(closing).then(
        () => undefined,
        () => undefined,
      ),
      giveUp,
    ]).finally(() => {
      clearTimeout(timer);
      inFlight = null;
    });
    inFlight = done;
    return done;
  };
}

/**
 * `op` を、テキスト編集を閉じ終えてから走らせる関数にする。Undo 可能な操作の入口に被せ、
 * 追記をその操作の 1 手に混ぜない(`createFinishTextEdit`)。
 */
export function afterTextEdit<A extends unknown[]>(
  finishTextEdit: () => Promise<void>,
  op: (...args: A) => void,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    await finishTextEdit();
    op(...args);
  };
}
