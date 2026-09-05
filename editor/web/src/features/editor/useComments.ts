// =============================================================================
// useComments.ts — パーツ単位コメント(1 段の入れ子スレッド)の読込/追加/返信/解決/編集/削除 composable
// =============================================================================
// 役割: 現在の版インスタンスのスレッド(版に閉じ、ペアや他版とは共有しない)を保持し、選択中
// パーツ(版内で安定な構造パスキー)の投稿列を提示する。追加・編集・削除はいずれも明示操作なので、
// 保留中の保存という状態は持たない(旧実装の debounce と `flush` は廃止した)。選択やテンプレ
// 読込への追従は getter 注入で行い、単体テスト可能に保つ(`usePartEditHistory.ts` と同様)。

import {
  type AddNoteOptions,
  isErr,
  type NoteRepository,
  type NoteStatus,
  type PartNoteEntry,
} from '@editor/shared';
import { computed, ref } from 'vue';
import { logError } from '@/lib/appError';
import { useLatest } from '@/lib/useLatest';
import { openKeysOf, openThreadCount } from './comments/commentFilter';

/**
 * パーツ単位コメント(1 段の入れ子スレッド)。`templateId` 配下の全投稿を保持し、選択中
 * パーツの投稿列を読み書きする。書き込み先は「今開いている版」ではなく「その投稿が属する版」
 * (`entry.templateId`)である点に注意。
 *
 * @param templateId  現在の版インスタンス id の getter(空なら no-op)
 * @param currentKey  選択中パーツの構造キーの getter(解決不能なら null)
 * @param repo        コメントの永続化先(`NoteRepository`)
 */
export function useComments(
  templateId: () => string,
  currentKey: () => string | null,
  repo: NoteRepository,
) {
  // 現在の版インスタンスの全投稿(他版とは共有しない)。`reload` で満たし、各操作の後に差分を反映する。
  const all = ref<PartNoteEntry[]>([]);

  // 対象テンプレートの高速切替で古い版の投稿が一覧へ残る、または空 id へ戻った後に旧応答が復活する
  // ことを防ぐ世代ガード。
  const latest = useLatest();

  /** 投稿を持つ pathKey 集合(canvas のマーカー描画を駆動する)。 */
  const notedKeys = computed<Set<string>>(() => new Set(all.value.map((e) => e.pathKey)));

  /** 未対応の親投稿を持つ pathKey 集合(マーカーの色分け)。 */
  const openKeys = computed<Set<string>>(() => openKeysOf(all.value));

  /** 未対応の**親投稿**の件数(タブバッジ用。パーツ数ではなくスレッド数を数える)。 */
  const openCount = computed<number>(() => openThreadCount(all.value));

  /** 現在の選択パーツのスレッド(リポジトリが決めた並びをそのまま保つ)。 */
  const entries = computed<PartNoteEntry[]>(() => {
    const k = currentKey();
    return k ? all.value.filter((e) => e.pathKey === k) : [];
  });

  /** 現在の選択がメモ対象キーへ解決できるか(UI の有効/無効判定)。 */
  const canNote = computed<boolean>(() => currentKey() !== null);

  /** 現在の版インスタンスの全投稿を読み込み直す(テンプレ読込時と各操作の後に呼ぶ)。 */
  async function reload(): Promise<void> {
    const isLatest = latest.begin();
    const tid = templateId();
    if (!tid) {
      all.value = [];
      return;
    }
    const res = await repo.listNotes(tid);
    if (!isLatest()) return;
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    all.value = res.value;
  }

  /**
   * 親投稿を追加する。宛先は第 3 引数 `pathKey` を優先し、省略時のみ `currentKey()` を使う
   * (承認タブは区画〈申請〉ごとに宛先を持ち、呼び出し側が表示中の宛先を明示する。
   * 「直近に操作した区画」に頼ると、別区画の select を触ってからこちらの追加を押したときに
   * 表示と投稿先がずれるため)。空文字はリポジトリが拒否するのでここでも送らない。
   */
  async function add(content: string, opts: AddNoteOptions = {}, pathKey?: string): Promise<void> {
    const key = pathKey ?? currentKey();
    const tid = templateId();
    if (!key || !tid || content.trim() === '') return;
    const res = await repo.addNote(tid, key, content, opts);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /**
   * 親投稿へ返信する。宛先は `parent.pathKey` — 選択パーツではなく親の属するパーツに付ける
   * (一覧から返信するとき、選択が別パーツへ移っていても返信先がずれない)。`kind` は親を
   * 引き継ぐ(スレッド 1 本 = 1 種別の形を保ち、一覧の絞り込みは親の種別で行うため)。
   */
  async function reply(parent: PartNoteEntry, content: string): Promise<void> {
    if (content.trim() === '') return;
    const res = await repo.addNote(parent.templateId, parent.pathKey, content, {
      replyTo: parent.id,
      kind: parent.kind,
    });
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 親投稿の状態を切り替える(返信への伝播はリポジトリが行う)。 */
  async function setStatus(parent: PartNoteEntry, status: NoteStatus): Promise<void> {
    const res = await repo.updateNote(parent.templateId, parent.id, { status });
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 投稿の本文を編集する。宛先は `entry.templateId`(投稿が属する版)。 */
  async function update(entry: PartNoteEntry, content: string): Promise<void> {
    if (content.trim() === '') return;
    const res = await repo.updateNote(entry.templateId, entry.id, { content });
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 投稿を削除する。親なら返信も消える(リポジトリが道連れにする)。 */
  async function remove(entry: PartNoteEntry): Promise<void> {
    const res = await repo.deleteNote(entry.templateId, entry.id);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  return {
    all,
    entries,
    notedKeys,
    openKeys,
    openCount,
    canNote,
    reload,
    add,
    reply,
    setStatus,
    update,
    remove,
  };
}
