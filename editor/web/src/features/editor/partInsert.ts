// =============================================================================
// partInsert.ts — パーツの追加で Undo・修正履歴・プレビュー選択を積むかの分岐
// =============================================================================
// `useTemplateEditor.ts` の `onPartInsert` の本体。Vue と GrapesJS に依存しないよう操作を `deps` で
// 受け取り、挿入しなかったときに何も積まないことを単体で検証できるようにする。

import type { PartCatalogItem } from '@editor/shared';

/** パーツの追加が使う操作(`useTemplateEditor.ts` が Undo・canvas・修正履歴へつなぐ)。 */
export interface PartInsertDeps {
  /** 今のページに挿入できるか(`useGrapes.ts` の `canInsertPart`)。 */
  canInsert: () => boolean;
  beginUndo: () => void;
  commitUndo: () => void;
  cancelUndo: () => void;
  /** 挿入したかを返す(`useGrapes.ts` の `insertPart`)。 */
  insertPart: (content: string, partId: string) => boolean;
  /** 挿入直後のパーツを今の編集可否に従わせる。 */
  setEditable: () => void;
  setPreview: (p: PartCatalogItem) => void;
  recordChange: (label: string) => void;
}

/**
 * パーツ `p` を挿入し、挿入したときだけ Undo を確定して修正履歴とプレビュー選択を積む。挿入した
 * かを返す。無変更で積むと Redo が消え、修正履歴に実際には無い変更が残るため、挿入しなければ
 * 何も積まない(`resetGeom` と同じく開始時の snapshot を保留して捨てる)。挿入できないページでは
 * snapshot も取らずに戻る(ボタンも押せないが、本文の直列化を無駄にしないため)。
 */
export function insertPartUndoable(deps: PartInsertDeps, p: PartCatalogItem): boolean {
  if (!deps.canInsert()) return false;
  deps.beginUndo();
  if (!deps.insertPart(p.content, p.id)) {
    deps.cancelUndo();
    return false;
  }
  deps.commitUndo();
  deps.setEditable();
  deps.setPreview(p);
  deps.recordChange(`パーツ「${p.name}」を追加`);
  return true;
}
