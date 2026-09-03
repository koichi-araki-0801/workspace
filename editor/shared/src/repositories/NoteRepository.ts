// =============================================================================
// NoteRepository.ts — パーツ単位コメント(1 段の入れ子スレッド)の集約
// =============================================================================
// 役割: 編集画面のパーツに紐づくコメントを、親投稿と返信の列として読み書きする契約。
// 投稿は書かれた版インスタンス(`templateId`)のファイルへ入り、他の版とは共有しない(交付版⇄
// 全体版のペアでも独立)。基準日をまたぐ繰り越しもしない。パーツの同定は構造パスキー
// (`pathKey`)で行う。返信は同じパーツの親投稿にだけ付き、状態は親にだけ切り替えられる。
import type { NoteKind, NoteStatus, PartNoteEntry } from '../index.js';
import type { Result } from '../result.js';

/** 追加時の任意指定。`replyTo` を渡すと返信になる(親は同じパーツの親投稿に限る)。 */
export interface AddNoteOptions {
  replyTo?: string | null;
  kind?: NoteKind;
}

/** 部分更新。本文か状態のどちらか一方以上を指定する。状態は親投稿にだけ指定できる。 */
export interface NotePatch {
  content?: string;
  status?: NoteStatus;
}

/** パーツ単位コメントの集約。読み書きとも投稿が属する版インスタンスにだけ向ける。 */
export interface NoteRepository {
  /** 版インスタンスの全投稿(作成日時の昇順)。無ければ空配列。 */
  listNotes(templateId: string): Promise<Result<PartNoteEntry[]>>;
  /** 投稿を追加する。本文の空文字は拒否する(削除は `deleteNote` で明示する)。 */
  addNote(
    templateId: string,
    pathKey: string,
    content: string,
    opts?: AddNoteOptions,
  ): Promise<Result<PartNoteEntry>>;
  /** 投稿の本文・状態を更新する。状態の変更は返信にも伝播する。 */
  updateNote(templateId: string, entryId: string, patch: NotePatch): Promise<Result<PartNoteEntry>>;
  /** 投稿を削除する。親投稿なら返信も一緒に消える。 */
  deleteNote(templateId: string, entryId: string): Promise<Result<void>>;
}
