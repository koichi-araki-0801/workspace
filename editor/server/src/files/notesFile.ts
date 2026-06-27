// =============================================================================
// notesFile.ts — パーツ単位メモのファイル永続化(版インスタンス単位の JSON)
// =============================================================================
// 役割: メモは版インスタンス単位で `dataRoot/notes/<templateId>.json` に
// `Record<pathKey, PartNote>` で保持する(別の基準日/版種の版へは引き継がない)。本体テキストは
// atomic write で半端読みを防ぐ。git 版管理対象のテンプレ本体とは別物で、メモは注釈として
// data ルート配下に置くだけ(コミットは伴わない)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { type PartNote, parseTemplateFileName, validation } from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

const notesDir = (): string => path.join(config.dataRoot, 'notes');

/**
 * templateId を安全なファイル名に限定する(パストラバーサル防止)。templateId は版種に
 * 非ASCII(例: `..._全体版`)を含みうるため文字種では絞れない。代わりに「パス区切りを含まない
 * 単一セグメント」かつ「`..` を含まない」かつ「4トークン構造(`parseTemplateFileName`)に
 * 一致する」ことを要件とし、テンプレ本体と同じ命名規則のみ許可する。
 */
function fileFor(templateId: string): string {
  const safe =
    templateId === path.basename(templateId) &&
    !templateId.includes('..') &&
    parseTemplateFileName(`${templateId}.html`) !== null;
  if (!safe) {
    throw validation(`不正なテンプレート id です: ${templateId}`);
  }
  return path.join(notesDir(), `${templateId}.json`);
}

type NoteMap = Record<string, PartNote>;

/** 指定版インスタンスの全メモ(pathKey → PartNote)。ファイルが無ければ空。 */
export async function readNotes(templateId: string): Promise<NoteMap> {
  const raw = await fs.readFile(fileFor(templateId), 'utf8').catch(() => '');
  if (!raw) return {};
  return JSON.parse(raw) as NoteMap;
}

/** 指定版インスタンスのメモ一式を書き出す(ディレクトリは必要に応じて作成)。 */
export async function writeNotes(templateId: string, notes: NoteMap): Promise<void> {
  await fs.mkdir(notesDir(), { recursive: true });
  await atomicWrite(fileFor(templateId), `${JSON.stringify(notes, null, 2)}\n`);
}
