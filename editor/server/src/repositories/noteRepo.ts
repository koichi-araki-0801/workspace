// =============================================================================
// noteRepo.ts — パーツ単位メモ(版インスタンス単位)のサーバ(REST)実装
// =============================================================================
// 役割: メモを版インスタンス単位の JSON ファイル(`notesFile.ts`)へ読み書きする。空文字 content
// は削除に倒す(`NoteRepository` 契約と同じ)。ルートは本モジュールを呼んで結果を返すだけ。
import type { PartNote } from '@editor/shared';
import { readNotes, writeNotes } from '../files/notesFile.js';

/** 指定版インスタンスの全メモ。 */
export async function listNotes(templateId: string): Promise<PartNote[]> {
  const map = await readNotes(templateId);
  return Object.values(map);
}

/** 1 パーツのメモを保存する。`content` が空文字なら削除に倒す。 */
export async function saveNote(
  templateId: string,
  pathKey: string,
  content: string,
  loginId: string,
): Promise<void> {
  const map = await readNotes(templateId);
  if (content.trim() === '') {
    delete map[pathKey];
  } else {
    map[pathKey] = {
      templateId,
      pathKey,
      content,
      updatedAt: new Date().toISOString(),
      updatedBy: loginId,
    };
  }
  await writeNotes(templateId, map);
}
