# editor コメント機能 計画 1/3: 契約・データ・サーバ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パーツメモの投稿に `status` / `replyTo` / `kind` を足し、交付版⇄全体版のマージ共有を廃止し、
返信・解決・連鎖削除をサーバと local 実装の両方で強制する(UI は既存のまま動き続ける)。

**Architecture:** 正典は `shared/src/schemas.ts`(Zod)で、server(`files/notesFile.ts` +
`repositories/noteRepo.ts` + `routes/notes.routes.ts`)と web local(`api/local/noteRepo.ts`)が
同じ規則を強制する。ファイル形式 `notes/<templateId>.json` は据え置き、旧データは読み取り時に
既定値を補う。`NoteRepository` 契約の引数だけを広げ、既存の呼び出し側(`usePartNote.ts` と
`NoteBubble.vue`)は最小の適合に留める(UI 刷新は計画 2)。

**Tech Stack:** TypeScript / Zod 4 / Fastify / Vue 3 / vitest(ルート `vitest.config.ts` の
projects 集約)/ pnpm workspace

**Spec:** `docs/superpowers/specs/2026-09-03-editor-reader-comments-design.md`(3 章・6 章・7 章)

## Global Constraints

- 作業ディレクトリはリポジトリルート `C:\Users\caads\workspace`。editor のパッケージは
  `editor/shared`・`editor/server`・`editor/web`。
- テストはルートから `pnpm exec vitest run --project <shared|server|web> <テストファイルの相対パス>`。
- 型チェックは **`@editor/shared` の先行ビルドが前提**:
  `pnpm --filter @editor/shared run build` → `pnpm run typecheck:editor`。
- `editor/**` を変更したコミットの直前に **必ず**
  `pnpm exec biome check --write editor/<変更ファイル…>` を実行する(lint-staged のステージ
  入れ替わり事故の回避。対象は変更ファイルに限定)。
- コミットメッセージは日本語の Conventional Commits(例 `feat(editor): …`)。末尾に
  `Claude-Session: https://claude.ai/code/session_01FzRSKkNMZEugJR2mhsMZAv` を付ける。
  コミット後に auto-push フックが origin へ push する(pre-push で CI が走る。11〜12 分)。
- コメントは `docs/コメント規約.md` に従う(なぜを書く / 日本語散文 + 英語ドメイン用語 /
  識別子はバッククォート / 経緯・日付・所見番号は書かない)。
- ファイルの改行は既存に合わせる(`.ts`/`.vue` は LF)。
- 新規ファイルをテストしたら、ルート `vitest.config.ts` の coverage `include` へ追加する
  (本計画では新規ソースファイルは作らない)。
- 既存の上限 4 定数(`MAX_NOTE_CONTENT_CHARS` / `MAX_NOTE_PATH_KEY_CHARS` /
  `MAX_NOTE_ENTRIES_PER_PART` / `MAX_NOTES_PER_TEMPLATE`)と `MAX_NOTES_FILE_BYTES` の
  強制は変えない。`MAX_NOTE_ENTRIES_PER_PART` は返信を含めて数える。
- `pairedTemplateId` 自体は削除しない(`pairSyncService` が使う)。

---

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `editor/shared/src/schemas.ts` | 修正 | `NoteStatus` / `NoteKind` / `PartNoteEntry` 3 フィールド / `AddNoteRequest` / `UpdateNoteRequest` |
| `editor/shared/src/index.ts` | 修正 | 型の再輸出とコメント |
| `editor/shared/src/repositories/NoteRepository.ts` | 修正 | `addNote` の `opts`、`updateNote` の `patch` |
| `editor/shared/test/partNote.test.ts` | 修正 | スキーマの受理・拒否 |
| `editor/server/src/files/notesFile.ts` | 修正 | `StoredNoteEntry` 3 フィールドと既定値補完 |
| `editor/server/src/repositories/noteRepo.ts` | 修正 | マージ撤去・返信検証・状態伝播・連鎖削除 |
| `editor/server/src/routes/notes.routes.ts` | 修正 | `POST` の `replyTo`/`kind`、`PATCH` の部分更新 |
| `editor/server/openapi/openapi.json` | 再生成 | 公開契約 |
| `editor/server/test/notesFile.thread.test.ts` | 修正 | 既定値補完 |
| `editor/server/test/noteRepo.test.ts` | 書き換え | 自版のみ・返信・解決・連鎖削除 |
| `editor/server/test/notes.routes.test.ts` | 修正 | 本文検証 |
| `editor/web/src/api/local/noteRepo.ts` | 修正 | server と同じ規則 |
| `editor/web/src/api/rest/noteRepo.ts` | 修正 | 新しい body |
| `editor/web/test/noteRepo.test.ts` | 修正 | local の規則 |
| `editor/web/src/features/editor/usePartNote.ts` | 修正 | `reply` / `setStatus`、`update` の適合 |
| `editor/web/test/usePartNote.test.ts` | 修正 | fake repo の適合と新メソッド |
| `editor/web/src/features/editor/useTemplateEditor.ts` | 修正 | コメントの更新のみ |
| `editor/web/src/features/editor/Inspector.vue` | 修正 | 案内文言(共有の記述を削る) |
| `docs/editor/src/設計正典.md` | 修正 | 「パーツメモ」節のペア共有記述 |

---

### Task 1: shared スキーマと契約

**Files:**
- Modify: `editor/shared/src/schemas.ts:595-630`
- Modify: `editor/shared/src/index.ts:160-170`
- Modify: `editor/shared/src/repositories/NoteRepository.ts`
- Test: `editor/shared/test/partNote.test.ts`

**Interfaces:**
- Produces:
  - `NoteStatus = 'open' | 'resolved'`、`NoteKind = 'note' | 'fix-request' | 'question'`(Zod enum と TS 型)
  - `PartNoteEntry` に `status: NoteStatus`、`replyTo: string | null`、`kind: NoteKind`(必須)
  - `AddNoteRequest = { pathKey; content; replyTo?: string | null; kind?: NoteKind }`(`kind` 未指定は `'note'` にパース)
  - `UpdateNoteRequest = { content?: string; status?: NoteStatus }`(どちらも無ければ拒否)
  - `AddNoteOptions = { replyTo?: string | null; kind?: NoteKind }`、`NotePatch = { content?: string; status?: NoteStatus }`
  - `NoteRepository.addNote(templateId, pathKey, content, opts?: AddNoteOptions)`
  - `NoteRepository.updateNote(templateId, entryId, patch: NotePatch)`

- [ ] **Step 1: 失敗するテストを書く**

`editor/shared/test/partNote.test.ts` の `describe('PartNoteEntry', …)` と
`describe('AddNoteRequest / UpdateNoteRequest', …)` に次を足す(既存の `it` は残す。
既存の `PartNoteEntry` 受理テストには `status: 'open', replyTo: null, kind: 'note'` を足して通す)。

