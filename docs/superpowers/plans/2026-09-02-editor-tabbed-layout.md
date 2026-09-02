# editor: 編集・プレビュー画面のタブ内展開とヘッダ帯の 1 行統合 — 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 編集・プレビュー画面を `MainLayout` の子ルートにしてアプリヘッダとタブの下に展開し、アプリヘッダとタブを 1 行 56px に統合し、編集セッションを「ブラウザタブの寿命」に揃える。

**Architecture:** ルートの子化（URL は不変）で画面遷移コードを触らずにタブ内展開を実現する。`MainLayout` を `h-screen` の内側スクロールへ変え、編集・プレビューは `route.meta.flush` で余白を落とし `h-full` で全高を使う。タブ点灯は純関数 `tabOf` に集約し、タブ復帰は Pinia ストア `tabMemory` が直前の `fullPath` を覚える。下書きの所属は `sessionStorage` のトークンで判定し、別タブが残した下書きは次回オープン時に破棄する。

**Tech Stack:** Vue 3 / vue-router 4 / Pinia / Tailwind / Vitest（jsdom）/ Playwright

**Spec:** `docs/superpowers/specs/2026-09-02-editor-tabbed-layout-design.md`

## Global Constraints

- 本文の最大幅は全画面で `max-w-[1760px]`（旧 1400px は下限要件。狭めない）。
- ヘッダ帯は 1 行 56px。ロゴ（アイコン + `RET` + 「Report Edit Tool」）は**何も落とさない**。ロゴとタブ群の間は `gap-8`（32px）以上、タブ群と右端は `ml-auto`。
- タブの見た目（`RouterLink` の class・グループ区切り・承認待ち件数バッジ）は現行を保つ。
- 編集 2 系統の原則: 経路判定の根拠は `route.query.created === '1'` のみ。`tabOf` はそれをタブ点灯へ写すだけで、値の差込やハイライトには関与しない。
- 編集セッションはブラウザタブの寿命。タブ遷移・プレビュー往復・リロードでは破棄しない。閉じた後の再オープンで下書きを破棄する。明示的な「編集を破棄」導線は置かない。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write editor/<対象>` を先行実行する（lint-staged のステージ入れ替わり事故の回避）。
- コメントは `docs/コメント規約.md` に従う（なぜを書く / 日本語散文 + 英語ドメイン用語 / 100 桁）。
- コミットメッセージ末尾に `Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3` を付ける。
- 単体テストは repo ルートで `pnpm vitest run --project web editor/web/test/<file>` で実行する。e2e は `pnpm exec playwright test -c editor/playwright.config.ts <spec 名>`（dev サーバは config の `webServer` が自動起動、起動済みなら再利用）。型検査は `pnpm typecheck:editor`。

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `editor/e2e/header_layout.spec.ts`（修正） | EditorTopBar と アプリヘッダの 1 行検証。測定対象を明示セレクタで選ぶ |
| `editor/web/src/features/layout/tabOf.ts`（新規） | ルート → タブ名の純関数写像 |
| `editor/web/src/stores/tabMemory.ts`（新規） | タブごとの「直前に見ていた画面」の記憶 |
| `editor/web/src/features/layout/MainLayout.vue`（修正） | 1 行ヘッダ / `h-screen` シェル / `flush` 余白 / タブ復帰 |
| `editor/web/src/router/index.ts`（修正） | `editor` / `preview` の子化と `meta.flush` |
| `editor/web/src/features/editor/EditorView.vue`・`features/preview/PreviewView.vue`（修正） | root を `h-full` へ |
| `editor/web/src/lib/storageKeys.ts`（修正） | `draftOwnerKey()`（ユーザースコープ付き） |
| `editor/web/src/lib/draftOwner.ts`（新規） | セッショントークンと下書きの所属 |
| `editor/web/src/features/editor/services/templateEditorService.ts`（修正） | オープン時の所属判定と破棄、autosave 時の所属記録 |
| `editor/web/src/features/editor/useTemplateEditor.ts`（修正） | 離脱ガードから破棄確認を撤去、`beforeunload` の条件 |
| `editor/web/src/api/local/store.ts`・`stores/auth.ts`（修正） | 所属キーの後片付け |
| `editor/e2e/tabbed_layout.spec.ts`（新規） | タブ内展開・タブ復帰・セッション生存の実画面検証 |
| `vitest.config.ts`（ルート・修正） | coverage include に新規 3 ファイルを追加 |
| `docs/editor/src/設計正典.md`・`設計書.md`（修正） | 最大幅の 2 値化、セッション規則、タブ点灯写像、ルート構成 |

---

### Task 1: `header_layout.spec.ts` の測定対象を EditorTopBar に限定する

子化するとアプリヘッダも `header` 要素になり、`document.querySelector('header')` がアプリヘッダを掴んで **別要素を測って緑のまま通る**。着手前にセレクタを固定する。

**Files:**
- Modify: `editor/e2e/header_layout.spec.ts:33-75`

**Interfaces:**
- Produces: `headerRows(page, selector)`（後続 Task 5 がアプリヘッダの測定に同じ関数を使う）、定数 `TOP_BAR`。

- [ ] **Step 1: 測定関数をセレクタ引数付きに書き換え、既存 2 テストを `TOP_BAR` で測るようにする**

`editor/e2e/header_layout.spec.ts` の 33〜75 行を次に置き換える:

```ts
/**
 * 編集画面の上部バー(`EditorTopBar.vue`)。アプリヘッダ(`MainLayout.vue`)も `header` 要素
 * なので、素の `header` では先頭のアプリヘッダを掴んで別要素を測ってしまう。上部バーだけが
 * 持つ「一覧へ戻る」で選ぶ。
 */
const TOP_BAR = 'header:has([aria-label="一覧へ戻る"])';

/**
 * `selector` が指す要素の子要素が何行に分かれているか。判定に上端でなく**中心の y**を
 * 使うのは、右ゾーンを押しやるスペーサー(`<span class="flex-1" />`)が高さゼロで、上端だと
 * 同じ行にいても他の要素と 20px 以上ずれるため。
 */
async function headerRows(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const header = document.querySelector(sel);
    if (!header) return -1;
    const centers = Array.from(header.children).map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const base = Math.min(...centers);
    return new Set(centers.map((y) => Math.round((y - base) / 20))).size;
  }, selector);
}

async function openLongNameEditor(page: Page) {
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(LONG_NAME_ID)}`, { waitUntil: 'commit' });
  await page.frameLocator('iframe.gjs-frame').locator('.page').first().waitFor({ timeout: 30_000 });
}

test('1440px: 長いファンド名でもヘッダが 1 行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongNameEditor(page);
  // この幅では保存状態の文言は出ない(アイコンのみ)。出すと必ず溢れる。
  await expect(page.locator(`${TOP_BAR} [role="status"] span`).last()).toBeHidden();
  expect(await headerRows(page, TOP_BAR)).toBe(1);
});

test('1600px: 保存状態の文言が出る幅でもヘッダが 1 行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openLongNameEditor(page);
  await expect(page.locator(`${TOP_BAR} [role="status"] span`).last()).toBeVisible();
  await page.evaluate(
    ([sel, status]) => {
      const label = document.querySelector(`${sel} [role="status"] span:last-child`);
      if (label) label.textContent = status;
    },
    [TOP_BAR, LONGEST_STATUS] as const,
  );
  await expect(page.locator(`${TOP_BAR} [role="status"]`)).toContainText(LONGEST_STATUS);
  expect(await headerRows(page, TOP_BAR)).toBe(1);
});
```

- [ ] **Step 2: e2e を実行して緑のままであることを確認する**

Run: `pnpm exec playwright test -c editor/playwright.config.ts header_layout`
Expected: 2 passed（現行のフルスクリーン編集画面でも `TOP_BAR` は一意に一致する）

- [ ] **Step 3: セレクタが実際に EditorTopBar を選んでいることを確認する（誤選択の検出）**

一時的に `TOP_BAR` を `'header:has([aria-label="存在しない"])'` に変えて実行し、`headerRows` が `-1` を返して失敗することを確認してから戻す。

Run: `pnpm exec playwright test -c editor/playwright.config.ts header_layout`
Expected: 2 failed（`expect(-1).toBe(1)`）→ 戻して 2 passed

- [ ] **Step 4: コミット**

