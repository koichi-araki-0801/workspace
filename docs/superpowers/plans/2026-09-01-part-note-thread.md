# パーツメモのスレッド化とペア版種共有 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パーツ単位メモを「1 本のテキストの上書き」から「投稿を積む追記型スレッド」へ変え、交付版と全体版のペアで 1 本のスレッドを共有し、既存メモをキャンバス余白の吹き出しで読めるようにする。

**Architecture:** 保存先は現行どおり `dataRoot/notes/<templateId>.json` を維持し、読み取り時にペア版（`pairedTemplateId`）のファイルもマージして 1 本のスレッドとして返す。ファイル形式は `pathKey → 投稿配列` へ変え、旧形式は読み取り時に投稿 1 件へ遅延変換する。画面はメモの表示をキャンバス overlay の吹き出しへ移し、右ペインは追加専用にする。

**Tech Stack:** TypeScript / Zod（`@editor/shared`）/ Fastify（server）/ Vue 3 + GrapesJS（web）/ Vitest / Playwright

**Spec:** `docs/superpowers/specs/2026-09-01-part-note-thread-design.md`

## Global Constraints

- コメント規約の正典は `docs/コメント規約.md`。新規・既存いずれのコードもこれに従う（なぜを書く / 日本語散文 + 英語ドメイン用語 / 識別子はバッククォート / 100 桁 / ASCII 括弧）。`pnpm run check:comments` が機械検査する。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write editor/<対象>` を先行実行する（lint-staged がステージを入れ替える事故の回避）。対象は変更ファイルに限定する。
- 型チェックは `@editor/shared` の先行ビルドが前提（`pnpm typecheck` が内部で `tsc -b editor/server` を行う）。
- カバレッジは include 列挙方式・全指標 85% 閾値。テストを書いたファイルはルート `vitest.config.ts` の include へ追加する。
- 変更系ルートは `editor/server/src/routes/routeGuards.ts` の `ROUTE_POLICY` へ必ず登録する（未登録ルートはサーバ起動時に落ちる）。
- メモ機能の 2 系統原則（編集タブ/作成タブ）には手を触れない。`web/test/twoSystems.guard.test.ts` は緑のまま保つ。
- ページ（帳票 HTML 本体）の描画サイズ・倍率は変更しない。吹き出しのためにズームを下げたり canvas 描画領域を狭めたりしない。動かしてよいのはキャンバス内でのページの左右位置だけ。
- 上限値: `MAX_NOTE_CONTENT_CHARS` = 64KiB（既存）、`MAX_NOTE_PATH_KEY_CHARS` = 512（既存）、`MAX_NOTES_FILE_BYTES` = 4MiB（既存）、`MAX_NOTES_PER_TEMPLATE` = 1000（既存）、`MAX_NOTE_ENTRIES_PER_PART` = 200（新設）。
- テスト実行は `pnpm vitest run <path>`、プロジェクト指定は `--project shared|server|web`。

---

### Task 1: shared の型・契約・API パス

**Files:**
- Modify: `editor/shared/src/schemas.ts:35-38, 584-613`
- Modify: `editor/shared/src/index.ts:160-166`
- Modify: `editor/shared/src/repositories/NoteRepository.ts`（全面）
- Modify: `editor/shared/src/api-paths.ts:41-42`
- Test: `editor/shared/test/partNote.test.ts`（新規）

**Interfaces:**
- Consumes: 既存の `parseTemplateFileName` / `pairedTemplateId`（`shared/src/domain/template.ts`）
- Produces:
  - `PartNoteEntry` = `{ id: string; templateId: string; pathKey: string; content: string; createdAt: string; createdBy: string; updatedAt: string | null; updatedBy: string | null }`
  - `AddNoteRequest` = `{ pathKey: string; content: string }`（`content` は `.min(1).max(MAX_NOTE_CONTENT_CHARS)`）
  - `UpdateNoteRequest` = `{ content: string }`（同上）
  - `MAX_NOTE_ENTRIES_PER_PART` = 200
  - `apiPaths.noteEntry` = `'/templates/:templateId/notes/:entryId'`
  - `NoteRepository` = `{ listNotes; addNote; updateNote; deleteNote }`（本文は Step 3 のコード）

- [ ] **Step 1: 失敗するテストを書く**

`editor/shared/test/partNote.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AddNoteRequest,
  apiPaths,
  buildPath,
  MAX_NOTE_ENTRIES_PER_PART,
  PartNoteEntry,
  UpdateNoteRequest,
} from '../src/index.js';

describe('PartNoteEntry', () => {
  it('投稿 1 件の形を受理する(未編集は updatedAt/updatedBy が null)', () => {
    const parsed = PartNoteEntry.parse({
      id: '2f1c9a52-0f3e-4a1b-9d5c-8e7a6b5c4d3e',
      templateId: 'AM01_510037_20240710_交付版',
      pathKey: '.page#1/cover#1',
      content: 'メモ本文',
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
    });
    expect(parsed.content).toBe('メモ本文');
  });
});

describe('AddNoteRequest / UpdateNoteRequest', () => {
  it('空文字の本文は拒否する(削除は DELETE で明示する)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '' }).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ content: '' }).success).toBe(false);
  });

  it('本文の長さ上限を強制する', () => {
    const tooLong = 'あ'.repeat(64 * 1024 + 1);
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: tooLong }).success).toBe(false);
  });
});

describe('apiPaths.noteEntry', () => {
  it('templateId と entryId を埋め込める', () => {
    expect(
      buildPath(apiPaths.noteEntry, { templateId: 'AM01_510037_20240710_交付版', entryId: 'e1' }),
    ).toBe('/templates/AM01_510037_20240710_%E4%BA%A4%E4%BB%98%E7%89%88/notes/e1');
  });
});

describe('MAX_NOTE_ENTRIES_PER_PART', () => {
  it('1 パーツあたりの投稿数上限を持つ', () => {
    expect(MAX_NOTE_ENTRIES_PER_PART).toBe(200);
  });
});
```

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project shared editor/shared/test/partNote.test.ts`
Expected: FAIL（`PartNoteEntry` などが export されていない）

- [ ] **Step 3: 型と契約を実装する**

`editor/shared/src/schemas.ts` の `MAX_NOTE_PATH_KEY_CHARS` の直後へ追加:

```ts
/** 1 パーツが保持できる投稿数の上限。件数上限だけではファイル上限を守れないため両方持つ。 */
export const MAX_NOTE_ENTRIES_PER_PART = 200;
```

同ファイルの `PartNote` / `SaveNoteRequest`（584-613 行）を次で置き換える:

```ts
/**
 * パーツ単位メモの投稿 1 件。メモは追記型のスレッドで、投稿は書かれた版インスタンスの
 * ファイルへ入る。表示は交付版と全体版のペアをマージした 1 本のスレッドになる。
 * `templateId` は投稿が属する版（編集・削除の宛先）。キー算出は web の `partKey.ts`。
 */
export const PartNoteEntry = z
  .object({
    id: z.string().meta({ description: '投稿 ID(UUID。旧形式からの変換分は legacy)' }),
    templateId: z.string().meta({ description: '投稿が属する版インスタンス ID' }),
    pathKey: z.string().meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    content: z.string().meta({ description: '投稿本文' }),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string().nullable().meta({ description: '編集された場合のみ' }),
    updatedBy: z.string().nullable(),
  })
  .meta({ id: 'PartNoteEntry' });

/** (server 専用) 投稿の追加。`templateId` はパスから取る。空文字の本文は受け付けない。 */
export const AddNoteRequest = z
  .object({
    pathKey: z
      .string()
      .min(1)
      .max(MAX_NOTE_PATH_KEY_CHARS)
      .meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS).meta({ description: '投稿本文' }),
  })
  .meta({ id: 'AddNoteRequest' });

/** (server 専用) 投稿本文の編集。削除は DELETE で明示するため、空文字は受け付けない。 */
export const UpdateNoteRequest = z
  .object({
    content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS).meta({ description: '投稿本文' }),
  })
  .meta({ id: 'UpdateNoteRequest' });
```

`editor/shared/src/index.ts` の `PartNote` 型 export（160-166 行）を置き換える:

```ts
/**
 * パーツ単位メモの投稿 1 件。メモは追記型スレッドで、交付版と全体版のペア
 * (`pairedTemplateId`)で 1 本のスレッドを共有する。基準日をまたぐ繰り越しはしない。
 * キー算出は `web` の `partKey.ts` の `partPathKeyFor`。
 */
export type PartNoteEntry = z.infer<typeof sch.PartNoteEntry>;
```

`editor/shared/src/api-paths.ts` の 41-42 行を置き換える:

```ts
  // notes (パーツ単位メモ。投稿の追加/編集/削除は entryId 付きパス)
  notes: '/templates/:templateId/notes',
  noteEntry: '/templates/:templateId/notes/:entryId',
```

`editor/shared/src/repositories/NoteRepository.ts` を全面的に置き換える:

```ts
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
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project shared editor/shared/test/partNote.test.ts`
Expected: PASS

この時点で server / web は旧契約を参照したままなので型エラーが出る。以降のタスクで解消する（Task 4 完了時に `pnpm typecheck` が通る）。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/shared/src editor/shared/test
git add editor/shared/src/schemas.ts editor/shared/src/index.ts editor/shared/src/repositories/NoteRepository.ts editor/shared/src/api-paths.ts editor/shared/test/partNote.test.ts
git commit -m "feat(editor): メモを追記型スレッドとして扱う型と契約を定める"
```

---

### Task 2: notesFile を新形式へ（旧形式の遅延変換・投稿数上限）

**Files:**
- Modify: `editor/server/src/files/notesFile.ts`
- Test: `editor/server/test/notesFile.thread.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の `PartNoteEntry` / `MAX_NOTE_ENTRIES_PER_PART`
- Produces:
  - `type NoteEntriesMap = Record<string, StoredNoteEntry[]>`（`StoredNoteEntry` = `PartNoteEntry` から `templateId` / `pathKey` を除いた形）
  - `readNotes(templateId): Promise<NoteEntriesMap>`（表示用・degrade あり）
  - `readNotesStrict(templateId): Promise<NoteEntriesMap>`（書き込み用・読めなければ例外）
  - `writeNotes(templateId, map): Promise<void>`
  - `withNotesLock(templateId, fn)`（変更なし）
  - `entriesAtCapacity(entries): boolean` / `entriesCapacityError(): never`
  - 既存の `notesAtCapacity` / `notesCapacityError` は維持（`pathKey` 件数の上限判定）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/notesFile.thread.test.ts`:

```ts
// =============================================================================
// notesFile.thread.test.ts — 追記型スレッドのファイル形式と旧形式からの遅延変換
// =============================================================================
// メモは `dataRoot/notes/<templateId>.json` に `pathKey → 投稿配列` で持つ。旧形式
// (`pathKey → メモ 1 件`)のファイルが残っていても読めること、変換後の投稿 ID が読むたびに
// 変わらないこと(編集・削除の宛先が安定すること)を主張する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

