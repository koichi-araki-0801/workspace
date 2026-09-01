// =============================================================================
// notesFile.ts — パーツ単位メモ(追記型スレッド)のファイル永続化
// =============================================================================
// 役割: メモは版インスタンス単位で `dataRoot/notes/<templateId>.json` に
// `Record<pathKey, 投稿配列>` で保持する。投稿は書かれた版のファイルへ入り、交付版⇄全体版の
// ペアをまたぐマージは読み取り側(`repositories/noteRepo.ts`)が行う。本体テキストは atomic
// write で半端読みを防ぐ。git 版管理対象のテンプレ本体とは別物で、メモは注釈として data
// ルート配下に置くだけ(コミットは伴わない)。

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertTemplateId,
  MAX_NOTE_ENTRIES_PER_PART,
  type PartNoteEntry,
  validation,
} from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';
import { withFileLock } from './fileLock.js';

const notesDir = (): string => path.join(config.dataRoot, 'notes');

/**
 * メモファイル 1 本の上限バイト数。読み側は `JSON.parse` で全体を 1 度に構造化するので、
 * サイズを見ずに読むと「書いた本人以外も含めた全 GET が同じ時間だけ止まる」。
 *
 * **この上限は書き込み側でも強制する**(`writeNotes`)。件数上限だけでは守れない —
 * `MAX_NOTES_PER_TEMPLATE`(1000)× 1 件あたり `MAX_NOTE_CONTENT_CHARS`(64KiB)は
 * 最大 64MiB で、この上限の 16 倍になる。件数を守っていてもサイズは超えられる。
 *
 * 読み側の扱いは経路で分ける(`readNotes` / `readNotesStrict`)。読み取りは degrade して
 * 空を返してよいが、**読み-改変-書きの入力にしてはならない** — 「読めない」を「空」と
 * 取り違えたまま書き戻すと、全メモが 1 件へ潰れる。
 */
export const MAX_NOTES_FILE_BYTES = 4 * 1024 * 1024;

/**
 * templateId を安全なファイル名に限定する(パストラバーサル防止)。
 *
 * 判定は shared の `assertTemplateId` **1 本**に寄せる。ここで独自に
 * 「basename 一致 + `..` を含まない + 4 トークン構造」と書き下すと、正典が持つ
 * 長さ上限(200 文字)のような制約を落とし、同じ id 規約に**2 つの実装**が並ぶ。
 * 正典が厳しくなってもこちらは追随しない、という形の乖離を構造的に作らない。
 */
function fileFor(templateId: string): string {
  return path.join(notesDir(), `${assertTemplateId(templateId)}.json`);
}

/**
 * ファイルに保存する投稿 1 件。`templateId` と `pathKey` はファイル名とキーから自明なので
 * 持たない(同じ事実を 2 箇所で持つと片方だけがずれる)。API 応答へ載せるときに補う。
 */
export type StoredNoteEntry = Omit<PartNoteEntry, 'templateId' | 'pathKey'>;

/** 1 版インスタンスのメモ一式(パーツ構造キー → 投稿の配列。配列は作成日時の昇順)。 */
export type NoteEntriesMap = Record<string, StoredNoteEntry[]>;

/**
 * 読み取りの結果。**「メモが無い」と「読めなかった」を呼び出し側が区別できる**ようにする。
 *
 * 区別が要るのは書き込み経路のため。`saveNote` は「全体を読む → 1 件差し替える → 全体を
 * 書く」なので、読めなかったのに空と受け取ると**残りの全メモを消して書き戻す**。
 */
interface NotesReadResult {
  notes: NoteEntriesMap;
  /** 実体は在るが読めなかった(サイズ超過・壊れた JSON)。`notes` は空。 */
  unreadable: boolean;
}

/**
 * 旧形式(`pathKey` → メモ 1 件)を投稿 1 件の配列へ変換する。
 *
 * 変換後の ID を固定値 `legacy` にするのは、読むたびに ID が変わると編集・削除の宛先が
 * 安定しないため。旧形式は 1 パーツにつき 1 件しか持てないので、この値で衝突しない。
 * 一括移行はしない — 次の書き込みで新形式として保存され、自然に移りきる。
 */
function normalizeStored(parsed: Record<string, unknown>): NoteEntriesMap {
  const out: NoteEntriesMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      out[key] = value as StoredNoteEntry[];
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const legacy = value as { content?: unknown; updatedAt?: unknown; updatedBy?: unknown };
    if (typeof legacy.content !== 'string') continue;
    out[key] = [
      {
        id: 'legacy',
        content: legacy.content,
        createdAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : '',
        createdBy: typeof legacy.updatedBy === 'string' ? legacy.updatedBy : '',
        updatedAt: null,
        updatedBy: null,
      },
    ];
  }
  return out;
}

