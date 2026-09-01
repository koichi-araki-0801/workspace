// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)の local 実装(localStorage)
// =============================================================================
// 役割: `NoteRepository` の local 実装。`editor:notes:v2` に
// `Record<templateId, Record<pathKey, PartNoteEntry[]>>` で保持する。読み取りは交付版⇄
// 全体版のペアをマージし、書き込みは投稿が属する版へ向ける(REST 実装と同じ挙動)。
// 版種の対応表は shared の `pairedTemplateId` を使う — web 側へ複製すると片方だけがずれる。
import {
  type NoteRepository,
  type PartNoteEntry,
  pairedTemplateId,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, write } from './store';

type NoteStore = Record<string, Record<string, PartNoteEntry[]>>;

// `now()` はミリ秒精度で、`addNote` が同一ミリ秒内に連続実行されると値が衝突しうる(実測:
// テスト環境で高頻度に発生)。一覧の並びは createdAt → templateId → id の順で決まり、
// 同一 templateId 内で衝突すると乱数 id の比較に落ちて作成順を保てなくなるため、直近の
// 発行値以下なら 1ms 繰り上げて単調増加を保証する(server 側の比較関数はそのまま — 差は
// createdAt の発行方法だけで、並び替えロジック自体は複製しない)。
let lastCreatedAt = '';
function issueCreatedAt(): string {
  const t = now();
  const next =
    t > lastCreatedAt ? t : new Date(new Date(lastCreatedAt).getTime() + 1).toISOString();
  lastCreatedAt = next;
  return next;
}

/** 1 版インスタンス分の投稿を平坦化する。 */
function flatten(all: NoteStore, templateId: string): PartNoteEntry[] {
  return Object.values(all[templateId] ?? {}).flat();
}

/** 投稿 ID から所在(版・パーツキー・位置)を引く。 */
function locate(
  all: NoteStore,
  templateId: string,
  entryId: string,
): { pathKey: string; index: number } {
  for (const [pathKey, entries] of Object.entries(all[templateId] ?? {})) {
    const index = entries.findIndex((e) => e.id === entryId);
    if (index >= 0) return { pathKey, index };
  }
  throw validation('対象のメモが見つかりません(すでに削除された可能性があります)');
}

export const localNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      const paired = pairedTemplateId(templateId);
      const merged = [...flatten(all, templateId), ...(paired ? flatten(all, paired) : [])];
      // server 実装と同じ並び(作成日時 → 版 → ID)。同時刻でも読むたびに順が変わらない。
      merged.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.templateId.localeCompare(b.templateId) ||
          a.id.localeCompare(b.id),
      );
      return delay(merged);
    }),

  addNote: (templateId: string, pathKey: string, content: string) =>
    attempt(() => {
      if (content === '') throw validation('メモの本文を入力してください');
      const all = read<NoteStore>(K.notes, {});
      const tpl = all[templateId] ?? {};
      const entry: PartNoteEntry = {
        id: crypto.randomUUID(),
        templateId,
        pathKey,
        content,
        createdAt: issueCreatedAt(),
        createdBy: currentUser()?.displayName ?? '不明',
        updatedAt: null,
        updatedBy: null,
      };
      tpl[pathKey] = [...(tpl[pathKey] ?? []), entry];
      all[templateId] = tpl;
      write(K.notes, all);
      return entry;
    }),

  updateNote: (templateId: string, entryId: string, content: string) =>
    attempt(() => {
      if (content === '') throw validation('メモの本文を入力してください');
      const all = read<NoteStore>(K.notes, {});
      const { pathKey, index } = locate(all, templateId, entryId);
      const updated: PartNoteEntry = {
        ...all[templateId][pathKey][index],
        content,
        updatedAt: now(),
        updatedBy: currentUser()?.displayName ?? '不明',
      };
      all[templateId][pathKey] = all[templateId][pathKey].map((e, i) =>
        i === index ? updated : e,
      );
      write(K.notes, all);
      return updated;
    }),

  deleteNote: (templateId: string, entryId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      const { pathKey, index } = locate(all, templateId, entryId);
      const rest = all[templateId][pathKey].filter((_, i) => i !== index);
      // 空になったキー・版はエントリごと畳む(空オブジェクトを残さない)。
      if (rest.length === 0) delete all[templateId][pathKey];
      else all[templateId][pathKey] = rest;
      if (Object.keys(all[templateId]).length === 0) delete all[templateId];
      write(K.notes, all);
    }),
};