async function importNotesFile(): Promise<typeof import('../src/files/notesFile.js')> {
  vi.stubEnv('DATA_ROOT', tmpRoot);
  vi.resetModules();
  return import('../src/files/notesFile.js');
}

const TPL = 'AM01_510037_20240710_交付版';
const KEY = '.page#1/cover#1';
const notesPath = (): string => path.join(tmpRoot, 'notes', `${TPL}.json`);

async function writeRaw(body: unknown): Promise<void> {
  await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
  await fs.writeFile(notesPath(), JSON.stringify(body), 'utf8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-notes-thread-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('新形式の read/write', () => {
  it('投稿配列を書いて読み戻せる', async () => {
    const files = await importNotesFile();
    await files.writeNotes(TPL, {
      [KEY]: [
        {
          id: 'e1',
          content: '一件目',
          createdAt: '2026-09-01T00:00:00.000Z',
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY]).toHaveLength(1);
    expect(map[KEY][0]).toMatchObject({ id: 'e1', content: '一件目' });
  });
});

describe('旧形式の遅延変換', () => {
  it('旧形式(1 パーツ 1 件)を投稿 1 件として読む', async () => {
    const files = await importNotesFile();
    await writeRaw({
      [KEY]: {
        templateId: TPL,
        pathKey: KEY,
        content: '旧メモ',
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: '旧編集者',
      },
    });
    const map = await files.readNotes(TPL);
    expect(map[KEY]).toHaveLength(1);
    expect(map[KEY][0]).toMatchObject({
      id: 'legacy',
      content: '旧メモ',
      createdAt: '2026-08-01T00:00:00.000Z',
      createdBy: '旧編集者',
    });
  });

  it('変換後の ID は読むたびに変わらない(編集・削除の宛先が安定する)', async () => {
    const files = await importNotesFile();
    await writeRaw({ [KEY]: { content: '旧メモ', updatedAt: 'x', updatedBy: 'u' } });
    const a = await files.readNotes(TPL);
    const b = await files.readNotes(TPL);
    expect(a[KEY][0].id).toBe(b[KEY][0].id);
  });
});

describe('1 パーツあたりの投稿数上限', () => {
  it('上限に達した配列を判定できる', async () => {
    const files = await importNotesFile();
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      content: 'x',
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'u',
      updatedAt: null,
      updatedBy: null,
    }));
    expect(files.entriesAtCapacity(full)).toBe(true);
    expect(files.entriesAtCapacity(full.slice(0, 199))).toBe(false);
  });
});

describe('書き込みの入力に degrade を使わない', () => {
  it('読めない実体では readNotesStrict が例外になる', async () => {
    const files = await importNotesFile();
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), '{ broken', 'utf8');
    await expect(files.readNotes(TPL)).resolves.toEqual({});
    await expect(files.readNotesStrict(TPL)).rejects.toMatchObject({ kind: 'validation' });
  });
});
```

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project server editor/server/test/notesFile.thread.test.ts`
Expected: FAIL（`entriesAtCapacity` が無い / 旧形式が配列として読めない）

- [ ] **Step 3: 実装する**

`editor/server/src/files/notesFile.ts` の `type NoteMap` 以降を次のように変える。

まず import 行に `MAX_NOTE_ENTRIES_PER_PART` を足す:

```ts
import {
  assertTemplateId,
  MAX_NOTE_ENTRIES_PER_PART,
  type PartNoteEntry,
  validation,
} from '@editor/shared';
```

`type NoteMap = Record<string, PartNote>;`（44 行）を置き換える:

```ts
/**
 * ファイルに保存する投稿 1 件。`templateId` と `pathKey` はファイル名とキーから自明なので
 * 持たない(同じ事実を 2 箇所で持つと片方だけがずれる)。API 応答へ載せるときに補う。
 */
export type StoredNoteEntry = Omit<PartNoteEntry, 'templateId' | 'pathKey'>;

/** 1 版インスタンスのメモ一式(パーツ構造キー → 投稿の配列。配列は作成日時の昇順)。 */
export type NoteEntriesMap = Record<string, StoredNoteEntry[]>;
```

`readNotesResult` の中の型と、パースの直後に旧形式の変換を挟む:

```ts
interface NotesReadResult {
  notes: NoteEntriesMap;
  /** 実体は在るが読めなかった(サイズ超過・壊れた JSON)。`notes` は空。 */
  unreadable: boolean;
}

/**
 * 旧形式(`pathKey` → メモ 1 件)を投稿 1 件の配列へ変換する。
 *
 * 変換後の ID を固定値 `legacy` にするのは、読むたびに ID が変わると編集・削除の宛先が
 * 安定しないため。旧形式は 1 パーツにつき 1 件しか持てないので、この値で衝突しない。
 * 一括移行はしない — 次の書き込みで新形式として保存され、自然に移りきる。
 */
function normalizeStored(parsed: Record<string, unknown>): NoteEntriesMap {
  const out: NoteEntriesMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      out[key] = value as StoredNoteEntry[];
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const legacy = value as { content?: unknown; updatedAt?: unknown; updatedBy?: unknown };
    if (typeof legacy.content !== 'string') continue;
    out[key] = [
      {
        id: 'legacy',
        content: legacy.content,
        createdAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : '',
        createdBy: typeof legacy.updatedBy === 'string' ? legacy.updatedBy : '',
        updatedAt: null,
        updatedBy: null,
      },
    ];
  }
  return out;
}
```

`readNotesResult` の成功枝を `normalizeStored` 経由にする:

```ts
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object')
      return { notes: normalizeStored(parsed as Record<string, unknown>), unreadable: false };
    return { notes: {}, unreadable: true };
  } catch {
```

`readNotes` / `readNotesStrict` / `writeNotes` の戻り値・引数の型を `NoteMap` から `NoteEntriesMap` へ差し替える（本体のロジックは変えない）。

ファイル末尾へ投稿数上限の判定を足す:

```ts
/**
 * 1 パーツの投稿数が上限に達しているか。件数上限(`MAX_NOTES_PER_TEMPLATE`)は `pathKey` の
 * 数しか縛らないので、これが無いと 1 パーツだけでファイル上限(`MAX_NOTES_FILE_BYTES`)へ
 * 到達でき、そのテンプレの全メモが保存不能になる。
 */
export function entriesAtCapacity(entries: readonly StoredNoteEntry[]): boolean {
  return entries.length >= MAX_NOTE_ENTRIES_PER_PART;
}

/** 投稿数の上限超過時に返す文言。 */
export function entriesCapacityError(): never {
  throw validation(
    `このパーツのメモは上限(${MAX_NOTE_ENTRIES_PER_PART} 件)に達しています。` +
      '不要なメモを削除してください。',
  );
}
```

ファイル冒頭の doc コメント（1-7 行）を実態へ合わせる:

```ts
// =============================================================================
// notesFile.ts — パーツ単位メモ(追記型スレッド)のファイル永続化
// =============================================================================
// 役割: メモは版インスタンス単位で `dataRoot/notes/<templateId>.json` に
// `Record<pathKey, 投稿配列>` で保持する。投稿は書かれた版のファイルへ入り、交付版⇄全体版の
// ペアをまたぐマージは読み取り側(`repositories/noteRepo.ts`)が行う。本体テキストは atomic
// write で半端読みを防ぐ。git 版管理対象のテンプレ本体とは別物で、メモは注釈として data
// ルート配下に置くだけ(コミットは伴わない)。
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project server editor/server/test/notesFile.thread.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/files/notesFile.ts editor/server/test/notesFile.thread.test.ts
git add editor/server/src/files/notesFile.ts editor/server/test/notesFile.thread.test.ts
git commit -m "feat(editor): メモファイルを投稿配列形式にし旧形式を遅延変換する"
```

---

### Task 3: server noteRepo（ペアのマージ・追加・編集・削除）

**Files:**
- Modify: `editor/server/src/repositories/noteRepo.ts`（全面）
- Test: `editor/server/test/noteRepo.test.ts`（新規）
- Modify: `editor/server/test/notes.limits.test.ts`（新 API へ追随）

**Interfaces:**
- Consumes: Task 2 の `readNotes` / `readNotesStrict` / `writeNotes` / `withNotesLock` / `entriesAtCapacity` / `entriesCapacityError` / `notesAtCapacity` / `notesCapacityError`、shared の `pairedTemplateId`
- Produces:
  - `listNotes(templateId): Promise<PartNoteEntry[]>` — 自版 + ペア版、`createdAt` 昇順（同値は `templateId` → `id`）
  - `addNote(templateId, pathKey, content, loginId): Promise<PartNoteEntry>`
  - `updateNote(templateId, entryId, content, loginId): Promise<PartNoteEntry>`
  - `deleteNote(templateId, entryId): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/noteRepo.test.ts`:

```ts
// =============================================================================
// noteRepo.test.ts — メモのペア共有(交付版⇄全体版)と投稿の追加・編集・削除
// =============================================================================
// メモは版インスタンス単位のファイルに保存しつつ、読み取りでペアの版をマージして 1 本の
// スレッドとして返す。ここで主張するのは、マージの範囲と順序・書き込みが投稿の属する版
// だけを変えること・上限が追加のみを止めること。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
const LONE = 'AM01_510037_20240710_kr';
const KEY = '.page#1/cover#1';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-note-repo-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('ペア版種のマージ', () => {
  it('交付版から読むと全体版の投稿も同じスレッドに並ぶ(作成日時の昇順)', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版の 1 件目', 'editor1');
    await repo.addNote(ZENTAI, KEY, '全体版の 1 件目', 'editor2');
    await repo.addNote(KOUFU, KEY, '交付版の 2 件目', 'editor1');

    const thread = await repo.listNotes(KOUFU);
    expect(thread.map((e) => e.content)).toEqual([
      '交付版の 1 件目',
      '全体版の 1 件目',
      '交付版の 2 件目',
    ]);
    // 版種が分かるよう、投稿は自分が属する版の id を持つ。
    expect(thread.map((e) => e.templateId)).toEqual([KOUFU, ZENTAI, KOUFU]);
  });

  it('全体版から読んでも同じ並びになる', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, 'A', 'editor1');
    await repo.addNote(ZENTAI, KEY, 'B', 'editor2');
    expect((await repo.listNotes(ZENTAI)).map((e) => e.content)).toEqual(['A', 'B']);
  });

  it('ペア対象外の版種は自版のみを返す', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版', 'editor1');
    await repo.addNote(LONE, KEY, '旧版種', 'editor1');
    expect((await repo.listNotes(LONE)).map((e) => e.content)).toEqual(['旧版種']);
  });
});

describe('編集と削除の宛先', () => {
  it('ペア側の投稿を編集してもこちらの版のファイルは変わらない', async () => {
    const { repo, files } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版', 'editor1');
    const zentai = await repo.addNote(ZENTAI, KEY, '全体版', 'editor2');

    await repo.updateNote(ZENTAI, zentai.id, '全体版(修正)', 'editor3');

    expect((await files.readNotes(KOUFU))[KEY][0].content).toBe('交付版');
    const updated = (await files.readNotes(ZENTAI))[KEY][0];
    expect(updated.content).toBe('全体版(修正)');
    expect(updated.updatedBy).toBe('editor3');
  });

  it('削除は指定した版の投稿だけを消す', async () => {
    const { repo, files } = await importRepo();
    const koufu = await repo.addNote(KOUFU, KEY, '交付版', 'editor1');
    await repo.addNote(ZENTAI, KEY, '全体版', 'editor2');

    await repo.deleteNote(KOUFU, koufu.id);

    expect((await files.readNotes(KOUFU))[KEY]).toBeUndefined();
    expect((await files.readNotes(ZENTAI))[KEY]).toHaveLength(1);
  });

  it('存在しない投稿 ID は validation エラーにする', async () => {
    const { repo } = await importRepo();
    await expect(repo.updateNote(KOUFU, 'no-such-id', 'x', 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(repo.deleteNote(KOUFU, 'no-such-id')).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});

describe('投稿数の上限', () => {
  it('上限に達したら追加は拒否し、編集と削除は通す', async () => {
    const { repo, files } = await importRepo();
    const entries = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      content: `メモ${i}`,
      createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
    }));
    await files.writeNotes(KOUFU, { [KEY]: entries });

    await expect(repo.addNote(KOUFU, KEY, 'あふれる', 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(repo.updateNote(KOUFU, 'e0', '更新', 'editor1')).resolves.toMatchObject({
      content: '更新',
    });
    await expect(repo.deleteNote(KOUFU, 'e1')).resolves.toBeUndefined();
  });
});

describe('同時追加で投稿が消えない', () => {
  it('同一テンプレへの並行 addNote が全て残る', async () => {
    const { repo } = await importRepo();
    await Promise.all([
      repo.addNote(KOUFU, KEY, 'A', 'u1'),
      repo.addNote(KOUFU, KEY, 'B', 'u2'),
      repo.addNote(KOUFU, KEY, 'C', 'u3'),
    ]);
    expect((await repo.listNotes(KOUFU)).map((e) => e.content).sort()).toEqual(['A', 'B', 'C']);
  });
});
```

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project server editor/server/test/noteRepo.test.ts`
Expected: FAIL（`addNote` などが存在しない）

- [ ] **Step 3: 実装する**

`editor/server/src/repositories/noteRepo.ts` を全面的に置き換える:

```ts
// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)のサーバ実装
// =============================================================================
// 役割: 投稿の追加・編集・削除を版インスタンス単位の JSON ファイル(`notesFile.ts`)へ
// 反映し、読み取りでは交付版⇄全体版のペアをマージして 1 本のスレッドとして返す。
// ルートは本モジュールを呼んで結果を返すだけ。
import { randomUUID } from 'node:crypto';
import { pairedTemplateId, type PartNoteEntry, validation } from '@editor/shared';
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
 * 自版とペア版(交付版⇄全体版)をマージしたスレッド。
 *
 * 並びは `createdAt` の昇順。同時刻の投稿で並びが揺れないよう、`templateId` → `id` を
 * 第 2・第 3 のキーにして安定させる(表示順が読むたびに変わると差分が読めない)。
 * ペアの実体が無い場合や版種がペア対象外の場合は、自版だけが返る。
 */
export async function listNotes(templateId: string): Promise<PartNoteEntry[]> {
  const paired = pairedTemplateId(templateId);
  const own = flatten(templateId, await readNotes(templateId));
  const other = paired ? flatten(paired, await readNotes(paired)) : [];
  return [...own, ...other].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.templateId.localeCompare(b.templateId) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * 投稿を追加する。読み-改変-書きは版インスタンス単位のロックで包む(包まないと同時追加が
 * 互いの投稿を消し、`atomicWrite` の rename 競合で片方が 500 になる)。
 *
 * 上限は 2 段。`pathKey` の件数(新規キーのときだけ見る)と、1 パーツの投稿数。
 */
export async function addNote(
  templateId: string,
  pathKey: string,
  content: string,
  loginId: string,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    if (notesAtCapacity(map, pathKey)) notesCapacityError();
    const entries = map[pathKey] ?? [];
    if (entriesAtCapacity(entries)) entriesCapacityError();
    const stored: StoredNoteEntry = {
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
      createdBy: loginId,
      updatedAt: null,
      updatedBy: null,
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
  throw validation('対象のメモが見つかりません(すでに削除された可能性があります)');
}

/**
 * 投稿本文を編集する。上限に達していても編集は必ず通す(上限が「直せない」状態を作らない)。
 * 誰の投稿でも編集できる(共同作業を前提とし、所有者による制限は設けない)。
 */
export async function updateNote(
  templateId: string,
  entryId: string,
  content: string,
  loginId: string,
): Promise<PartNoteEntry> {
  return withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey, index } = locate(map, entryId);
    const updated: StoredNoteEntry = {
      ...map[pathKey][index],
      content,
      updatedAt: new Date().toISOString(),
      updatedBy: loginId,
    };
    map[pathKey] = map[pathKey].map((e, i) => (i === index ? updated : e));
    await writeNotes(templateId, map);
    return toEntry(templateId, pathKey, updated);
  });
}

/** 投稿を削除する。パーツの投稿が空になったらキーごと畳む(空配列を残さない)。 */
export async function deleteNote(templateId: string, entryId: string): Promise<void> {
  await withNotesLock(templateId, async () => {
    const map = await readNotesStrict(templateId);
    const { pathKey, index } = locate(map, entryId);
    const rest = map[pathKey].filter((_, i) => i !== index);
    if (rest.length === 0) delete map[pathKey];
    else map[pathKey] = rest;
    await writeNotes(templateId, map);
  });
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project server editor/server/test/noteRepo.test.ts`
Expected: PASS

- [ ] **Step 5: 既存の上限テストを新 API へ追随させる**

`editor/server/test/notes.limits.test.ts` の変更点は次の 3 つ。

「マップの件数上限」ブロック（65-91 行）の中身を投稿配列形式へ書き換える:

```ts
describe('マップの件数上限', () => {
  it('上限に達したら新規キーは拒否し、既存キーの追加と削除は通す', async () => {
    const { files, repo } = await importNotes();
    const full: Record<string, unknown> = {};
    for (let i = 0; i < files.MAX_NOTES_PER_TEMPLATE; i++) {
      full[`p${i}`] = [
        {
          id: `e${i}`,
          content: 'x',
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'tester',
          updatedAt: null,
          updatedBy: null,
        },
      ];
    }
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), JSON.stringify(full), 'utf8');

    await expect(repo.addNote(TPL, 'brand-new', 'メモ', 'tester')).rejects.toMatchObject({
      kind: 'validation',
    });
    // 既存キーへの追加・削除は上限に関係なく通る(上限が「消せない」状態を作らない)。
    await expect(repo.addNote(TPL, 'p0', '追記', 'tester')).resolves.toMatchObject({
      content: '追記',
    });
    await expect(repo.deleteNote(TPL, 'e1')).resolves.toBeUndefined();
    const after = await files.readNotes(TPL);
    expect(after.p0).toHaveLength(2);
    expect(after.p1).toBeUndefined();
  });
});
```

「同時保存で更新が消えない」の 3 つのケース（94-139 行）は `repo.saveNote(...)` を
`repo.addNote(TPL, 'a', 'A', 'u1')` の形へ置き換える。読めない実体・壊れた JSON のケースは
`repo.addNote(tplId, 'p1', '新しいメモ', 'editor1')` へ置き換える（主張は変えない）。

「件数上限内でもサイズ上限を超える書き込みは拒否される」（142-162 行）のマップ生成を
投稿配列へ変える:

```ts
    const map: Record<string, unknown> = {};
    for (let i = 0; i < 70; i++)
      map[`p${i}`] = [
        {
          id: `e${i}`,
          content: 'あ'.repeat(20_000),
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ];
```

- [ ] **Step 6: server のテスト全体が通ることを確認する**

Run: `pnpm vitest run --project server editor/server/test/notes.limits.test.ts editor/server/test/noteRepo.test.ts editor/server/test/notesFile.thread.test.ts`
Expected: PASS（3 ファイルとも）

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/server/src/repositories/noteRepo.ts editor/server/test
git add editor/server/src/repositories/noteRepo.ts editor/server/test/noteRepo.test.ts editor/server/test/notes.limits.test.ts
git commit -m "feat(editor): メモの読み取りで交付版と全体版をマージする"
```

---

### Task 4: メモの REST ルート（追加・編集・削除）

**Files:**
- Modify: `editor/server/src/routes/notes.routes.ts`（全面）
- Modify: `editor/server/src/routes/routeGuards.ts:71-73`
- Modify: `editor/server/src/openapi/document.ts:398-419`
- Test: `editor/server/test/notes.routes.test.ts`（新規）

**Interfaces:**
- Consumes: Task 3 の `listNotes` / `addNote` / `updateNote` / `deleteNote`、Task 1 の `AddNoteRequest` / `UpdateNoteRequest` / `apiPaths.noteEntry`
- Produces: `GET|POST /api/templates/:templateId/notes`、`PATCH|DELETE /api/templates/:templateId/notes/:entryId`

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/notes.routes.test.ts`:

```ts
// =============================================================================
// notes.routes.test.ts — メモ API の権限宣言と本文検証
// =============================================================================
// 変更系ルートは `ROUTE_POLICY` へ宣言されていなければ起動時に落ちる。ここでは 4 経路が
// 宣言されていること(GET は閲覧可・変更系は editor 以上)と、空文字の本文を受け付けない
// ことを主張する。
import { apiPaths, AddNoteRequest, UpdateNoteRequest } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { ROUTE_POLICY } from '../src/routes/routeGuards.js';

describe('メモ API の権限宣言', () => {
  it('4 経路すべてが宣言されている', () => {
    expect(ROUTE_POLICY[`GET /api${apiPaths.notes}`]).toBe('auth');
    expect(ROUTE_POLICY[`POST /api${apiPaths.notes}`]).toBe('editor');
    expect(ROUTE_POLICY[`PATCH /api${apiPaths.noteEntry}`]).toBe('editor');
    expect(ROUTE_POLICY[`DELETE /api${apiPaths.noteEntry}`]).toBe('editor');
  });

  it('旧 PUT 経路は宣言から消えている', () => {
    expect(ROUTE_POLICY[`PUT /api${apiPaths.notes}`]).toBeUndefined();
  });
});

describe('本文の検証', () => {
  it('空文字は追加・編集とも拒否する(削除は DELETE で明示する)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '   ' }).success).toBe(true);
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '' }).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ content: '' }).success).toBe(false);
  });
});
```

`ROUTE_POLICY` は `routeGuards.ts:40` で既に export 済みなので、そのまま import できる。

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project server editor/server/test/notes.routes.test.ts`
Expected: FAIL（POST/PATCH/DELETE の宣言が無い）