```bash
pnpm exec biome check --write editor/e2e/header_layout.spec.ts
git add editor/e2e/header_layout.spec.ts
git commit -F - <<'EOF'
test(editor): ヘッダ 1 行検証の測定対象を上部バーの明示セレクタで選ぶ

編集画面を MainLayout の子にするとアプリヘッダも header 要素になり、素の
`querySelector('header')` は別要素を測って緑のまま通る。「一覧へ戻る」を持つ header に
限定し、測定関数はセレクタを受け取る形にする。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 2: `tabOf` — ルート → タブ名の写像

**Files:**
- Create: `editor/web/src/features/layout/tabOf.ts`
- Test: `editor/web/test/tabOf.test.ts`
- Modify: `editor/web/test/twoSystems.guard.test.ts`（末尾に describe を追加）
- Modify: `vitest.config.ts`（ルート。coverage include）

**Interfaces:**
- Produces:
  ```ts
  export type TabName = 'edit' | 'create' | 'reviews' | 'merge' | 'compare' | 'history';
  export interface TabRouteLike { name?: RouteRecordName | null; query: LocationQuery }
  export function tabOf(route: TabRouteLike): TabName | null;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/tabOf.test.ts`:

```ts
// =============================================================================
// tabOf.test.ts — ルート → 上部ナビのタブ名の写像
// =============================================================================
import { describe, expect, it } from 'vitest';
import { tabOf } from '@/features/layout/tabOf';