```ts
import { AddNoteRequest, NoteKind, NoteStatus, PartNoteEntry, UpdateNoteRequest } from '../src/schemas.js';

describe('PartNoteEntry のコメント属性', () => {
  const base = {
    id: 'e1',
    templateId: 'AM01_510037_20240710_交付版',
    pathKey: '.page#1/cover#1',
    content: '本文',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'editor1',
    updatedAt: null,
    updatedBy: null,
  };

  it('status / replyTo / kind を持つ形を受理する', () => {
    const res = PartNoteEntry.safeParse({ ...base, status: 'resolved', replyTo: 'p1', kind: 'question' });
    expect(res.success).toBe(true);
  });

  it('3 フィールドはいずれも必須(応答はサーバが必ず補う)', () => {
    expect(PartNoteEntry.safeParse(base).success).toBe(false);
  });

  it('列挙の外の値は拒否する', () => {
    expect(NoteStatus.safeParse('closed').success).toBe(false);
    expect(NoteKind.safeParse('todo').success).toBe(false);
  });
});

describe('AddNoteRequest の返信と種別', () => {
  it('kind を省くと note にパースされる', () => {
    const res = AddNoteRequest.parse({ pathKey: 'p', content: 'x' });
    expect(res.kind).toBe('note');
    expect(res.replyTo).toBeNull();
  });

  it('replyTo と kind を受理する', () => {
    const res = AddNoteRequest.parse({ pathKey: 'p', content: 'x', replyTo: 'p1', kind: 'fix-request' });
    expect(res.replyTo).toBe('p1');
    expect(res.kind).toBe('fix-request');
  });

  it('replyTo の空文字は拒否する(親を指さない返信を作らない)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: 'x', replyTo: '' }).success).toBe(false);
  });
});

describe('UpdateNoteRequest の部分更新', () => {
  it('content だけ / status だけ / 両方 を受理する', () => {
    expect(UpdateNoteRequest.safeParse({ content: 'x' }).success).toBe(true);
    expect(UpdateNoteRequest.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(UpdateNoteRequest.safeParse({ content: 'x', status: 'open' }).success).toBe(true);
  });

  it('どちらも無い本文は拒否する', () => {
    expect(UpdateNoteRequest.safeParse({}).success).toBe(false);
  });

  it('content の空文字は引き続き拒否する', () => {
    expect(UpdateNoteRequest.safeParse({ content: '', status: 'open' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project shared editor/shared/test/partNote.test.ts`
Expected: FAIL(`NoteStatus` / `NoteKind` が export されていない、`status` 必須の検査が通らない)

- [ ] **Step 3: スキーマを実装する**

`editor/shared/src/schemas.ts` の `PartNoteEntry` の直前に列挙を足し、3 スキーマを次に置き換える。

```ts
/** コメントの状態。返信は親と同じ値を持ち、切り替えは親投稿にだけ許す。 */
export const NoteStatus = z.enum(['open', 'resolved']).meta({ id: 'NoteStatus' });

/** コメントの種別。表示ラベルは「メモ」「修正依頼」「質問」。 */
export const NoteKind = z.enum(['note', 'fix-request', 'question']).meta({ id: 'NoteKind' });

/**
 * パーツ単位コメントの投稿 1 件。コメントは 1 段の入れ子を持つスレッドで、投稿は書かれた
 * 版インスタンスのファイルへ入る(交付版⇄全体版で共有しない)。
 * `templateId` は投稿が属する版(編集・削除の宛先)。キー算出は web の `partKey.ts`。
 */
export const PartNoteEntry = z
  .object({
    id: z.string().meta({ description: '投稿 ID(UUID。旧形式からの変換分は `legacy:<pathKey>`)' }),
    templateId: z.string().meta({ description: '投稿が属する版インスタンス ID' }),
    pathKey: z.string().meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    content: z.string().meta({ description: '投稿本文' }),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string().nullable().meta({ description: '本文が編集された場合のみ' }),
    updatedBy: z.string().nullable(),
    status: NoteStatus.meta({ description: '未対応 / 解決済み。返信は親と同じ値' }),
    replyTo: z.string().nullable().meta({ description: '親投稿の ID。null なら親(スレッドの起点)' }),
    kind: NoteKind.meta({ description: '種別' }),
  })
  .meta({ id: 'PartNoteEntry' });

/**
 * (server 専用) 投稿の追加。`templateId` はパスから取る。空文字の本文は受け付けない。
 * `replyTo` は同じパーツの親投稿を指す(親の検証はサーバの `noteRepo` が行う)。
 */
export const AddNoteRequest = z
  .object({
    pathKey: z
      .string()
      .min(1)
      .max(MAX_NOTE_PATH_KEY_CHARS)
      .meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS).meta({ description: '投稿本文' }),
    replyTo: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .meta({ description: '返信先の親投稿 ID。null なら親投稿として追加する' }),
    kind: NoteKind.default('note'),
  })
  .meta({ id: 'AddNoteRequest' });

/**
 * (server 専用) 投稿の部分更新。本文と状態のどちらか一方以上を指定する。削除は DELETE で
 * 明示するため、本文の空文字は受け付けない。状態は親投稿にだけ指定できる(返信への指定は
 * サーバが拒否する)。
 */
export const UpdateNoteRequest = z
  .object({
    content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS).optional().meta({ description: '投稿本文' }),
    status: NoteStatus.optional(),
  })
  .refine((b) => b.content !== undefined || b.status !== undefined, {
    message: '本文か状態のどちらかを指定してください',
  })
  .meta({ id: 'UpdateNoteRequest' });
```

`editor/shared/src/index.ts` の `PartNoteEntry` 周辺を次に置き換える。

```ts
/**
 * パーツ単位コメントの投稿 1 件。コメントは親投稿とその返信(1 段)から成るスレッドで、
 * 版インスタンスごとに独立する(交付版と全体版で共有しない)。基準日をまたぐ繰り越しもしない。
 * キー算出は `web` の `partKey.ts` の `partPathKeyFor`。
 */
export type PartNoteEntry = z.infer<typeof sch.PartNoteEntry>;
export type NoteStatus = z.infer<typeof sch.NoteStatus>;
export type NoteKind = z.infer<typeof sch.NoteKind>;

export type AddNoteRequest = z.infer<typeof sch.AddNoteRequest>;

export type UpdateNoteRequest = z.infer<typeof sch.UpdateNoteRequest>;
```

`editor/shared/src/repositories/NoteRepository.ts` を次に置き換える。

```ts
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
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project shared editor/shared/test/partNote.test.ts`
Expected: PASS(既存を含め全件)

- [ ] **Step 5: shared をビルドしてコミットする**

```bash
pnpm --filter @editor/shared run build
pnpm exec biome check --write editor/shared/src/schemas.ts editor/shared/src/index.ts editor/shared/src/repositories/NoteRepository.ts editor/shared/test/partNote.test.ts
git add editor/shared/src/schemas.ts editor/shared/src/index.ts editor/shared/src/repositories/NoteRepository.ts editor/shared/test/partNote.test.ts
git commit -m "feat(editor): コメントの状態・返信・種別を shared の契約へ足す"
```

(この時点で server / web の型チェックは赤い。Task 2〜7 で順に直す。)

---

### Task 2: notesFile の保存形式と既定値補完

**Files:**
- Modify: `editor/server/src/files/notesFile.ts:55-120`
- Test: `editor/server/test/notesFile.thread.test.ts`