async function readNotesResult(templateId: string): Promise<NotesReadResult> {
  const file = fileFor(templateId);
  const size = await fs
    .stat(file)
    .then((s) => s.size)
    .catch(() => -1);
  // ファイルが無い = 素直に「メモが無い」。ここだけは degrade ではない。
  if (size < 0) return { notes: {}, unreadable: false };
  if (size > MAX_NOTES_FILE_BYTES) return { notes: {}, unreadable: true };
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  if (!raw) return { notes: {}, unreadable: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object')
      return { notes: normalizeStored(parsed as Record<string, unknown>), unreadable: false };
    return { notes: {}, unreadable: true };
  } catch {
    // 壊れたメモファイルで編集画面ごと落とさない(メモは注釈で、本体は git 側が正典)。
    return { notes: {}, unreadable: true };
  }
}

/**
 * 指定版インスタンスの全メモ(pathKey → StoredNoteEntry[])。**表示用**。
 * 読めない実体(サイズ超過・壊れた JSON)は空として扱い、画面を落とさない。
 * **この戻り値を書き戻しの入力にしてはならない**(`readNotesStrict` を使う)。
 */
export async function readNotes(templateId: string): Promise<NoteEntriesMap> {
  return (await readNotesResult(templateId)).notes;
}

/**
 * 読み-改変-書きのための読み取り。読めない実体は**空ではなく例外**にする。
 *
 * degrade(空を返す)は読み取りを守るための仕組みで、書き込みの入力にすると破壊になる。
 * 「読めない」まま書き戻せば残りの全メモが消え、メモは git 管理外なので復元できない。
 */
export async function readNotesStrict(templateId: string): Promise<NoteEntriesMap> {
  const res = await readNotesResult(templateId);
  if (res.unreadable)
    throw validation(
      'このテンプレートのメモファイルを読み取れないため保存できません' +
        '(サイズ超過または破損)。既存のメモを失わないよう、保存を中止しました。',
    );
  return res.notes;
}

/**
 * 指定版インスタンスのメモ一式を書き出す(ディレクトリは必要に応じて作成)。
 *
 * **サイズ上限はここで強制する。** 件数上限は「1 件の大きさ」を縛らないので、
 * 件数を守ったまま読み取り不能なファイルを作れてしまう(そして次の保存で全件が消える)。
 * 上限は書いた結果のバイト数で見る — 申告値や件数からの見積もりではなく実測で判定する。
 */
export async function writeNotes(templateId: string, notes: NoteEntriesMap): Promise<void> {
  const body = `${JSON.stringify(notes, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_NOTES_FILE_BYTES)
    throw validation(
      `このテンプレートのメモが上限(${Math.floor(MAX_NOTES_FILE_BYTES / 1024 / 1024)}MB)を` +
        '超えるため保存できません。不要なメモを削除してください。',
    );
  await fs.mkdir(notesDir(), { recursive: true });
  await atomicWrite(fileFor(templateId), body);
}

/**
 * 1 版インスタンスの読み-改変-書きを直列化する。
 *
 * メモの保存は「全体を読む → 1 件差し替える → 全体を書く」なので、直列化しないと
 * 同時保存が後勝ちで**互いの更新を消す**(しかも `atomicWrite` の rename が競合すると
 * 片方が ENOENT で 500 になる)。ロックのキーは書き込む実ファイルのパスにする。
 */
export function withNotesLock<T>(templateId: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(fileFor(templateId), fn);
}

/** メモ 1 ファイルが保持できる件数の上限(パーツ数の実物は 1 版あたり数十)。 */
export const MAX_NOTES_PER_TEMPLATE = 1000;

/** 件数上限に達しているか(新規キーの追加可否の判定に使う)。 */
export function notesAtCapacity(notes: NoteEntriesMap, pathKey: string): boolean {
  return !(pathKey in notes) && Object.keys(notes).length >= MAX_NOTES_PER_TEMPLATE;
}

/** 上限超過時に返す文言(ルート・repo で同じ案内にする)。 */
export function notesCapacityError(): never {
  throw validation(`このテンプレートのメモは上限(${MAX_NOTES_PER_TEMPLATE} 件)に達しています`);
}

/**
 * 1 パーツの投稿数が上限に達しているか。件数上限(`MAX_NOTES_PER_TEMPLATE`)は `pathKey` の
 * 数しか縛らないので、これが無いと 1 パーツだけでファイル上限(`MAX_NOTES_FILE_BYTES`)へ
 * 到達でき、そのテンプレの全メモが保存不能になる。
 */
export function entriesAtCapacity(entries: readonly StoredNoteEntry[]): boolean {
  return entries.length >= MAX_NOTE_ENTRIES_PER_PART;
}

/** 投稿数の上限超過時に返す文言。 */
export function entriesCapacityError(): never {
  throw validation(
    `このパーツのメモは上限(${MAX_NOTE_ENTRIES_PER_PART} 件)に達しています。` +
      '不要なメモを削除してください。',
  );
}
