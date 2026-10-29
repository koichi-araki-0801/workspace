// =============================================================================
// useThreadActions.ts — コメントのスレッド内操作(編集・削除確認・解決切替)
// =============================================================================
// 右ペインの一覧(`CommentPanel.vue`)と canvas の吹き出し(`NoteBubble.vue`)は同じ規則で
// 投稿を編集・削除・解決する。規則を片方だけ直して画面ごとに挙動がずれないよう、状態と
// 手順をここに 1 つ持つ。永続は呼び出し側が持つので、`deps` は emit への橋渡しだけ。
import type { NoteStatus, PartNoteEntry } from '@editor/shared';
import { type Ref, ref } from 'vue';
import type { confirm } from '@/components/ui/confirm';

/** 編集中の対象や展開状態のキー。投稿 id の一意性は版インスタンスのファイルの中でだけ約束
 * されているので、`id` 単体でなく `templateId/id` の対で持つ(他版の投稿が並んでも衝突しない)。 */
export function entryKey(entry: PartNoteEntry): string {
  return `${entry.templateId}/${entry.id}`;
}

/** 削除確認の文言。返信があるときだけ、親を消すと返信も消えることを書く。 */
export function removeConfirmMessage(
  isParent: boolean,
  replyCount: number,
): { title: string; description: string } {
  if (!isParent) {
    return { title: 'この返信を削除しますか？', description: '削除した返信は元に戻せません。' };
  }
  return {
    title: 'このコメントを削除しますか？',
    description: `削除したコメントは元に戻せません。${replyCount > 0 ? '返信も一緒に削除されます。' : ''}`,
  };
}

interface ThreadActionDeps {
  update(entry: PartNoteEntry, content: string): void;
  remove(entry: PartNoteEntry): void;
  setStatus(parent: PartNoteEntry, status: NoteStatus): void;
  /** 親投稿の返信件数。削除確認の文言にだけ使うので、親の削除時にだけ呼ぶ。 */
  replyCountOf(parent: PartNoteEntry): number;
  confirm: typeof confirm;
}

export function useThreadActions(deps: ThreadActionDeps): {
  editingKey: Ref<string | null>;
  draft: Ref<string>;
  startEdit(entry: PartNoteEntry): void;
  commitEdit(entry: PartNoteEntry): void;
  cancelEdit(): void;
  requestRemove(entry: PartNoteEntry): Promise<void>;
  toggleStatus(parent: PartNoteEntry): void;
} {
  // 1 度に 1 件だけ編集する。
  const editingKey = ref<string | null>(null);
  const draft = ref('');

  function startEdit(entry: PartNoteEntry): void {
    editingKey.value = entryKey(entry);
    draft.value = entry.content;
  }

  function commitEdit(entry: PartNoteEntry): void {
    if (draft.value.trim() !== '') deps.update(entry, draft.value);
    editingKey.value = null;
  }

  function cancelEdit(): void {
    editingKey.value = null;
  }

  async function requestRemove(entry: PartNoteEntry): Promise<void> {
    const isParent = entry.replyTo === null;
    const ok = await deps.confirm({
      ...removeConfirmMessage(isParent, isParent ? deps.replyCountOf(entry) : 0),
      confirmLabel: '削除する',
      variant: 'destructive',
    });
    if (ok) deps.remove(entry);
  }

  function toggleStatus(parent: PartNoteEntry): void {
    deps.setStatus(parent, parent.status === 'open' ? 'resolved' : 'open');
  }

  return { editingKey, draft, startEdit, commitEdit, cancelEdit, requestRemove, toggleStatus };
}