- [ ] **Step 3: ルートと宣言を実装する**

`editor/server/src/routes/notes.routes.ts` を全面的に置き換える:

```ts
// =============================================================================
// notes.routes.ts — パーツ単位メモ(追記型スレッド)の取得・追加・編集・削除
// =============================================================================
import { AddNoteRequest, apiPaths, UpdateNoteRequest } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as notes from '../repositories/noteRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

// ⚠ ここに私有のスキーマを再定義しないこと。正典は `@editor/shared/schemas` の
// `AddNoteRequest` / `UpdateNoteRequest` で、複製すると上限(`pathKey`/`content` の
// `.max()`)が片方にしか入らず、OpenAPI が公表する契約と実際に強制される契約が食い違う。

type NotesParams = { Params: { templateId: string } };
type EntryParams = { Params: { templateId: string; entryId: string } };

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get<NotesParams>(apiPaths.notes, { preHandler: requireAuth }, async (request) => {
    return notes.listNotes(request.params.templateId);
  });

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
      );
      return reply.code(201).send(entry);
    },
  );

  app.patch<EntryParams & { Body: z.infer<typeof UpdateNoteRequest> }>(
    apiPaths.noteEntry,
    { preHandler: [requireAuth, requireEditor, validate(UpdateNoteRequest)] },
    async (request) => {
      const { templateId, entryId } = request.params;
      return notes.updateNote(templateId, entryId, request.body.content, actor(request));
    },
  );

  app.delete<EntryParams>(
    apiPaths.noteEntry,
    { preHandler: [requireAuth, requireEditor] },
    async (request, reply) => {
      const { templateId, entryId } = request.params;
      await notes.deleteNote(templateId, entryId);
      return reply.code(204).send();
    },
  );
}
```

`editor/server/src/routes/routeGuards.ts` の notes ブロック（71-73 行）を置き換える:

```ts
  // notes
  [`GET ${api(apiPaths.notes)}`]: 'auth',
  [`POST ${api(apiPaths.notes)}`]: 'editor',
  [`PATCH ${api(apiPaths.noteEntry)}`]: 'editor',
  [`DELETE ${api(apiPaths.noteEntry)}`]: 'editor',
```

`editor/server/src/openapi/document.ts` の notes ブロック（398-419 行）を置き換える:

```ts
      // ── 5. notes ──
      [toOpenApiPath(apiPaths.notes)]: {
        get: {
          tags: ['notes'],
          summary: 'パーツ単位メモを取得(交付版と全体版をマージしたスレッド)',
          operationId: 'listNotes',
          requestParams: { path: z.object({ templateId: z.string() }) },
          responses: {
            '200': json('投稿の配列(作成日時の昇順)', z.array(s.PartNoteEntry)),
            ...ERR_401,
            ...ERR_404,
          },
        },
        post: {
          tags: ['notes'],
          summary: 'パーツ単位メモへ投稿を追加',
          operationId: 'addNote',
          requestParams: { path: z.object({ templateId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.AddNoteRequest } } },
          responses: { '201': json('追加した投稿', s.PartNoteEntry), ...ERR_400, ...ERR_401 },
        },
      },
      [toOpenApiPath(apiPaths.noteEntry)]: {
        patch: {
          tags: ['notes'],
          summary: 'メモの投稿本文を編集',
          operationId: 'updateNote',
          requestParams: { path: z.object({ templateId: z.string(), entryId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.UpdateNoteRequest } } },
          responses: { '200': json('更新後の投稿', s.PartNoteEntry), ...ERR_400, ...ERR_401 },
        },
        delete: {
          tags: ['notes'],
          summary: 'メモの投稿を削除',
          operationId: 'deleteNote',
          requestParams: { path: z.object({ templateId: z.string(), entryId: z.string() }) },
          responses: { '204': noContent('削除完了'), ...ERR_400, ...ERR_401 },
        },
      },
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project server editor/server/test/notes.routes.test.ts`
Expected: PASS

- [ ] **Step 5: server 全体のテストが通ることを確認する**

Run: `pnpm vitest run --project server`
Expected: PASS（OpenAPI 一致検査を含む。落ちた場合は document.ts の記述と実ルートの差分を直す）

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/server/src editor/server/test
git add editor/server/src/routes/notes.routes.ts editor/server/src/routes/routeGuards.ts editor/server/src/openapi/document.ts editor/server/test/notes.routes.test.ts
git commit -m "feat(editor): メモの投稿を追加・編集・削除する API を通す"
```

---

### Task 5: web の local / rest リポジトリ

**Files:**
- Modify: `editor/web/src/api/local/noteRepo.ts`（全面）
- Modify: `editor/web/src/api/rest/noteRepo.ts`（全面）
- Modify: `editor/web/src/lib/storageKeys.ts:22-27`（コメントとキー名）
- Test: `editor/web/test/noteRepo.test.ts`（全面書き換え）

**Interfaces:**
- Consumes: Task 1 の `NoteRepository` / `PartNoteEntry` / `apiPaths.noteEntry`、shared の `pairedTemplateId`
- Produces: `localNoteRepo` / `restNoteRepo`（ともに `NoteRepository`）

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/noteRepo.test.ts` を全面的に置き換える:

```ts
import { isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localNoteRepo } from '@/api/local/noteRepo';

beforeEach(() => localStorage.clear());

const KEY = '.page#1/cover#1';
const KOUFU = 'AM01_510037_20240710_交付版';
const ZENTAI = 'AM01_510037_20240710_全体版';
const LONE = 'AM01_510037_20240710_kr';

async function add(templateId: string, content: string): Promise<string> {
  const res = await localNoteRepo.addNote(templateId, KEY, content);
  if (!isOk(res)) throw new Error('追加に失敗');
  return res.value.id;
}

describe('localNoteRepo', () => {
  it('投稿を積み、作成順に返す', async () => {
    await add(KOUFU, '1 件目');
    await add(KOUFU, '2 件目');
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.content)).toEqual(['1 件目', '2 件目']);
  });

  it('交付版と全体版で 1 本のスレッドを共有する', async () => {
    await add(KOUFU, '交付版');
    await add(ZENTAI, '全体版');
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.templateId)).toEqual([KOUFU, ZENTAI]);
  });

  it('ペア対象外の版種は自版のみを返す', async () => {
    await add(KOUFU, '交付版');
    await add(LONE, '旧版種');
    const list = await localNoteRepo.listNotes(LONE);
    expect(isOk(list) && list.value.map((e) => e.content)).toEqual(['旧版種']);
  });

  it('投稿を編集できる(誰の投稿でも編集できる)', async () => {
    const id = await add(KOUFU, '初版');
    await localNoteRepo.updateNote(KOUFU, id, '改訂');
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value[0].content).toBe('改訂');
    expect(isOk(list) && list.value[0].updatedAt).not.toBeNull();
  });

  it('投稿を削除できる', async () => {
    const id = await add(KOUFU, '消す');
    await localNoteRepo.deleteNote(KOUFU, id);
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value).toEqual([]);
  });

  it('空文字の本文は追加できない(削除は deleteNote で明示する)', async () => {
    const res = await localNoteRepo.addNote(KOUFU, KEY, '');
    expect(isOk(res)).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project web editor/web/test/noteRepo.test.ts`
Expected: FAIL（`addNote` が無い）

- [ ] **Step 3: local 実装を書く**

`editor/web/src/api/local/noteRepo.ts` を全面的に置き換える:

```ts
// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)の local 実装(localStorage)
// =============================================================================
// 役割: `NoteRepository` の local 実装。`editor:notes:v2` に
// `Record<templateId, Record<pathKey, PartNoteEntry[]>>` で保持する。読み取りは交付版⇄
// 全体版のペアをマージし、書き込みは投稿が属する版へ向ける(REST 実装と同じ挙動)。
// 版種の対応表は shared の `pairedTemplateId` を使う — web 側へ複製すると片方だけがずれる。
import { pairedTemplateId, type NoteRepository, type PartNoteEntry, validation } from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, write } from './store';

type NoteStore = Record<string, Record<string, PartNoteEntry[]>>;

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
        createdAt: now(),
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
```

`editor/web/src/lib/storageKeys.ts` の 22-27 行を置き換える（キー名を bump して旧形式を
一掃する。local は体験用で、旧形式との互換を保つ価値がない）:

```ts
  // パーツ単位メモ(追記型スレッド)。`Record<templateId, Record<pathKey, PartNoteEntry[]>>`。
  // 交付版⇄全体版で 1 本のスレッドを共有し、基準日をまたぐ繰り越しはしない。版(構造)に
  // 依存する working-state なので `WORKING_KEYS` に含め、スキーマ bump で破棄する。
  // `:v2` はスレッド化での形式変更(旧 `editor:notes` は 1 パーツ 1 件だった)。
  notes: 'editor:notes:v2',
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/noteRepo.test.ts`
Expected: PASS

- [ ] **Step 5: rest 実装を書く**

`editor/web/src/api/rest/noteRepo.ts` を全面的に置き換える:

```ts
// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)の REST 実装
// =============================================================================
// 役割: `NoteRepository` の REST 実装。一覧は GET、追加は POST、編集は PATCH、削除は
// DELETE で叩く。ペアのマージ・並び順はサーバが決める(web では並べ直さない — 2 箇所に
// 並び順を持つと片方だけがずれる)。インタフェースは local 実装と同一で、
// `repositories.ts` の差し替えだけで切替わる。
import { apiPaths, buildPath, type NoteRepository, type PartNoteEntry } from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attemptRest(() => apiFetch<PartNoteEntry[]>(buildPath(apiPaths.notes, { templateId }))),

  addNote: (templateId: string, pathKey: string, content: string) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.notes, { templateId }), {
        method: 'POST',
        body: { pathKey, content },
      }),
    ),

  updateNote: (templateId: string, entryId: string, content: string) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.noteEntry, { templateId, entryId }), {
        method: 'PATCH',
        body: { content },
      }),
    ),

  deleteNote: (templateId: string, entryId: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.noteEntry, { templateId, entryId }), { method: 'DELETE' }),
    ),
};
```

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/web/src/api editor/web/src/lib/storageKeys.ts editor/web/test/noteRepo.test.ts
git add editor/web/src/api/local/noteRepo.ts editor/web/src/api/rest/noteRepo.ts editor/web/src/lib/storageKeys.ts editor/web/test/noteRepo.test.ts
git commit -m "feat(editor): メモのリポジトリ実装をスレッド形式へ差し替える"
```

---

### Task 6: usePartNote をスレッドへ

**Files:**
- Modify: `editor/web/src/features/editor/usePartNote.ts`（全面）
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts:174-217, 436-453, 490-495`
- Test: `editor/web/test/usePartNote.test.ts`（全面書き換え）

**Interfaces:**
- Consumes: Task 1 の `NoteRepository` / `PartNoteEntry`
- Produces: `usePartNote(templateId, currentKey, repo)` が返す
  `{ entries, notedKeys, canNote, reload, add, update, remove }`
  - `entries: ComputedRef<PartNoteEntry[]>` — 選択パーツのスレッド
  - `notedKeys: ComputedRef<Set<string>>` — 投稿が 1 件以上ある `pathKey`
  - `canNote: ComputedRef<boolean>`
  - `add(content: string): Promise<void>` / `update(entry: PartNoteEntry, content: string): Promise<void>` / `remove(entry: PartNoteEntry): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/usePartNote.test.ts` を全面的に置き換える:

```ts
import { err, type NoteRepository, ok, type PartNoteEntry, unexpected } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { usePartNote } from '@/features/editor/usePartNote';

const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';
const TPL = 'AM01_510037_20240710_交付版';

/** インメモリの fake NoteRepository(`store` を直接覗いて永続化を検証する)。 */
function makeRepo() {
  const store: PartNoteEntry[] = [];
  let seq = 0;
  const repo: NoteRepository = {
    listNotes: async () => ok([...store]),
    addNote: async (templateId, pathKey, content) => {
      const entry: PartNoteEntry = {
        id: `e${++seq}`,
        templateId,
        pathKey,
        content,
        createdAt: `2026-09-01T00:00:0${seq}.000Z`,
        createdBy: '編集者',
        updatedAt: null,
        updatedBy: null,
      };
      store.push(entry);
      return ok(entry);
    },
    updateNote: async (_templateId, entryId, content) => {
      const i = store.findIndex((e) => e.id === entryId);
      store[i] = { ...store[i], content, updatedAt: 'x', updatedBy: '編集者' };
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

describe('usePartNote', () => {
  it('追加した投稿がスレッドとマーカーへ反映される', async () => {
    const { repo, store } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => TPL,
      () => key.value,
      repo,
    );

    await note.reload();
    expect(note.entries.value).toEqual([]);

    await note.add('1 件目');
    expect(note.entries.value.map((e) => e.content)).toEqual(['1 件目']);
    expect([...note.notedKeys.value]).toEqual([COVER]);
    expect(store).toHaveLength(1);
  });

  it('選択を切り替えるとそのパーツのスレッドを見せる', async () => {
    const { repo } = makeRepo();
    const key = ref<string | null>(COVER);
    const note = usePartNote(
      () => TPL,
      () => key.value,
      repo,
    );
    await note.add('表紙のメモ');

    key.value = SUMMARY;
    expect(note.entries.value).toEqual([]);
    key.value = COVER;
    expect(note.entries.value.map((e) => e.content)).toEqual(['表紙のメモ']);
  });

  it('投稿を編集・削除できる', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => TPL,
      () => COVER,
      repo,
    );
    await note.add('初版');
    await note.update(note.entries.value[0], '改訂');
    expect(note.entries.value[0].content).toBe('改訂');

    await note.remove(note.entries.value[0]);
    expect(note.entries.value).toEqual([]);
    expect(note.notedKeys.value.size).toBe(0);
    expect(store).toHaveLength(0);
  });

  it('ペア側の投稿は自分の版でなくその投稿の版へ書き戻す', async () => {
    const { repo } = makeRepo();
    const seen: string[] = [];
    const spy: NoteRepository = {
      ...repo,
      updateNote: async (templateId, entryId, content) => {
        seen.push(templateId);
        return repo.updateNote(templateId, entryId, content);
      },
    };
    const note = usePartNote(
      () => TPL,
      () => COVER,
      spy,
    );
    await note.add('交付版のメモ');
    const pairEntry = { ...note.entries.value[0], templateId: 'AM01_510037_20240710_全体版' };
    await note.update(pairEntry, '書き換え');
    expect(seen).toEqual(['AM01_510037_20240710_全体版']);
  });

  it('reload はリポジトリのエラーを飲み込む(スレッドは空のまま)', async () => {
    const repo: NoteRepository = {
      listNotes: async () => err(unexpected('boom')),
      addNote: async () => err(unexpected('boom')),
      updateNote: async () => err(unexpected('boom')),
      deleteNote: async () => err(unexpected('boom')),
    };
    const note = usePartNote(
      () => TPL,
      () => COVER,
      repo,
    );
    await note.reload();
    expect(note.entries.value).toEqual([]);
    expect(note.notedKeys.value.size).toBe(0);
  });

  it('選択キーが解決できないときは追加しない', async () => {
    const { repo, store } = makeRepo();
    const note = usePartNote(
      () => TPL,
      () => null,
      repo,
    );
    await note.add('無視される');
    expect(store).toHaveLength(0);
    expect(note.canNote.value).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project web editor/web/test/usePartNote.test.ts`
Expected: FAIL（`entries` / `add` が無い）

- [ ] **Step 3: 実装する**

`editor/web/src/features/editor/usePartNote.ts` を全面的に置き換える:

```ts
// =============================================================================
// usePartNote.ts — パーツ単位メモ(追記型スレッド)の読込/追加/編集/削除 composable
// =============================================================================
// 役割: 現在の版インスタンスのスレッド(交付版⇄全体版をマージ済み)を保持し、選択中パーツ
// (版内で安定な構造パスキー)の投稿列を提示する。追加・編集・削除はいずれも明示操作なので、
// 保留中の保存という状態は持たない(旧実装の debounce と `flush` は廃止した)。選択やテンプレ
// 読込への追従は getter 注入で行い、単体テスト可能に保つ(`usePartEditHistory.ts` と同様)。

import { isErr, type NoteRepository, type PartNoteEntry } from '@editor/shared';
import { computed, ref } from 'vue';
import { logError } from '@/lib/appError';

/**
 * パーツ単位メモ(追記型スレッド)。`templateId` 配下の全投稿を保持し、選択中パーツの
 * 投稿列を読み書きする。書き込み先は「今開いている版」ではなく「その投稿が属する版」
 * (`entry.templateId`)である点に注意 — ペア側の投稿も同じスレッドに並ぶため。
 *
 * @param templateId  現在の版インスタンス id の getter(空なら no-op)
 * @param currentKey  選択中パーツの構造キーの getter(解決不能なら null)
 * @param repo        メモの永続化先(`NoteRepository`)
 */
export function usePartNote(
  templateId: () => string,
  currentKey: () => string | null,
  repo: NoteRepository,
) {
  // 版インスタンス(+ペア)の全投稿。`reload` で満たし、各操作の後に差分を反映する。
  const all = ref<PartNoteEntry[]>([]);

  /** 投稿を持つ pathKey 集合(canvas のマーカー描画を駆動する)。 */
  const notedKeys = computed<Set<string>>(() => new Set(all.value.map((e) => e.pathKey)));

  /** 現在の選択パーツのスレッド(リポジトリが決めた並びをそのまま保つ)。 */
  const entries = computed<PartNoteEntry[]>(() => {
    const k = currentKey();
    return k ? all.value.filter((e) => e.pathKey === k) : [];
  });

  /** 現在の選択がメモ対象キーへ解決できるか(UI の有効/無効判定)。 */
  const canNote = computed<boolean>(() => currentKey() !== null);

  /** 現在の版インスタンスの全投稿を読み込み直す(テンプレ読込時と各操作の後に呼ぶ)。 */
  async function reload(): Promise<void> {
    const tid = templateId();
    if (!tid) {
      all.value = [];
      return;
    }
    const res = await repo.listNotes(tid);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    all.value = res.value;
  }

  /** 選択パーツへ投稿を追加する。空文字はリポジトリが拒否するのでここでも送らない。 */
  async function add(content: string): Promise<void> {
    const key = currentKey();
    const tid = templateId();
    if (!key || !tid || content.trim() === '') return;
    const res = await repo.addNote(tid, key, content);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /**
   * 投稿の本文を編集する。宛先は `entry.templateId` — 今開いている版ではない。
   * ペア側(全体版)の投稿を交付版の画面から直すとき、自版へ書くと投稿が複製される。
   */
  async function update(entry: PartNoteEntry, content: string): Promise<void> {
    if (content.trim() === '') return;
    const res = await repo.updateNote(entry.templateId, entry.id, content);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  /** 投稿を削除する。宛先は `update` と同じ理由で `entry.templateId`。 */
  async function remove(entry: PartNoteEntry): Promise<void> {
    const res = await repo.deleteNote(entry.templateId, entry.id);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    await reload();
  }

  return { entries, notedKeys, canNote, reload, add, update, remove };
}
```

`editor/web/src/features/editor/useTemplateEditor.ts` を次のように直す。

174-177 行のコメントと `noteRepo` 取得部:

```ts
  // メモは追記型スレッドで、投稿は書かれた版インスタンスのファイルへ入る。表示は交付版⇄
  // 全体版のペアをマージした 1 本のスレッド(基準日をまたぐ繰り越しはしない)。パーツの
  // 同定は版内で安定な構造キー(`partKey.ts`)で行う。
  const noteRepo = useNoteRepo();
```

204-214 行の `usePartNote` 呼び出しから第 3 引数（`userName`）を落とす:

```ts
  const note = usePartNote(
    () => template.value?.meta.id ?? '',
    () => {
      // 選択/編集で再評価させるため reactive 値を読む(computed の依存に含める)。
      void g.selected.value;
      void g.revision.value;
      return currentNoteKey();
    },
    noteRepo,
  );
```