**Interfaces:**
- Consumes: Task 1 の `PartNoteEntry`
- Produces: `StoredNoteEntry`(`Omit<PartNoteEntry, 'templateId' | 'pathKey'>` = 3 フィールドを含む)。
  `readNotes` / `readNotesStrict` が返す全要素は `status` / `replyTo` / `kind` を必ず持つ。

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/notesFile.thread.test.ts` に `describe` を足す(既存の `describe` の書き方 —
`vi.stubEnv('DATA_ROOT', tmpRoot)` + `vi.resetModules()` + 動的 import — に合わせる。
既存テストで `writeNotes` に渡している要素には `status: 'open', replyTo: null, kind: 'note'` を足す)。

```ts
describe('コメント属性の既定値補完', () => {
  it('3 フィールドを持たない投稿は open / null / note として読む', async () => {
    const files = await importFiles();
    const dir = path.join(tmpRoot, 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${TPL}.json`),
      JSON.stringify({
        [KEY]: [
          {
            id: 'e1',
            content: '旧い投稿',
            createdAt: '2026-09-01T00:00:00.000Z',
            createdBy: 'editor1',
            updatedAt: null,
            updatedBy: null,
          },
        ],
      }),
    );
    const notes = await files.readNotes(TPL);
    expect(notes[KEY][0]).toMatchObject({ status: 'open', replyTo: null, kind: 'note' });
  });

  it('列挙の外の値は既定値へ戻す(壊れた値で画面を落とさない)', async () => {
    const files = await importFiles();
    const dir = path.join(tmpRoot, 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${TPL}.json`),
      JSON.stringify({
        [KEY]: [
          {
            id: 'e1',
            content: 'x',
            createdAt: '',
            createdBy: '',
            updatedAt: null,
            updatedBy: null,
            status: 'closed',
            replyTo: 42,
            kind: 'todo',
          },
        ],
      }),
    );
    const notes = await files.readNotes(TPL);
    expect(notes[KEY][0]).toMatchObject({ status: 'open', replyTo: null, kind: 'note' });
  });

  it('旧形式(1 パーツ 1 件)の変換分も 3 フィールドを持つ', async () => {
    const files = await importFiles();
    const dir = path.join(tmpRoot, 'notes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${TPL}.json`),
      JSON.stringify({ [KEY]: { content: '旧形式', updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'e' } }),
    );
    const notes = await files.readNotes(TPL);
    expect(notes[KEY][0]).toMatchObject({ id: `legacy:${KEY}`, status: 'open', replyTo: null, kind: 'note' });
  });
});
```

`importFiles` / `TPL` / `KEY` は既存テストのヘルパ名に合わせる(無ければ次を冒頭に置く)。

```ts
const TPL = 'AM01_510037_20240710_交付版';
const KEY = '.page#1/cover#1';
async function importFiles(): Promise<typeof import('../src/files/notesFile.js')> {
  vi.stubEnv('DATA_ROOT', tmpRoot);
  vi.resetModules();
  return import('../src/files/notesFile.js');
}
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/notesFile.thread.test.ts`
Expected: FAIL(`status` が undefined)

- [ ] **Step 3: 既定値補完を実装する**

`editor/server/src/files/notesFile.ts` の `looksLikeStoredNoteEntry` と `normalizeStored` を
次に置き換える(`StoredNoteEntry` 型は `Omit` のままで 3 フィールドが自動的に入る)。
import に `NoteKind`, `NoteStatus` 型を足す(`import { …, type NoteKind, type NoteStatus, … } from '@editor/shared'`)。

```ts
/**
 * 配列要素が投稿として最低限の形をしているか(`id` と `content` が string であること)。
 *
 * 壊れた要素(`null`・`content` 欠如)を弾かないと、`repositories/noteRepo.ts` の `locate` が
 * `.id` 参照で例外を投げ、保存の関所であるはずの `validation`(400)ではなく素の TypeError
 * (500)が返る。フルスキーマ検証は別レイヤ(REST 契約の Zod)の役目なので、ここは壊れた要素を
 * 静かに落とすだけの最小限に絞る(他フィールドの型までは見ない)。
 */
function looksLikeStoredNoteEntry(v: unknown): v is Record<string, unknown> & { id: string; content: string } {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { content?: unknown }).content === 'string'
  );
}

const NOTE_STATUSES: ReadonlySet<string> = new Set<NoteStatus>(['open', 'resolved']);
const NOTE_KINDS: ReadonlySet<string> = new Set<NoteKind>(['note', 'fix-request', 'question']);

/**
 * 保存済みの投稿へコメント属性の既定値を補う。属性を持たない投稿(以前の形式)は
 * 「未対応の親投稿・種別メモ」として読む。列挙の外の値も既定値へ戻す — ここで例外にすると
 * 1 要素の破損でテンプレの全コメントが読めなくなる(コメントは注釈で、本体は git 側が正典)。
 * 補完は読み取り時だけで、次の書き込みで新形式として保存され自然に移りきる。
 */
function withCommentDefaults(raw: Record<string, unknown> & { id: string; content: string }): StoredNoteEntry {
  const status = typeof raw.status === 'string' && NOTE_STATUSES.has(raw.status) ? (raw.status as NoteStatus) : 'open';
  const kind = typeof raw.kind === 'string' && NOTE_KINDS.has(raw.kind) ? (raw.kind as NoteKind) : 'note';
  const replyTo = typeof raw.replyTo === 'string' && raw.replyTo !== '' ? raw.replyTo : null;
  return {
    id: raw.id,
    content: raw.content,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
    status,
    replyTo,
    kind,
  };
}

/**
 * 旧形式(`pathKey` → メモ 1 件)を投稿 1 件の配列へ変換する。
 *
 * 変換後の ID を `` `legacy:${key}` ``(`key` = そのメモが属する `pathKey`)にするのは、
 * 読むたびに ID が変わると編集・削除の宛先が安定しないため。固定値 `legacy` 単体だと、
 * `repositories/noteRepo.ts` の `locate` は**ファイル内の全 `pathKey` を横断**して ID 一致を
 * 探すので、旧形式ファイルが 2 パーツ以上を持つ場合に全パーツが同じ ID を名乗ってしまい、
 * 先に見つかったパーツ(= 別パーツ)が編集・削除の宛先になる(所在特定はファイル単位で一意な
 * ID を前提にしている)。`pathKey` を連結すれば旧形式(1 パーツにつき 1 件)の制約と合わせて
 * ファイル内で一意になる。一括移行はしない — 次の書き込みで新形式として保存され、自然に
 * 移りきる。
 */
function normalizeStored(parsed: Record<string, unknown>): NoteEntriesMap {
  const out: NoteEntriesMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      out[key] = value.filter(looksLikeStoredNoteEntry).map(withCommentDefaults);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const legacy = value as { content?: unknown; updatedAt?: unknown; updatedBy?: unknown };
    if (typeof legacy.content !== 'string') continue;
    out[key] = [
      withCommentDefaults({
        id: `legacy:${key}`,
        content: legacy.content,
        createdAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : '',
        createdBy: typeof legacy.updatedBy === 'string' ? legacy.updatedBy : '',
        updatedAt: null,
        updatedBy: null,
      }),
    ];
  }
  return out;
}
```

ファイル冒頭の役割コメント(`// 役割: メモは版インスタンス単位で …`)の「交付版⇄全体版の
ペアをまたぐマージは読み取り側(`repositories/noteRepo.ts`)が行う。」の 1 文を削る。

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/notesFile.thread.test.ts editor/server/test/notesFile.test.ts editor/server/test/notes.limits.test.ts`
Expected: PASS(`notes.limits.test.ts` / `notesFile.test.ts` で `writeNotes` に旧形の要素を渡して
いる箇所があれば 3 フィールドを足す。`readNotes` の戻りを `toEqual` で比べている箇所は
`toMatchObject` に変えるか 3 フィールドを足す)

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/files/notesFile.ts editor/server/test/notesFile.thread.test.ts editor/server/test/notesFile.test.ts editor/server/test/notes.limits.test.ts
git add editor/server/src/files/notesFile.ts editor/server/test/
git commit -m "feat(editor): コメント属性を持たない投稿へ読み取り時に既定値を補う"
```

