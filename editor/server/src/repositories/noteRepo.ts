// =============================================================================
// noteRepo.ts — パーツ単位メモ(版インスタンス単位)のサーバ(REST)実装
// =============================================================================
// 役割: メモを版インスタンス単位の JSON ファイル(`notesFile.ts`)へ読み書きする。空文字 content
// は削除に倒す(`NoteRepository` 契約と同じ)。ルートは本モジュールを呼んで結果を返すだけ。
import type { PartNote } from '@editor/shared';
import {
  notesAtCapacity,
  notesCapacityError,
  readNotes,
  withNotesLock,
  writeNotes,
} from '../files/notesFile.js';

/** 指定版インスタンスの全メモ。 */
export async function listNotes(templateId: string): Promise<PartNote[]> {
  const map = await readNotes(templateId);
  return Object.values(map);
}

/**
 * 1 パーツのメモを保存する。`content` が空文字なら削除に倒す。
 *
 * 読み-改変-書きの全体を 1 版インスタンス単位のロックで包む。包まなかった版は、
 * 同一テンプレへの同時保存が互いの更新を消し(後勝ち)、`atomicWrite` の rename 競合で
 * 片方が 500 になっていた。件数上限は**新規キーのときだけ**見る — 既存メモの更新と
 * 削除は、上限に達していても必ず通す(でないと上限が「メモを消せない」状態を作る)。
 */
export async function saveNote(
  templateId: string,
  pathKey: string,
  content: string,
  loginId: string,
): Promise<void> {
  await withNotesLock(templateId, async () => {
    const map = await readNotes(templateId);
    if (content.trim() === '') {
      delete map[pathKey];
    } else {
      if (notesAtCapacity(map, pathKey)) notesCapacityError();
      map[pathKey] = {
        templateId,
        pathKey,
        content,
        updatedAt: new Date().toISOString(),
        updatedBy: loginId,
      };
    }
    await writeNotes(templateId, map);
  });
}
