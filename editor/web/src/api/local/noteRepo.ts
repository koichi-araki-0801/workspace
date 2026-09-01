// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)の local 実装(localStorage)
// =============================================================================
// 役割: `NoteRepository` の local 実装。`editor:notes:v2` に
// `Record<templateId, Record<pathKey, PartNoteEntry[]>>` で保持する。読み取りは交付版⇄
// 全体版のペアをマージし、書き込みは投稿が属する版へ向ける(REST 実装と同じ挙動)。
// 版種の対応表は shared の `pairedTemplateId` を使う — web 側へ複製すると片方だけがずれる。
import {
  type NoteRepository,
  type PartNoteEntry,
  pairedTemplateId,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, write } from './store';

type NoteStore = Record<string, Record<string, PartNoteEntry[]>>;

/** 1 版インスタンス分の投稿を平坦化する。 */
function flatten(all: NoteStore, templateId: string): PartNoteEntry[] {
  return Object.values(all[templateId] ?? {}).flat();
}

/** 投稿 ID から所在(版・パーツキー・位置)を引く。 */
function locate(
  all: NoteStore,
  templateId: string,
  entryId: string,
): { pathKey: string; index: number } {
  for (const [pathKey, entries] of Object.entries(all[templateId] ?? {})) {
    const index = entries.findIndex((e) => e.id === entryId);
    if (index >= 0) return { pathKey, index };
  }
  throw validation('対象のメモが見つかりません(すでに削除された可能性があります)');
}

export const localNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      const paired = pairedTemplateId(templateId);
      const merged = [...flatten(all, templateId), ...(paired ? flatten(all, paired) : [])];
      // server 実装と同じ並び(作成日時のみで比較する)。`Array.prototype.sort` は ES2019
      // 以降 安定ソートなので、同値のときは連結前の順(同一版内は配列 = 挿入順、版をまたぐ
      // 場合は自版 → ペア版)がそのまま保たれる — これで「同時刻でも読むたびに順が変わら
      // ない」を満たせる。以前は templateId → id を追加のタイブレークにしていたが、id は
      // 乱数 UUID で挿入順と無関係なため、同一ミリ秒の連投で並びが崩れる実測不具合があった
      // (2 件以上を同一 templateId へ短時間に追加すると id 順に化けていた)。
      merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return delay(merged);
    }),

  addNote: (templateId: string, pathKey: string, content: string) =>
    attempt(() => {
      if (content === '') throw validation('メモの本文を入力してください');
      const all = read<NoteStore>(K.notes, {});
      const tpl = all[templateId] ?? {};
      const entry: PartNoteEntry = {
        id: crypto.randomUUID(),
        templateId,
        pathKey,
        content,
        createdAt: now(),
        createdBy: currentUser()?.displayName ?? '不明',
        updatedAt: null,
        updatedBy: null,
      };
      tpl[pathKey] = [...(tpl[pathKey] ?? []), entry];
      all[templateId] = tpl;
      write(K.notes, all);
      return entry;
    }),

  updateNote: (templateId: string, entryId: string, content: string) =>
    attempt(() => {
      if (content === '') throw validation('メモの本文を入力してください');
      const all = read<NoteStore>(K.notes, {});
      const { pathKey, index } = locate(all, templateId, entryId);
      const updated: PartNoteEntry = {
        ...all[templateId][pathKey][index],
        content,
        updatedAt: now(),
        updatedBy: currentUser()?.displayName ?? '不明',
      };
      all[templateId][pathKey] = all[templateId][pathKey].map((e, i) =>
        i === index ? updated : e,
      );
      write(K.notes, all);
      return updated;
    }),

  deleteNote: (templateId: string, entryId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      const { pathKey, index } = locate(all, templateId, entryId);
      const rest = all[templateId][pathKey].filter((_, i) => i !== index);
      // 空になったキー・版はエントリごと畳む(空オブジェクトを残さない)。
      if (rest.length === 0) delete all[templateId][pathKey];
      else all[templateId][pathKey] = rest;
      if (Object.keys(all[templateId]).length === 0) delete all[templateId];
      write(K.notes, all);
    }),
};