---

### Task 3: サーバ noteRepo — マージ撤去・返信・解決・連鎖削除

**Files:**
- Modify: `editor/server/src/repositories/noteRepo.ts`(全面)
- Test: `editor/server/test/noteRepo.test.ts`(全面書き換え)

**Interfaces:**
- Consumes: Task 2 の `StoredNoteEntry`、Task 1 の `NoteKind` / `NoteStatus`
- Produces:
  - `listNotes(templateId): Promise<PartNoteEntry[]>`(自版のみ、`createdAt` 昇順)
  - `addNote(templateId, pathKey, content, loginId, opts: { replyTo: string | null; kind: NoteKind })`
  - `updateNote(templateId, entryId, patch: { content?: string; status?: NoteStatus }, loginId)`
  - `deleteNote(templateId, entryId)`(親なら返信も削除)

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/noteRepo.test.ts` を次で置き換える(ファイル冒頭のヘルパは既存と同じ)。

```ts
// =============================================================================
// noteRepo.test.ts — コメントの版インスタンス独立・返信・解決・連鎖削除
// =============================================================================
// コメントは版インスタンス単位のファイルに保存し、他の版(交付版⇄全体版のペアを含む)とは
// 共有しない。ここで主張するのは、読み取りが自版に閉じること・返信が同じパーツの親投稿にだけ
// 付くこと・状態の切替が親にだけ許され返信へ伝播すること・親の削除が返信を道連れにすること。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_NOTE_ENTRIES_PER_PART } from '@editor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

async function importRepo(): Promise<{
  repo: typeof import('../src/repositories/noteRepo.js');
  files: typeof import('../src/files/notesFile.js');
}> {
  vi.stubEnv('DATA_ROOT', tmpRoot);
  vi.resetModules();
  return {
    repo: await import('../src/repositories/noteRepo.js'),
    files: await import('../src/files/notesFile.js'),
  };
}

const KOUFU = 'AM01_510037_20240710_交付版';
const ZENTAI = 'AM01_510037_20240710_全体版';
const KEY = '.page#1/cover#1';
const OTHER_KEY = '.page#1/.summary#1';
const PARENT = { replyTo: null, kind: 'note' as const };

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-note-repo-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('版インスタンスの独立', () => {
  it('交付版から読んでも全体版の投稿は混ざらない', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版', 'editor1', PARENT);
    await repo.addNote(ZENTAI, KEY, '全体版', 'editor2', PARENT);
    expect((await repo.listNotes(KOUFU)).map((e) => e.content)).toEqual(['交付版']);
    expect((await repo.listNotes(ZENTAI)).map((e) => e.content)).toEqual(['全体版']);
  });

  it('作成日時の昇順で返し、同一 createdAt は書き込み順を保つ', async () => {
    const { repo, files } = await importRepo();
    const t = '2026-09-01T00:00:00.000Z';
    const stored = (id: string, content: string) => ({
      id,
      content,
      createdAt: t,
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
      status: 'open' as const,
      replyTo: null,
      kind: 'note' as const,
    });
    await files.writeNotes(KOUFU, { [KEY]: [stored('z1', '1 件目'), stored('m2', '2 件目'), stored('a3', '3 件目')] });
    expect((await repo.listNotes(KOUFU)).map((e) => e.content)).toEqual(['1 件目', '2 件目', '3 件目']);
  });
});

describe('追加', () => {
  it('親投稿は open / replyTo null / 指定した種別で保存される', async () => {
    const { repo } = await importRepo();
    const e = await repo.addNote(KOUFU, KEY, '修正して', 'editor1', { replyTo: null, kind: 'fix-request' });
    expect(e).toMatchObject({ status: 'open', replyTo: null, kind: 'fix-request', templateId: KOUFU, pathKey: KEY });
  });

  it('返信は親の状態を引き継ぐ', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    await repo.updateNote(KOUFU, p.id, { status: 'resolved' }, 'editor1');
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id, kind: 'note' });
    expect(r).toMatchObject({ replyTo: p.id, status: 'resolved' });
  });

  it('存在しない親への返信は拒否する', async () => {
    const { repo } = await importRepo();
    await expect(repo.addNote(KOUFU, KEY, '返信', 'editor1', { replyTo: 'nope', kind: 'note' })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('別パーツの投稿を親にした返信は拒否する', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, OTHER_KEY, '別パーツ', 'editor1', PARENT);
    await expect(repo.addNote(KOUFU, KEY, '返信', 'editor1', { replyTo: p.id, kind: 'note' })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('返信への返信は拒否する(入れ子は 1 段)', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id, kind: 'note' });
    await expect(repo.addNote(KOUFU, KEY, '孫', 'editor1', { replyTo: r.id, kind: 'note' })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('1 パーツの投稿数上限は返信を含めて数える', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    // 親 1 件 + 返信 (上限 - 1) 件で上限に達する。次の親投稿は拒否される。
    for (let i = 1; i < MAX_NOTE_ENTRIES_PER_PART; i += 1) {
      await repo.addNote(KOUFU, KEY, `返信 ${i}`, 'editor1', { replyTo: p.id, kind: 'note' });
    }
    await expect(repo.addNote(KOUFU, KEY, '上限超え', 'editor1', PARENT)).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('更新', () => {
  it('本文の更新は updatedAt/updatedBy を刻み、状態だけの更新は刻まない', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const edited = await repo.updateNote(KOUFU, p.id, { content: '直した' }, 'editor2');
    expect(edited.content).toBe('直した');
    expect(edited.updatedBy).toBe('editor2');
    const resolved = await repo.updateNote(KOUFU, p.id, { status: 'resolved' }, 'editor3');
    expect(resolved.status).toBe('resolved');
    expect(resolved.updatedBy).toBe('editor2');
  });

  it('親の状態切替は返信へ伝播する', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id, kind: 'note' });
    await repo.updateNote(KOUFU, p.id, { status: 'resolved' }, 'editor1');
    const all = await repo.listNotes(KOUFU);
    expect(all.find((e) => e.id === r.id)?.status).toBe('resolved');
    await repo.updateNote(KOUFU, p.id, { status: 'open' }, 'editor1');
    expect((await repo.listNotes(KOUFU)).every((e) => e.status === 'open')).toBe(true);
  });

  it('返信への状態指定は拒否する', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id, kind: 'note' });
    await expect(repo.updateNote(KOUFU, r.id, { status: 'resolved' }, 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('返信の本文は編集できる', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id, kind: 'note' });
    expect((await repo.updateNote(KOUFU, r.id, { content: '直した返信' }, 'editor2')).content).toBe('直した返信');
  });
});

