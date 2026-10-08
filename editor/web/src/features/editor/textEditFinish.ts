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
 * テキスト編集中なら編集を閉じ、入力がモデルへ反映されるまで待つ関数を作る。解決値は、待ち終えた
 * 時点で編集が閉じているか(編集中でなければすぐ true)。
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
 * `disableEditing` は 1 回の編集につき 1 回だけ呼び、その Promise が決着するまで持ち続ける。
 * 閉じている途中や、上限時間で打ち切った後に呼ばれても同じ Promise を待ち直す。呼び直すと
 * `rte:disable` が 2 回出て、修正履歴にテキストの編集が 2 件残る。閉じる処理の失敗は握りつぶし、
 * 結果は編集が閉じたかどうかだけで返す。false なら呼び出し側は操作を取りやめる(`afterTextEdit`)。
 *
 * 取りやめた操作は画面に何も起きず、押しても効かないように見えるので、`onStuck` で知らせる。
 * 同じ閉じる処理を待っている間に何度押されても、知らせは 1 回にまとめる(押すたびに出すと
 * トーストが積み重なる)。
 */
export function createFinishTextEdit(
  getEditor: () => Editor | null | undefined,
  opts: { timeoutMs?: number; onStuck?: (message: string) => void } = {},
): () => Promise<boolean> {
  const { timeoutMs = FINISH_TEXT_EDIT_TIMEOUT_MS, onStuck } = opts;
  let closing: Promise<void> | null = null;
  // 知らせ済みの閉じる処理。同じ処理で打ち切られた 2 回目以降は知らせない。
  let notifiedFor: Promise<void> | null = null;
  const editingNow = () => !!getEditor()?.getEditing();
  const stuck = (attempt: Promise<void> | null): false => {
    if (attempt === null || attempt !== notifiedFor) onStuck?.(TEXT_EDIT_STUCK_MESSAGE);
    notifiedFor = attempt;
    return false;
  };
  return async () => {
    if (!closing) {
      const view = getEditor()?.getEditing()?.getView() as
        | { disableEditing?: () => Promise<void> | void }
        | undefined;
      if (!view?.disableEditing) return editingNow() ? stuck(null) : true;
      let res: Promise<void> | void;
      try {
        res = view.disableEditing();
      } catch {
        res = undefined;
      }
      const settled = Promise.resolve(res).then(
        () => undefined,
        () => undefined,
      );
      closing = settled;
      void settled.then(() => {
        closing = null;
      });
    }
    const attempt = closing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([attempt, giveUp]);
    clearTimeout(timer);
    return editingNow() ? stuck(attempt) : true;
  };
}

/** テキスト編集を閉じられず操作を取りやめたときに利用者へ出す文言。 */
export const TEXT_EDIT_STUCK_MESSAGE =
  'テキストの編集を閉じられなかったため、操作を取りやめました。紙面の文字の外をクリックしてから、もう一度操作してください';

/**
 * `op` を、テキスト編集を閉じ終えてから走らせる関数にする。Undo 可能な操作の入口に被せ、
 * 追記をその操作の 1 手に混ぜない(`createFinishTextEdit`)。閉じられなかったら `op` は走らせない。
 * 編集が開いたまま走らせると、`beginUndo` の操作では追記が独立した 1 手にならず、`pushUndo` の
 * 操作では後から閉じたテキスト編集の 1 手が操作より後ろに積まれて Undo の順序が逆になる。
 * 利用者へ知らせるのは `finishTextEdit` 側(`createFinishTextEdit` の `onStuck`)。
 */
export function afterTextEdit<A extends unknown[]>(
  finishTextEdit: () => Promise<boolean>,
  op: (...args: A) => void,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    if (await finishTextEdit()) op(...args);
  };
}
