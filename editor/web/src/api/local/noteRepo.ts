// =============================================================================
// noteRepo.ts — パーツ単位コメント(1 段の入れ子スレッド)の local 実装(localStorage)
// =============================================================================
// 役割: `NoteRepository` の local 実装。`editor:notes:v2` に
// `Record<templateId, Record<pathKey, PartNoteEntry[]>>` で保持する。読み書きとも投稿が属する
// 版インスタンスに閉じ、交付版⇄全体版のペアでも共有しない(REST 実装と同じ挙動)。
// 資源上限も REST(server の Zod 契約 + `files/notesFile.ts`)と同じ 4 定数を shared から
// 引いて強制する。ここが素通しだと、local(オフライン/デモビルド)だけ本物の server が拒否する
// 操作を許してしまい、offline ビルドが実物と異なる挙動を利用者に学習させる。
// 返信・状態の規則(親は同じパーツ・入れ子は 1 段・状態は親だけ・親削除で返信も消える)も
// server の `repositories/noteRepo.ts` と同じにする。
import {
  type AddNoteOptions,
  MAX_NOTE_CONTENT_CHARS,
  MAX_NOTE_ENTRIES_PER_PART,
  MAX_NOTE_PATH_KEY_CHARS,
  MAX_NOTES_PER_TEMPLATE,
  type NoteKind,
  type NotePatch,
  type NoteRepository,
  type NoteStatus,
  type PartNoteEntry,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, write } from './store';

type NoteStore = Record<string, Record<string, PartNoteEntry[]>>;

const NOTE_STATUSES: ReadonlySet<string> = new Set<NoteStatus>(['open', 'resolved']);
const NOTE_KINDS: ReadonlySet<string> = new Set<NoteKind>(['note', 'fix-request', 'question']);

/**
 * `status`/`replyTo`/`kind` を持たない旧データ(`editor:notes:v2` 導入前に書かれた投稿)へ
 * 既定値を補う。server の `files/notesFile.ts` の `withCommentDefaults` と同じ規則
 * (status は 'open'、kind は 'note'、replyTo は非空文字列でなければ null)。補わないと
 * `parent.replyTo !== null` が `undefined !== null` で真になり、旧投稿への返信・解決が
 * 常に拒否される。列挙の外の値も既定へ戻す(1 件の破損で読み取り全体を落とさない)。
 */
function withCommentDefaults(raw: PartNoteEntry): PartNoteEntry {
  const status =
    typeof raw.status === 'string' && NOTE_STATUSES.has(raw.status) ? raw.status : 'open';
  const kind = typeof raw.kind === 'string' && NOTE_KINDS.has(raw.kind) ? raw.kind : 'note';
  const replyTo = typeof raw.replyTo === 'string' && raw.replyTo !== '' ? raw.replyTo : null;
  return { ...raw, status, replyTo, kind };
}

/** `K.notes` を読み、全投稿へコメント属性の既定値を補って返す(読み取りの唯一の入口)。 */
function readStore(): NoteStore {
  const all = read<NoteStore>(K.notes, {});
  const out: NoteStore = {};
  for (const [templateId, tpl] of Object.entries(all)) {
    const outTpl: Record<string, PartNoteEntry[]> = {};
    for (const [pathKey, entries] of Object.entries(tpl)) {
      outTpl[pathKey] = entries.map(withCommentDefaults);
    }
    out[templateId] = outTpl;
  }
  return out;
}

/** 本文の長さ上限。add/update 共通(REST の `AddNoteRequest`/`UpdateNoteRequest` と同じ)。 */
function assertContentLength(content: string): void {
  if (content.length > MAX_NOTE_CONTENT_CHARS) {
    throw validation(`コメントの本文は${MAX_NOTE_CONTENT_CHARS}文字までです`);
  }
}

/** パーツキーの長さ上限。pathKey は追加時にしか受け取らないので add でのみ検査する。 */
function assertPathKeyLength(pathKey: string): void {
  if (pathKey.length > MAX_NOTE_PATH_KEY_CHARS) {
    throw validation(`パーツキーが上限(${MAX_NOTE_PATH_KEY_CHARS}文字)を超えています`);
  }
}

/**
 * 1 パーツの投稿数が上限に達しているか(返信を含む)。上限が効くのは追加だけ — 編集・削除
 * まで止めると「上限に達したパーツのコメントを消せない」という詰みを作る
 * (`files/notesFile.ts` と同じ方針)。
 */
function entriesAtCapacity(entries: readonly PartNoteEntry[]): boolean {
  return entries.length >= MAX_NOTE_ENTRIES_PER_PART;
}

