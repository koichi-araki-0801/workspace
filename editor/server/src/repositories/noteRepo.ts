// =============================================================================
// noteRepo.ts — パーツ単位コメント(1 段の入れ子スレッド)のサーバ実装
// =============================================================================
// 役割: 投稿の追加・更新・削除を版インスタンス単位の JSON ファイル(`notesFile.ts`)へ
// 反映する。読み取りも自版に閉じ、他の版(交付版⇄全体版のペアを含む)とは共有しない。
// 返信は同じパーツの親投稿にだけ付き、状態の切替は親にだけ許して返信へ伝播する。
// ルートは本モジュールを呼んで結果を返すだけ。
import { randomUUID } from 'node:crypto';
import { type NoteKind, type NoteStatus, type PartNoteEntry, validation } from '@editor/shared';
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

/** 追加時の指定。ルートが Zod で既定値を埋めるので、ここでは省略不可にする。 */
export interface AddNoteOptions {
  replyTo: string | null;
  kind: NoteKind;
}

/** 部分更新。本文か状態のどちらか一方以上(ルートの Zod が保証する)。 */
export interface NotePatch {
  content?: string;
  status?: NoteStatus;
}

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
 * 版インスタンスの全投稿。並びは `createdAt` の昇順のみで比較する。`Array.prototype.sort` は
 * 安定ソートなので、同時刻の投稿は配列順(= 挿入順)がそのまま保たれ、表示順が読むたびに
 * 変わることはない。`id` は乱数 UUID で挿入順と無関係なので、タイブレークに使わない。
 */
export async function listNotes(templateId: string): Promise<PartNoteEntry[]> {
  return flatten(templateId, await readNotes(templateId)).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * 返信先として指定された親投稿を同じパーツの配列から引く。親は「同じパーツ」「存在する」
 * 「それ自体が親(`replyTo` が null)」の 3 条件を満たす。ファイル全体から探さないのは、
 * 別パーツの投稿を親にした返信を作らせないため(表示はパーツ単位のスレッドなので、
 * 別パーツに付いた返信はどこにも出ない)。
 */
function requireParent(entries: readonly StoredNoteEntry[], replyTo: string): StoredNoteEntry {
  const parent = entries.find((e) => e.id === replyTo);
  if (!parent)
    throw validation('返信先のコメントが見つかりません(すでに削除された可能性があります)');
  if (parent.replyTo !== null) throw validation('返信への返信はできません');
  return parent;
}

/**
 * 投稿を追加する。読み-改変-書きは版インスタンス単位のロックで包む(包まないと同時追加が
 * 互いの投稿を消し、`atomicWrite` の rename 競合で片方が 500 になる)。
 *
 * 上限は 2 段。`pathKey` の件数(新規キーのときだけ見る)と、1 パーツの投稿数(返信を含む)。
 * 返信は親の状態を引き継ぐ(解決済みスレッドへの返信は解決済みのまま並ぶ。未対応へ戻すのは
 * 親の切替で行う)。
 */
export async function addNote(
  templateId: string,
  pathKey: string,
  content: string,
  loginId: string,
  opts: AddNoteOptions,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    if (notesAtCapacity(map, pathKey)) notesCapacityError();
    const entries = map[pathKey] ?? [];
    if (entriesAtCapacity(entries)) entriesCapacityError();
    const parent = opts.replyTo === null ? null : requireParent(entries, opts.replyTo);
    const stored: StoredNoteEntry = {
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
      createdBy: loginId,
      updatedAt: null,
      updatedBy: null,
      status: parent ? parent.status : 'open',
      replyTo: parent ? parent.id : null,
      kind: opts.kind,
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
  throw validation('対象のコメントが見つかりません(すでに削除された可能性があります)');
}

/**
 * 投稿の本文・状態を更新する。上限に達していても更新は必ず通す(上限が「直せない」状態を
 * 作らない)。誰の投稿でも更新できる(共同作業を前提とし、所有者による制限は設けない)。
 *
 * 本文の更新だけが `updatedAt`/`updatedBy` を刻む — 「(編集済み)」は本文が書き換わった
 * ことの表示で、解決の切替は編集ではない。状態は親投稿にだけ指定でき、同じ親を持つ返信へ
 * まとめて伝播する(スレッド 1 本が 1 つの状態を持つ形を保つ)。
 */
export async function updateNote(
  templateId: string,
  entryId: string,
  patch: NotePatch,
  loginId: string,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey, index } = locate(map, entryId);
    const target = map[pathKey][index];
    if (patch.status !== undefined && target.replyTo !== null)
      throw validation('状態は親のコメントでだけ切り替えられます');
    const updated: StoredNoteEntry = {
      ...target,
      ...(patch.content !== undefined
        ? { content: patch.content, updatedAt: new Date().toISOString(), updatedBy: loginId }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    map[pathKey] = map[pathKey].map((e) => {
      if (e.id === entryId) return updated;
      if (patch.status !== undefined && e.replyTo === entryId)
        return { ...e, status: patch.status };
      return e;
    });
    await writeNotes(templateId, map);
    return toEntry(templateId, pathKey, updated);
  });
}

/**
 * 投稿を削除する。親投稿なら返信も一緒に消す(親を失った返信はどのスレッドにも出ないため、
 * 残しても操作できない)。パーツの投稿が空になったらキーごと畳む(空配列を残さない)。
 */
export async function deleteNote(templateId: string, entryId: string): Promise<void> {
  await withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey } = locate(map, entryId);
    const rest = map[pathKey].filter((e) => e.id !== entryId && e.replyTo !== entryId);
    if (rest.length === 0) delete map[pathKey];
    else map[pathKey] = rest;
    await writeNotes(templateId, map);
  });
}
