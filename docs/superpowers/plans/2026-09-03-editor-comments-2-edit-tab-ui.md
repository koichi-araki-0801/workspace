# editor コメント機能 計画 2/3: 編集タブのコメント UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 編集タブの右ペインに Adobe Reader 風の「コメント」一覧(検索・絞り込み・並び・行クリックで
パーツへ移動)を置き、吹き出しを親投稿 + 返信の入れ子表示に改め、マーカーを未対応 / 解決済みで
出し分ける。

**Architecture:** 一覧の絞り込み・並びは純関数 `commentFilter.ts` に置き、表示は
`CommentPanel.vue`(右ペイン)と `NoteBubble.vue`(canvas 吹き出し)が担う。データは計画 1 の
`usePartNote.ts`(本計画で `useComments.ts` へ改名)が保持し、`useTemplateEditor.ts` が
GrapesJS 側の選択・スクロールと橋渡しする。右ペインは `Inspector.vue` の頭に
「プロパティ | コメント」の切替を持ち、コメント側は slot で `CommentPanel` を受ける。

**Tech Stack:** Vue 3(`<script setup>`)/ Tailwind / lucide / GrapesJS / vitest + @vue/test-utils / Playwright

**Spec:** `docs/superpowers/specs/2026-09-03-editor-reader-comments-design.md`(4 章・7 章)

## Global Constraints

- 作業ディレクトリはリポジトリルート `C:\Users\caads\workspace`。計画 1 が完了していること
  (`PartNoteEntry` が `status` / `replyTo` / `kind` を持ち、`usePartNote` が `reply` / `setStatus` を持つ)。
- テストはルートから `pnpm exec vitest run --project web <テストファイル>`。e2e は
  `pnpm exec playwright test -c editor/playwright.config.ts <spec>`。
- 型チェックは `pnpm --filter @editor/shared run build` → `pnpm run typecheck:editor`。
- `editor/**` を変更したコミットの直前に **必ず** `pnpm exec biome check --write editor/<変更ファイル…>`。
- コミットメッセージは日本語の Conventional Commits。末尾に
  `Claude-Session: https://claude.ai/code/session_01FzRSKkNMZEugJR2mhsMZAv`。
- コメントは `docs/コメント規約.md` に従う。UI 文言は丁寧な日本語(genshijin 圧縮を適用しない)。
- 新規ソースファイルをテストしたらルート `vitest.config.ts` の coverage `include` へ追加する
  (全指標 85% 閾値)。
- **2 系統の原則を崩さない**: `useGrapes` / `jinjaComponents` / `useTemplateEditor` /
  `templateEditorService` を触る Task は `twoSystems.guard.test.ts` を含む `pnpm run test:editor` を通す。
- overlay 層(canvas の上)に置く操作要素は `pointer-events: auto` を明示する(既存
  `.note-bubble` と同じ約束。無いと押せない)。
- 右ペインの幅は 312px 固定(`Inspector.vue` の `w-[312px]`)。コメント一覧はこの幅に収める。
- 吹き出しはページの大きさ・倍率を変えない(`noteBubbleLayout.ts` の設計を変えない)。
- 文言: 利用者向けは「メモ」を「コメント」へ改める。識別子(`note*`)は据え置いてよい。

---

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `editor/web/src/features/editor/comments/commentFilter.ts` | 新規 | スレッド化・絞り込み・並び・投稿者列挙・種別ラベル(純関数) |
| `editor/web/src/features/editor/comments/CommentPanel.vue` | 新規 | 右ペインのコメント一覧(検索・絞り込み・新規入力・行展開で返信/解決) |
| `editor/web/src/features/editor/useComments.ts` | 改名 | 旧 `usePartNote.ts`。`all` と `openKeys` を公開 |
| `editor/web/src/features/editor/NoteBubble.vue` | 修正 | 親 + 返信の入れ子、返信入力、解決トグル |
| `editor/web/src/features/editor/Inspector.vue` | 修正 | 頭の切替(プロパティ / コメント)と `comments` slot。メモ追加セクションを撤去 |
| `editor/web/src/features/editor/EditorView.vue` | 修正 | 切替状態、`CommentPanel` の配置、マーカーの解決済み表示、吹き出しの新 emit |
| `editor/web/src/features/editor/useTemplateEditor.ts` | 修正 | `selectPartByKey` と `partOrder`、新メソッドの公開 |
| `editor/web/test/commentFilter.test.ts` | 新規 | 純関数 |
| `editor/web/test/commentPanel.test.ts` | 新規 | 一覧の描画・emit |
| `editor/web/test/useComments.test.ts` | 改名 | 旧 `usePartNote.test.ts` + `openKeys` |
| `editor/e2e/note_bubble.spec.ts` | 修正 | 返信・解決を追加 |
| `editor/e2e/comment_panel.spec.ts` | 新規 | 検索・絞り込み・行クリックの canvas 追従 |
| `vitest.config.ts` | 修正 | coverage include |

---

### Task 1: `commentFilter.ts` — スレッド化と絞り込みの純関数

**Files:**
- Create: `editor/web/src/features/editor/comments/commentFilter.ts`
- Test: `editor/web/test/commentFilter.test.ts`
- Modify: `vitest.config.ts`(include に `'editor/web/src/features/editor/comments/commentFilter.ts'` を足す)

**Interfaces:**
- Produces:
  ```ts
  export interface CommentThread { parent: PartNoteEntry; replies: PartNoteEntry[]; lastAt: string }
  export type CommentStatusFilter = 'all' | 'open' | 'resolved';
  export type CommentSort = 'updated' | 'part';
  export interface CommentFilter {
    query: string;                 // 本文・投稿者の部分一致(空なら無条件)
    status: CommentStatusFilter;
    kinds: ReadonlySet<NoteKind>;  // 空集合なら無条件
    author: string | null;         // null なら無条件
    onlySelected: boolean;         // true なら selectedKey のパーツだけ
    sort: CommentSort;
  }
  export const DEFAULT_COMMENT_FILTER: CommentFilter;
  export const KIND_LABEL: Record<NoteKind, string>;   // note→メモ, fix-request→修正依頼, question→質問
  export function threadsOf(entries: readonly PartNoteEntry[]): CommentThread[];
  export function authorsOf(entries: readonly PartNoteEntry[]): string[];
  export function filterThreads(threads, filter, ctx: { selectedKey: string | null; partOrder: ReadonlyMap<string, number> }): CommentThread[];
  export function openKeysOf(entries: readonly PartNoteEntry[]): Set<string>;  // 未対応の親を持つ pathKey
  ```

- [ ] **Step 1: 失敗するテストを書く**