439 行と 453 行の `void note.flush();` / `await note.flush();` を削除する（保留中の保存が
無くなったため）。行の直前のコメントも一緒に削除する。

490-495 行の公開値を差し替える:

```ts
    noteEntries: note.entries,
    canNote: note.canNote,
    addNote: note.add,
    updateNote: note.update,
    removeNote: note.remove,
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/usePartNote.test.ts`
Expected: PASS

この時点で `EditorView.vue` / `Inspector.vue` は旧 props を参照しており型エラーが残る。Task 8 で解消する。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/usePartNote.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/test/usePartNote.test.ts
git add editor/web/src/features/editor/usePartNote.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/test/usePartNote.test.ts
git commit -m "feat(editor): メモの composable をスレッド操作へ作り替える"
```

---

### Task 7: 吹き出しの配置計算

**Files:**
- Create: `editor/web/src/features/editor/noteBubbleLayout.ts`
- Modify: `editor/web/src/features/editor/useCanvasMarkers.ts`
- Test: `editor/web/test/noteBubbleLayout.test.ts`（新規）

**Interfaces:**
- Consumes: 既存の `SelectedRect`（`grapesEvents.ts`）
- Produces:
  - `interface BubbleAnchorInput { part: {left,top,width,height}; page: {left,width}; container: {width,height}; bubble: {width,height} }`
  - `interface BubbleAnchor { side: 'left' | 'right'; overlap: boolean; left: number; top: number; leader: { left: number; top: number; width: number } }`
  - `computeBubbleAnchor(input: BubbleAnchorInput): BubbleAnchor`
  - `useCanvasMarkers` が返す `bubbleAnchor: Ref<BubbleAnchor | null>` と `refreshBubbleAnchor(bubbleSize)`

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/noteBubbleLayout.test.ts`:

```ts
// =============================================================================
// noteBubbleLayout.test.ts — メモ吹き出しの左右判定・重ね・縦クランプ
// =============================================================================
// 吹き出しは「リーダー線が帳票を横切る量が少ない側」へ出し、その反対へページを寄せて
// 場所を作る。寄せても幅が足りなければページに重ねる(ページの大きさは変えない)。
import { describe, expect, it } from 'vitest';
import { computeBubbleAnchor } from '@/features/editor/noteBubbleLayout';

const BUBBLE = { width: 244, height: 300 };
const CONTAINER = { width: 856, height: 700 };

describe('左右の判定', () => {
  it('パーツが右寄りなら右へ出す', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('right');
  });

  it('パーツが左寄りなら左へ出す', () => {
    const a = computeBubbleAnchor({
      part: { left: 160, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('left');
  });

  it('ページ幅いっぱいのパーツは既定の右へ出す', () => {
    const a = computeBubbleAnchor({
      part: { left: 150, top: 100, width: 556, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.side).toBe('right');
  });
});

describe('場所が足りないとき', () => {
  it('寄せれば入るなら重ねない', () => {
    const a = computeBubbleAnchor({
      part: { left: 150, top: 100, width: 556, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    // 856 - 556 = 300 >= 244 なので、ページを左端へ寄せれば収まる。
    expect(a.overlap).toBe(false);
  });

  it('ページがコンテナ幅に近いときは重ねる', () => {
    const a = computeBubbleAnchor({
      part: { left: 20, top: 100, width: 820, height: 80 },
      page: { left: 20, width: 820 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    // 856 - 820 = 36 < 244。ページは縮めないので吹き出しを重ねる。
    expect(a.overlap).toBe(true);
    // 重ねる位置はコンテナ内に収まる。
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.left + BUBBLE.width).toBeLessThanOrEqual(CONTAINER.width);
  });
});

describe('縦の収まり', () => {
  it('下がはみ出すときは上へクランプする', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 650, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.top + BUBBLE.height).toBeLessThanOrEqual(CONTAINER.height);
    expect(a.top).toBeGreaterThanOrEqual(0);
  });

  it('リーダーはパーツの縦中心から引く', () => {
    const a = computeBubbleAnchor({
      part: { left: 400, top: 100, width: 150, height: 80 },
      page: { left: 150, width: 556 },
      container: CONTAINER,
      bubble: BUBBLE,
    });
    expect(a.leader.top).toBe(140);
    expect(a.leader.left).toBe(550);
    expect(a.leader.width).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストを実行して落ちることを確認する**

Run: `pnpm vitest run --project web editor/web/test/noteBubbleLayout.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

`editor/web/src/features/editor/noteBubbleLayout.ts`:

```ts
// =============================================================================
// noteBubbleLayout.ts — メモ吹き出しの配置計算(純関数)
// =============================================================================
// 役割: 選択パーツ・ページ・canvas コンテナ・吹き出しの寸法から、吹き出しを出す側と
// 座標・リーダー線を決める。DOM も Vue も触らない純関数なので、分岐(左右・重ね・縦
// クランプ)を単体テストで固定できる。座標系は overlay 層(canvas コンテナ相対、
// `getElementPos({noScroll:true})` と同じ)。
//
// ⚠ ページの大きさ・倍率はここでは決めない。吹き出しの都合で本体の見えを変えないのが
// 前提で、足りないときは重ねる(`overlap`)。

/** 配置計算の入力(すべて overlay 層の px)。 */
export interface BubbleAnchorInput {
  /** 選択パーツの矩形。 */
  part: { left: number; top: number; width: number; height: number };
  /** ページ(帳票)の水平位置と幅。 */
  page: { left: number; width: number };
  /** canvas コンテナの内寸。 */
  container: { width: number; height: number };
  /** 吹き出しの実寸(描画後に測った値)。 */
  bubble: { width: number; height: number };
}

/** 配置計算の結果。 */
export interface BubbleAnchor {
  /** 吹き出しを出す側。ページはこの反対側へ寄せる。 */
  side: 'left' | 'right';
  /** 寄せても幅が足りず、ページに重ねる必要があるか。 */
  overlap: boolean;
  left: number;
  top: number;
  /** パーツと吹き出しを結ぶ水平線(重ねる場合は幅 0)。 */
  leader: { left: number; top: number; width: number };
}

/** 吹き出しとコンテナ端の間に残す余白。 */
const EDGE_GAP = 12;
/** パーツと吹き出しの間隔(リーダー線の長さ)。 */
const LEADER_GAP = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 吹き出しの配置を決める。
 *
 * 左右は「リーダー線が帳票の上を横切る量が少ない側」で選ぶ。パーツ右端からページ右端まで
 * (`gapRight`)と、ページ左端からパーツ左端まで(`gapLeft`)を比べ、同値なら右へ出す
 * (ページ幅いっぱいのパーツは常にこの経路。実運用のパーツはほぼこれに当たる)。
 *
 * 場所は「吹き出しと反対側へページを寄せる」ことで作るので、判定に使う空きはページを
 * 端まで寄せたときの最大値 = `container.width - page.width` になる。これが吹き出しの幅に
 * 満たないときだけ `overlap` を立てる。
 */
export function computeBubbleAnchor(input: BubbleAnchorInput): BubbleAnchor {
  const { part, page, container, bubble } = input;
  const pageRight = page.left + page.width;
  const partRight = part.left + part.width;
  const side: 'left' | 'right' = pageRight - partRight <= part.left - page.left ? 'right' : 'left';

  // ページを端まで寄せたときに空く幅。ページは縮めないので、これが上限。
  const room = container.width - page.width;
  const overlap = room < bubble.width + EDGE_GAP;

  const top = clamp(part.top, EDGE_GAP, Math.max(EDGE_GAP, container.height - bubble.height - EDGE_GAP));
  const centerY = part.top + part.height / 2;

  if (overlap) {
    // 重ねるときはパーツの内側へ寄せて置き、リーダーは引かない(距離が無く意味を持たない)。
    const left = clamp(
      side === 'right' ? partRight - bubble.width : part.left,
      EDGE_GAP,
      Math.max(EDGE_GAP, container.width - bubble.width - EDGE_GAP),
    );
    return { side, overlap, left, top, leader: { left, top: centerY, width: 0 } };
  }

  if (side === 'right') {
    const left = clamp(
      partRight + LEADER_GAP,
      EDGE_GAP,
      Math.max(EDGE_GAP, container.width - bubble.width - EDGE_GAP),
    );
    return {
      side,
      overlap,
      left,
      top,
      leader: { left: partRight, top: centerY, width: Math.max(0, left - partRight) },
    };
  }

  const left = clamp(part.left - LEADER_GAP - bubble.width, EDGE_GAP, container.width);
  return {
    side,
    overlap,
    left,
    top,
    leader: {
      left: left + bubble.width,
      top: centerY,
      width: Math.max(0, part.left - (left + bubble.width)),
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/noteBubbleLayout.test.ts`
Expected: PASS

- [ ] **Step 5: `useCanvasMarkers` から配置計算を呼べるようにする**

`editor/web/src/features/editor/useCanvasMarkers.ts` の doc コメント冒頭（1-6 行）の
「版を跨ぐメモ」を「メモ」へ改める（メモが跨ぐのはペア版種で、版一般ではない）。
`NoteMarker` の doc コメント（15-20 行）も同様に直す。

`refreshNoteMarkers` の下へ吹き出しアンカーの計測を足す:

```ts
  /** 吹き出しの配置(選択パーツが無い / 吹き出しを閉じている間は null)。 */
  const bubbleAnchor = ref<BubbleAnchor | null>(null);

  /**
   * 選択パーツに紐づく吹き出しの配置を測り直す。ページ矩形は canvas body の
   * `getElementPos` で取り、コンテナ内寸は overlay 層の実寸を使う。吹き出しの実寸は
   * 描画後に呼び出し側が測って渡す(中身の件数で高さが変わるため)。
   */
  function refreshBubbleAnchor(bubble: { width: number; height: number } | null): void {
    const ed = ctx.editor.value;
    const comp = ed?.getSelected();
    const el = comp?.getEl?.();
    const body = ed?.Canvas.getBody();
    const containerEl = ctx.getContainer();
    if (!ed || !el || !body || !containerEl || !bubble) {
      bubbleAnchor.value = null;
      return;
    }
    try {
      const part = ed.Canvas.getElementPos(el, { noScroll: true });
      const page = ed.Canvas.getElementPos(body, { noScroll: true });
      bubbleAnchor.value = computeBubbleAnchor({
        part: { left: part.left, top: part.top, width: part.width, height: part.height },
        page: { left: page.left, width: page.width },
        container: { width: containerEl.clientWidth, height: containerEl.clientHeight },
        bubble,
      });
    } catch (e) {
      logError(toAppError(e));
      bubbleAnchor.value = null;
    }
  }
```