describe('削除', () => {
  it('親を削除すると返信も消え、パーツが空になればキーごと畳む', async () => {
    const { repo, files } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    await repo.addNote(KOUFU, KEY, '返信 1', 'editor2', { replyTo: p.id, kind: 'note' });
    await repo.addNote(KOUFU, KEY, '返信 2', 'editor2', { replyTo: p.id, kind: 'note' });
    await repo.deleteNote(KOUFU, p.id);
    expect(await repo.listNotes(KOUFU)).toEqual([]);
    expect(await files.readNotes(KOUFU)).toEqual({});
  });

  it('返信だけを削除しても親は残る', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id, kind: 'note' });
    await repo.deleteNote(KOUFU, r.id);
    expect((await repo.listNotes(KOUFU)).map((e) => e.id)).toEqual([p.id]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/noteRepo.test.ts`
Expected: FAIL(型エラーまたは `opts` 未対応で `replyTo` が保存されない)

- [ ] **Step 3: noteRepo を実装する**

`editor/server/src/repositories/noteRepo.ts` を次で置き換える。

```ts
// =============================================================================
// noteRepo.ts — パーツ単位コメント(1 段の入れ子スレッド)のサーバ実装
// =============================================================================
// 役割: 投稿の追加・更新・削除を版インスタンス単位の JSON ファイル(`notesFile.ts`)へ
// 反映する。読み取りも自版に閉じ、他の版(交付版⇄全体版のペアを含む)とは共有しない。
// 返信は同じパーツの親投稿にだけ付き、状態の切替は親にだけ許して返信へ伝播する。
// ルートは本モジュールを呼んで結果を返すだけ。
import { randomUUID } from 'node:crypto';
import { type NoteKind, type NoteStatus, type PartNoteEntry, validation } from '@editor/shared';
import {
  entriesAtCapacity,
  entriesCapacityError,
  type NoteEntriesMap,
  notesAtCapacity,
  notesCapacityError,
  readNotes,
  readNotesStrict,
  type StoredNoteEntry,
  withNotesLock,
  writeNotes,
} from '../files/notesFile.js';

/** 追加時の指定。ルートが Zod で既定値を埋めるので、ここでは省略不可にする。 */
export interface AddNoteOptions {
  replyTo: string | null;
  kind: NoteKind;
}

/** 部分更新。本文か状態のどちらか一方以上(ルートの Zod が保証する)。 */
export interface NotePatch {
  content?: string;
  status?: NoteStatus;
}

/** ファイル上の投稿へ、ファイル名とキーから自明な属性を補って API の形にする。 */
function toEntry(templateId: string, pathKey: string, stored: StoredNoteEntry): PartNoteEntry {
  return { ...stored, templateId, pathKey };
}

/** 1 版インスタンス分の全投稿を平坦化する(pathKey を各投稿へ補う)。 */
function flatten(templateId: string, map: NoteEntriesMap): PartNoteEntry[] {
  return Object.entries(map).flatMap(([pathKey, entries]) =>
    entries.map((e) => toEntry(templateId, pathKey, e)),
  );
}

/**
 * 版インスタンスの全投稿。並びは `createdAt` の昇順のみで比較する。`Array.prototype.sort` は
 * 安定ソートなので、同時刻の投稿は配列順(= 挿入順)がそのまま保たれ、表示順が読むたびに
 * 変わることはない。`id` は乱数 UUID で挿入順と無関係なので、タイブレークに使わない。
 */
export async function listNotes(templateId: string): Promise<PartNoteEntry[]> {
  return flatten(templateId, await readNotes(templateId)).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * 返信先として指定された親投稿を同じパーツの配列から引く。親は「同じパーツ」「存在する」
 * 「それ自体が親(`replyTo` が null)」の 3 条件を満たす。ファイル全体から探さないのは、
 * 別パーツの投稿を親にした返信を作らせないため(表示はパーツ単位のスレッドなので、
 * 別パーツに付いた返信はどこにも出ない)。
 */
function requireParent(entries: readonly StoredNoteEntry[], replyTo: string): StoredNoteEntry {
  const parent = entries.find((e) => e.id === replyTo);
  if (!parent) throw validation('返信先のコメントが見つかりません(すでに削除された可能性があります)');
  if (parent.replyTo !== null) throw validation('返信への返信はできません');
  return parent;
}

/**
 * 投稿を追加する。読み-改変-書きは版インスタンス単位のロックで包む(包まないと同時追加が
 * 互いの投稿を消し、`atomicWrite` の rename 競合で片方が 500 になる)。
 *
 * 上限は 2 段。`pathKey` の件数(新規キーのときだけ見る)と、1 パーツの投稿数(返信を含む)。
 * 返信は親の状態を引き継ぐ(解決済みスレッドへの返信は解決済みのまま並ぶ。未対応へ戻すのは
 * 親の切替で行う)。
 */
export async function addNote(
  templateId: string,
  pathKey: string,
  content: string,
  loginId: string,
  opts: AddNoteOptions,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    if (notesAtCapacity(map, pathKey)) notesCapacityError();
    const entries = map[pathKey] ?? [];
    if (entriesAtCapacity(entries)) entriesCapacityError();
    const parent = opts.replyTo === null ? null : requireParent(entries, opts.replyTo);
    const stored: StoredNoteEntry = {
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
      createdBy: loginId,
      updatedAt: null,
      updatedBy: null,
      status: parent ? parent.status : 'open',
      replyTo: parent ? parent.id : null,
      kind: opts.kind,
    };
    map[pathKey] = [...entries, stored];
    await writeNotes(templateId, map);
    return toEntry(templateId, pathKey, stored);
  });
}

/**
 * 投稿 ID から所在(パーツキーと配列内位置)を引く。`entryId` は UUID なので `pathKey` を
 * 併せて受け取らない — 宛先を 2 つ受けると、食い違ったときの挙動を決める必要が出る。
 */
function locate(map: NoteEntriesMap, entryId: string): { pathKey: string; index: number } {
  for (const [pathKey, entries] of Object.entries(map)) {
    const index = entries.findIndex((e) => e.id === entryId);
    if (index >= 0) return { pathKey, index };
  }
  throw validation('対象のコメントが見つかりません(すでに削除された可能性があります)');
}

/**
 * 投稿の本文・状態を更新する。上限に達していても更新は必ず通す(上限が「直せない」状態を
 * 作らない)。誰の投稿でも更新できる(共同作業を前提とし、所有者による制限は設けない)。
 *
 * 本文の更新だけが `updatedAt`/`updatedBy` を刻む — 「(編集済み)」は本文が書き換わった
 * ことの表示で、解決の切替は編集ではない。状態は親投稿にだけ指定でき、同じ親を持つ返信へ
 * まとめて伝播する(スレッド 1 本が 1 つの状態を持つ形を保つ)。
 */
export async function updateNote(
  templateId: string,
  entryId: string,
  patch: NotePatch,
  loginId: string,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey, index } = locate(map, entryId);
    const target = map[pathKey][index];
    if (patch.status !== undefined && target.replyTo !== null)
      throw validation('状態は親のコメントでだけ切り替えられます');
    const updated: StoredNoteEntry = {
      ...target,
      ...(patch.content !== undefined
        ? { content: patch.content, updatedAt: new Date().toISOString(), updatedBy: loginId }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    map[pathKey] = map[pathKey].map((e) => {
      if (e.id === entryId) return updated;
      if (patch.status !== undefined && e.replyTo === entryId) return { ...e, status: patch.status };
      return e;
    });
    await writeNotes(templateId, map);
    return toEntry(templateId, pathKey, updated);
  });
}

/**
 * 投稿を削除する。親投稿なら返信も一緒に消す(親を失った返信はどのスレッドにも出ないため、
 * 残しても操作できない)。パーツの投稿が空になったらキーごと畳む(空配列を残さない)。
 */