describe('tabOf', () => {
  it('タブ画面そのものは自分の名前に写す', () => {
    expect(tabOf({ name: 'edit', query: {} })).toBe('edit');
    expect(tabOf({ name: 'create', query: {} })).toBe('create');
    expect(tabOf({ name: 'reviews', query: {} })).toBe('reviews');
    expect(tabOf({ name: 'merge', query: {} })).toBe('merge');
    expect(tabOf({ name: 'compare', query: {} })).toBe('compare');
    expect(tabOf({ name: 'history', query: {} })).toBe('history');
  });

  it('編集・プレビュー画面は query なしなら「編集」、?created=1 なら「テンプレート作成」', () => {
    expect(tabOf({ name: 'editor', query: {} })).toBe('edit');
    expect(tabOf({ name: 'preview', query: {} })).toBe('edit');
    expect(tabOf({ name: 'editor', query: { created: '1' } })).toBe('create');
    expect(tabOf({ name: 'preview', query: { created: '1' } })).toBe('create');
    // '1' 以外の値は作成経路ではない(経路判定は厳密一致)
    expect(tabOf({ name: 'editor', query: { created: 'true' } })).toBe('edit');
  });

  it('精査画面は「承認」に属する', () => {
    expect(tabOf({ name: 'review-detail', query: {} })).toBe('reviews');
  });

  it('タブを持たない画面は null', () => {
    expect(tabOf({ name: 'admin', query: {} })).toBeNull();
    expect(tabOf({ name: 'login', query: {} })).toBeNull();
    expect(tabOf({ name: undefined, query: {} })).toBeNull();
    expect(tabOf({ name: Symbol('x'), query: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm vitest run --project web editor/web/test/tabOf.test.ts`
Expected: FAIL（`@/features/layout/tabOf` が解決できない）

- [ ] **Step 3: 実装する**

`editor/web/src/features/layout/tabOf.ts`:

```ts
// =============================================================================
// tabOf.ts — ルートから点灯すべき上部ナビのタブ名への写像
// =============================================================================
import type { LocationQuery, RouteRecordName } from 'vue-router';

/** 上部ナビのタブ名(`MainLayout.vue` の `tabs` と同じ集合)。 */
export type TabName = 'edit' | 'create' | 'reviews' | 'merge' | 'compare' | 'history';

const TAB_NAMES: ReadonlySet<string> = new Set<TabName>([
  'edit',
  'create',
  'reviews',
  'merge',
  'compare',
  'history',
]);

/** 写像に必要なルート情報の最小形(`RouteLocationNormalized` が構造的に満たす)。 */
export interface TabRouteLike {
  name?: RouteRecordName | null;
  query: LocationQuery;
}

/**
 * ルートを上部ナビのタブへ写す。編集・プレビュー画面は作成経路(`?created=1`)なら
 * 「テンプレート作成」、でなければ「編集」に属する。経路判定の根拠は 2 系統の原則どおり
 * `route.query.created === '1'` だけで、ここはそれを表示上のタブ点灯へ写すだけ(値の差込や
 * ハイライトの出し分けには関与しない — 設計正典「編集 2 系統」)。精査画面は「承認」に属する。
 * タブを持たない画面(管理者・ログインなど)は null。
 * タブ点灯とタブ復帰の記録キー(`stores/tabMemory.ts`)の両方がこの関数を使い、判定を
 * 2 か所に書かない。
 */
export function tabOf(route: TabRouteLike): TabName | null {
  const name = typeof route.name === 'string' ? route.name : null;
  if (name === 'editor' || name === 'preview') {
    return route.query.created === '1' ? 'create' : 'edit';
  }
  if (name === 'review-detail') return 'reviews';
  return name !== null && TAB_NAMES.has(name) ? (name as TabName) : null;
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/tabOf.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 2 系統ガードに写像のケースを足す**

`editor/web/test/twoSystems.guard.test.ts` の import に `import { tabOf } from '@/features/layout/tabOf';` を追加し、ファイル末尾に追記する:

```ts
describe('editor 2系統の原則: タブ点灯の写像', () => {
  // 編集・プレビュー画面がタブの下に展開されるため、点灯するタブも経路から決まる。
  // 根拠は `route.query.created === '1'` だけ(設計正典「中核原則」)で、写像はそれを表示へ
  // 写すだけ。ここが別の根拠(パスや state)を見始めると経路判定が 2 本になる。
  it('編集経路(query なし)は「編集」、作成経路(?created=1)は「テンプレート作成」に点灯する', () => {
    expect(tabOf({ name: 'editor', query: {} })).toBe('edit');
    expect(tabOf({ name: 'editor', query: { created: '1' } })).toBe('create');
    expect(tabOf({ name: 'preview', query: {} })).toBe('edit');
    expect(tabOf({ name: 'preview', query: { created: '1' } })).toBe('create');
  });
});
```

ファイル冒頭のコメント（「起きやすい 2 つの退行」の箇条書き）に 3 つ目を足す:

```
//   - 点灯ずれ型: タブ点灯の写像が `created` query 以外の根拠を見て、作成経路の編集画面が
//     「編集」タブに点灯する退行。→ 写像は query のみで決まる、を検証。
```

Run: `pnpm vitest run --project web editor/web/test/twoSystems.guard.test.ts`
Expected: PASS

- [ ] **Step 6: coverage include に追加する**

ルート `vitest.config.ts` の `'editor/web/src/stores/pendingReviews.ts',` の直後に追記:

```ts
        // 編集・プレビュー画面のタブ内展開。タブ点灯の写像と直前画面の記憶は、退行が
        // 「別のタブが点く / 一覧へ落ちる」という UI 上の無言の形で出るため被覆に入れる。
        'editor/web/src/features/layout/tabOf.ts',
```

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/layout/tabOf.ts editor/web/test/tabOf.test.ts editor/web/test/twoSystems.guard.test.ts
git add editor/web/src/features/layout/tabOf.ts editor/web/test/tabOf.test.ts editor/web/test/twoSystems.guard.test.ts vitest.config.ts
git commit -F - <<'EOF'
feat(editor): ルートから上部ナビのタブ名へ写す tabOf を追加する

編集・プレビュー画面をタブの下に展開する準備。作成経路(?created=1)は「テンプレート作成」、
query なしは「編集」、精査画面は「承認」に写す。経路判定の根拠は created query のみで、
2 系統ガードに写像のケースを足す。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 3: `tabMemory` ストア — タブごとの直前画面

**Files:**
- Create: `editor/web/src/stores/tabMemory.ts`
- Test: `editor/web/test/tabMemory.store.test.ts`
- Modify: `vitest.config.ts`（ルート）

**Interfaces:**
- Consumes: `tabOf`, `TabName`, `TabRouteLike`（Task 2）
- Produces:
  ```ts
  useTabMemoryStore(): { remember(route: TabRouteLike & { fullPath: string }): void; pathFor(tab: TabName): string | undefined }
  ```

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/tabMemory.store.test.ts`:

```ts
// =============================================================================
// tabMemory.store.test.ts — タブごとの「直前に見ていた画面」の記憶
// =============================================================================
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTabMemoryStore } from '@/stores/tabMemory';

describe('useTabMemoryStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('記憶が無いタブは undefined(呼び手がタブの既定画面へ送る)', () => {
    const store = useTabMemoryStore();
    expect(store.pathFor('edit')).toBeUndefined();
  });

  it('編集画面を見ていたら「編集」タブの直前画面として fullPath を覚える', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'editor', query: {}, fullPath: '/edit/t1' });
    expect(store.pathFor('edit')).toBe('/edit/t1');
    // 一覧へ戻ればそれが最新
    store.remember({ name: 'edit', query: {}, fullPath: '/edit' });
    expect(store.pathFor('edit')).toBe('/edit');
  });

  it('作成経路(?created=1)の編集画面は「テンプレート作成」タブの直前画面になる', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'editor', query: { created: '1' }, fullPath: '/edit/t2?created=1' });
    expect(store.pathFor('create')).toBe('/edit/t2?created=1');
    expect(store.pathFor('edit')).toBeUndefined();
  });

  it('タブを持たない画面は何も覚えない', () => {
    const store = useTabMemoryStore();
    store.remember({ name: 'admin', query: {}, fullPath: '/admin' });
    expect(Object.keys(store.paths)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm vitest run --project web editor/web/test/tabMemory.store.test.ts`
Expected: FAIL（`@/stores/tabMemory` が解決できない）

- [ ] **Step 3: 実装する**

`editor/web/src/stores/tabMemory.ts`:

```ts
// =============================================================================
// tabMemory.ts — タブごとに「直前に見ていた画面」を覚える Pinia ストア
// =============================================================================
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { type TabName, type TabRouteLike, tabOf } from '@/features/layout/tabOf';

/**
 * 上部ナビのタブを押したとき、そのタブで直前に見ていた画面(一覧 or 編集中のテンプレート)へ
 * 戻すための記憶。編集画面がタブの下に展開されるため、他タブを見てから「編集」へ戻ったときに
 * 一覧へ落とすと、編集中のテンプレートを探し直すことになる。
 * in-memory のみ — リロード後はルート自体が復元されるので永続化は要らない。
 */
export const useTabMemoryStore = defineStore('tabMemory', () => {
  const paths = reactive<Partial<Record<TabName, string>>>({});

  /** 遷移先を、その属するタブの「直前の画面」として記録する。タブを持たない画面は無視する。 */
  function remember(route: TabRouteLike & { fullPath: string }): void {
    const tab = tabOf(route);
    if (tab) paths[tab] = route.fullPath;
  }

  /** タブの「直前の画面」。記憶が無ければ undefined(呼び手はタブの既定画面へ送る)。 */
  function pathFor(tab: TabName): string | undefined {
    return paths[tab];
  }

  return { paths, remember, pathFor };
});
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/tabMemory.store.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: coverage include に追加する**

ルート `vitest.config.ts` の `'editor/web/src/features/layout/tabOf.ts',` の直後に追記:

```ts
        'editor/web/src/stores/tabMemory.ts',
```

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/web/src/stores/tabMemory.ts editor/web/test/tabMemory.store.test.ts
git add editor/web/src/stores/tabMemory.ts editor/web/test/tabMemory.store.test.ts vitest.config.ts
git commit -F - <<'EOF'
feat(editor): タブごとに直前に見ていた画面を覚える tabMemory ストアを追加する

編集画面がタブの下に展開されると、他タブを見てから「編集」へ戻ったときに一覧へ落ちる。
tabOf で属するタブを決め、fullPath を in-memory で覚える。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 4: ルート子化とスクロールモデル（編集・プレビューをタブの下に展開）

**Files:**
- Modify: `editor/web/src/router/index.ts:33-105`
- Modify: `editor/web/src/features/layout/MainLayout.vue`（script と template）
- Modify: `editor/web/src/features/editor/EditorView.vue:282`
- Modify: `editor/web/src/features/preview/PreviewView.vue:162`
- Create: `editor/e2e/tabbed_layout.spec.ts`

**Interfaces:**
- Consumes: `tabOf` / `TabName`（Task 2）、`useTabMemoryStore`（Task 3）
- Produces: `route.meta.flush === true` のルートは `main` の余白を持たない。`editor` / `preview` は `MainLayout` の children。

- [ ] **Step 1: 失敗する e2e を書く**

`editor/e2e/tabbed_layout.spec.ts`:

```ts
// =============================================================================
// tabbed_layout.spec.ts — 編集・プレビュー画面がタブの下に展開されること
// =============================================================================
// 編集・プレビューは MainLayout の子ルートで、アプリヘッダとタブが常に見える。編集画面は
// 残りの高さを全部使う(`h-full`)。タブを押すと、そのタブで直前に見ていた画面へ戻る。
import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

async function login(page: Page) {
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
}

async function openEditor(page: Page, query = '') {
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}${query}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  return frame;
}

test('編集画面でもアプリヘッダとタブが見え、「編集」タブが点灯する', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await openEditor(page);
  await expect(page.getByText('Report Edit Tool')).toBeVisible();
  await expect(page.getByRole('link', { name: '編集' })).toHaveAttribute('aria-current', 'page');
  // 上部バー(一覧へ戻る)も同時に見える = 2 つの header が縦に並ぶ
  await expect(page.getByLabel('一覧へ戻る')).toBeVisible();
});

test('作成経路(?created=1)の編集画面は「テンプレート作成」タブが点灯する', async ({ page }) => {
  await login(page);
  await openEditor(page, '?created=1');
  await expect(page.getByRole('link', { name: 'テンプレート作成' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: '編集' })).not.toHaveAttribute('aria-current', 'page');
});

test('編集画面はアプリヘッダの下の残り高さを全部使い、ページはスクロールしない', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await openEditor(page);
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('main');
    const topBar = document.querySelector('header:has([aria-label="一覧へ戻る"])');
    const editorRoot = topBar?.parentElement;
    return {
      mainH: main?.getBoundingClientRect().height ?? -1,
      editorH: editorRoot?.getBoundingClientRect().height ?? -1,
      editorBottom: editorRoot?.getBoundingClientRect().bottom ?? -1,
      docScroll: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(Math.abs(metrics.mainH - metrics.editorH)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.editorBottom - 900)).toBeLessThanOrEqual(1);
  expect(metrics.docScroll).toBeLessThanOrEqual(0);
});

test('プレビュー画面もタブの下に展開される', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`, { waitUntil: 'commit' });
  await expect(page.getByRole('link', { name: '編集' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('エディターに戻る')).toBeVisible();
});

test('他タブへ行って「編集」タブを押すと、編集中のテンプレートへ戻る', async ({ page }) => {
  await login(page);
  await openEditor(page);
  await page.getByRole('link', { name: '比較' }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await page.getByRole('link', { name: '編集' }).click();
  await expect(page).toHaveURL(new RegExp(`/edit/${encodeURIComponent(SEED_ID)}$`));
  await page.frameLocator('iframe.gjs-frame').locator('.page').first().waitFor({ timeout: 30_000 });
});

test('一覧を見ていた状態から他タブへ行って「編集」タブを押すと、一覧へ戻る', async ({ page }) => {
  await login(page);
  await page.goto('/edit', { waitUntil: 'commit' });
  await page.getByRole('link', { name: '履歴' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.getByRole('link', { name: '編集' }).click();
  await expect(page).toHaveURL(/\/edit$/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec playwright test -c editor/playwright.config.ts tabbed_layout`
Expected: 1 番目〜5 番目が失敗（編集画面に `Report Edit Tool` が無い等）。6 番目（一覧 → 履歴 → 編集）だけは現行でも通る。

- [ ] **Step 3: ルートを子化する**

`editor/web/src/router/index.ts`: トップレベルの `editor` / `preview` レコード（`path: '/edit/:id'` と `path: '/preview/:id'` の 2 つ）を削除し、`MainLayout` の `children` 配列の `admin` の直後に追加する:

```ts
      // 編集・プレビューはタブの下に展開する(アプリヘッダとタブを常に見せる)。`flush` は
      // `MainLayout` が本文の余白を落とす合図で、この 2 画面は残りの高さを全部使う。
      {
        path: 'edit/:id',
        name: 'editor',
        component: () => import('@/features/editor/EditorView.vue'),
        props: true,
        meta: { access: 'auth', flush: true },
      },
      {
        path: 'preview/:id',
        name: 'preview',
        component: () => import('@/features/preview/PreviewView.vue'),
        props: true,
        meta: { access: 'auth', flush: true },
      },
```

- [ ] **Step 4: `MainLayout.vue` をシェル化する（スクロールモデル・flush・タブ点灯・タブ復帰）**

script の変更:

```ts
// import に追加
import type { RouteLocationRaw } from 'vue-router';
import { type TabName, tabOf } from './tabOf';
import { useTabMemoryStore } from '@/stores/tabMemory';

// `const pending = usePendingReviewsStore();` の直後
const memory = useTabMemoryStore();

// `tabs` の型を TabName に固定する(name の綴り違いを型で止める)
const tabs: { name: TabName; label: string; icon: Component; group: number }[] = [
  ...(現行の 6 要素そのまま)
];

// `activeName` を置き換える(review-detail の特例は tabOf が持つ)
const activeTab = computed(() => tabOf(route));

// 編集・プレビューは本文の余白を持たない(残りの高さを全部使う)。
const flush = computed(() => route.meta.flush === true);

// タブごとに「直前に見ていた画面」を覚え、タブを押したときそこへ戻す。記憶が無ければ
// タブの既定画面。`immediate` は初期表示の画面も覚えるため。
watch(() => route.fullPath, () => memory.remember(route), { immediate: true });
function tabTarget(name: TabName): RouteLocationRaw {
  return memory.pathFor(name) ?? { name };
}
```

`Component` 型は `import { type Component, computed, onMounted, watch } from 'vue';` で取る。

template の変更（root・`main`・タブの `to` / `aria-current`）:

```html
  <div class="flex h-screen flex-col bg-muted/40">
    <header class="shrink-0 border-b bg-card print:hidden">
      （中身は現行のまま。Task 5 で 1 行化する）
    </header>
    <!-- 本文だけがスクロールする(ヘッダ帯は常に固定)。編集・プレビュー(`flush`)は余白を
         持たず残りの高さを全部使う。`min-h-0` が無いと flex 子の最小高さが内容高になり
         はみ出す。 -->
    <main
      :class="
        cn('mx-auto min-h-0 w-full max-w-[1400px] flex-1 overflow-auto', !flush && 'px-5 pb-16 pt-6')
      "
    >
      <RouterView />
    </main>
  </div>
```

タブの `RouterLink` は `:to="tabTarget(t.name)"`、`:aria-current="activeTab === t.name ? 'page' : undefined"`、class の三項も `activeTab === t.name` に置き換える。`activeName` への参照を全部消す。

- [ ] **Step 5: 編集・プレビューの root を `h-full` にする**

`editor/web/src/features/editor/EditorView.vue:282`:

```html
  <div class="flex h-full min-h-0 flex-col bg-background">
```

`editor/web/src/features/preview/PreviewView.vue:162`:

```html
  <div class="flex h-full min-h-0 flex-col bg-background">
```

- [ ] **Step 6: 型検査と e2e を通す**

Run: `pnpm typecheck:editor`
Expected: エラーなし

Run: `pnpm exec playwright test -c editor/playwright.config.ts tabbed_layout header_layout canvas smoke note_bubble`
Expected: すべて passed（`header_layout` は Task 1 のセレクタで上部バーを測る。`canvas` / `smoke` の `header [role="status"]` は上部バーにしか無いので変更不要）

- [ ] **Step 7: 単体テストを通す（ルート表の網羅ガード）**

Run: `pnpm vitest run --project web editor/web/test/routePolicy.guard.test.ts editor/web/test/routerGuard.test.ts`
Expected: PASS（name → access の対応表は変わらない。children へ移っても `flatten` が拾う）

- [ ] **Step 8: コミット**

```bash
pnpm exec biome check --write editor/web/src/router/index.ts editor/web/src/features/layout/MainLayout.vue editor/web/src/features/editor/EditorView.vue editor/web/src/features/preview/PreviewView.vue editor/e2e/tabbed_layout.spec.ts
git add editor/web/src/router/index.ts editor/web/src/features/layout/MainLayout.vue editor/web/src/features/editor/EditorView.vue editor/web/src/features/preview/PreviewView.vue editor/e2e/tabbed_layout.spec.ts
git commit -F - <<'EOF'
feat(editor): 編集・プレビュー画面を MainLayout の子にしてタブの下に展開する

/edit/:id と /preview/:id を children へ移す(URL は不変)。MainLayout は h-screen の
内側スクロールにし、flush ルートは本文の余白を持たず残りの高さを全部使う。タブ点灯は
tabOf、タブを押したときの戻り先は tabMemory の直前画面。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 5: アプリヘッダとタブを 1 行に統合し、最大幅を 1760px へ

**Files:**
- Modify: `editor/web/src/features/layout/MainLayout.vue`（template の `header` と `main` の `max-w`、冒頭コメント）
- Modify: `editor/e2e/header_layout.spec.ts`（アプリヘッダの検証を追加）

**Interfaces:**
- Consumes: `headerRows(page, selector)`（Task 1）

- [ ] **Step 1: 失敗する e2e を書く**

`editor/e2e/header_layout.spec.ts` の末尾に追記:

```ts
/**
 * アプリヘッダ(`MainLayout.vue`)の 1 行。ロゴ・タブ群・右端(管理者/テーマ/ユーザー)は
 * 同じ行の直接の子なので、その親の行を測る。
 */
const APP_HEADER_ROW = 'header:has(nav) > div';

/** 要素の縦中心 y。ロゴとタブが同じ行にあるかの判定に使う。 */
async function centerY(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r ? r.top + r.height / 2 : -1;
  }, selector);
}

for (const width of [1440, 1600, 1920]) {
  test(`${width}px: アプリヘッダ(ロゴ + タブ + 右端)が 1 行に収まり、横に溢れない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openLongNameEditor(page);
    // ロゴは副文言まで出す(落として幅を稼がない)
    await expect(page.getByText('Report Edit Tool')).toBeVisible();
    await expect(page.getByRole('link', { name: '履歴' })).toBeVisible();
    // ロゴとタブが同じ行にある(2 段ヘッダなら約 50px ずれる)
    const logoY = await centerY(page, 'header:has(nav) span.tracking-\\[0\\.1em\\]');
    const tabY = await centerY(page, 'header nav a[aria-current="page"]');
    expect(Math.abs(logoY - tabY)).toBeLessThanOrEqual(2);
    expect(await headerRows(page, APP_HEADER_ROW)).toBe(1);
    const overflow = await page.evaluate((sel) => {
      const row = document.querySelector(sel);
      return row ? row.scrollWidth - row.clientWidth : -1;
    }, APP_HEADER_ROW);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('1920px: 本文の最大幅は 1760px(編集 3 ペインの固定幅 584px + ページ 794px の要件)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openLongNameEditor(page);
  const widths = await page.evaluate((sel) => {
    const bar = document.querySelector(sel);
    const main = document.querySelector('main');
    return {
      bar: bar?.getBoundingClientRect().width ?? -1,
      main: main?.getBoundingClientRect().width ?? -2,
    };
  }, TOP_BAR);
  expect(Math.round(widths.main)).toBe(1760);
  // 上部バーは main の全幅を使う(flush で左右の余白が無い)
  expect(Math.abs(widths.bar - widths.main)).toBeLessThanOrEqual(1);
  expect(await headerRows(page, TOP_BAR)).toBe(1);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec playwright test -c editor/playwright.config.ts header_layout`
Expected: 追加した 4 テストが失敗（現行はロゴ行とタブ行が別の段で `logoY - tabY` が約 50px、`main` の幅は 1400px）。既存の上部バー 2 テストは passed のまま。

- [ ] **Step 3: ヘッダを 1 行にし、最大幅を 1760px にする**

`editor/web/src/features/layout/MainLayout.vue` の template の `header` 全体を次に置き換える（ロゴ・タブ・右端の中身は現行のまま。変えるのは入れ物だけ）:

```html
    <!-- ヘッダ帯は 1 行 56px。編集・プレビューがこの帯の下に展開されるため、帯を 2 段
         (ロゴ行 + タブ行)にすると canvas の高さを 46px 余分に失う。ロゴ(副文言まで)・
         タブ群・右端(管理者/テーマ/ユーザー)を同じ行に置き、ゾーン間は `gap-8` と `ml-auto`
         で十分に空ける。1760px 枠で約 1205px を使う。それより狭い画面では行ごと横スクロール
         (要素を隠さない)。 -->
    <header class="shrink-0 border-b bg-card print:hidden">
      <div class="mx-auto flex h-14 max-w-[1760px] items-center gap-8 overflow-x-auto px-5">
        <div class="flex shrink-0 items-baseline gap-2 font-bold text-primary">
          <FileText class="h-5 w-5 self-center" />
          <span class="text-base tracking-[0.1em]">RET</span>
          <span class="whitespace-nowrap text-xs font-semibold tracking-[0.02em] text-muted-foreground">
            Report Edit Tool
          </span>
        </div>
        <nav class="flex shrink-0 items-center gap-1">
          <template v-for="(t, i) in tabs" :key="t.name">
            （現行の区切り線と RouterLink をそのまま）
          </template>
        </nav>
        <div class="ml-auto flex shrink-0 items-center gap-2.5">
          （現行の 管理者 RouterLink / ThemeToggle / UserMenu をそのまま）
        </div>
      </div>
    </header>
```

`main` の `max-w-[1400px]` を `max-w-[1760px]` に変える。

template 冒頭のコメント（「ヘッダ・タブ・本文の 3 か所は同じ最大幅で揃える。1320px は…」）を次に書き換える:

```html
  <!-- ヘッダ帯と本文は同じ最大幅で揃える。1760px は編集画面の要件から決まる: 左ペイン 272px +
       右ペイン 312px = 584px が固定で、内容幅がページ実体 794px + 余白を収めるには 1500px 強
       要る。1400px 枠だと canvas が 776px でページより狭く、上部バーも折り返す(実測)。
       下限は絞り込みバーの要件 1400px: 項目名つき placeholder が収まる列幅(240px)で、比較画面の
       最大構成である 5 列(240px×4 + 「比較する版」220px + 間隔 48px = 1228px)を 1 行に並べる
       のに要る幅。狭めると 5 列目が次行へ落ち、編集画面では操作ボタンだけが次行へ落ちる。 -->
```

- [ ] **Step 4: e2e を通す**

Run: `pnpm exec playwright test -c editor/playwright.config.ts header_layout tabbed_layout filter_bar_layout capture_docs`
Expected: すべて passed（`capture_docs` は `getByRole('link', { name: '管理者' })` 等の導線が変わらないことの確認。撮影された `docs/editor/images/*.png` の差分は Task 8 でまとめてコミットするので、ここでは `git checkout -- docs/editor/images` で戻す）

- [ ] **Step 5: コミット**

```bash
git checkout -- docs/editor/images
pnpm exec biome check --write editor/web/src/features/layout/MainLayout.vue editor/e2e/header_layout.spec.ts
git add editor/web/src/features/layout/MainLayout.vue editor/e2e/header_layout.spec.ts
git commit -F - <<'EOF'
feat(editor): アプリヘッダとタブを 1 行に統合し、本文の最大幅を 1760px に広げる

編集画面がヘッダ帯の下に展開されるため、帯を 2 段のままにすると canvas の高さを
46px 余分に失う。ロゴ(副文言まで)・タブ群・右端を 1 行 56px に置き、ゾーン間は gap-8 と
ml-auto で空ける。最大幅は編集 3 ペインの固定幅 584px + ページ 794px の要件から 1760px。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 6: 下書きの所属（セッショントークン）— 閉じた後の再オープンで破棄する

**Files:**
- Modify: `editor/web/src/lib/storageKeys.ts:53-72`
- Create: `editor/web/src/lib/draftOwner.ts`
- Test: `editor/web/test/draftOwner.test.ts`
- Modify: `editor/web/src/features/editor/services/templateEditorService.ts`
- Modify: `editor/web/test/templateEditorService.test.ts`
- Modify: `editor/web/src/api/local/store.ts:20,148-163`
- Modify: `editor/web/src/stores/auth.ts:18,70-75`
- Modify: `vitest.config.ts`（ルート）

**Interfaces:**
- Produces:
  ```ts
  // storageKeys.ts
  export function draftOwnerKey(): string;
  // draftOwner.ts
  export interface DraftOwner { claim(templateId: string): void; release(templateId: string): void; belongsToSession(templateId: string): boolean }
  export function sessionToken(): string;
  export const draftOwner: DraftOwner;
  // templateEditorService.ts
  export function createTemplateEditorService(templates, parts, owner: DraftOwner = draftOwner): TemplateEditorService;
  ```

- [ ] **Step 1: `draftOwner` の失敗するテストを書く**

`editor/web/test/draftOwner.test.ts`:

```ts
// =============================================================================
// draftOwner.test.ts — 下書きの所属セッションの判定
// =============================================================================
// 編集セッションはブラウザタブの寿命。sessionStorage のトークンで「同じタブか」を判定し、
// 別タブ(閉じたタブ・別端末)が残した下書きは次回オープン時に破棄される側へ倒す。
import { beforeEach, describe, expect, it } from 'vitest';
import { draftOwner, sessionToken } from '@/lib/draftOwner';
import { draftOwnerKey } from '@/lib/storageKeys';

describe('draftOwner', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('sessionToken はタブ内で安定し、sessionStorage が消える(タブを閉じる)と変わる', () => {
    const a = sessionToken();
    expect(sessionToken()).toBe(a);
    sessionStorage.clear();
    expect(sessionToken()).not.toBe(a);
  });

  it('claim した下書きは同じセッションのものとして扱う', () => {
    expect(draftOwner.belongsToSession('t1')).toBe(false); // 記録なし = 別セッション扱い
    draftOwner.claim('t1');
    expect(draftOwner.belongsToSession('t1')).toBe(true);
  });

  it('タブを閉じた後(sessionStorage が消えた後)は別セッション扱いになる', () => {
    draftOwner.claim('t1');
    sessionStorage.clear();
    expect(draftOwner.belongsToSession('t1')).toBe(false);
  });

  it('release で所属の記録が消える', () => {
    draftOwner.claim('t1');
    draftOwner.claim('t2');
    draftOwner.release('t1');
    expect(draftOwner.belongsToSession('t1')).toBe(false);
    expect(draftOwner.belongsToSession('t2')).toBe(true);
    expect(JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}')).toEqual({
      t2: sessionToken(),
    });
  });

  it('所属の記録が壊れていても例外にせず「別セッション」へ倒す', () => {
    localStorage.setItem(draftOwnerKey(), '{not json');
    expect(draftOwner.belongsToSession('t1')).toBe(false);
    draftOwner.claim('t1'); // 壊れた記録は上書きされる
    expect(draftOwner.belongsToSession('t1')).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm vitest run --project web editor/web/test/draftOwner.test.ts`
Expected: FAIL（`@/lib/draftOwner` / `draftOwnerKey` が無い）

- [ ] **Step 3: `storageKeys.ts` に `draftOwnerKey()` を足す**

`editor/web/src/lib/storageKeys.ts` の `const UNDO_STACKS_PREFIX = 'editor:session:undo';` から `undoStacksKey` 関数の末尾までを次に置き換える:

```ts
const UNDO_STACKS_PREFIX = 'editor:session:undo';
// 下書きの所属セッション。値は `Record<templateId, sessionToken>`(`lib/draftOwner.ts`)。
// 編集セッションはブラウザタブの寿命で、別タブが残した下書きは次回オープン時に破棄する。
// Undo ミラーと同じ理由でユーザー別に分ける。
const DRAFT_OWNER_PREFIX = 'editor:draft:owner';
const LOCAL_UNDO_SCOPE = 'local';
const ANONYMOUS_UNDO_SCOPE = 'anonymous';

/** ユーザー非分離だった旧形式キー。後片付け(logout / スキーマ bump)でのみ参照する。 */
export const LEGACY_UNDO_STACKS_KEY = UNDO_STACKS_PREFIX;

let undoLoginId: string | null = null;

/**
 * Undo ミラーと下書き所属のユーザースコープを設定する。`stores/auth.ts` が bootstrap /
 * login / logout で呼ぶ(ストアを跨いで参照し合わないための受け渡し点)。
 */
export function setUndoUserScope(loginId: string | null): void {
  undoLoginId = loginId;
}

/** 現在のユーザーのスコープ。rest はログイン ID、local は単一利用者前提の固定値。 */
function userScope(): string {
  return import.meta.env.VITE_API_MODE === 'rest'
    ? (undoLoginId ?? ANONYMOUS_UNDO_SCOPE)
    : LOCAL_UNDO_SCOPE;
}

/** 現在のユーザー向け Undo ミラーキー。 */
export function undoStacksKey(): string {
  return `${UNDO_STACKS_PREFIX}:${userScope()}`;
}

/** 現在のユーザー向け下書き所属キー。 */
export function draftOwnerKey(): string {
  return `${DRAFT_OWNER_PREFIX}:${userScope()}`;
}
```

- [ ] **Step 4: `draftOwner.ts` を実装する**

`editor/web/src/lib/draftOwner.ts`:

```ts
// =============================================================================
// draftOwner.ts — 下書きがどのブラウザタブ(セッション)に属するか
// =============================================================================
// 編集セッションはブラウザタブの寿命。閉じる瞬間にサーバへ破棄を届ける手段は不確実
// (`beforeunload` 内の通信はベストエフォートで、クラッシュや電源断では何も送れない)ため、
// 「次回オープン時に、前のタブが残した下書きを破棄する」形で成立させる。
//   - セッショントークン: `sessionStorage`(タブを閉じると消え、リロードとタブ内遷移では残る)
//   - 下書きの所属: `localStorage` の `Record<templateId, token>`(ユーザー別キー)
// 判定はすべて「わからなければ別セッション」へ倒す — 古い下書きを黙って復元するより、
// 確定版から開き直す方が規則に沿う。
import { draftOwnerKey } from './storageKeys';

const SESSION_TOKEN_KEY = 'editor:tab-session';

/** 下書きの所属を扱う操作の束。service が受け取る差し替え点(テストはフェイクを渡す)。 */
export interface DraftOwner {
  /** 下書きを現在のセッションのものとして記録する(下書きを書くたびに呼ぶ)。 */
  claim(templateId: string): void;
  /** 所属の記録を消す(下書きの破棄と対にする)。 */
  release(templateId: string): void;
  /** 下書きが現在のセッションのものか。記録が無い・別セッションのものなら false。 */
  belongsToSession(templateId: string): boolean;
}

function newToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 現在のブラウザタブのセッショントークン。無ければ生成して `sessionStorage` に置く。 */
export function sessionToken(): string {
  try {
    const current = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (current) return current;
    const token = newToken();
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    return token;
  } catch {
    // storage が使えない環境では毎回別トークン = 常に「前のタブの下書き」として破棄される。
    return newToken();
  }
}

function readMap(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(draftOwnerKey(), JSON.stringify(map));
  } catch {
    // quota 等。記録できなければ次回オープン時に破棄側へ倒れるだけで、編集は止めない。
  }
}

export const draftOwner: DraftOwner = {
  claim(templateId) {
    const map = readMap();
    map[templateId] = sessionToken();
    writeMap(map);
  },
  release(templateId) {
    const map = readMap();
    if (!(templateId in map)) return;
    delete map[templateId];
    writeMap(map);
  },
  belongsToSession(templateId) {
    return readMap()[templateId] === sessionToken();
  },
};
```

- [ ] **Step 5: 通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/draftOwner.test.ts editor/web/test/editorSession.test.ts`
Expected: PASS（`editorSession.test.ts` は `undoStacksKey` の挙動が変わっていないことの確認）

- [ ] **Step 6: service の失敗するテストを書く**

`editor/web/test/templateEditorService.test.ts` の `repos()` を、`discardDraft` / `saveDraft` のフェイクを持つ形に置き換え、`owner` フェイクを足す:

```ts
function repos(opts: { draft?: TemplateDraft | null; templateErr?: boolean }) {
  const templates = {
    getTemplate: vi.fn(async () => (opts.templateErr ? err(notFound('no')) : ok(tpl))),
    listParts: vi.fn(async () => ok([])),
    getDraft: vi.fn(async () => ok(opts.draft ?? null)),
    saveDraft: vi.fn(async () => ok(undefined)),
    discardDraft: vi.fn(async () => ok(undefined)),
  } as unknown as TemplateRepository & {
    saveDraft: ReturnType<typeof vi.fn>;
    discardDraft: ReturnType<typeof vi.fn>;
  };
  const parts = {
    listParts: vi.fn(async () => ok([])),
    listPartHistory: vi.fn(async () => ok([])),
  } as unknown as PartRepository;
  return { templates, parts };
}

/** 下書きの所属のフェイク。`belongs` で「同じセッションか」を固定する。 */
function ownerOf(belongs: boolean): DraftOwner & { claim: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn(), release: vi.fn(), belongsToSession: vi.fn(() => belongs) };
}
```

import に `import type { DraftOwner } from '@/lib/draftOwner';` を足す。既存の `prefers the autosaved draft over the file` は `createTemplateEditorService(templates, parts, ownerOf(true))` に変える（所属が同じセッションのときの復元）。次のテストを追加する:

```ts
  it('別セッションが残した下書きは破棄して確定版から開く', async () => {
    const draft: TemplateDraft = {
      templateId: 't1',
      html: '<p>stale draft</p>',
      css: '.from-draft{}',
      savedAt: '',
      savedBy: '',
    };
    const { templates, parts } = repos({ draft });
    const owner = ownerOf(false);
    const svc = createTemplateEditorService(templates, parts, owner);
    const res = await svc.loadForEdit('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.editableBody).not.toContain('stale draft');
      expect(res.value.css).toBe('.from-file{}');
      expect(res.value.hasDraft).toBe(false); // 確定版から開くので dirty ではない
    }
    expect(templates.discardDraft).toHaveBeenCalledWith('t1');
    expect(owner.release).toHaveBeenCalledWith('t1');
  });

  it('下書きが無ければ所属判定を呼ばない(破棄要求も出さない)', async () => {
    const { templates, parts } = repos({ draft: null });
    const owner = ownerOf(false);
    await createTemplateEditorService(templates, parts, owner).loadForEdit('t1');
    expect(templates.discardDraft).not.toHaveBeenCalled();
  });

  it('下書きの破棄に失敗しても確定版から開く(古い下書きを黙って復元しない)', async () => {
    const draft: TemplateDraft = {
      templateId: 't1',
      html: '<p>stale draft</p>',
      css: '.from-draft{}',
      savedAt: '',
      savedBy: '',
    };
    const { templates, parts } = repos({ draft });
    templates.discardDraft.mockResolvedValueOnce(err(network('down')));
    const res = await createTemplateEditorService(templates, parts, ownerOf(false)).loadForEdit('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.hasDraft).toBe(false);
  });

  it('saveDraft は成功時に所属を記録し、discardDraft は成功時に記録を消す', async () => {
    const { templates, parts } = repos({ draft: null });
    const owner = ownerOf(true);
    const svc = createTemplateEditorService(templates, parts, owner);
    await svc.saveDraft('t1', '<p>x</p>', '');
    expect(owner.claim).toHaveBeenCalledWith('t1');
    await svc.discardDraft('t1');
    expect(owner.release).toHaveBeenCalledWith('t1');
  });

  it('saveDraft が失敗したら所属を記録しない', async () => {
    const { templates, parts } = repos({ draft: null });
    templates.saveDraft.mockResolvedValueOnce(err(network('down')));
    const owner = ownerOf(true);
    await createTemplateEditorService(templates, parts, owner).saveDraft('t1', '<p>x</p>', '');
    expect(owner.claim).not.toHaveBeenCalled();
  });
```

`network` は `@editor/shared` から import する（`err, isErr, isOk, network, notFound, ok` の並びへ足す）。

- [ ] **Step 7: 失敗を確認する**

Run: `pnpm vitest run --project web editor/web/test/templateEditorService.test.ts`
Expected: FAIL（第 3 引数を受けない / `discardDraft` が呼ばれない）

- [ ] **Step 8: service を実装する**

`editor/web/src/features/editor/services/templateEditorService.ts`:

import に `isOk` を足し（`isErr, isOk, ok,` の並び）、`import { type DraftOwner, draftOwner } from '@/lib/draftOwner';` を追加する。

`discardDraft` のインターフェースコメントを `/** 未確定 draft を破棄する(所属の記録も消す)。 */` に変える。

関数シグネチャを `createTemplateEditorService(templates, parts, owner: DraftOwner = draftOwner)` にし、`loadForEdit` の `const draft = draftRes.value;` を次に置き換える:

```ts
      let draft = draftRes.value;
      // 編集セッションはブラウザタブの寿命。別のタブ(閉じたタブ・別端末)が残した下書きは
      // ここで破棄して確定版から開く(設計正典「編集セッションの生存規則」)。破棄要求の失敗は
      // 下書きを採用しない形で吸収する — 古い下書きを黙って復元するより確定版から開く方が
      // 規則に沿い、残った実体は次の autosave が上書きする。
      if (draft && !owner.belongsToSession(id)) {
        const dropped = await templates.discardDraft(id);
        if (isOk(dropped)) owner.release(id);
        draft = null;
      }
```

`saveDraft` / `discardDraft` を次に置き換える:

```ts
    async saveDraft(id, html, css) {
      const res = await templates.saveDraft({ templateId: id, html, css });
      if (isOk(res)) owner.claim(id);
      return res;
    },

    async discardDraft(id) {
      const res = await templates.discardDraft(id);
      if (isOk(res)) owner.release(id);
      return res;
    },
```

- [ ] **Step 9: 通ることを確認する**

Run: `pnpm vitest run --project web editor/web/test/templateEditorService.test.ts`
Expected: PASS

- [ ] **Step 10: 後片付け（スキーマ bump と logout）に所属キーを足す**

`editor/web/src/api/local/store.ts:20` の import を `import { draftOwnerKey, K, LEGACY_NOTES_KEY, LEGACY_UNDO_STACKS_KEY, undoStacksKey } from '@/lib/storageKeys';` にし、`WORKING_KEYS` の `undoStacksKey(),` の直後に `draftOwnerKey(),` を足す。

`editor/web/src/stores/auth.ts:18` の import を `import { draftOwnerKey, LEGACY_UNDO_STACKS_KEY, setUndoUserScope, undoStacksKey } from '@/lib/storageKeys';` にし、`logout` の `localStorage.removeItem(LEGACY_UNDO_STACKS_KEY);` の直後に足す:

```ts
    // 下書きの所属も端末に残る。次の利用者のセッションで前の利用者の下書きが
    // 「同じセッション」と誤判定されることは無い(トークンが違う)が、キーを残さない。
    localStorage.removeItem(draftOwnerKey());
```

- [ ] **Step 11: coverage include に追加し、全体を通す**

ルート `vitest.config.ts` の `'editor/web/src/stores/tabMemory.ts',` の直後に追記:

```ts
        // 下書きの所属判定。退行は「閉じたはずの下書きが黙って復元される」形で出る。
        'editor/web/src/lib/draftOwner.ts',
```

Run: `pnpm typecheck:editor && pnpm vitest run --project web`
Expected: すべて PASS

- [ ] **Step 12: コミット**

```bash
pnpm exec biome check --write editor/web/src/lib/storageKeys.ts editor/web/src/lib/draftOwner.ts editor/web/src/features/editor/services/templateEditorService.ts editor/web/src/api/local/store.ts editor/web/src/stores/auth.ts editor/web/test/draftOwner.test.ts editor/web/test/templateEditorService.test.ts
git add editor/web/src/lib/storageKeys.ts editor/web/src/lib/draftOwner.ts editor/web/src/features/editor/services/templateEditorService.ts editor/web/src/api/local/store.ts editor/web/src/stores/auth.ts editor/web/test/draftOwner.test.ts editor/web/test/templateEditorService.test.ts vitest.config.ts
git commit -F - <<'EOF'
feat(editor): 下書きの所属をセッショントークンで判定し、閉じた後の再オープンで破棄する

編集セッションはブラウザタブの寿命。閉じる瞬間の通信は不確実なので、sessionStorage の
トークンと localStorage の所属記録を比べ、別タブが残した下書きは loadForEdit で破棄して
確定版から開く。autosave が所属を記録し、破棄で消す。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 7: 離脱ガードから破棄確認を撤去し、閉じるときの警告条件を `dirty` に広げる

**Files:**
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts:19,438-500`
- Modify: `editor/web/src/stores/editorSession.ts:8`
- Modify: `editor/e2e/tabbed_layout.spec.ts`（末尾に追加）
- Modify: `editor/e2e/smoke.spec.ts`（`preview shows the edited body after an autosaved draft exists`）

**Interfaces:**
- Consumes: `draftOwner`（Task 6。e2e が sessionStorage を消して「閉じた後」を再現する）

**`beforeunload` と Playwright:** 本 Task で閉じる前の警告条件に `dirty` が加わるため、編集後に
`page.goto` / `page.reload` する e2e では `beforeunload` ダイアログが出る（クリック操作で
user activation が付いている）。Playwright はリスナ無しのダイアログを **dismiss** し、
`beforeunload` の dismiss は「ページに留まる」なので、遷移が止まって timeout になる。
編集後に遷移するテストは `page.on('dialog', (d) => void d.accept())` を先に登録する。
タブ内遷移（`RouterLink` クリック）は SPA 内の遷移で `beforeunload` は発火しない。

- [ ] **Step 1: 失敗する e2e を書く**

`editor/e2e/tabbed_layout.spec.ts` の `const SEED_ID = ...` の直後に追記:

```ts
// 編集後に reload するテストがある。dirty な編集画面は閉じる前の警告(`beforeunload`)を出し、
// Playwright はリスナ無しのダイアログを dismiss(= ページに留まる)するため、reload が止まる。
// 警告は accept して進める(ここで検証したいのは警告でなく、その後の復元・破棄の挙動)。
test.beforeEach(({ page }) => {
  page.on('dialog', (d) => void d.accept());
});
```

`editor/e2e/smoke.spec.ts` の `preview shows the edited body after an autosaved draft exists` の
`await page.goto(`/preview/${id}`, { waitUntil: 'commit' });` の直前に追記:

```ts
  // dirty な編集画面は閉じる前の警告(`beforeunload`)を出す。Playwright の既定 dismiss は
  // 「ページに留まる」なので、accept してプレビューへ進める。
  page.on('dialog', (d) => void d.accept());
```

`editor/e2e/tabbed_layout.spec.ts` の末尾に追記:

```ts
/**
 * 編集を許可して地の段落へ 1 語追記し、autosave の完了を待つ。RTE の活性化は dblclick だが、
 * Playwright の合成ダブルクリックは選択後に出る GrapesJS のオーバーレイに 2 打目を吸われて
 * 発火しない(実測)ので、canvas 文書へ直接 dblclick を配送する(`smoke.spec.ts` と同じ)。
 */
async function appendAndAutosave(page: Page, text: string) {
  const frame = page.frameLocator('iframe.gjs-frame');
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  await frame.getByText('受益者のみなさまへ').first().click();
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes('受益者のみなさまへ'),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, t) => {
    el.append(t);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, text);
  await frame.locator('.page').first().click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText(text).first()).toBeVisible({ timeout: 10_000 });
  // 文言は 2xl 未満で隠れるので、全文を持つ title で autosave 完了を待つ
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
}

test('未確定の編集があっても他タブへ行ける(破棄確認は出ない)し、戻ると編集が残っている', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await openEditor(page);
  await appendAndAutosave(page, 'E2Eタブ往復');

  await page.getByRole('link', { name: '比較' }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await expect(page.getByText('保存していない変更があります')).toHaveCount(0);

  await page.getByRole('link', { name: '編集' }).click();
  const frame = page.frameLocator('iframe.gjs-frame');
  await expect(frame.getByText('E2Eタブ往復').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('未確定', { exact: true })).toBeVisible();
});

test('リロードでは編集が残る(同じタブ = 同じセッション)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await openEditor(page);
  await appendAndAutosave(page, 'E2Eリロード');
  await page.reload({ waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await expect(frame.getByText('E2Eリロード').first()).toBeVisible({ timeout: 30_000 });
});

test('タブを閉じた後(セッショントークンが消えた後)に開き直すと、未確定の編集は破棄される', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await openEditor(page);
  await appendAndAutosave(page, 'E2E破棄');
  // ブラウザタブを閉じて開き直す = sessionStorage が消えて localStorage は残る
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.getByText('E2E破棄')).toHaveCount(0);
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible();
  // 下書きの実体(local モードは localStorage の `editor:drafts`)も消えている
  const leftover = await page.evaluate(() =>
    (localStorage.getItem('editor:drafts') ?? '').includes('E2E破棄'),
  );
  expect(leftover).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec playwright test -c editor/playwright.config.ts tabbed_layout`
Expected: 「未確定の編集があっても他タブへ行ける」が失敗（現行は破棄確認ダイアログが出て `/compare` へ進めない）。「タブを閉じた後」は Task 6 で既に通る。

- [ ] **Step 3: 離脱ガードを差し替える**

`editor/web/src/features/editor/useTemplateEditor.ts` の `// アプリ内 navigation guard。` から `onBeforeRouteLeave(...)` の閉じ `});` までを次に置き換える:

```ts
  // アプリ内 navigation guard。編集セッションはブラウザタブの寿命なので、タブ遷移・
  // プレビュー往復・精査画面往復のどれでも破棄しない(draft は autosave 済み、履歴と
  // Undo/Redo は `editorSession` ストアが templateId 単位で保持する)。進行中の保存だけは
  // 待ってから離れる — 離脱直後に着地した保存が、次の画面で読んだ内容より古い draft を
  // 書き戻さないため。閉じたタブが残した draft の破棄は `loadForEdit` が次回オープン時に行う。
  onBeforeRouteLeave(async () => {
    await autosave.settled();
    return true;
  });
```

import から `confirm` を外す（`import { confirm } from '@/components/ui/confirm';` を削除）。`logError` は `onMounted` で使うので残す。

- [ ] **Step 4: `beforeUnload` の条件を広げる**

同ファイルの `// 未保存分が失われうる間は、離脱(tab を閉じる / reload)前に警告する。` から `beforeUnload` 関数の末尾までを次に置き換える:

```ts
  // 閉じる / reload の前に警告する条件は「未確定の編集がある」(`dirty`)、または autosave が
  // 未保存の窓にある(debounce 待ち・保存中・失敗)。編集セッションはブラウザタブの寿命で、
  // 閉じると次回オープン時に draft が破棄されるため、autosave 済みでも dirty なら警告する。
  // reload は同じセッションなので実際には残るが、ブラウザは閉じると reload を区別しない。
  function beforeUnload(e: BeforeUnloadEvent) {
    const st = autosave.state.value;
    if (dirty.value || autosave.pending.value || st === 'saving' || st === 'error') {
      e.preventDefault();
      e.returnValue = '';
    }
  }
```

- [ ] **Step 5: `editorSession.ts` の冒頭コメントを合わせる**

`editor/web/src/stores/editorSession.ts:8` の `// プレビューから戻った時に履歴と Undo/Redo がそのまま継続する。セッションは「メニューへの` 以降 2 行を次に書き換える:

```ts
// プレビューから戻った時に履歴と Undo/Redo がそのまま継続する。タブ遷移でも破棄しない
// (編集セッションはブラウザタブの寿命)。セッションは「確定保存」で終了し、その時 `clear` で破棄する。
```

- [ ] **Step 6: 型検査・単体・e2e を通す**

Run: `pnpm typecheck:editor && pnpm vitest run --project web`
Expected: PASS（`confirm` の未使用 import が無いこと）

Run: `pnpm exec playwright test -c editor/playwright.config.ts tabbed_layout smoke canvas`
Expected: すべて passed

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/stores/editorSession.ts editor/e2e/tabbed_layout.spec.ts editor/e2e/smoke.spec.ts
git add editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/stores/editorSession.ts editor/e2e/tabbed_layout.spec.ts editor/e2e/smoke.spec.ts
git commit -F - <<'EOF'
feat(editor): タブ遷移で編集を破棄しない(離脱ガードの破棄確認を撤去する)

編集セッションはブラウザタブの寿命。タブが常に見える配置では破棄確認が誤クリックのたびに
出るため、離脱ガードは進行中の保存を待つだけにする。閉じる前の警告は autosave の未保存窓に
加えて dirty でも出す(閉じると次回オープン時に下書きが破棄されるため)。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

### Task 8: ドキュメントと後始末（設計正典・設計書・スクリーンショット再撮影）

**Files:**
- Modify: `docs/editor/src/設計正典.md`（「中核原則」に 2 項追加、「本文の最大幅」の項を書き換え）
- Modify: `docs/editor/src/設計書.md:276-277`
- Regenerate: `docs/editor/images/*.png`、`docs/editor/editor_手引き.html`、`docs/editor/editor_設計.html`

- [ ] **Step 1: 設計正典の「本文の最大幅」の項を 2 値で書き直す**

`docs/editor/src/設計正典.md` の次の 2 行（項の冒頭）を:

```
- **本文の最大幅（`MainLayout.vue` の 1400px）を狭める**: しない（2026-09）。この値は
  絞り込みバー（`SearchFilters`）の最大構成から逆算されている。項目名を含む placeholder
```

次に置き換える（3 行目以降「「委託会社コードを入力/選択」の描画幅が 193px で…」はそのまま残す）:

```
- **本文の最大幅（`MainLayout.vue` の `max-w-[1760px]`）を 1400px 未満へ狭める**: しない
  （2026-09）。上限 1760px は編集画面の要件（左ペイン 272px + 右ペイン 312px = 584px の固定幅と
  ページ実体 794px + 余白）から決めた値で、1400px 枠だと canvas がページより狭くなり上部バーも
  折り返す（実測）。下限 1400px は絞り込みバー（`SearchFilters`）の最大構成から逆算されている。
  項目名を含む placeholder
```

- [ ] **Step 2: 設計正典の「中核原則」に 2 項を足す**

`docs/editor/src/設計正典.md` の「中核原則」節の末尾（`- **編集キャンバスの赤入れ表示は生 DOM の装飾で…` の項の直後、`- **守りを足すときは…` の前）に追記:

```
- **編集・プレビュー画面はタブの下に展開し、アプリヘッダとタブは 1 行 56px**（2026-09）:
  `/edit/:id` と `/preview/:id` は `MainLayout` の children（URL は不変）。`MainLayout` は
  `h-screen` の内側スクロールで、`route.meta.flush` のルートは本文の余白を持たず残りの高さを
  全部使う。タブ点灯は `features/layout/tabOf.ts` の純関数で、編集・プレビューは
  `route.query.created === '1'` なら「テンプレート作成」、でなければ「編集」に写す（2 系統の
  根拠を表示へ写すだけで、値の差込やハイライトには関与しない）。タブを押すと
  `stores/tabMemory.ts` が覚えた「そのタブで直前に見ていた画面」へ戻る。ヘッダ帯のロゴは
  副文言まで残し、ゾーン間は `gap-8` と `ml-auto` で空ける。機械検証は
  `e2e/tabbed_layout.spec.ts`・`e2e/header_layout.spec.ts`（アプリヘッダと上部バーの両方を
  明示セレクタで測る。素の `header` はアプリヘッダを掴む）。
- **編集セッションはブラウザタブの寿命**（2026-09）: タブ遷移・プレビュー往復・リロードでは
  未確定の編集を破棄しない（離脱ガードは進行中の保存を待つだけ）。閉じる前の警告は dirty で
  出す。閉じた後の再オープンでは下書きを破棄して確定版から開く — 閉じる瞬間の通信は
  不確実なので、`sessionStorage` のトークン（`lib/draftOwner.ts`）と `localStorage` の所属
  記録を `loadForEdit` が比べて判定する。明示的な「編集を破棄」導線は置かない。同一テンプレの
  複数タブ・複数利用者の同時編集は非サポート（後から開いた側が先の下書きを破棄しうる）。
```

- [ ] **Step 3: 設計書 5.1 のルート構成を直す**

`docs/editor/src/設計書.md:276-277` の 2 行を次に置き換える:

```
- `MainLayout` の子: `edit`（`/` 既定）/ `create` / `compare` / `reviews`・`reviews/:reqId` / `history` / `merge` / `admin`（`meta.admin`）/ `edit/:id`（エディタ）/ `preview/:id`（プレビュー）。
- エディタとプレビューは `meta.flush` を持ち、`MainLayout` が本文の余白を落として残りの高さを全部使わせる（全画面ルートは持たない。アプリヘッダとタブは常に見える）。
```

- [ ] **Step 4: スクリーンショットを再撮影し、HTML を作り直す**

Run: `pnpm exec playwright test -c editor/playwright.config.ts capture_docs`
Expected: passed。`git status` で `docs/editor/images/` の PNG（少なくとも `editor.png` / `editor-parts.png` / `preview.png`、タブ画面の各 PNG）が変更される。

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `docs/editor/editor_手引き.html` と `docs/editor/editor_設計.html` が更新される。

`docs/editor/images/editor.png` を開いて、アプリヘッダ（ロゴ + タブ 1 行）の下に上部バーと 3 ペインが出ていることを目視で確認する。

- [ ] **Step 5: 全体 CI 相当を通す**

Run: `pnpm run check:comments && pnpm run check:ci && pnpm typecheck && pnpm vitest run --project web`
Expected: すべて成功

- [ ] **Step 6: コミット**

```bash
git add docs/editor/src/設計正典.md docs/editor/src/設計書.md docs/editor/images docs/editor/editor_手引き.html docs/editor/editor_設計.html
git commit -F - <<'EOF'
docs(editor): タブ内展開・ヘッダ 1 行統合・編集セッションの規則を設計正典へ残し、画面を再撮影する

本文の最大幅を上限 1760px / 下限 1400px の 2 値で記し、タブ点灯の写像と編集セッションが
ブラウザタブの寿命である規則を中核原則に加える。設計書のルート構成を children 化に合わせ、
capture_docs の再撮影と build_all の再生成を含める。

Claude-Session: https://claude.ai/code/session_01C8TAKZaatEcrSTKzR6W9q3
EOF
```

---

## 自己レビュー

- **spec §3（子化・URL 不変）**: Task 4。
- **spec §4.1（1 行ヘッダ・ロゴ現行維持・間隔）/ §4.2（1760px）**: Task 5。
- **spec §5（スクロールモデル・flush）**: Task 4。
- **spec §6（セッション = タブの寿命・所属判定・離脱ガード撤去・beforeunload）**: Task 6・7。
- **spec §7（タブ復帰）**: Task 3・4。
- **spec §8（tabOf・2 系統ガード）**: Task 2。
- **spec §9.1（header_layout の是正）**: Task 1。§9.2 のテスト: `tabOf.test.ts`（Task 2）/ `tabMemory.store.test.ts`（Task 3）/ `draftOwner.test.ts` + `templateEditorService.test.ts`（Task 6）/ `header_layout.spec.ts`（Task 5）/ `tabbed_layout.spec.ts`（Task 4・7。spec は `smoke.spec.ts` へ足すとしていたが、独立した spec ファイルにまとめた）。§9.3（後始末）: Task 8。
- **spec §10（保留・対象外）**: `EditorTopBar` 自身の 1 行化は含めない。ログイン・パスワード初期化・精査画面は触らない。
- 型名の一致: `TabName` / `TabRouteLike` / `tabOf`（Task 2）を Task 3・4 が同名で使う。`DraftOwner` / `draftOwner` / `sessionToken` / `draftOwnerKey`（Task 6）を service とテストが同名で使う。`headerRows(page, selector)` / `TOP_BAR`（Task 1）を Task 5 が使う。