import と `CanvasMarkersContext` に必要な追加:

```ts
import { type BubbleAnchor, computeBubbleAnchor } from './noteBubbleLayout';
```

```ts
interface CanvasMarkersContext {
  editor: ShallowRef<Editor | undefined>;
  pageEls: ShallowRef<HTMLElement[]>;
  currentPageIndex: Ref<number>;
  singlePageMode: Ref<boolean>;
  /** 吹き出し配置の基準になる canvas コンテナ(`useZoomFit` と同じ getter を渡す)。 */
  getContainer: () => HTMLElement | undefined;
}
```

戻り値へ追加する:

```ts
  return {
    selectedRect,
    noteMarkers,
    bubbleAnchor,
    refreshRect,
    refreshNoteMarkers,
    refreshBubbleAnchor,
    setNoteKeys,
  };
```

`useGrapes.ts` で `useCanvasMarkers` を呼んでいる箇所へ `getContainer` を渡し、
`refreshBubbleAnchor` を公開する（`refreshNoteMarkers` を公開している箇所に倣う）。
overlay を測り直す各経路（`setZoom` の `afterZoom` / `recomputeLayout` / 選択変更）で
`refreshBubbleAnchor` も呼ぶ。

- [ ] **Step 6: 型チェックとテストを通す**

Run: `pnpm typecheck:editor`
Expected: PASS（Task 8 の UI 変更が未了なら `EditorView.vue` / `Inspector.vue` の
エラーだけが残る。その場合は Task 8 まで進めてから再実行する）

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor
git add editor/web/src/features/editor/noteBubbleLayout.ts editor/web/src/features/editor/useCanvasMarkers.ts editor/web/src/features/editor/useGrapes.ts editor/web/test/noteBubbleLayout.test.ts
git commit -m "feat(editor): メモ吹き出しの配置計算を純関数で用意する"
```

---

### Task 8: 吹き出しの UI と右ペインの追加欄

**Files:**
- Create: `editor/web/src/features/editor/NoteBubble.vue`
- Modify: `editor/web/src/features/editor/EditorView.vue:320-340, 415-436`
- Modify: `editor/web/src/features/editor/Inspector.vue:50-60, 148-160, 391-408, 491-500`
- Modify: `editor/web/src/assets/index.css:247-272`

**Interfaces:**
- Consumes: Task 6 の `noteEntries` / `canNote` / `addNote` / `updateNote` / `removeNote`、Task 7 の `bubbleAnchor` / `refreshBubbleAnchor`、既存の `confirm()`（`components/ui/confirm.ts`）、shared の `parseTemplateFileName`
- Produces: 画面。他タスクが参照する API は無い。

- [ ] **Step 1: `NoteBubble.vue` を作る**

```vue
<script setup lang="ts">
// =============================================================================
// NoteBubble.vue — キャンバス余白に出すメモの吹き出し(選択パーツのスレッド)
// =============================================================================
// 役割: 選択パーツの投稿列を表示し、その場での編集と削除を受ける。追加は右ペインに一本化
// しているのでここには置かない(入口を 2 つ持つと、どちらで書いたかで挙動が違うように
// 見える)。位置は `noteBubbleLayout.ts` が決めた値をそのまま使う。
import { parseTemplateFileName, type PartNoteEntry } from '@editor/shared';
import { Pencil, StickyNote, Trash2, X } from '@lucide/vue';
import { ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import type { BubbleAnchor } from './noteBubbleLayout';

const props = defineProps<{
  entries: PartNoteEntry[];
  anchor: BubbleAnchor;
}>();

const emit = defineEmits<{
  update: [PartNoteEntry, string];
  remove: [PartNoteEntry];
  close: [];
}>();

// 編集中の投稿 ID と入力中の本文。1 度に 1 件だけ編集する。
const editingId = ref<string | null>(null);
const draft = ref('');

function startEdit(entry: PartNoteEntry): void {
  editingId.value = entry.id;
  draft.value = entry.content;
}

function commitEdit(entry: PartNoteEntry): void {
  if (draft.value.trim() !== '') emit('update', entry, draft.value);
  editingId.value = null;
}

/** 投稿がどの版種で書かれたかを id から解く(保存はしない — 同じ事実を 2 箇所に持たない)。 */
function editionOf(entry: PartNoteEntry): string {
  return parseTemplateFileName(`${entry.templateId}.html`)?.editionType ?? '';
}

/** 表示用の日時(年は省く。同一基準日のスレッドなので月日と時刻で足りる)。 */
function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

async function requestRemove(entry: PartNoteEntry): Promise<void> {
  const ok = await confirm({
    title: 'このメモを削除しますか？',
    description: '削除したメモは元に戻せません。',
    confirmLabel: '削除する',
    variant: 'destructive',
  });
  if (ok) emit('remove', entry);
}
</script>

<template>
  <div
    class="note-bubble"
    :class="anchor.side === 'left' ? 'note-bubble-left' : 'note-bubble-right'"
    :style="{ left: `${anchor.left}px`, top: `${anchor.top}px` }"
  >
    <div class="note-bubble-head">
      <StickyNote class="h-3.5 w-3.5" />
      <span>メモ</span>
      <span class="flex-1" />
      <span class="note-bubble-count">{{ entries.length }}</span>
      <Button variant="ghost" size="iconSm" aria-label="メモを閉じる" @click="emit('close')">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div class="note-bubble-body">
      <div v-for="e in entries" :key="e.id" class="note-entry">
        <div class="note-entry-head">
          <span class="note-entry-who">{{ e.createdBy }}</span>
          <span>{{ formatAt(e.createdAt) }}</span>
          <span v-if="editionOf(e)" class="note-entry-edition">{{ editionOf(e) }}</span>
          <span class="flex-1" />
          <Button variant="ghost" size="iconSm" aria-label="このメモを編集" @click="startEdit(e)">
            <Pencil class="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            class="text-destructive"
            aria-label="このメモを削除"
            @click="requestRemove(e)"
          >
            <Trash2 class="h-3 w-3" />
          </Button>
        </div>

        <template v-if="editingId === e.id">
          <textarea v-model="draft" class="note-entry-input" rows="3" />
          <div class="mt-1.5 flex gap-1.5">
            <Button size="sm" @click="commitEdit(e)">保存</Button>
            <Button size="sm" variant="outline" @click="editingId = null">取消</Button>
          </div>
        </template>
        <div v-else class="note-entry-body">
          {{ e.content }}
          <span v-if="e.updatedAt" class="note-entry-edited">(編集済み)</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 吹き出しは overlay 層(非スクロール)に絶対配置する。位置は `noteBubbleLayout` が決める。
   幅は固定 px でズーム非依存 — メモは注釈であり、帳票と一緒に拡大縮小させない。 */
.note-bubble {
  position: absolute;
  z-index: 5;
  width: 244px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  box-shadow: 0 4px 14px rgb(0 0 0 / 32%);
}

.note-bubble-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 700;
}

.note-bubble-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--secondary);
  font-size: 10px;
  font-weight: 700;
}

.note-bubble-body {
  max-height: 320px;
  overflow-y: auto;
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.note-entry-head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--muted-foreground);
}

.note-entry-who {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--foreground);
}

.note-entry-edition {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 9.5px;
  font-weight: 700;
}

.note-entry-body {
  margin-top: 1px;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.note-entry-edited {
  margin-left: 4px;
  font-size: 10px;
  color: var(--muted-foreground);
}

.note-entry-input {
  width: 100%;
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}
</style>
```

使える値は確認済み。`Button` の `variant` は
`default | destructive | outline | secondary | ghost | link`、`size` は
`default | sm | lg | icon | iconSm`（`components/ui/Button.vue:8-22`）。`confirm()` のオプションは
`title` / `description` / `confirmLabel` / `cancelLabel` / `variant`（`components/ui/confirm.ts:8-14`）。

- [ ] **Step 2: `EditorView.vue` へ吹き出しを載せる**

`useTemplateEditor` の分割代入（38-46 行付近）を新しい名前へ差し替える:

```ts
  noteEntries,
  canNote,
  addNote,
  updateNote,
  removeNote,
```

overlay 層（`note-marker` の v-for の直後、320-340 行付近）へ吹き出しとリーダー線を足す:

```html
          <!-- メモ吹き出し(選択パーツのスレッド)。リーダー線でパーツと結ぶ。
               ページは反対側へ寄るが、大きさ・倍率は変えない(`noteBubbleLayout` を見よ)。 -->
          <template v-if="g.bubbleAnchor.value && noteEntries.length > 0">
            <div
              v-if="g.bubbleAnchor.value.leader.width > 0"
              class="note-leader"
              :style="{
                left: `${g.bubbleAnchor.value.leader.left}px`,
                top: `${g.bubbleAnchor.value.leader.top}px`,
                width: `${g.bubbleAnchor.value.leader.width}px`,
              }"
            />
            <NoteBubble
              :entries="noteEntries"
              :anchor="g.bubbleAnchor.value"
              @update="updateNote"
              @remove="removeNote"
              @close="bubbleClosed = true"
            />
          </template>
```

閉じるボタンの状態は `EditorView.vue` のローカル ref で持つ。選択が変わったら開き直す
（閉じたままだと別パーツのメモが出ない）。上の `v-if` へ `&& !bubbleClosed` を足す:

```ts
// 吹き出しの ✕ で閉じた状態。選択が変わったら開き直す(閉じたままだと次のパーツの
// メモが出ず、「メモが消えた」ように見える)。
const bubbleClosed = ref(false);
watch(
  () => g.selected.value,
  () => {
    bubbleClosed.value = false;
  },
);
```

吹き出しの実寸を測って `refreshBubbleAnchor` へ渡す。`NoteBubble` に `ref` を付け、
`onMounted` / スレッド更新時 / ズーム・レイアウト再計算時に
`g.refreshBubbleAnchor({ width: el.offsetWidth, height: el.offsetHeight })` を呼ぶ。
初回は幅 244・高さ 0 の見積もりで呼び、描画後に実寸で測り直す。

Inspector へ渡す props を差し替える（415-436 行付近）:

```html
        :note-count="noteEntries.length"
        :can-note="canNote"
        ...
        @add-note="addNote"
```

リーダー線のスタイルを `<style scoped>` へ足す:

```css
/* メモ吹き出しとパーツを結ぶ水平線。overlay 層に描くので canvas のズームに追従しない
   (位置だけが `noteBubbleLayout` の計算で追従する)。 */
