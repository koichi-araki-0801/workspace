// =============================================================================
// NoteRepository.ts — パーツ単位メモ(追記型スレッド)の集約
// =============================================================================
// 役割: 編集画面のパーツに紐づく作業メモを、投稿を積むスレッドとして読み書きする契約。
// 投稿は書かれた版インスタンス(`templateId`)のファイルへ入り、読み取りでは交付版⇄全体版の
// ペア(`pairedTemplateId`)をマージした 1 本のスレッドとして返る。基準日をまたぐ繰り越しは
// しない(基準日が違えば別スレッド)。パーツの同定は構造パスキー(`pathKey`)で行う。
import type { PartNoteEntry } from '../index.js';
import type { Result } from '../result.js';

/** パーツ単位メモの集約。読み取りはペアをマージし、書き込みは投稿が属する版へ向ける。 */
export interface NoteRepository {
  /** 自版とペア版をマージしたスレッド(作成日時の昇順)。無ければ空配列。 */
  listNotes(templateId: string): Promise<Result<PartNoteEntry[]>>;
  /** 投稿を追加する。本文の空文字は拒否する(削除は `deleteNote` で明示する)。 */
  addNote(templateId: string, pathKey: string, content: string): Promise<Result<PartNoteEntry>>;
  /** 投稿本文を編集する。`templateId` は投稿が属する版(ペア側なら相手の版)。 */
  updateNote(templateId: string, entryId: string, content: string): Promise<Result<PartNoteEntry>>;
  /** 投稿を削除する。`templateId` は投稿が属する版(ペア側なら相手の版)。 */
  deleteNote(templateId: string, entryId: string): Promise<Result<void>>;
}