export async function deleteNote(templateId: string, entryId: string): Promise<void> {
  await withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey } = locate(map, entryId);
    const rest = map[pathKey].filter((e) => e.id !== entryId && e.replyTo !== entryId);
    if (rest.length === 0) delete map[pathKey];
    else map[pathKey] = rest;
    await writeNotes(templateId, map);
  });
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/noteRepo.test.ts editor/server/test/notes.limits.test.ts editor/server/test/notes.entryId.test.ts`
Expected: PASS(`notes.limits.test.ts` / `notes.entryId.test.ts` が `addNote(…, loginId)` を 4 引数で
呼んでいれば第 5 引数 `{ replyTo: null, kind: 'note' }` を、`updateNote(…, content, loginId)` を
呼んでいれば `{ content }` を足す)

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/repositories/noteRepo.ts editor/server/test/noteRepo.test.ts editor/server/test/notes.limits.test.ts editor/server/test/notes.entryId.test.ts
git add editor/server/src/repositories/noteRepo.ts editor/server/test/
git commit -m "feat(editor): コメントの返信・解決・連鎖削除をサーバへ実装し版ごとの共有を止める"
```

---

### Task 4: ルートと OpenAPI

**Files:**
- Modify: `editor/server/src/routes/notes.routes.ts:26-48`
- Modify: `editor/server/src/openapi/document.ts:400-435`(説明文のみ)
- Regenerate: `editor/server/openapi/openapi.json`
- Test: `editor/server/test/notes.routes.test.ts`

**Interfaces:**
- Consumes: Task 3 の `addNote(…, opts)` / `updateNote(…, patch, loginId)`

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/notes.routes.test.ts` の `describe('本文の検証', …)` に足す。

```ts
  it('追加は返信先と種別を受け、種別の既定は note', () => {
    const parsed = AddNoteRequest.parse({ pathKey: 'p', content: 'x', replyTo: 'p1' });
    expect(parsed.kind).toBe('note');
    expect(parsed.replyTo).toBe('p1');
  });

  it('更新は本文か状態のどちらかが要る', () => {
    expect(UpdateNoteRequest.safeParse({}).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ status: 'resolved' }).success).toBe(true);
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/notes.routes.test.ts`
Expected: このテストは shared を直接見るので Task 1 後は PASS する。代わりに型チェックで
ルートが赤いことを確認する: `pnpm --filter server run typecheck` → `notes.addNote` の引数不足で FAIL。

- [ ] **Step 3: ルートを直す**

`editor/server/src/routes/notes.routes.ts` の `POST` と `PATCH` ハンドラを次に置き換える。

```ts
  app.post<NotesParams & { Body: z.infer<typeof AddNoteRequest> }>(
    apiPaths.notes,
    { preHandler: [requireAuth, requireEditor, validate(AddNoteRequest)] },
    async (request, reply) => {
      const body = request.body;
      const entry = await notes.addNote(
        request.params.templateId,
        body.pathKey,
        body.content,
        actor(request),
        { replyTo: body.replyTo, kind: body.kind },
      );
      return reply.code(201).send(entry);
    },
  );

  app.patch<EntryParams & { Body: z.infer<typeof UpdateNoteRequest> }>(
    apiPaths.noteEntry,
    { preHandler: [requireAuth, requireEditor, validate(UpdateNoteRequest)] },
    async (request) => {
      const { templateId, entryId } = request.params;
      const { content, status } = request.body;
      return notes.updateNote(templateId, entryId, { content, status }, actor(request));
    },
  );
```

ファイル冒頭の見出しコメントを `notes.routes.ts — パーツ単位コメント(1 段の入れ子スレッド)の
取得・追加・更新・削除` に改める。`document.ts` の `listNotes` 応答説明を
`'投稿の配列(作成日時の昇順。親投稿と返信が混在し、返信は replyTo で親を指す)'`、`updateNote` の
説明を `'更新後の投稿(状態の変更は返信にも伝播する)'` に改める。

- [ ] **Step 4: OpenAPI を再生成し、テストと型チェックを通す**

```bash
pnpm --filter @editor/shared run build && pnpm --filter server run openapi:gen
pnpm exec vitest run --project server editor/server/test/notes.routes.test.ts editor/server/test/openapiArtifact.guard.test.ts editor/server/test/routeGuards.test.ts editor/server/test/guardCoverage.guard.test.ts
pnpm --filter server run typecheck
```

Expected: 全て PASS / 型エラー 0。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/routes/notes.routes.ts editor/server/src/openapi/document.ts editor/server/test/notes.routes.test.ts
git add editor/server/src/routes/notes.routes.ts editor/server/src/openapi/document.ts editor/server/openapi/openapi.json editor/server/test/notes.routes.test.ts
git commit -m "feat(editor): コメント API に返信先・種別・状態の部分更新を足し OpenAPI を再生成する"
```

---

### Task 5: web local 実装

**Files:**
- Modify: `editor/web/src/api/local/noteRepo.ts`(全面)
- Test: `editor/web/test/noteRepo.test.ts`

**Interfaces:**
- Consumes: Task 1 の `NoteRepository` / `AddNoteOptions` / `NotePatch`
- Produces: `localNoteRepo: NoteRepository`(server と同じ規則)

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/noteRepo.test.ts` の `describe('localNoteRepo', …)` から
「交付版と全体版で 1 本のスレッドを共有する」「ペア対象外の版種は自版のみを返す」の 2 件を
消し、`ZENTAI` / `LONE` 定数のうち使わなくなるものを消す。代わりに次を足す。

```ts
  it('交付版と全体版は別々のスレッドを持つ(共有しない)', async () => {
    await add(KOUFU, '交付版');
    await add(ZENTAI, '全体版');
    const k = await localNoteRepo.listNotes(KOUFU);
    const z = await localNoteRepo.listNotes(ZENTAI);
    expect(isOk(k) && k.value.map((e) => e.content)).toEqual(['交付版']);
    expect(isOk(z) && z.value.map((e) => e.content)).toEqual(['全体版']);
  });

  it('追加は open / 親 / 指定した種別で保存される', async () => {
    const res = await localNoteRepo.addNote(KOUFU, KEY, '質問', { kind: 'question' });
    expect(isOk(res) && res.value).toMatchObject({ status: 'open', replyTo: null, kind: 'question' });
  });

  it('返信は同じパーツの親にだけ付き、親の状態を引き継ぐ', async () => {
    const parentId = await add(KOUFU, '親');
    await localNoteRepo.updateNote(KOUFU, parentId, { status: 'resolved' });
    const r = await localNoteRepo.addNote(KOUFU, KEY, '返信', { replyTo: parentId });
    expect(isOk(r) && r.value).toMatchObject({ replyTo: parentId, status: 'resolved' });
    const orphan = await localNoteRepo.addNote(KOUFU, KEY, '迷子', { replyTo: 'nope' });
    expect(isOk(orphan)).toBe(false);
    const grand = await localNoteRepo.addNote(KOUFU, KEY, '孫', { replyTo: isOk(r) ? r.value.id : '' });
    expect(isOk(grand)).toBe(false);
  });

  it('親の状態切替は返信へ伝播し、返信への状態指定は拒否する', async () => {
    const parentId = await add(KOUFU, '親');
    const r = await localNoteRepo.addNote(KOUFU, KEY, '返信', { replyTo: parentId });
    const replyId = isOk(r) ? r.value.id : '';
    await localNoteRepo.updateNote(KOUFU, parentId, { status: 'resolved' });
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.every((e) => e.status === 'resolved')).toBe(true);
    expect(isOk(await localNoteRepo.updateNote(KOUFU, replyId, { status: 'open' }))).toBe(false);
  });

  it('状態だけの更新は updatedAt を刻まない', async () => {
    const parentId = await add(KOUFU, '親');
    const res = await localNoteRepo.updateNote(KOUFU, parentId, { status: 'resolved' });
    expect(isOk(res) && res.value.updatedAt).toBeNull();
  });

  it('本文も状態も無い更新は拒否する', async () => {
    const parentId = await add(KOUFU, '親');
    expect(isOk(await localNoteRepo.updateNote(KOUFU, parentId, {}))).toBe(false);
  });

  it('親の削除は返信を道連れにする', async () => {
    const parentId = await add(KOUFU, '親');
    await localNoteRepo.addNote(KOUFU, KEY, '返信', { replyTo: parentId });
    await localNoteRepo.deleteNote(KOUFU, parentId);
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value).toEqual([]);
  });