.note-leader {
  position: absolute;
  height: 1px;
  background: var(--primary);
  opacity: 0.55;
}
```

- [ ] **Step 3: `Inspector.vue` のメモ欄を追加専用にする**

props（50-60 行付近）を差し替える:

```ts
  /** 選択パーツのメモ件数(バッジ表示用)。本文はキャンバスの吹き出しが受け持つ。 */
  noteCount: number;
  /** 選択がメモ対象キーへ解決できるか(不能なら入力を無効化)。 */
  canNote: boolean;
```

emits を差し替える:

```ts
  'add-note': [string];
```

2b ブロック（148-160 行）を置き換える:

```ts
// ── 2b. メモの追加 ──
// 既存のメモはキャンバスの吹き出しが表示する。ここは追加の入口だけを持つ(メモが 0 件の
// パーツへ最初の 1 件を書く動線でもある)。送信後は入力を空へ戻す。
const noteDraft = ref('');
function submitNote(): void {
  const text = noteDraft.value.trim();
  if (text === '') return;
  emit('add-note', noteDraft.value);
  noteDraft.value = '';
}
```

テンプレートのメモセクション（391-408 行）を置き換える:

```html
        <!-- ── メモの追加(表示は canvas の吹き出し) ── -->
        <InspectorSection v-model:open="open.memo" label="メモを追加" :icon="StickyNote" class="border-b" body-class="px-4 pb-3.5">
          <template #badge>
            <span class="flex-1" />
            <Badge variant="secondary" class="h-[18px] py-0 text-[10.5px]">{{ noteCount }} 件</Badge>
          </template>
          <textarea
            v-model="noteDraft"
            :disabled="!canNote"
            class="memo-area"
            rows="3"
            placeholder="このパーツへのメモを書く…"
            @keydown.ctrl.enter="submitNote"
          />
          <div class="mt-1.5 flex items-center">
            <span class="text-[10.5px] text-muted-foreground">Ctrl + Enter で追加</span>
            <span class="flex-1" />
            <Button size="sm" :disabled="!canNote || noteDraft.trim() === ''" @click="submitNote">
              追加
            </Button>
          </div>
          <p class="mt-1.5 text-[11px] text-muted-foreground">
            既存のメモはキャンバスの吹き出しに表示します。交付版と全体版で共有します（基準日ごとに独立）。
          </p>
        </InspectorSection>
```

`.memo-area` の CSS コメント（491 行）を「メモ追加の入力欄。固定 UI スケールで常に読める
（キャンバスズーム非依存）」へ直す。

- [ ] **Step 4: ページの左右寄せを CSS で用意する**

`editor/web/src/assets/index.css` の `.gjs-frame-wrapper` ブロック（253-272 行）の後ろへ
足す:

```css
/* メモ吹き出しを開いている間だけ、吹き出しと反対側へページを寄せて場所を作る。
   動かすのは水平位置だけで、幅・倍率は変えない(ページの見えは PDF の見えと一致している
   必要があり、注釈の都合で本体を縮めない)。class は `EditorView.vue` が付ける。 */
.ret-note-side-right .gjs-frame-wrapper {
  /* biome-ignore lint/complexity/noImportantStyles: 上の中央寄せ margin を打ち消すため必要 */
  margin-left: 0 !important;
}

.ret-note-side-left .gjs-frame-wrapper {
  /* biome-ignore lint/complexity/noImportantStyles: 上の中央寄せ margin を打ち消すため必要 */
  margin-right: 0 !important;
}
```

`EditorView.vue` で `bubbleAnchor` を監視し、canvas コンテナへ class を出し分ける:

```ts
// 吹き出しを開いている間だけページを反対側へ寄せる(重ねる場合は寄せても意味が無いので
// 付けない)。class の付け外しは `updateScrollMode` と同じく canvas コンテナに対して行う。
watch(
  () => g.bubbleAnchor.value,
  (anchor) => {
    const el = canvasEl.value;
    if (!el) return;
    const shift = anchor && !anchor.overlap && noteEntries.value.length > 0;
    el.classList.toggle('ret-note-side-right', shift === true && anchor?.side === 'right');
    el.classList.toggle('ret-note-side-left', shift === true && anchor?.side === 'left');
  },
);
```

class を付け外しするとページの水平位置が変わるので、直後の `requestAnimationFrame` で
`g.refreshRect()` / `g.refreshPageGuides()` / `g.refreshNoteMarkers()` /
`g.refreshBubbleAnchor(...)` を呼び直す（`setZoom` と同じ手順）。

- [ ] **Step 5: 型チェックとテストを通す**

Run: `pnpm typecheck:editor`
Expected: PASS

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 6: 実画面で確認する**

Run: `pnpm dev`（`http://localhost:24681` を開き、テンプレートを編集で開く）
確認項目:
1. パーツを選ぶと右側に吹き出しが出て、ページが左へ寄る。ページの大きさは変わらない。
2. 右ペインの「メモを追加」で投稿でき、吹き出しへ反映される。
3. 吹き出しの投稿を編集・削除できる。削除は確認ダイアログを経る。
4. ズームを上げて余白が無くなると、吹き出しがページに重なる（ページは縮まない）。
5. メモを持つ他パーツにはマーカーだけが出る。

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/web/src
git add editor/web/src/features/editor/NoteBubble.vue editor/web/src/features/editor/EditorView.vue editor/web/src/features/editor/Inspector.vue editor/web/src/assets/index.css
git commit -m "feat(editor): メモをキャンバスの吹き出しで表示し右ペインを追加専用にする"
```

---

### Task 9: 仕上げ（コメント是正・カバレッジ・ドキュメント・スクリーンショット）

**Files:**
- Modify: `editor/web/src/features/editor/partKey.ts:1-13`
- Modify: `editor/web/src/features/editor/useCanvasMarkers.ts`（doc コメント）
- Modify: `vitest.config.ts`（include へ 2 ファイル追加）
- Modify: `docs/editor/src/設計正典.md`
- Modify: `docs/editor/src/設計書.md`（メモ機能の節）
- Modify: `docs/editor/images/*.png`（e2e の再撮影分）

- [ ] **Step 1: 事実と食い違うコメントを直す**

`partKey.ts` の 8-9 行「メモ自体は会社・ファンド・基準日・版ごとに独立し、版を跨いでは
継続しない」を次へ:

```ts
// (版比較 `htmlBlockDiff.ts` のブロック整列と同思想)。メモはこのキーでパーツを指し、
// 交付版⇄全体版のペアで 1 本のスレッドを共有する(基準日をまたぐ繰り越しはしない)。
```

`useCanvasMarkers.ts` の「版を跨ぐメモ」表現をすべて「メモ」へ直す（3 箇所前後）。

Run: `pnpm run check:comments`
Expected: PASS

- [ ] **Step 2: カバレッジの include を足す**

`vitest.config.ts` の include 配列へ 2 行足す（既存の並びに合わせる。`usePartNote.ts` と
`noteRepo.ts` は既に入っている）:

```ts
        'editor/web/src/features/editor/noteBubbleLayout.ts',
```

```ts
        'editor/server/src/repositories/noteRepo.ts',
```

Run: `pnpm test:coverage`
Expected: PASS（全指標 85% 以上）

- [ ] **Step 3: 設計正典を更新する**

`docs/editor/src/設計正典.md` の「中核原則」へ次を足す（`パーツ自動同期` の項の近く）:

```markdown
- **パーツメモは追記型スレッドで、ペア版種と共有する**: メモは `dataRoot/notes/<templateId>.json`
  に `pathKey → 投稿配列` で持ち、読み取り時に交付版⇄全体版（`pairedTemplateId`）をマージして
  1 本のスレッドとして返す。**基準日をまたぐ繰り越しはしない**（基準日が違えば別スレッド）。
  投稿の追加・編集・削除は投稿が属する版のファイルへ向ける。上限は「ファイル 4MB」「`pathKey`
  1000 件」「1 パーツ 200 投稿」の 3 段で、件数上限だけではサイズを守れない（1 パーツで
  ファイル上限に達すると、そのテンプレの全メモが保存不能になる）。旧形式（1 パーツ 1 件）は
  読み取り時に投稿 1 件（ID は `legacy` 固定）へ遅延変換する。
- **メモの表示はキャンバスの吹き出し、追加は右ペイン**: 既存のメモは選択パーツの横の吹き出しに
  出し、右ペインは追加専用にする（入口を 2 つ持たない）。吹き出しはリーダー線が帳票を横切る量が
  少ない側へ出し、反対側へページを寄せて場所を作る。**ページの大きさ・倍率は変えない** —
  ページの見えは PDF の見えと一致している必要があり、注釈の都合で本体を縮めない。寄せても幅が
  足りなければページに重ねる。配置計算は `web/src/features/editor/noteBubbleLayout.ts` の純関数。
```

「してはならないこと・却下済み設計」へ次を足す:

```markdown
- **メモを基準日の次の版へ繰り越す**: しない（2026-09 のユーザー判断）。共有はペア版種
  （交付版⇄全体版）だけに留める。
- **メモの保存先をペア単位ファイル（`notes/<pairKey>.json`）へ集約する**: しない。ペア対象外の
  版種（`kr`/`zr` 等の残存資産）のために 2 系統が併存し、既存メモの一括移行も要る。読み取り時の
  マージで足りる。
- **吹き出しの場所を作るためにズームを下げる / canvas の描画領域を狭める**: しない（上記の
  中核原則）。動かしてよいのはページの水平位置だけ。
```

- [ ] **Step 4: 設計書のメモの節を更新する**

`docs/editor/src/設計書.md` でメモ機能を説明している箇所を、スレッド化・ペア共有・吹き出し
表示へ書き換える（該当節は「メモ」で検索して特定する）。

- [ ] **Step 5: ドキュメントの HTML を作り直す**

Run: `pnpm test:e2e`
（`capture_docs.spec.ts` が `docs/editor/images/` を再撮影する。メモ欄の見た目が変わるため
差分が出る）

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `docs/editor/editor_手引き.html` / `editor_設計.html` が再生成される（画像を
base64 でインラインしているので、再撮影しただけでは HTML が追随しない）

- [ ] **Step 6: 集約 CI を通す**

Run: `pnpm run ci`
Expected: PASS（`check:comments` → `check:ci` → `typecheck` → `test:coverage` → `build` →
`test:e2e`）

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/web/src
git add editor/web/src/features/editor/partKey.ts editor/web/src/features/editor/useCanvasMarkers.ts vitest.config.ts docs/editor
git commit -m "docs(editor): メモのスレッド化とペア共有を設計正典へ反映する"
```