/** 1 版インスタンス(pathKey の件数)が上限に達しているか。新規キーの追加可否にのみ使う。 */
function notesAtCapacity(tpl: Record<string, PartNoteEntry[]>, pathKey: string): boolean {
  return !(pathKey in tpl) && Object.keys(tpl).length >= MAX_NOTES_PER_TEMPLATE;
}

/** 投稿 ID から所在(パーツキー・位置)を引く。 */
function locate(
  all: NoteStore,
  templateId: string,
  entryId: string,
): { pathKey: string; index: number } {
  for (const [pathKey, entries] of Object.entries(all[templateId] ?? {})) {
    const index = entries.findIndex((e) => e.id === entryId);
    if (index >= 0) return { pathKey, index };
  }
  throw validation('対象のコメントが見つかりません(すでに削除された可能性があります)');
}

/** 返信先の親を同じパーツから引く(server の `requireParent` と同じ 3 条件)。 */
function requireParent(entries: readonly PartNoteEntry[], replyTo: string): PartNoteEntry {
  const parent = entries.find((e) => e.id === replyTo);
  if (!parent)
    throw validation('返信先のコメントが見つかりません(すでに削除された可能性があります)');
  if (parent.replyTo !== null) throw validation('返信への返信はできません');
  return parent;
}

export const localNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attempt(() => {
      const all = readStore();
      const own = Object.values(all[templateId] ?? {}).flat();
      // server 実装と同じ並び(作成日時のみで比較する)。安定ソートなので同値は挿入順のまま。
      own.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return delay(own);
    }),

  addNote: (templateId: string, pathKey: string, content: string, opts: AddNoteOptions = {}) =>
    attempt(() => {
      if (content === '') throw validation('コメントの本文を入力してください');
      assertContentLength(content);
      assertPathKeyLength(pathKey);
      const all = readStore();
      const tpl = all[templateId] ?? {};
      if (notesAtCapacity(tpl, pathKey)) {
        throw validation(
          `このテンプレートのコメントは上限(${MAX_NOTES_PER_TEMPLATE} 件)に達しています`,
        );
      }
      const entries = tpl[pathKey] ?? [];
      if (entriesAtCapacity(entries)) {
        throw validation(
          `このパーツのコメントは上限(${MAX_NOTE_ENTRIES_PER_PART} 件)に達しています。` +
            '不要なコメントを削除してください。',
        );
      }
      const replyTo = opts.replyTo ?? null;
      const parent = replyTo === null ? null : requireParent(entries, replyTo);
      const entry: PartNoteEntry = {
        id: crypto.randomUUID(),
        templateId,
        pathKey,
        content,
        createdAt: now(),
        createdBy: currentUser()?.displayName ?? '不明',
        updatedAt: null,
        updatedBy: null,
        status: parent ? parent.status : 'open',
        replyTo: parent ? parent.id : null,
        kind: opts.kind ?? 'note',
      };
      tpl[pathKey] = [...entries, entry];
      all[templateId] = tpl;
      write(K.notes, all);
      return entry;
    }),

  updateNote: (templateId: string, entryId: string, patch: NotePatch) =>
    attempt(() => {
      if (patch.content === undefined && patch.status === undefined)
        throw validation('本文か状態のどちらかを指定してください');
      if (patch.content !== undefined) {
        if (patch.content === '') throw validation('コメントの本文を入力してください');
        assertContentLength(patch.content);
      }
      const all = readStore();
      const { pathKey, index } = locate(all, templateId, entryId);
      const target = all[templateId][pathKey][index];
      if (patch.status !== undefined && target.replyTo !== null)
        throw validation('状態は親のコメントでだけ切り替えられます');
      const updated: PartNoteEntry = {
        ...target,
        ...(patch.content !== undefined
          ? {
              content: patch.content,
              updatedAt: now(),
              updatedBy: currentUser()?.displayName ?? '不明',
            }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      all[templateId][pathKey] = all[templateId][pathKey].map((e) => {
        if (e.id === entryId) return updated;
        if (patch.status !== undefined && e.replyTo === entryId)
          return { ...e, status: patch.status };
        return e;
      });
      write(K.notes, all);
      return updated;
    }),

  deleteNote: (templateId: string, entryId: string) =>
    attempt(() => {
      const all = readStore();
      const { pathKey } = locate(all, templateId, entryId);
      const rest = all[templateId][pathKey].filter(
        (e) => e.id !== entryId && e.replyTo !== entryId,
      );
      // 空になったキー・版はエントリごと畳む(空オブジェクトを残さない)。
      if (rest.length === 0) delete all[templateId][pathKey];
      else all[templateId][pathKey] = rest;
      if (Object.keys(all[templateId]).length === 0) delete all[templateId];
      write(K.notes, all);
    }),
};
