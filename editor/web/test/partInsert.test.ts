import type { PartCatalogItem } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { insertPartUndoable, type PartInsertDeps } from '@/features/editor/partInsert';
import { useSnapshotHistory } from '@/features/editor/useSnapshotHistory';

// =============================================================================
// partInsert.test.ts — パーツの追加は、挿入したときだけ Undo・修正履歴・プレビュー選択を積む
// =============================================================================
// 本文を文字列で持つ偽の挿入と本物の `useSnapshotHistory` で、`useTemplateEditor.ts` の
// `onPartInsert` が呼ぶ分岐を確かめる。

const PART = { id: 'NEW', name: '注記', content: '<section>new</section>' } as PartCatalogItem;

/** 本文 `box.doc` を挿入で書き換える偽の deps。呼ばれた順を `calls` に残す。 */
function setup(opts: { canInsert?: boolean; inserts?: boolean } = {}) {
  const box = { doc: 'a' };
  const calls: string[] = [];
  const h = useSnapshotHistory(
    () => box.doc,
    (s) => {
      box.doc = s;
    },
  );
  const deps: PartInsertDeps = {
    canInsert: () => {
      calls.push('canInsert');
      return opts.canInsert ?? true;
    },
    beginUndo: () => {
      calls.push('beginUndo');
      h.beginUndo();
    },
    commitUndo: () => {
      calls.push('commitUndo');
      h.commitUndo();
    },
    cancelUndo: () => {
      calls.push('cancelUndo');
      h.cancelUndo();
    },
    insertPart: (content, id) => {
      calls.push(`insertPart:${id}`);
      if (!(opts.inserts ?? true)) return false;
      box.doc += content;
      return true;
    },
    setEditable: () => {
      calls.push('setEditable');
    },
    setPreview: (p) => {
      calls.push(`setPreview:${p.id}`);
    },
    recordChange: (label) => {
      calls.push(`recordChange:${label}`);
    },
  };
  return { box, calls, h, deps };
}

/** Redo を 1 つ残した状態にする(無変更の操作で消えないことを見るため)。 */
function withRedo(s: ReturnType<typeof setup>): void {
  s.h.pushUndo();
  s.box.doc = 'b';
  s.h.undo();
  expect(s.h.canRedo.value).toBe(true);
}

describe('insertPartUndoable', () => {
  it('挿入すれば、Undo を確定してから編集可否・プレビュー選択・修正履歴の順に積み、Undo 1 回で戻る', () => {
    const s = setup();
    expect(insertPartUndoable(s.deps, PART)).toBe(true);
    expect(s.calls).toEqual([
      'canInsert',
      'beginUndo',
      'insertPart:NEW',
      'commitUndo',
      'setEditable',
      'setPreview:NEW',
      'recordChange:パーツ「注記」を追加',
    ]);
    expect(s.box.doc).toBe('a<section>new</section>');
    expect(s.h.canUndo.value).toBe(true);
    s.h.undo();
    expect(s.box.doc).toBe('a');
    expect(s.h.canUndo.value).toBe(false);
  });

  it('挿入しなかった(照合外れなど)ときは、Undo・編集可否・プレビュー選択・修正履歴を積まず Redo を残す', () => {
    const s = setup({ inserts: false });
    withRedo(s);
    expect(insertPartUndoable(s.deps, PART)).toBe(false);
    expect(s.calls).toEqual(['canInsert', 'beginUndo', 'insertPart:NEW', 'cancelUndo']);
    expect(s.h.canUndo.value).toBe(false);
    expect(s.h.canRedo.value).toBe(true);
  });

  it('挿入できないページでは、snapshot を取る前に戻る', () => {
    const s = setup({ canInsert: false });
    withRedo(s);
    expect(insertPartUndoable(s.deps, PART)).toBe(false);
    expect(s.calls).toEqual(['canInsert']);
    expect(s.h.canUndo.value).toBe(false);
    expect(s.h.canRedo.value).toBe(true);
  });
});
