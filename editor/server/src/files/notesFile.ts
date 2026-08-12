// =============================================================================
// notesFile.ts — パーツ単位メモのファイル永続化(版インスタンス単位の JSON)
// =============================================================================
// 役割: メモは版インスタンス単位で `dataRoot/notes/<templateId>.json` に
// `Record<pathKey, PartNote>` で保持する(別の基準日/版種の版へは引き継がない)。本体テキストは
// atomic write で半端読みを防ぐ。git 版管理対象のテンプレ本体とは別物で、メモは注釈として
// data ルート配下に置くだけ(コミットは伴わない)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertTemplateId, type PartNote, validation } from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';
import { withFileLock } from './fileLock.js';

const notesDir = (): string => path.join(config.dataRoot, 'notes');

/**
 * メモファイル 1 本の上限バイト数。読み側は `JSON.parse` で全体を 1 度に構造化するので、
 * サイズを見ずに読むと「書いた本人以外も含めた全 GET が同じ時間だけ止まる」。上限を
 * 超えたファイルは壊れているとみなし、空として扱う(読み取り経路は落とさない)。
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

type NoteMap = Record<string, PartNote>;

/**
 * 指定版インスタンスの全メモ(pathKey → PartNote)。ファイルが無ければ空。
 * サイズが `MAX_NOTES_FILE_BYTES` を超えるファイルは読まずに空を返す(理由は定数の説明)。
 */
export async function readNotes(templateId: string): Promise<NoteMap> {
  const file = fileFor(templateId);
  const size = await fs
    .stat(file)
    .then((s) => s.size)
    .catch(() => -1);
  if (size < 0 || size > MAX_NOTES_FILE_BYTES) return {};
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as NoteMap) : {};
  } catch {
    // 壊れたメモファイルで編集画面ごと落とさない(メモは注釈で、本体は git 側が正典)。
    return {};
  }
}

/** 指定版インスタンスのメモ一式を書き出す(ディレクトリは必要に応じて作成)。 */
export async function writeNotes(templateId: string, notes: NoteMap): Promise<void> {
  await fs.mkdir(notesDir(), { recursive: true });
  await atomicWrite(fileFor(templateId), `${JSON.stringify(notes, null, 2)}\n`);
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
export function notesAtCapacity(notes: NoteMap, pathKey: string): boolean {
  return !(pathKey in notes) && Object.keys(notes).length >= MAX_NOTES_PER_TEMPLATE;
}

/** 上限超過時に返す文言(ルート・repo で同じ案内にする)。 */
export function notesCapacityError(): never {
  throw validation(`このテンプレートのメモは上限(${MAX_NOTES_PER_TEMPLATE} 件)に達しています`);
}