```ts
// editor/web/test/commentFilter.test.ts
import type { PartNoteEntry } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  authorsOf,
  DEFAULT_COMMENT_FILTER,
  filterThreads,
  openKeysOf,
  threadsOf,
} from '@/features/editor/comments/commentFilter';

const TPL = 'AM01_510037_20240710_交付版';
const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';

function entry(p: Partial<PartNoteEntry> & { id: string }): PartNoteEntry {
  return {
    templateId: TPL,
    pathKey: COVER,
    content: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'editor1',
    updatedAt: null,
    updatedBy: null,
    status: 'open',
    replyTo: null,
    kind: 'note',
    ...p,
  };
}

const ctx = { selectedKey: COVER, partOrder: new Map([[COVER, 0], [SUMMARY, 1]]) };

describe('threadsOf', () => {
  it('親ごとに返信を集め、親の作成順に並べる', () => {
    const list = [
      entry({ id: 'p1', createdAt: '2026-09-01T00:00:01.000Z' }),
      entry({ id: 'r1', replyTo: 'p1', createdAt: '2026-09-01T00:00:03.000Z' }),
      entry({ id: 'p2', createdAt: '2026-09-01T00:00:02.000Z', pathKey: SUMMARY }),
    ];
    const t = threadsOf(list);
    expect(t.map((x) => x.parent.id)).toEqual(['p1', 'p2']);
    expect(t[0].replies.map((r) => r.id)).toEqual(['r1']);
    expect(t[0].lastAt).toBe('2026-09-01T00:00:03.000Z');
  });

  it('親の無い返信は捨てる(表示先が無い)', () => {
    expect(threadsOf([entry({ id: 'r', replyTo: 'gone' })])).toEqual([]);
  });

  it('lastAt は本文の編集日時も見る', () => {
    const t = threadsOf([entry({ id: 'p', updatedAt: '2026-09-02T00:00:00.000Z' })]);
    expect(t[0].lastAt).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('filterThreads', () => {
  const threads = threadsOf([
    entry({ id: 'a', content: '表紙の日付', createdBy: '山田', kind: 'fix-request', createdAt: '2026-09-01T00:00:01.000Z' }),
    entry({ id: 'a-r', replyTo: 'a', content: '直しました', createdBy: '鈴木', createdAt: '2026-09-01T00:00:05.000Z' }),
    entry({ id: 'b', content: '要約の数値', createdBy: '鈴木', pathKey: SUMMARY, status: 'resolved', kind: 'question', createdAt: '2026-09-01T00:00:02.000Z' }),
    entry({ id: 'c', content: 'ロゴ', createdBy: '山田', createdAt: '2026-09-01T00:00:03.000Z' }),
  ]);

  it('既定は未対応だけを更新日時の降順で返す', () => {
    const out = filterThreads(threads, DEFAULT_COMMENT_FILTER, ctx);
    expect(out.map((t) => t.parent.id)).toEqual(['a', 'c']);
  });

  it('検索は本文と投稿者を見て、返信の本文も対象にする', () => {
    const q = (query: string) =>
      filterThreads(threads, { ...DEFAULT_COMMENT_FILTER, status: 'all', query }, ctx).map((t) => t.parent.id);
    expect(q('数値')).toEqual(['b']);
    expect(q('鈴木')).toEqual(['a', 'b']);
    expect(q('直しました')).toEqual(['a']);
  });

  it('状態・種別・投稿者・選択パーツで絞り込める', () => {
    const f = DEFAULT_COMMENT_FILTER;
    expect(filterThreads(threads, { ...f, status: 'resolved' }, ctx).map((t) => t.parent.id)).toEqual(['b']);
    expect(filterThreads(threads, { ...f, status: 'all', kinds: new Set(['question']) }, ctx).map((t) => t.parent.id)).toEqual(['b']);
    expect(filterThreads(threads, { ...f, status: 'all', author: '山田' }, ctx).map((t) => t.parent.id)).toEqual(['c', 'a']);
    expect(filterThreads(threads, { ...f, status: 'all', onlySelected: true }, ctx).map((t) => t.parent.id)).toEqual(['c', 'a']);
  });

  it('パーツ順の並びは partOrder に従い、同じパーツ内は作成順', () => {
    const out = filterThreads(threads, { ...DEFAULT_COMMENT_FILTER, status: 'all', sort: 'part' }, ctx);
    expect(out.map((t) => t.parent.id)).toEqual(['a', 'c', 'b']);
  });

  it('partOrder に無いパーツは末尾へ回す', () => {
    const out = filterThreads(threads, { ...DEFAULT_COMMENT_FILTER, status: 'all', sort: 'part' }, { selectedKey: null, partOrder: new Map([[SUMMARY, 0]]) });
    expect(out.map((t) => t.parent.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('authorsOf / openKeysOf', () => {
  it('投稿者は重複を除いて出現順', () => {
    expect(authorsOf([entry({ id: '1', createdBy: 'b' }), entry({ id: '2', createdBy: 'a' }), entry({ id: '3', createdBy: 'b' })])).toEqual(['b', 'a']);
  });

  it('未対応の親を持つパーツだけを返す(返信の状態は見ない)', () => {
    const keys = openKeysOf([
      entry({ id: 'p', status: 'resolved' }),
      entry({ id: 'q', pathKey: SUMMARY }),
      entry({ id: 'q-r', pathKey: SUMMARY, replyTo: 'q', status: 'open' }),
    ]);
    expect([...keys]).toEqual([SUMMARY]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/commentFilter.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
// =============================================================================
// commentFilter.ts — コメント一覧のスレッド化・絞り込み・並び(純関数)
// =============================================================================
// 役割: `PartNoteEntry` の平坦な配列を「親投稿 + 返信」のスレッドへ組み、右ペインの
// 一覧が持つ検索・絞り込み・並びの規則をここに閉じる。DOM や store に依存しないので
// 単体テストで規則を固定できる。表示コンポーネント(`CommentPanel.vue`)は結果を描くだけ。
import type { NoteKind, PartNoteEntry } from '@editor/shared';

/** 親投稿 1 件とその返信。`lastAt` は親・返信の作成/編集日時の最大値(更新順の並びに使う)。 */
export interface CommentThread {
  parent: PartNoteEntry;
  replies: PartNoteEntry[];
  lastAt: string;
}

export type CommentStatusFilter = 'all' | 'open' | 'resolved';
export type CommentSort = 'updated' | 'part';

export interface CommentFilter {
  /** 本文・投稿者の部分一致。空文字は無条件。 */
  query: string;
  status: CommentStatusFilter;
  /** 空集合は無条件。 */
  kinds: ReadonlySet<NoteKind>;
  /** null は無条件。 */
  author: string | null;
  /** true なら選択中のパーツのスレッドだけ。 */
  onlySelected: boolean;
  sort: CommentSort;
}

/** 既定は「未対応を更新順」— レビューで次に見るべきものが上に来る形。 */
export const DEFAULT_COMMENT_FILTER: CommentFilter = {
  query: '',
  status: 'open',
  kinds: new Set<NoteKind>(),
  author: null,
  onlySelected: false,
  sort: 'updated',
};

export const KIND_LABEL: Record<NoteKind, string> = {
  note: 'メモ',
  'fix-request': '修正依頼',
  question: '質問',
};

function activityAt(e: PartNoteEntry): string {
  return e.updatedAt && e.updatedAt > e.createdAt ? e.updatedAt : e.createdAt;
}

/**
 * 平坦な投稿列をスレッドへ組む。親の無い返信は捨てる — サーバは親の削除で返信も消すので
 * 通常は起きないが、並行操作の狭間で届いた場合に一覧のどこにも置けない。
 */
export function threadsOf(entries: readonly PartNoteEntry[]): CommentThread[] {
  const byParent = new Map<string, CommentThread>();
  const parents = entries.filter((e) => e.replyTo === null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of parents) byParent.set(p.id, { parent: p, replies: [], lastAt: activityAt(p) });
  const replies = entries.filter((e) => e.replyTo !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of replies) {
    const t = byParent.get(r.replyTo as string);
    if (!t) continue;
    t.replies.push(r);
    const at = activityAt(r);
    if (at > t.lastAt) t.lastAt = at;
  }
  return [...byParent.values()];
}

/** 投稿者の一覧(重複除去・出現順)。絞り込みの選択肢に使う。 */
export function authorsOf(entries: readonly PartNoteEntry[]): string[] {
  return [...new Set(entries.map((e) => e.createdBy))];
}

/** 未対応の親投稿を持つ `pathKey` の集合(マーカーの色分けに使う。返信の状態は見ない)。 */
export function openKeysOf(entries: readonly PartNoteEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.replyTo === null && e.status === 'open').map((e) => e.pathKey));
}

function matchesQuery(t: CommentThread, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const all = [t.parent, ...t.replies];
  return all.some((e) => e.content.toLowerCase().includes(q) || e.createdBy.toLowerCase().includes(q));
}

/**
 * 絞り込みと並び。状態・種別・投稿者は**親投稿**で判定する(スレッド 1 本が 1 つの状態・
 * 種別を持つ形)。検索だけは返信の本文も見る(返信に書かれた語で探せないと一覧の意味が薄い)。
 * パーツ順は `partOrder`(canvas の出現順)に従い、無いキーは末尾へ回す。
 */
export function filterThreads(
  threads: readonly CommentThread[],
  filter: CommentFilter,
  ctx: { selectedKey: string | null; partOrder: ReadonlyMap<string, number> },
): CommentThread[] {
  const out = threads.filter((t) => {
    const p = t.parent;
    if (filter.status !== 'all' && p.status !== filter.status) return false;
    if (filter.kinds.size > 0 && !filter.kinds.has(p.kind)) return false;
    if (filter.author !== null && p.createdBy !== filter.author) return false;
    if (filter.onlySelected && p.pathKey !== ctx.selectedKey) return false;
    return matchesQuery(t, filter.query);
  });
  if (filter.sort === 'updated') return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const order = (t: CommentThread) => ctx.partOrder.get(t.parent.pathKey) ?? Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => order(a) - order(b) || a.parent.createdAt.localeCompare(b.parent.createdAt));
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/commentFilter.test.ts`
Expected: PASS

