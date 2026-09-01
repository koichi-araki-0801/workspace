// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)のサーバ実装
// =============================================================================
// 役割: 投稿の追加・編集・削除を版インスタンス単位の JSON ファイル(`notesFile.ts`)へ
// 反映し、読み取りでは交付版⇄全体版のペアをマージして 1 本のスレッドとして返す。
// ルートは本モジュールを呼んで結果を返すだけ。
import { randomUUID } from 'node:crypto';
import { type PartNoteEntry, pairedTemplateId, validation } from '@editor/shared';
import {
  entriesAtCapacity,
  entriesCapacityError,
  type NoteEntriesMap,
  notesAtCapacity,
  notesCapacityError,
  readNotes,
  readNotesStrict,
  type StoredNoteEntry,
  withNotesLock,
  writeNotes,
} from '../files/notesFile.js';

/** ファイル上の投稿へ、ファイル名とキーから自明な属性を補って API の形にする。 */
function toEntry(templateId: string, pathKey: string, stored: StoredNoteEntry): PartNoteEntry {
  return { ...stored, templateId, pathKey };
}

/** 1 版インスタンス分の全投稿を平坦化する(pathKey を各投稿へ補う)。 */
function flatten(templateId: string, map: NoteEntriesMap): PartNoteEntry[] {
  return Object.entries(map).flatMap(([pathKey, entries]) =>
    entries.map((e) => toEntry(templateId, pathKey, e)),
  );
}

/**
 * 自版とペア版(交付版⇄全体版)をマージしたスレッド。
 *
 * 並びは `createdAt` の昇順。同時刻の投稿で並びが揺れないよう、`templateId` → `id` を
 * 第 2・第 3 のキーにして安定させる(表示順が読むたびに変わると差分が読めない)。
 * ペアの実体が無い場合や版種がペア対象外の場合は、自版だけが返る。
 */
export async function listNotes(templateId: string): Promise<PartNoteEntry[]> {
  const paired = pairedTemplateId(templateId);
  const own = flatten(templateId, await readNotes(templateId));
  const other = paired ? flatten(paired, await readNotes(paired)) : [];
  return [...own, ...other].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.templateId.localeCompare(b.templateId) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * 投稿を追加する。読み-改変-書きは版インスタンス単位のロックで包む(包まないと同時追加が
 * 互いの投稿を消し、`atomicWrite` の rename 競合で片方が 500 になる)。
 *
 * 上限は 2 段。`pathKey` の件数(新規キーのときだけ見る)と、1 パーツの投稿数。
 */
export async function addNote(
  templateId: string,
  pathKey: string,
  content: string,
  loginId: string,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    if (notesAtCapacity(map, pathKey)) notesCapacityError();
    const entries = map[pathKey] ?? [];
    if (entriesAtCapacity(entries)) entriesCapacityError();
    const stored: StoredNoteEntry = {
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
      createdBy: loginId,
      updatedAt: null,
      updatedBy: null,
    };
    map[pathKey] = [...entries, stored];
    await writeNotes(templateId, map);
    return toEntry(templateId, pathKey, stored);
  });
}

/**
 * 投稿 ID から所在(パーツキーと配列内位置)を引く。`entryId` は UUID なので `pathKey` を
 * 併せて受け取らない — 宛先を 2 つ受けると、食い違ったときの挙動を決める必要が出る。
 */
function locate(map: NoteEntriesMap, entryId: string): { pathKey: string; index: number } {
  for (const [pathKey, entries] of Object.entries(map)) {
    const index = entries.findIndex((e) => e.id === entryId);
    if (index >= 0) return { pathKey, index };
  }
  throw validation('対象のメモが見つかりません(すでに削除された可能性があります)');
}

/**
 * 投稿本文を編集する。上限に達していても編集は必ず通す(上限が「直せない」状態を作らない)。
 * 誰の投稿でも編集できる(共同作業を前提とし、所有者による制限は設けない)。
 */
export async function updateNote(
  templateId: string,
  entryId: string,
  content: string,
  loginId: string,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey, index } = locate(map, entryId);
    const updated: StoredNoteEntry = {
      ...map[pathKey][index],
      content,
      updatedAt: new Date().toISOString(),
      updatedBy: loginId,
    };
    map[pathKey] = map[pathKey].map((e, i) => (i === index ? updated : e));
    await writeNotes(templateId, map);
    return toEntry(templateId, pathKey, updated);
  });
}

/** 投稿を削除する。パーツの投稿が空になったらキーごと畳む(空配列を残さない)。 */
export async function deleteNote(templateId: string, entryId: string): Promise<void> {
  await withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey, index } = locate(map, entryId);
    const rest = map[pathKey].filter((_, i) => i !== index);
    if (rest.length === 0) delete map[pathKey];
    else map[pathKey] = rest;
    await writeNotes(templateId, map);
  });
}