```

既存の「投稿を編集できる」テストは `updateNote(KOUFU, id, '直した')` を
`updateNote(KOUFU, id, { content: '直した' })` に、「本文が上限を超える編集は拒否する」も同様に
`{ content }` 形へ直す。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/noteRepo.test.ts`
Expected: FAIL(`replyTo` が保存されない / 共有テストで全体版が混ざる)

- [ ] **Step 3: local 実装を書き換える**

`editor/web/src/api/local/noteRepo.ts` を次で置き換える。

```ts
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
  type NotePatch,
  type NoteRepository,
  type PartNoteEntry,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, write } from './store';

type NoteStore = Record<string, Record<string, PartNoteEntry[]>>;

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
  if (!parent) throw validation('返信先のコメントが見つかりません(すでに削除された可能性があります)');
  if (parent.replyTo !== null) throw validation('返信への返信はできません');
  return parent;
}

export const localNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
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
      const all = read<NoteStore>(K.notes, {});
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
      const all = read<NoteStore>(K.notes, {});
      const { pathKey, index } = locate(all, templateId, entryId);
      const target = all[templateId][pathKey][index];
      if (patch.status !== undefined && target.replyTo !== null)
        throw validation('状態は親のコメントでだけ切り替えられます');
      const updated: PartNoteEntry = {
        ...target,
        ...(patch.content !== undefined
          ? { content: patch.content, updatedAt: now(), updatedBy: currentUser()?.displayName ?? '不明' }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      all[templateId][pathKey] = all[templateId][pathKey].map((e) => {
        if (e.id === entryId) return updated;
        if (patch.status !== undefined && e.replyTo === entryId) return { ...e, status: patch.status };
        return e;
      });
      write(K.notes, all);
      return updated;
    }),

  deleteNote: (templateId: string, entryId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      const { pathKey } = locate(all, templateId, entryId);
      const rest = all[templateId][pathKey].filter((e) => e.id !== entryId && e.replyTo !== entryId);
      // 空になったキー・版はエントリごと畳む(空オブジェクトを残さない)。
      if (rest.length === 0) delete all[templateId][pathKey];
      else all[templateId][pathKey] = rest;
      if (Object.keys(all[templateId]).length === 0) delete all[templateId];
      write(K.notes, all);
    }),
};
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/noteRepo.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/api/local/noteRepo.ts editor/web/test/noteRepo.test.ts
git add editor/web/src/api/local/noteRepo.ts editor/web/test/noteRepo.test.ts
git commit -m "feat(editor): local のコメント実装を返信・解決・版ごとの独立へ揃える"
```

---

### Task 6: web rest 実装

**Files:**
- Modify: `editor/web/src/api/rest/noteRepo.ts`

**Interfaces:**
- Consumes: Task 1 の契約、Task 4 の body 形

- [ ] **Step 1: rest 実装を直す**

`addNote` と `updateNote` を次に置き換え、ファイル冒頭コメントの「ペアのマージ・並び順は
サーバが決める」を「並び順はサーバが決める」に改める。

```ts
  addNote: (templateId: string, pathKey: string, content: string, opts: AddNoteOptions = {}) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.notes, { templateId }), {
        method: 'POST',
        body: { pathKey, content, replyTo: opts.replyTo ?? null, kind: opts.kind ?? 'note' },
      }),
    ),

  updateNote: (templateId: string, entryId: string, patch: NotePatch) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.noteEntry, { templateId, entryId }), {
        method: 'PATCH',
        body: patch,
      }),
    ),
```

import に `type AddNoteOptions, type NotePatch` を足す。

- [ ] **Step 2: 型チェック**

Run: `pnpm --filter @editor/shared run build && pnpm --filter web run typecheck`
Expected: rest / local の noteRepo は緑。`usePartNote.ts` / `NoteBubble.vue` 由来のエラーだけが残る(Task 7 で直す)。

- [ ] **Step 3: コミット**

```bash
pnpm exec biome check --write editor/web/src/api/rest/noteRepo.ts
git add editor/web/src/api/rest/noteRepo.ts
git commit -m "feat(editor): REST のコメント実装で返信先・種別・部分更新を送る"
```

---

### Task 7: composable と既存 UI の適合

**Files:**
- Modify: `editor/web/src/features/editor/usePartNote.ts`
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts:183-186`(コメントのみ)
- Modify: `editor/web/src/features/editor/Inspector.vue:418`(案内文言)
- Test: `editor/web/test/usePartNote.test.ts`

**Interfaces:**
- Consumes: Task 1 の契約
- Produces: `usePartNote(...)` が `{ entries, notedKeys, canNote, reload, add, reply, setStatus, update, remove }` を返す
  - `add(content: string, opts?: AddNoteOptions)`
  - `reply(parent: PartNoteEntry, content: string)`
  - `setStatus(parent: PartNoteEntry, status: NoteStatus)`
  - `update(entry: PartNoteEntry, content: string)`(既存シグネチャ据え置き。`NoteBubble.vue` の `@update` がそのまま使う)

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/usePartNote.test.ts` の `makeRepo` を新契約に合わせ、新メソッドのテストを足す。

```ts
function makeRepo() {
  const store: PartNoteEntry[] = [];
  let seq = 0;
  const repo: NoteRepository = {
    listNotes: async () => ok([...store]),
    addNote: async (templateId, pathKey, content, opts = {}) => {
      const entry: PartNoteEntry = {
        id: `e${++seq}`,
        templateId,
        pathKey,
        content,
        createdAt: `2026-09-01T00:00:0${seq}.000Z`,
        createdBy: '編集者',
        updatedAt: null,
        updatedBy: null,
        status: 'open',
        replyTo: opts.replyTo ?? null,
        kind: opts.kind ?? 'note',
      };
      store.push(entry);
      return ok(entry);
    },
    updateNote: async (_templateId, entryId, patch) => {
      const i = store.findIndex((e) => e.id === entryId);
      store[i] = {
        ...store[i],
        ...(patch.content !== undefined ? { content: patch.content, updatedAt: 'x', updatedBy: '編集者' } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      return ok(store[i]);
    },
    deleteNote: async (_templateId, entryId) => {
      const i = store.findIndex((e) => e.id === entryId);
      store.splice(i, 1);
      return ok(undefined);
    },
  };
  return { repo, store };
}
```

`describe('usePartNote', …)` に足す。