- [ ] **Step 5: coverage include を更新してコミット**

`vitest.config.ts` の include に `'editor/web/src/features/editor/comments/commentFilter.ts'` を
`'editor/web/src/features/editor/usePartNote.ts'` の隣へ足す。

```bash
pnpm exec biome check --write editor/web/src/features/editor/comments/commentFilter.ts editor/web/test/commentFilter.test.ts
git add editor/web/src/features/editor/comments/commentFilter.ts editor/web/test/commentFilter.test.ts vitest.config.ts
git commit -m "feat(editor): コメント一覧のスレッド化・絞り込み・並びを純関数へ切り出す"
```

---

### Task 2: `useComments.ts`(旧 `usePartNote.ts`)— `all` と `openKeys` の公開

**Files:**
- Rename: `editor/web/src/features/editor/usePartNote.ts` → `editor/web/src/features/editor/useComments.ts`
- Rename: `editor/web/test/usePartNote.test.ts` → `editor/web/test/useComments.test.ts`
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts:30,214`(import と呼び出し名)
- Modify: `editor/web/src/features/editor/useCanvasMarkers.ts:42,104`(コメント内の `usePartNote` 参照)
- Modify: `vitest.config.ts`(include のパスを改名)

**Interfaces:**
- Produces: `useComments(templateId, currentKey, repo)` が計画 1 の戻り値に加えて
  `all: Ref<PartNoteEntry[]>`(版の全投稿)と `openKeys: ComputedRef<Set<string>>` を返す。

- [ ] **Step 1: 改名して失敗するテストを足す**

```bash
git mv editor/web/src/features/editor/usePartNote.ts editor/web/src/features/editor/useComments.ts
git mv editor/web/test/usePartNote.test.ts editor/web/test/useComments.test.ts
```

`useComments.test.ts` の import を `import { useComments } from '@/features/editor/useComments';`
に、`usePartNote(` の呼び出しを `useComments(` に置換し、`describe` 名を `'useComments'` にする。
次を足す。

```ts
  it('all は版の全投稿、openKeys は未対応の親を持つパーツだけ', async () => {
    const { repo } = makeRepo();
    const key = ref<string | null>(COVER);
    const c = useComments(() => TPL, () => key.value, repo);
    await c.add('表紙');
    key.value = SUMMARY;
    await c.add('要約');
    await c.setStatus(c.entries.value[0], 'resolved');
    expect(c.all.value).toHaveLength(2);
    expect([...c.notedKeys.value]).toEqual([COVER, SUMMARY]);
    expect([...c.openKeys.value]).toEqual([COVER]);
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/useComments.test.ts`
Expected: FAIL(`useComments` が無い / `openKeys` が無い)

- [ ] **Step 3: 実装する**

`useComments.ts` の見出しコメントを `useComments.ts — パーツ単位コメント(1 段の入れ子スレッド)の
読込/追加/返信/解決/編集/削除 composable` に改め、関数名を `useComments` にする。import に
`openKeysOf` を足し、`notedKeys` の下に置く。

```ts
import { openKeysOf } from './comments/commentFilter';
```

```ts
  /** 未対応の親投稿を持つ pathKey 集合(マーカーの色分け)。 */
  const openKeys = computed<Set<string>>(() => openKeysOf(all.value));
```

戻り値を `{ all, entries, notedKeys, openKeys, canNote, reload, add, reply, setStatus, update, remove }` にする。

`useTemplateEditor.ts` の import を `import { useComments } from './useComments';`、
`const note = usePartNote(` を `const note = useComments(` にする。`useCanvasMarkers.ts` の
コメント 2 箇所の `usePartNote` を `useComments` に改める。`vitest.config.ts` の
`'editor/web/src/features/editor/usePartNote.ts'` を `'editor/web/src/features/editor/useComments.ts'` に。

- [ ] **Step 4: テストと型チェック**

```bash
pnpm exec vitest run --project web editor/web/test/useComments.test.ts
pnpm run typecheck:editor
```

Expected: PASS / 型エラー 0

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/useComments.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/features/editor/useCanvasMarkers.ts editor/web/test/useComments.test.ts
git add -A editor/web/src/features/editor editor/web/test vitest.config.ts
git commit -m "refactor(editor): usePartNote を useComments へ改名し全投稿と未対応キー集合を公開する"
```

---

### Task 3: `CommentPanel.vue` — 右ペインのコメント一覧

**Files:**
- Create: `editor/web/src/features/editor/comments/CommentPanel.vue`
- Test: `editor/web/test/commentPanel.test.ts`
- Modify: `vitest.config.ts`(include に `'editor/web/src/features/editor/comments/CommentPanel.vue'`)

**Interfaces:**
- Consumes: Task 1 の `commentFilter.ts`
- Produces: コンポーネント `CommentPanel`
  - props: `entries: PartNoteEntry[]`、`selectedKey: string | null`、`canAdd: boolean`、
    `partLabels: Map<string, string>`(pathKey → 表示ラベル。`partOrder` は Map の挿入順から導く)、
    `compact?: boolean`(承認画面用に検索欄を 1 行へ畳む。計画 3 で使う)
  - emits: `add: [content: string, kind: NoteKind]`、`reply: [parent: PartNoteEntry, content: string]`、
    `set-status: [parent: PartNoteEntry, status: NoteStatus]`、`update: [entry: PartNoteEntry, content: string]`、
    `remove: [entry: PartNoteEntry]`、`focus: [pathKey: string]`
  - data 属性: 一覧の行は `data-comment-row` と `data-path-key="<pathKey>"` を持つ(e2e が掴む)

- [ ] **Step 1: 失敗するテストを書く**

```ts
// editor/web/test/commentPanel.test.ts
import type { PartNoteEntry } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CommentPanel from '@/features/editor/comments/CommentPanel.vue';

const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';

function entry(p: Partial<PartNoteEntry> & { id: string }): PartNoteEntry {
  return {
    templateId: 'AM01_510037_20240710_交付版',
    pathKey: COVER,
    content: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: '山田',
    updatedAt: null,
    updatedBy: null,
    status: 'open',
    replyTo: null,
    kind: 'note',
    ...p,
  };
}

const partLabels = new Map([
  [COVER, 'ページ1・パーツ1'],
  [SUMMARY, 'ページ1・パーツ2'],
]);

const entries = [
  entry({ id: 'a', content: '表紙の日付を直してください', kind: 'fix-request', createdAt: '2026-09-01T00:00:01.000Z' }),
  entry({ id: 'a-r', replyTo: 'a', content: '直しました', createdBy: '鈴木', createdAt: '2026-09-01T00:00:02.000Z' }),
  entry({ id: 'b', content: '要約の数値は確定ですか', pathKey: SUMMARY, kind: 'question', status: 'resolved', createdAt: '2026-09-01T00:00:03.000Z' }),
];

function mountPanel(extra: Record<string, unknown> = {}) {
  return mount(CommentPanel, {
    props: { entries, selectedKey: COVER, canAdd: true, partLabels, ...extra },
  });
}

describe('CommentPanel', () => {
  it('既定は未対応の親投稿だけを行として出し、返信数とパーツ名を添える', () => {
    const w = mountPanel();
    const rows = w.findAll('[data-comment-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('表紙の日付');
    expect(rows[0].text()).toContain('ページ1・パーツ1');
    expect(rows[0].text()).toContain('返信 1');
  });

  it('状態の絞り込みを「すべて」にすると解決済みも出る', async () => {
    const w = mountPanel();
    await w.find('[data-filter-status]').setValue('all');
    expect(w.findAll('[data-comment-row]')).toHaveLength(2);
  });

  it('検索欄は本文で絞り込む', async () => {
    const w = mountPanel();
    await w.find('[data-filter-status]').setValue('all');
    await w.find('input[type="search"]').setValue('数値');
    const rows = w.findAll('[data-comment-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('要約');
  });

  it('行のクリックで focus(pathKey) を emit する', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row]').trigger('click');
    expect(w.emitted('focus')?.[0]).toEqual([COVER]);
  });

  it('新規入力は選択パーツ宛に種別付きで add を emit し、入力を空へ戻す', async () => {
    const w = mountPanel();
    await w.find('[data-add-kind]').setValue('question');
    const ta = w.find('textarea[data-add-content]');
    await ta.setValue('これは確定値ですか');
    await w.find('button[data-add-submit]').trigger('click');
    expect(w.emitted('add')?.[0]).toEqual(['これは確定値ですか', 'question']);
    expect((ta.element as HTMLTextAreaElement).value).toBe('');
  });

  it('canAdd が false なら入力欄は無効', () => {
    const w = mountPanel({ canAdd: false, selectedKey: null });
    expect((w.find('textarea[data-add-content]').element as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('行を開くと返信と解決の操作が出て emit する', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row] [data-expand]').trigger('click');
    expect(w.text()).toContain('直しました');
    await w.find('[data-resolve]').trigger('click');
    expect(w.emitted('set-status')?.[0]).toEqual([entries[0], 'resolved']);
    await w.find('textarea[data-reply-content]').setValue('ありがとうございます');
    await w.find('button[data-reply-submit]').trigger('click');
    expect(w.emitted('reply')?.[0]).toEqual([entries[0], 'ありがとうございます']);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/commentPanel.test.ts`
Expected: FAIL(コンポーネントが無い)

- [ ] **Step 3: 実装する**

```vue
<script setup lang="ts">
// =============================================================================
// CommentPanel.vue — 右ペインのコメント一覧(検索・絞り込み・新規投稿・返信・解決)
// =============================================================================
// 役割: テンプレート 1 件の全コメントを Adobe Reader のコメントリストと同じ形で出す。
// 新規投稿の入口はここ 1 つ(選択パーツ宛)。スレッド内の操作(返信・解決・編集・削除)は
// 行を開いた中で行い、canvas の吹き出し(`NoteBubble.vue`)と同じ規則で emit する。
// 絞り込み・並びの規則は `commentFilter.ts` に閉じ、ここは描画と入力だけを持つ。
import type { NoteKind, NoteStatus, PartNoteEntry } from '@editor/shared';
import { Check, ChevronDown, ChevronRight, MessageSquare, Pencil, RotateCcw, Trash2 } from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import {
  authorsOf,
  type CommentFilter,
  type CommentThread,
  DEFAULT_COMMENT_FILTER,
  filterThreads,
  KIND_LABEL,
  threadsOf,
} from './commentFilter';

const props = withDefaults(
  defineProps<{
    entries: PartNoteEntry[];
    selectedKey: string | null;
    /** 新規投稿ができるか(選択がコメント対象キーへ解決できるか)。 */
    canAdd: boolean;
    /** pathKey → 表示ラベル。Map の挿入順を canvas の出現順として並びに使う。 */
    partLabels: Map<string, string>;
    /** 承認画面向け: 検索と絞り込みを 1 行に畳む。 */
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  add: [content: string, kind: NoteKind];
  reply: [parent: PartNoteEntry, content: string];
  'set-status': [parent: PartNoteEntry, status: NoteStatus];
  update: [entry: PartNoteEntry, content: string];
  remove: [entry: PartNoteEntry];
  focus: [pathKey: string];
}>();

// ── 1. 絞り込み ──
const filter = reactive<CommentFilter>({ ...DEFAULT_COMMENT_FILTER, kinds: new Set() });
const kindChecked = reactive<Record<NoteKind, boolean>>({ note: false, 'fix-request': false, question: false });
watch(kindChecked, () => {
  filter.kinds = new Set((Object.keys(kindChecked) as NoteKind[]).filter((k) => kindChecked[k]));
});

const threads = computed(() => threadsOf(props.entries));
const authors = computed(() => authorsOf(props.entries));
const partOrder = computed(() => new Map([...props.partLabels.keys()].map((k, i) => [k, i] as const)));
const visible = computed<CommentThread[]>(() =>
  filterThreads(threads.value, filter, { selectedKey: props.selectedKey, partOrder: partOrder.value }),
);
const openCount = computed(() => threads.value.filter((t) => t.parent.status === 'open').length);

function partLabel(key: string): string {
  return props.partLabels.get(key) ?? key;
}

// ── 2. 新規投稿(選択パーツ宛。入口はここだけ) ──
const draft = ref('');
const draftKind = ref<NoteKind>('note');
function submitAdd(): void {
  const text = draft.value.trim();
  if (text === '' || !props.canAdd) return;
  emit('add', draft.value, draftKind.value);
  draft.value = '';
}
// 選択が変わったら下書きを捨てる(別パーツへ書き込む事故を避ける — 右ペインの旧入口と同じ)。
watch(
  () => props.selectedKey,
  () => {
    draft.value = '';
  },
);

// ── 3. 行の展開(返信・解決・編集・削除) ──
const expandedId = ref<string | null>(null);
const replyDraft = ref('');
const editingId = ref<string | null>(null);
const editDraft = ref('');

function toggle(t: CommentThread): void {
  expandedId.value = expandedId.value === t.parent.id ? null : t.parent.id;
  replyDraft.value = '';
  editingId.value = null;
}
function submitReply(t: CommentThread): void {
  if (replyDraft.value.trim() === '') return;
  emit('reply', t.parent, replyDraft.value);
  replyDraft.value = '';
}
function startEdit(e: PartNoteEntry): void {
  editingId.value = e.id;
  editDraft.value = e.content;
}
function commitEdit(e: PartNoteEntry): void {
  if (editDraft.value.trim() !== '') emit('update', e, editDraft.value);
  editingId.value = null;
}
async function requestRemove(e: PartNoteEntry): Promise<void> {
  const ok = await confirm({
    title: e.replyTo === null ? 'このコメントを削除しますか？' : 'この返信を削除しますか？',
    description:
      e.replyTo === null ? '返信も一緒に削除されます。削除したコメントは元に戻せません。' : '削除した返信は元に戻せません。',
    confirmLabel: '削除する',
    variant: 'destructive',
  });
  if (ok) emit('remove', e);
}

function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 新規投稿 -->
    <div class="border-b px-3 py-2.5">
      <div class="mb-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <MessageSquare class="h-3.5 w-3.5" />
        <span class="truncate">{{ selectedKey ? `宛先: ${partLabel(selectedKey)}` : 'パーツを選ぶと書けます' }}</span>
        <span class="flex-1" />
        <select v-model="draftKind" data-add-kind class="comment-select" :disabled="!canAdd" aria-label="種別">
          <option v-for="(label, k) in KIND_LABEL" :key="k" :value="k">{{ label }}</option>
        </select>
      </div>
      <textarea
        v-model="draft"
        data-add-content
        class="comment-area"
        rows="3"
        :disabled="!canAdd"
        placeholder="このパーツへのコメントを書く…"
        @keydown.ctrl.enter="submitAdd"
      />
      <div class="mt-1.5 flex items-center">
        <span class="text-[10.5px] text-muted-foreground">Ctrl + Enter で追加</span>
        <span class="flex-1" />
        <Button size="sm" data-add-submit :disabled="!canAdd || draft.trim() === ''" @click="submitAdd">追加</Button>
      </div>
    </div>

    <!-- 検索・絞り込み -->
    <div class="space-y-1.5 border-b px-3 py-2">
      <input
        v-model="filter.query"
        type="search"
        class="comment-input"
        placeholder="本文・投稿者で検索"
        aria-label="コメントを検索"
      />
      <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
        <select v-model="filter.status" data-filter-status class="comment-select" aria-label="状態">
          <option value="open">未対応</option>
          <option value="resolved">解決済み</option>
          <option value="all">すべて</option>
        </select>
        <select v-model="filter.author" data-filter-author class="comment-select" aria-label="投稿者">
          <option :value="null">投稿者: すべて</option>
          <option v-for="a in authors" :key="a" :value="a">{{ a }}</option>
        </select>
        <select v-model="filter.sort" data-filter-sort class="comment-select" aria-label="並び順">
          <option value="updated">更新順</option>
          <option value="part">パーツ順</option>
        </select>
      </div>
      <div v-if="!compact" class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
        <label v-for="(label, k) in KIND_LABEL" :key="k" class="flex cursor-pointer items-center gap-1">
          <input v-model="kindChecked[k]" type="checkbox" :data-filter-kind="k" /> {{ label }}
        </label>
        <label class="ml-auto flex cursor-pointer items-center gap-1">
          <input v-model="filter.onlySelected" type="checkbox" data-filter-selected /> 選択パーツのみ
        </label>
      </div>
      <div class="text-[10.5px] text-muted-foreground">
        未対応 {{ openCount }} / 全 {{ threads.length }} 件・表示 {{ visible.length }} 件
      </div>
    </div>

    <!-- 一覧 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="visible.length === 0" class="px-3 py-6 text-center text-[12px] text-muted-foreground">
        表示するコメントがありません。
      </p>
      <ul v-else>
        <li
          v-for="t in visible"
          :key="`${t.parent.templateId}/${t.parent.id}`"
          data-comment-row
          :data-path-key="t.parent.pathKey"
          class="cursor-pointer border-b px-3 py-2 hover:bg-muted/40"
          :class="t.parent.pathKey === selectedKey ? 'bg-primary-soft/40' : ''"
          @click="emit('focus', t.parent.pathKey)"
        >
          <div class="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <Badge :variant="t.parent.status === 'open' ? 'warning' : 'secondary'" class="h-[16px] py-0 text-[9.5px]">
              {{ KIND_LABEL[t.parent.kind] }}
            </Badge>
            <span class="truncate">{{ partLabel(t.parent.pathKey) }}</span>
            <span class="flex-1" />
            <span>{{ formatAt(t.lastAt) }}</span>
            <button
              type="button"
              data-expand
              class="rounded p-0.5 hover:bg-muted"
              :aria-label="expandedId === t.parent.id ? '閉じる' : '開く'"
              @click.stop="toggle(t)"
            >
              <ChevronDown v-if="expandedId === t.parent.id" class="h-3.5 w-3.5" />
              <ChevronRight v-else class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="mt-0.5 flex items-baseline gap-1.5 text-[12px]">
            <span class="shrink-0 font-bold">{{ t.parent.createdBy }}</span>
            <span :class="expandedId === t.parent.id ? 'whitespace-pre-wrap break-words' : 'truncate'" class="min-w-0">
              {{ t.parent.content }}
            </span>
          </div>
          <div class="mt-0.5 text-[10.5px] text-muted-foreground">
            <span v-if="t.replies.length">返信 {{ t.replies.length }}</span>
            <span v-if="t.parent.status === 'resolved'" class="ml-1.5">解決済み</span>
          </div>

          <!-- 展開: 返信一覧・返信入力・解決/編集/削除 -->
          <div v-if="expandedId === t.parent.id" class="mt-2 space-y-2" @click.stop>
            <div class="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                data-resolve
                @click="emit('set-status', t.parent, t.parent.status === 'open' ? 'resolved' : 'open')"
              >
                <Check v-if="t.parent.status === 'open'" class="h-3.5 w-3.5" />
                <RotateCcw v-else class="h-3.5 w-3.5" />
                {{ t.parent.status === 'open' ? '解決にする' : '未対応に戻す' }}
              </Button>
              <span class="flex-1" />
              <Button variant="ghost" size="iconSm" aria-label="このコメントを編集" @click="startEdit(t.parent)">
                <Pencil class="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="このコメントを削除" @click="requestRemove(t.parent)">
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
            <template v-if="editingId === t.parent.id">
              <textarea v-model="editDraft" class="comment-area" rows="3" />
              <div class="flex gap-1.5">
                <Button size="sm" @click="commitEdit(t.parent)">保存</Button>
                <Button size="sm" variant="outline" @click="editingId = null">取消</Button>
              </div>
            </template>

            <div v-for="r in t.replies" :key="`${r.templateId}/${r.id}`" class="ml-3 border-l-2 pl-2">
              <div class="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                <span class="font-bold text-foreground">{{ r.createdBy }}</span>
                <span>{{ formatAt(r.createdAt) }}</span>
                <span class="flex-1" />
                <Button variant="ghost" size="iconSm" aria-label="この返信を編集" @click="startEdit(r)">
                  <Pencil class="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="この返信を削除" @click="requestRemove(r)">
                  <Trash2 class="h-3 w-3" />
                </Button>
              </div>
              <template v-if="editingId === r.id">
                <textarea v-model="editDraft" class="comment-area" rows="2" />
                <div class="mt-1 flex gap-1.5">
                  <Button size="sm" @click="commitEdit(r)">保存</Button>
                  <Button size="sm" variant="outline" @click="editingId = null">取消</Button>
                </div>
              </template>
              <p v-else class="whitespace-pre-wrap break-words text-[12px]">
                {{ r.content }}<span v-if="r.updatedAt" class="ml-1 text-[10px] text-muted-foreground">(編集済み)</span>
              </p>
            </div>

            <textarea
              v-model="replyDraft"
              data-reply-content
              class="comment-area"
              rows="2"
              placeholder="返信を書く…"
              @keydown.ctrl.enter="submitReply(t)"
            />
            <div class="flex justify-end">
              <Button size="sm" data-reply-submit :disabled="replyDraft.trim() === ''" @click="submitReply(t)">返信</Button>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* 入力欄は固定 UI スケールで常に読める(キャンバスズーム非依存。Inspector の memo-area と同じ)。 */
.comment-area,
.comment-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--background);
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
}
.comment-area:disabled {
  opacity: 0.5;
}
.comment-select {
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--background);
  padding: 2px 6px;
  font-size: 11px;
}
</style>
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project web editor/web/test/commentPanel.test.ts`
Expected: PASS(`Badge` の `variant` に `warning` が無ければ `Badge.vue` の variants を確認して
既存の名前(`warning` は `TemplateTable.vue` で使用済み)に合わせる)

- [ ] **Step 5: coverage include を更新してコミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/comments/CommentPanel.vue editor/web/test/commentPanel.test.ts
git add editor/web/src/features/editor/comments/CommentPanel.vue editor/web/test/commentPanel.test.ts vitest.config.ts
git commit -m "feat(editor): 右ペイン用のコメント一覧(検索・絞り込み・返信・解決)を追加する"
```

---

### Task 4: 吹き出しの入れ子表示(`NoteBubble.vue`)

**Files:**
- Modify: `editor/web/src/features/editor/NoteBubble.vue`

**Interfaces:**
- Produces: emits に `reply: [parent: PartNoteEntry, content: string]` と
  `'set-status': [parent: PartNoteEntry, status: NoteStatus]` を足す。既存の `update` / `remove` / `close` は据え置き。
  親投稿の行は `data-note-parent`、返信は `data-note-reply` を持つ(e2e が掴む)。

- [ ] **Step 1: 実装する**

`<script setup>` の import に `type NoteStatus` と `Check, MessageSquareReply, RotateCcw` を足し、
`threadsOf` / `KIND_LABEL` を `./comments/commentFilter` から import する。`emit` を次にする。

```ts
const emit = defineEmits<{
  update: [PartNoteEntry, string];
  remove: [PartNoteEntry];
  reply: [PartNoteEntry, string];
  'set-status': [PartNoteEntry, NoteStatus];
  close: [];
}>();

const threads = computed(() => threadsOf(props.entries));
const replyingKey = ref<string | null>(null);
const replyDraft = ref('');
function startReply(parent: PartNoteEntry): void {
  replyingKey.value = entryKey(parent);
  replyDraft.value = '';
}
function commitReply(parent: PartNoteEntry): void {
  if (replyDraft.value.trim() !== '') emit('reply', parent, replyDraft.value);
  replyingKey.value = null;
}
```

`requestRemove` の文言を親なら「返信も一緒に削除されます。」を含む形に変える(`CommentPanel` と同じ)。

`<template>` の `note-bubble-body` を次に置き換える(見出しの「メモ」は「コメント」、件数は
`threads.length`)。

```vue
    <div class="note-bubble-body">
      <div
        v-for="t in threads"
        :key="entryKey(t.parent)"
        class="note-entry"
        :class="t.parent.status === 'resolved' ? 'note-entry-resolved' : ''"
        data-note-parent
      >
        <div class="note-entry-head">
          <span class="note-entry-kind">{{ KIND_LABEL[t.parent.kind] }}</span>
          <span class="note-entry-who">{{ t.parent.createdBy }}</span>
          <span>{{ formatAt(t.parent.createdAt) }}</span>
          <span class="flex-1" />
          <Button
            variant="ghost"
            size="iconSm"
            :aria-label="t.parent.status === 'open' ? '解決にする' : '未対応に戻す'"
            :title="t.parent.status === 'open' ? '解決にする' : '未対応に戻す'"
            @click="emit('set-status', t.parent, t.parent.status === 'open' ? 'resolved' : 'open')"
          >
            <Check v-if="t.parent.status === 'open'" class="h-3 w-3" />
            <RotateCcw v-else class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="iconSm" aria-label="返信する" title="返信する" @click="startReply(t.parent)">
            <MessageSquareReply class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="iconSm" aria-label="このコメントを編集" @click="startEdit(t.parent)">
            <Pencil class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="このコメントを削除" @click="requestRemove(t.parent)">
            <Trash2 class="h-3 w-3" />
          </Button>
        </div>

        <template v-if="editingKey === entryKey(t.parent)">
          <textarea v-model="draft" class="note-entry-input" rows="3" />
          <div class="mt-1.5 flex gap-1.5">
            <Button size="sm" @click="commitEdit(t.parent)">保存</Button>
            <Button size="sm" variant="outline" @click="editingKey = null">取消</Button>
          </div>
        </template>
        <div v-else class="note-entry-body">
          {{ t.parent.content }}
          <span v-if="t.parent.updatedAt" class="note-entry-edited">(編集済み)</span>
          <span v-if="t.parent.status === 'resolved'" class="note-entry-edited">・解決済み</span>
        </div>

        <div v-for="r in t.replies" :key="entryKey(r)" class="note-reply" data-note-reply>
          <div class="note-entry-head">
            <span class="note-entry-who">{{ r.createdBy }}</span>
            <span>{{ formatAt(r.createdAt) }}</span>
            <span class="flex-1" />
            <Button variant="ghost" size="iconSm" aria-label="この返信を編集" @click="startEdit(r)">
              <Pencil class="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="この返信を削除" @click="requestRemove(r)">
              <Trash2 class="h-3 w-3" />
            </Button>
          </div>
          <template v-if="editingKey === entryKey(r)">
            <textarea v-model="draft" class="note-entry-input" rows="2" />
            <div class="mt-1.5 flex gap-1.5">
              <Button size="sm" @click="commitEdit(r)">保存</Button>
              <Button size="sm" variant="outline" @click="editingKey = null">取消</Button>
            </div>
          </template>
          <div v-else class="note-entry-body">
            {{ r.content }}
            <span v-if="r.updatedAt" class="note-entry-edited">(編集済み)</span>
          </div>
        </div>

        <template v-if="replyingKey === entryKey(t.parent)">
          <textarea v-model="replyDraft" class="note-entry-input mt-1.5" rows="2" placeholder="返信を書く…" data-bubble-reply />
          <div class="mt-1.5 flex gap-1.5">
            <Button size="sm" @click="commitReply(t.parent)">返信</Button>
            <Button size="sm" variant="outline" @click="replyingKey = null">取消</Button>
          </div>
        </template>
      </div>
    </div>
```

`<style scoped>` に足す。

```css
.note-entry-kind {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--warning);
  color: #fff;
  font-size: 9.5px;
  font-weight: 700;
}
.note-entry-resolved .note-entry-kind {
  background: var(--secondary);
  color: var(--muted-foreground);
}
.note-entry-resolved .note-entry-body {
  color: var(--muted-foreground);
}
.note-reply {
  margin: 6px 0 0 10px;
  padding-left: 8px;
  border-left: 2px solid var(--border);
}
```

`editionOf` と `note-entry-edition` は使わなくなるので削除する(ペア共有の廃止で版種表示は不要)。
`parseTemplateFileName` の import も外す。

- [ ] **Step 2: 型チェック**

Run: `pnpm run typecheck:editor`
Expected: `EditorView.vue` が新 emit を受けていないだけの警告は無い(未使用 emit は許される)。型エラー 0。

- [ ] **Step 3: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/NoteBubble.vue
git add editor/web/src/features/editor/NoteBubble.vue
git commit -m "feat(editor): 吹き出しを親と返信の入れ子表示にし返信と解決の操作を足す"
```

---

### Task 5: `useTemplateEditor.ts` — パーツへの移動と公開 API

**Files:**
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts:214-226, 490-500`

**Interfaces:**
- Produces(戻り値に追加):
  - `allNotes: Ref<PartNoteEntry[]>`(`note.all`)、`openNoteKeys: ComputedRef<Set<string>>`(`note.openKeys`)
  - `currentNoteKeyRef: ComputedRef<string | null>`(選択パーツのキー)
  - `replyNote: (parent, content) => Promise<void>`、`setNoteStatus: (parent, status) => Promise<void>`
  - `selectPartByKey(key: string): void` — pathKey のパーツを GrapesJS で選択し、1 ページ表示なら
    そのページへ送り、canvas をスクロールして見えるようにする

- [ ] **Step 1: 実装する**

`const note = useComments(...)` の下に足す。

```ts
  /** 選択パーツのキー(右ペインのコメント一覧へ渡す。選択・編集で再評価)。 */
  const currentNoteKeyRef = computed<string | null>(() => {
    void g.selected.value;
    void g.revision.value;
    return currentNoteKey();
  });

  /**
   * コメント一覧の行から、そのパーツを canvas 上で選択して見えるようにする。
   * pathKey は版内で安定な構造キーなので、現在ページ列から同じキーの要素を探して選ぶ。
   * 1 ページ表示中は当該ページへ送ってから選ぶ(非表示ページの要素は `getElementPos` が 0 を
   * 返し、選択枠が崩れる)。要素 → component の解決は GrapesJS が live 要素へ付ける id を
   * `Components.getById` で引く。見つからなければ何もしない(コメントは残り、行は押せる)。
   */
  function selectPartByKey(key: string): void {
    const ed = g.editor.value;
    const root = canvasRoot();
    if (!ed || !root) return;
    const pages = g.pageEls.value;
    for (let pi = 0; pi < pages.length; pi += 1) {
      for (const part of partEls(pages[pi])) {
        if (partPathKeyFor(part, root) !== key) continue;
        if (g.singlePageMode.value) g.goToPage(pi);
        const comp = part.id ? ed.Components.getById(part.id) : undefined;
        if (comp) ed.select(comp);
        part.scrollIntoView({ block: 'center' });
        return;
      }
    }
  }
```

import に `partEls` を足す(`import { partEls, partLabelMap, partPathKeyFor } from './partKey';` —
既存の import 行に合わせる)。戻り値に次を足す。

```ts
    allNotes: note.all,
    openNoteKeys: note.openKeys,
    currentNoteKey: currentNoteKeyRef,
    replyNote: note.reply,
    setNoteStatus: note.setStatus,
    selectPartByKey,
```

- [ ] **Step 2: 型チェックとガード**

```bash
pnpm run typecheck:editor
pnpm exec vitest run --project web editor/web/test/twoSystems.guard.test.ts
```

Expected: 型エラー 0 / PASS

- [ ] **Step 3: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/useTemplateEditor.ts
git add editor/web/src/features/editor/useTemplateEditor.ts
git commit -m "feat(editor): コメント一覧からパーツを選択して表示する橋渡しを足す"
```

---

### Task 6: 右ペインの切替(`Inspector.vue`)と `EditorView.vue` の配線

**Files:**
- Modify: `editor/web/src/features/editor/Inspector.vue`(props / emit / 頭 / メモ追加セクション撤去)
- Modify: `editor/web/src/features/editor/EditorView.vue`(切替状態・`CommentPanel`・マーカー・吹き出し emit)

**Interfaces:**
- Consumes: Task 3 の `CommentPanel`、Task 4 の `NoteBubble` emit、Task 5 の公開 API
- Produces: `Inspector` の props に `paneTab: 'props' | 'comments'` と `commentCount: number` を足し、
  `noteCount` / `canNote` / `'add-note'` を外す。emit に `'pane-tab': ['props' | 'comments']`。
  `paneTab === 'comments'` のとき本体の代わりに `<slot name="comments" />` を描く。

- [ ] **Step 1: `Inspector.vue` を直す**

props から `noteCount` / `canNote` を消し、次を足す。

```ts
  /** 右ペインの表示(プロパティ / コメント)。切替の状態は `EditorView` が持つ。 */
  paneTab: 'props' | 'comments';
  /** 未対応コメントの件数(切替タブのバッジ)。 */
  commentCount: number;
```

emit から `'add-note'` を消し `'pane-tab': ['props' | 'comments']` を足す。
`// ── 2b. メモの追加 ──` のブロック(`noteDraft` / `submitNote` / 選択変更の watch)を削除し、
`<template>` の「メモの追加」`InspectorSection` を削除する。`StickyNote` の import を外し、
`MessageSquare` を足す。`.memo-area` のスタイルを削除する。

頭の `<div class="flex h-[46px] …">` を次に置き換える。

```vue
    <div class="flex h-[46px] shrink-0 items-center gap-1 border-b px-2 text-[12.5px] font-bold">
      <button
        type="button"
        class="pane-tab"
        :class="paneTab === 'props' ? 'pane-tab-active' : ''"
        data-pane-tab="props"
        @click="emit('pane-tab', 'props')"
      >
        プロパティ
      </button>
      <button
        type="button"
        class="pane-tab"
        :class="paneTab === 'comments' ? 'pane-tab-active' : ''"
        data-pane-tab="comments"
        @click="emit('pane-tab', 'comments')"
      >
        <MessageSquare class="h-3.5 w-3.5" /> コメント
        <Badge v-if="commentCount > 0" variant="warning" class="h-[16px] py-0 text-[9.5px]">{{ commentCount }}</Badge>
      </button>
      <span class="flex-1" />
      <Badge v-if="paneTab === 'props' && selected && !editMode" variant="secondary" class="h-[19px] gap-1 py-0">
        <Eye class="h-[11px] w-[11px]" /> 表示のみ
      </Badge>
      <Tooltip text="右パネルを畳む">
        <Button variant="ghost" size="iconSm" class="text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="右パネルを畳む" @click="emit('collapse')">
          <PanelRightClose class="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>

    <slot v-if="paneTab === 'comments'" name="comments" />

    <!-- 未選択 -->
    <div v-else-if="!selected || !geom" …(既存)
```

既存の `<template v-else>`(選択時の本体)はそのまま。`<style scoped>` に足す。

```css
.pane-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--muted-foreground);
}
.pane-tab:hover {
  background: var(--muted);
}
.pane-tab-active {
  color: var(--foreground);
  background: var(--primary-soft);
}
```

- [ ] **Step 2: `EditorView.vue` を直す**

`useTemplateEditor()` の分割代入に `allNotes, openNoteKeys, currentNoteKey, replyNote, setNoteStatus, selectPartByKey, partLabels` を足す(`partLabels` は既に `Inspector` へ渡しているので既存)。
`import CommentPanel from './comments/CommentPanel.vue';` を足す。

```ts
// ── 右ペインの表示(プロパティ / コメント)。編集セッションをまたいで保持しない(画面ごと) ──
const paneTab = ref<'props' | 'comments'>('props');
const openCommentCount = computed(() => openNoteKeys.value.size);

/** コメント一覧の行 → そのパーツを選択して見せる。吹き出しも開き直す。 */
function focusPart(key: string): void {
  selectPartByKey(key);
  bubbleClosed.value = false;
}
```

`<Inspector …>` の props を次に変える(`:note-count` / `:can-note` / `@add-note` を消す)。

```vue
      <Inspector
        v-else
        :selected="g.selected.value"
        :part="selectedPart"
        :geom="selectedGeom"
        :history="displayHistory"
        :part-labels="partLabels"
        :pane-tab="paneTab"
        :comment-count="openCommentCount"
        :edit-mode="allowEdit"
        :can-up="g.canMoveUp.value"
        :can-down="g.canMoveDown.value"
        @apply="applyGeom"
        @move="moveSelected($event)"
        @reset="resetGeom"
        @del="deletePart"
        @pane-tab="paneTab = $event"
        @collapse="rightCollapsed = true"
      >
        <template #comments>
          <CommentPanel
            :entries="allNotes"
            :selected-key="currentNoteKey"
            :can-add="canNote"
            :part-labels="partLabels"
            @add="(content, kind) => addNote(content, { kind })"
            @reply="replyNote"
            @set-status="setNoteStatus"
            @update="updateNote"
            @remove="removeNote"
            @focus="focusPart"
          />
        </template>
      </Inspector>
```

`<NoteBubble …>` に `@reply="replyNote"` と `@set-status="setNoteStatus"` を足す。マーカーを次に変える。

```vue
          <div
            v-for="m in g.noteMarkers.value"
            :key="m.key"
            class="note-marker"
            :class="openNoteKeys.has(m.key) ? '' : 'note-marker-resolved'"
            :title="openNoteKeys.has(m.key) ? '未対応のコメントあり' : 'コメントあり(解決済み)'"
            :style="{ left: `${m.left}px`, top: `${m.top}px` }"
          >
            <StickyNote class="h-3 w-3" />
          </div>
```

`<style scoped>` の `.note-marker` の下に足す。

```css
/* 全部解決済みのパーツは灰色で残す(「見た」ことは分かるが、次に見るべき場所ではない)。 */
.note-marker-resolved {
  background: var(--muted-foreground);
}
```

`useTemplateEditor` の戻り値名 `addNote` は `note.add` で `(content, opts?)` を受けるので
`CommentPanel` の `add` をそのまま渡せる(上の `@add` のとおり)。

- [ ] **Step 3: 型チェック・単体・e2e スモーク**

```bash
pnpm run typecheck:editor
pnpm run test:editor
pnpm exec playwright test -c editor/playwright.config.ts editor/e2e/note_bubble.spec.ts editor/e2e/canvas.spec.ts
```

Expected: 全て PASS。`note_bubble.spec.ts` の `getByPlaceholder('このパーツへのメモを書く')` は
入口が `CommentPanel` へ移ったため落ちる → Task 7 で spec を直すので、この時点では
`note_bubble.spec.ts` の失敗だけ許容し、Task 7 で緑にする。

- [ ] **Step 4: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/Inspector.vue editor/web/src/features/editor/EditorView.vue
git add editor/web/src/features/editor/Inspector.vue editor/web/src/features/editor/EditorView.vue
git commit -m "feat(editor): 右ペインにコメントタブを置き一覧・吹き出し・マーカーを結線する"
```

---

### Task 7: e2e — 吹き出しの返信・解決とコメント一覧

**Files:**
- Modify: `editor/e2e/note_bubble.spec.ts`
- Create: `editor/e2e/comment_panel.spec.ts`

- [ ] **Step 1: `note_bubble.spec.ts` を新入口へ合わせる**

`draft` / `addButton` を次に変える(右ペインの「コメント」タブを先に押す)。

```ts
  const panelTab = page.locator('[data-pane-tab="comments"]');
  const draft = page.getByPlaceholder('このパーツへのコメントを書く');
  const addButton = page.locator('button[data-add-submit]');
```

パーツ A をクリックした直後に `await panelTab.click();` を挟む。以後の期待値の「メモ」文言は
「コメント」に合わせる(見出し `メモ` → `コメント`、`aria-label` の `このメモを編集` →
`このコメントを編集`、`このメモを削除` → `このコメントを削除`)。テストの末尾に足す。

```ts
test('吹き出しから返信と解決ができ、マーカーが灰色になる', async ({ page }) => {
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(3000);

  const frame = page.frameLocator('iframe.gjs-frame');
  const part = frame.locator('.page > *').nth(4);
  await part.waitFor({ state: 'visible', timeout: 30_000 });
  await part.click();
  await page.waitForTimeout(600);
  await page.locator('[data-pane-tab="comments"]').click();
  await page.getByPlaceholder('このパーツへのコメントを書く').fill('親コメント');
  await page.locator('button[data-add-submit]').click();
  await page.waitForTimeout(800);

  const bubble = page.locator('.note-bubble');
  await expect(bubble).toBeVisible();
  await bubble.getByRole('button', { name: '返信する' }).click();
  await bubble.locator('[data-bubble-reply]').fill('返信です');
  await bubble.getByRole('button', { name: '返信', exact: true }).click();
  await page.waitForTimeout(800);
  await expect(bubble.locator('[data-note-reply]')).toHaveCount(1);

  await bubble.getByRole('button', { name: '解決にする' }).click();
  await page.waitForTimeout(800);
  await expect(page.locator('.note-marker.note-marker-resolved')).toHaveCount(1);
  await expect(bubble.getByRole('button', { name: '未対応に戻す' })).toBeVisible();
});
```

- [ ] **Step 2: `comment_panel.spec.ts` を書く**

```ts
// =============================================================================
// comment_panel.spec.ts — 右ペインのコメント一覧が検索・絞り込み・パーツ移動を実際に行うことの回帰網
// =============================================================================
// 一覧は右ペイン(overlay 層の外)にあるので pointer-events の罠は無いが、行クリックが
// GrapesJS の選択と 1 ページ表示のページ送りまで届くかは実機でしか分からない。ここで押さえる。
import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  await page.waitForTimeout(800);
}

async function addComment(page: Page, partIndex: number, text: string): Promise<void> {
  const frame = page.frameLocator('iframe.gjs-frame');
  const part = frame.locator('.page > *').nth(partIndex);
  await part.waitFor({ state: 'visible', timeout: 30_000 });
  await part.click();
  await page.waitForTimeout(600);
  await page.getByPlaceholder('このパーツへのコメントを書く').fill(text);
  await page.locator('button[data-add-submit]').click();
  await page.waitForTimeout(800);
}

test('コメント一覧は検索・状態で絞り込め、行クリックでパーツを選択する', async ({ page }) => {
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(3000);
  await page.locator('[data-pane-tab="comments"]').click();

  await addComment(page, 2, '表紙の日付');
  await addComment(page, 4, '要約の数値');

  const rows = page.locator('[data-comment-row]');
  await expect(rows).toHaveCount(2);

  await page.getByLabel('コメントを検索').fill('数値');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('要約の数値');
  await page.getByLabel('コメントを検索').fill('');

  // 1 件目を解決すると既定(未対応)の一覧から消え、「すべて」で戻る。
  await rows.filter({ hasText: '表紙の日付' }).locator('[data-expand]').click();
  await page.locator('[data-resolve]').click();
  await page.waitForTimeout(800);
  await expect(rows).toHaveCount(1);
  await page.locator('[data-filter-status]').selectOption('all');
  await expect(rows).toHaveCount(2);

  // 行クリックで別パーツが選択され、吹き出しがそのパーツのスレッドを出す。
  await rows.filter({ hasText: '表紙の日付' }).click();
  await page.waitForTimeout(800);
  await expect(page.locator('.note-bubble')).toContainText('表紙の日付');
  await expect(page.locator('.note-bubble')).not.toContainText('要約の数値');
});
```

- [ ] **Step 3: e2e を通す**

Run: `pnpm exec playwright test -c editor/playwright.config.ts editor/e2e/note_bubble.spec.ts editor/e2e/comment_panel.spec.ts`
Expected: PASS(パーツの index `2` / `4` に投稿できない場合は `.page > *` の子要素の index を
`note_bubble.spec.ts` と同じ `4` と別の要素(例 `6`)に変える。同じ index を 2 回使わない)

- [ ] **Step 4: フル CI 相当を通してコミット**

```bash
pnpm run test:editor
pnpm exec biome check --write editor/e2e/note_bubble.spec.ts editor/e2e/comment_panel.spec.ts
git add editor/e2e/note_bubble.spec.ts editor/e2e/comment_panel.spec.ts
git commit -m "test(editor): コメント一覧と吹き出しの返信・解決を e2e で固定する"
```

---

### Task 8: 設計正典と手引きの「コメント」記述

**Files:**
- Modify: `docs/editor/src/設計正典.md`(「メモの表示はキャンバスの吹き出し、追加は右ペイン」の段落)
- Modify: `docs/editor/src/操作手順書.md`(編集画面のメモに関する節。`grep -n "メモ" docs/editor/src/操作手順書.md` で位置を確認する)

- [ ] **Step 1: 設計正典の段落を書き換える**

「**メモの表示はキャンバスの吹き出し、追加は右ペイン**」で始まる段落を次に置き換える。

```markdown
- **コメントの一覧は右ペイン、スレッドの表示はキャンバスの吹き出し**: 右ペインは
  「プロパティ | コメント」の切替を持ち、コメント側(`features/editor/comments/CommentPanel.vue`)
  はテンプレート全体のコメントを一覧にする(検索 = 本文・投稿者 / 絞り込み = 状態・種別・
  投稿者・選択パーツ / 並び = 更新順・パーツ順。規則は `commentFilter.ts` の純関数)。
  新規投稿の入口は一覧の上の入力欄 1 つ(選択パーツ宛)で、返信・解決・編集・削除はスレッドに
  属する操作として吹き出しと一覧の行展開の両方に置く。一覧の行クリックはそのパーツを
  `selectPartByKey` で選択して canvas をスクロールする。吹き出しは**常にページへ重ねて出す**
  (表計算ソフトのセルコメントと同じ挙動)。左右どちらへ出すかは、吹き出しが帳票の上に
  重なる量が少ない側で選ぶ。**ページの大きさ・倍率は変えない** — ページの見えは PDF の見えと
  一致している必要があり、注釈の都合で本体を縮めない。配置計算は
  `web/src/features/editor/noteBubbleLayout.ts` の純関数。マーカーは未対応の親投稿があれば
  琥珀、全部解決済みなら灰色。
```

- [ ] **Step 2: 手引きの編集画面の節を直す**

「メモ」の操作を説明している箇所を「コメント」へ改め、次の操作を足す(既存の文体に合わせる):
右ペインの「コメント」タブ、種別の選択(メモ / 修正依頼 / 質問)、検索と絞り込み、行クリックで
パーツへ移動、吹き出しの「返信する」「解決にする」。「交付版と全体版で共有」の記述は削る。

- [ ] **Step 3: docs を再生成してコミット**

```bash
py -3.13 docs/_build/build_all.py --project editor
git add docs/editor/src/設計正典.md docs/editor/src/操作手順書.md docs/editor/editor_手引き.html docs/editor/editor_設計.html
git commit -m "docs(editor): コメント一覧と吹き出しの操作を設計正典と手引きへ写す"
```

(スクリーンショットの再撮影は計画 3 の最後にまとめて行う。ここでは文章だけ。)

---

## 計画の自己レビュー

- spec 4.1(一覧・入口・検索・絞り込み・並び・行クリック・幅)は Task 1・3・6。4.2(吹き出しの
  入れ子)は Task 4。4.3(マーカー)は Task 6。4.4(`useComments`)は Task 2。7 章の
  `commentFilter` 単体・`note_bubble` 拡張・`comment_panel` e2e は Task 1・7。
- `CommentPanel` の emit 名(`add` / `reply` / `set-status` / `update` / `remove` / `focus`)と
  `EditorView` の `@…` は一致。`useTemplateEditor` の公開名(`allNotes` / `openNoteKeys` /
  `currentNoteKey` / `replyNote` / `setNoteStatus` / `selectPartByKey`)は Task 5・6 で一致。
- `Inspector` から外した `noteCount` / `canNote` / `add-note` を `EditorView` が渡していないこと
  (Task 6 Step 2)。
- `Badge` の `variant="warning"` は `TemplateTable.vue` で既に使われている。
