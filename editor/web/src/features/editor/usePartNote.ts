// =============================================================================
// usePartNote.ts — パーツ単位メモ(追記型スレッド)の読込/追加/編集/削除 composable
// =============================================================================
// 役割: 現在の版インスタンスのスレッド(交付版⇄全体版をマージ済み)を保持し、選択中パーツ
// (版内で安定な構造パスキー)の投稿列を提示する。追加・編集・削除はいずれも明示操作なので、
// 保留中の保存という状態は持たない(旧実装の debounce と `flush` は廃止した)。選択やテンプレ
// 読込への追従は getter 注入で行い、単体テスト可能に保つ(`usePartEditHistory.ts` と同様)。

import { isErr, type NoteRepository, type PartNoteEntry } from '@editor/shared';
import { computed, ref } from 'vue';
import { logError } from '@/lib/appError';

/**
 * パーツ単位メモ(追記型スレッド)。`templateId` 配下の全投稿を保持し、選択中パーツの
 * 投稿列を読み書きする。書き込み先は「今開いている版」ではなく「その投稿が属する版」
 * (`entry.templateId`)である点に注意 — ペア側の投稿も同じスレッドに並ぶため。
 *
 * @param templateId  現在の版インスタンス id の getter(空なら no-op)
 * @param currentKey  選択中パーツの構造キーの getter(解決不能なら null)
 * @param repo        メモの永続化先(`NoteRepository`)
 */
export function usePartNote(
  templateId: () => string,
  currentKey: () => string | null,
  repo: NoteRepository,
) {
  // 版インスタンス(+ペア)の全投稿。`reload` で満たし、各操作の後に差分を反映する。
  const all = ref<PartNoteEntry[]>([]);

  /** 投稿を持つ pathKey 集合(canvas のマーカー描画を駆動する)。 */
  const notedKeys = computed<Set<string>>(() => new Set(all.value.map((e) => e.pathKey)));

  /** 現在の選択パーツのスレッド(リポジトリが決めた並びをそのまま保つ)。 */
  const entries = computed<PartNoteEntry[]>(() => {
    const k = currentKey();
    return k ? all.value.filter((e) => e.pathKey === k) : [];
  });

  /** 現在の選択がメモ対象キーへ解決できるか(UI の有効/無効判定)。 */
  const canNote = computed<boolean>(() => currentKey() !== null);

  /** 現在の版インスタンスの全投稿を読み込み直す(テンプレ読込時と各操作の後に呼ぶ)。 */
  async function reload(): Promise<void> {
    const tid = templateId();
    if (!tid) {
      all.value = [];
      return;
    }
    const res = await repo.listNotes(tid);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    all.value = res.value;
  }

  /** 選択パーツへ投稿を追加する。空文字はリポジトリが拒否するのでここでも送らない。 */
  async function add(content: string): Promise<void> {
    const key = currentKey();
    const tid = templateId();
    if (!key || !tid || content.trim() === '') return;
    const res = await repo.addNote(tid, key, content);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /**
   * 投稿の本文を編集する。宛先は `entry.templateId` — 今開いている版ではない。
   * ペア側(全体版)の投稿を交付版の画面から直すとき、自版へ書くと投稿が複製される。
   */
  async function update(entry: PartNoteEntry, content: string): Promise<void> {
    if (content.trim() === '') return;
    const res = await repo.updateNote(entry.templateId, entry.id, content);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 投稿を削除する。宛先は `update` と同じ理由で `entry.templateId`。 */
  async function remove(entry: PartNoteEntry): Promise<void> {
    const res = await repo.deleteNote(entry.templateId, entry.id);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  return { entries, notedKeys, canNote, reload, add, update, remove };
}