```ts
  it('reply は選択パーツの親へ返信を積み、setStatus は親の状態を切り替える', async () => {
    const { repo, store } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(() => TPL, () => key.value, repo);
    await note.add('親', { kind: 'question' });
    const parent = note.entries.value[0];
    expect(parent.kind).toBe('question');

    await note.reply(parent, '返信');
    expect(note.entries.value.map((e) => e.replyTo)).toEqual([null, parent.id]);

    await note.setStatus(parent, 'resolved');
    expect(store.find((e) => e.id === parent.id)?.status).toBe('resolved');
  });

  it('本文が空の返信は送らない', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(() => TPL, () => COVER, repo);
    await note.add('親');
    await note.reply(note.entries.value[0], '   ');
    expect(store).toHaveLength(1);
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/usePartNote.test.ts`
Expected: FAIL(`reply` / `setStatus` が無い)

- [ ] **Step 3: composable を直す**

`editor/web/src/features/editor/usePartNote.ts` の import と `update` 以降を次に置き換える
(`all` / `notedKeys` / `entries` / `canNote` / `reload` は据え置き。冒頭の役割コメントの
「(交付版⇄全体版をマージ済み)」を削る)。

```ts
import {
  type AddNoteOptions,
  isErr,
  type NoteRepository,
  type NoteStatus,
  type PartNoteEntry,
} from '@editor/shared';
```

```ts
  /** 選択パーツへ親投稿を追加する。空文字はリポジトリが拒否するのでここでも送らない。 */
  async function add(content: string, opts: AddNoteOptions = {}): Promise<void> {
    const key = currentKey();
    const tid = templateId();
    if (!key || !tid || content.trim() === '') return;
    const res = await repo.addNote(tid, key, content, opts);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /**
   * 親投稿へ返信する。宛先は `parent.pathKey` — 選択パーツではなく親の属するパーツに付ける
   * (一覧から返信するとき、選択が別パーツへ移っていても返信先がずれない)。
   */
  async function reply(parent: PartNoteEntry, content: string): Promise<void> {
    if (content.trim() === '') return;
    const res = await repo.addNote(parent.templateId, parent.pathKey, content, {
      replyTo: parent.id,
      kind: parent.kind,
    });
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 親投稿の状態を切り替える(返信への伝播はリポジトリが行う)。 */
  async function setStatus(parent: PartNoteEntry, status: NoteStatus): Promise<void> {
    const res = await repo.updateNote(parent.templateId, parent.id, { status });
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 投稿の本文を編集する。宛先は `entry.templateId`(投稿が属する版)。 */
  async function update(entry: PartNoteEntry, content: string): Promise<void> {
    if (content.trim() === '') return;
    const res = await repo.updateNote(entry.templateId, entry.id, { content });
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 投稿を削除する。親なら返信も消える(リポジトリが道連れにする)。 */
  async function remove(entry: PartNoteEntry): Promise<void> {
    const res = await repo.deleteNote(entry.templateId, entry.id);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  return { entries, notedKeys, canNote, reload, add, reply, setStatus, update, remove };
```

`useTemplateEditor.ts` の `// ── パーツ単位メモ(追記型スレッド) ──` の 3 行コメントを次に改める。

```ts
  // ── パーツ単位コメント(1 段の入れ子スレッド) ──
  // 投稿は書かれた版インスタンスのファイルへ入り、他の版とは共有しない(基準日をまたぐ
  // 繰り越しもしない)。パーツの同定は版内で安定な構造キー(`partKey.ts`)で行う。
```

`Inspector.vue` の案内文 `既存のメモはキャンバスの吹き出しに表示します。交付版と全体版で共有します（基準日ごとに独立）。` を
`既存のメモはキャンバスの吹き出しに表示します（この版だけのメモです）。` に改める。

- [ ] **Step 4: テスト・型チェック・全体テスト**

```bash
pnpm exec vitest run --project web editor/web/test/usePartNote.test.ts
pnpm run typecheck:editor
pnpm run test:editor
```

Expected: 全て PASS / 型エラー 0。`twoSystems.guard.test.ts` を含むガード群が緑であること。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/usePartNote.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/features/editor/Inspector.vue editor/web/test/usePartNote.test.ts
git add editor/web/src/features/editor/usePartNote.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/features/editor/Inspector.vue editor/web/test/usePartNote.test.ts
git commit -m "feat(editor): コメントの返信と解決を composable へ足し既存 UI を新契約へ合わせる"
```

---

### Task 8: 設計正典の更新と e2e 確認

**Files:**
- Modify: `docs/editor/src/設計正典.md`(「パーツメモは追記型スレッドで、ペア版種と共有する」の段落)
- Verify: `editor/e2e/note_bubble.spec.ts`

- [ ] **Step 1: 設計正典の段落を書き換える**

「**パーツメモは追記型スレッドで、ペア版種と共有する**」で始まる段落を次に置き換える
(他の段落は触らない。計画 3 でコメント一覧・承認タブの記述を足す)。

```markdown
- **パーツコメントは 1 段の入れ子スレッドで、版インスタンスごとに独立する**: コメントは
  `dataRoot/notes/<templateId>.json` に `pathKey → 投稿配列` で持ち、読み書きとも自版に閉じる
  (交付版⇄全体版のペアでも共有しない。基準日をまたぐ繰り越しもしない)。投稿は `status`
  (open / resolved)・`replyTo`(親投稿 id。null なら親)・`kind`(note / fix-request / question)
  を持ち、返信は同じパーツの親投稿にだけ付く(返信への返信は不可)。状態の切替は親にだけ許し、
  返信へ伝播する。親の削除は返信を道連れにする。上限は「ファイル 4MB」「`pathKey` 1000 件」
  「1 パーツ 200 投稿(返信を含む)」の 3 段で、件数上限だけではサイズを守れない(1 パーツで
  ファイル上限に達すると、そのテンプレの全コメントが保存不能になる)。旧形式(1 パーツ 1 件)と
  3 属性を持たない投稿は読み取り時に既定値(open / null / note)を補って読む(ID は
  `legacy:<pathKey>` 固定)。
```

- [ ] **Step 2: e2e の吹き出しテストを通す**

Run: `pnpm exec playwright test -c editor/playwright.config.ts editor/e2e/note_bubble.spec.ts`
Expected: PASS(`note_bubble.spec.ts` は追加・編集・削除の既存挙動を見ており、契約変更で
壊れないことを確認する。落ちたら fixture の投稿に 3 フィールドが無いことを疑い、
`web/src/api/local` の seed か spec 側の期待値を直す)

- [ ] **Step 3: コミット**

```bash
git add docs/editor/src/設計正典.md
git commit -m "docs(editor): コメントの版ごとの独立と返信・解決の規則を設計正典へ写す"
```

---

## 計画の自己レビュー

- spec 3 章(データ・ファイル・ペア廃止・API)は Task 1〜6 が覆う。spec 6 章(サーバ)は
  Task 3〜4。spec 7 章のうち server / shared / web 単体(`noteRepo` / `usePartNote`)は本計画、
  `commentFilter` / `resolveReviewTarget` / e2e 新規は計画 2・3。
- `updateNote` の状態変更が `updatedAt` を刻まない規則は Task 3・5・7 で同じ。
- `AddNoteOptions` は shared では `replyTo?: string | null; kind?: NoteKind`(省略可)、server の
  `noteRepo` では省略不可の `{ replyTo: string | null; kind: NoteKind }`(ルートの Zod が既定値を
  埋めた後)。名前が同じでも役割が違うので、server 側は `repositories/noteRepo.ts` 内の
  ローカル型として持つ(shared のものを import しない)。
