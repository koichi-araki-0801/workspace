// =============================================================================
// NoteRepository.ts — パーツ単位メモ(版インスタンス単位)の集約
// =============================================================================
// 役割: 編集画面のパーツに紐づく作業メモを、版インスタンス(`templateId` = 委託会社/
// ファンドコード/基準日/版種を内包)単位で読み書きする契約。パーツ構造パスキー(`pathKey`)へ
// メモ本文を結びつける。別の基準日/版種の版へは引き継がない(`web` の `partKey.ts` を見よ)。
import type { PartNote } from '../index.js';
import type { Result } from '../result.js';

/** パーツ単位メモの集約。`templateId`(版インスタンス)単位で全件取得し、1 パーツ単位で保存する。 */
export interface NoteRepository {
  /** 指定版インスタンスの全メモを返す。無ければ空配列。 */
  listNotes(templateId: string): Promise<Result<PartNote[]>>;
  /**
   * 1 パーツのメモを保存する。`content` が空文字なら「メモ無し」として削除に倒す
   * (別 API を増やさず、空＝削除で一意に扱う)。
   */
  saveNote(templateId: string, pathKey: string, content: string): Promise<Result<void>>;
}
