# editor コメント機能・承認タブ 品質強化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-09-03 に入れたコメント機能と承認タブ(PR #64、`main` の `7ff3f1c`)について、最終レビューで
「動作はするが補強が要る」と残した項目を潰す。機能追加はしない。

**Architecture:** 変更は `editor/web` に閉じる。テストの穴(承認タブの単体テスト・競合ガード・
ページ整列)を先に埋め、次に a11y と構造の是正、最後に文言・コメントの掃除を行う。仕様の判断が
要る 2 件(要約箱の語・コメント列の重複)は本計画では**判断待ち**として着手しない。

**Tech Stack:** Vue 3 / vitest + @vue/test-utils / Playwright / TypeScript

**Spec:** `docs/superpowers/specs/2026-09-03-editor-reader-comments-design.md`(§4・§5)。
本計画は spec を変えない(Task 4 の整列規則は §5.4「該当ページへ」の実現手段の補強)。

## Global Constraints

- 作業ディレクトリはリポジトリルート `C:\Users\caads\workspace`。ブランチは常設
  `chore/deps-latest-offline-bundle`(`main` は squash 済みで一致)。
- テストはルートから `pnpm exec vitest run --project web <file>`、e2e は
  `pnpm exec playwright test -c editor/playwright.config.ts <spec>`、型は `pnpm run typecheck:editor`。
- `editor/**` を変更したコミットの直前に **必ず** `pnpm exec biome check --write editor/<変更ファイル…>`。
- コミットは日本語 Conventional Commits + 空行 + `Claude-Session:` 行。auto-push は通常動作
  (コミットごとに pre-push CI 11〜12 分)。連続コミットが多い場合は `.claude/auto-push.paused`
  で止めて最後に 1 回 push する。
- コメントは `docs/コメント規約.md`(なぜを書く・経緯を書かない・新規 `.ts/.vue` は箱型ヘッダ)。
- 新規にテストしたソースはルート `vitest.config.ts` の coverage `include` へ足す(閾値 85%)。
- 2 系統の原則・overlay の `pointer-events` 規約・iframe の sandbox 構成は変えない。
- 見える UI 文言の取捨はユーザー判断(判断待ち 2 件は本計画外)。

---

## 判断待ち(本計画では着手しない)

| 項目 | 現状 | 選択肢 |
|---|---|---|
| 要約箱の語「却下」と行バッジ「差し戻し」の併存 | 箱はユーザー指定語、バッジは既存語彙 | (a) 箱を「差し戻し」へ統一 (b) 現状維持 + 箱に tooltip「差し戻し済みの申請」 |
| 2 区画同時展開で同一内容の `CommentPanel` が 2 枚 | spec §5.4 が「各区画の右」 | (a) コメント列を一覧の右に 1 枚だけ置く(spec 改訂) (b) 現状維持 |

---

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `editor/web/test/reviewTabView.test.ts` | 新規 | 承認タブの mount テスト |
| `vitest.config.ts` | 修正 | `ReviewTabView.vue` を coverage include へ |
| `editor/web/src/features/editor/useComments.ts` | 修正 | `reload` の世代ガード |
| `editor/web/test/useComments.test.ts` | 修正 | 競合テスト |
| `editor/web/src/features/reviews/services/reviewCompareDocs.ts` | 修正 | `pageAnchors` の index 別マージ |
| `editor/web/test/reviewCompareDocs.test.ts` | 修正 | ページ数不一致のテスト |
| `editor/web/src/features/editor/Inspector.vue` | 修正 | 切替の tablist 化 |
| `editor/web/src/features/editor/comments/CommentPanel.vue` | 修正 | 入力欄の `aria-label` |
| `editor/web/src/features/editor/NoteBubble.vue` | 修正 | 返信欄の `aria-label` |
| `editor/web/src/features/reviews/ReviewTabView.vue` | 修正 | 行ヘッダの構造(button 内 div 解消)、`aria-pressed` 維持 |
| `editor/web/test/commentPanel.test.ts` / `editor/web/test/reviewTabView.test.ts` | 修正 | a11y 属性の固定 |
| `editor/e2e/review_tab.spec.ts` | 修正 | 固定待ちをロケータ待ちへ |
| `editor/shared/src/schemas.ts` / `repositories/ReviewRepository.ts` | 修正 | JSDoc の「承認キュー」語 |

---

### Task 1: 承認タブの mount テスト

**Files:**
- Create: `editor/web/test/reviewTabView.test.ts`
- Modify: `vitest.config.ts`(include に `'editor/web/src/features/reviews/ReviewTabView.vue'`)

**Interfaces:**
- Consumes: `ReviewTabView.vue` の `data-summary` / `data-review-item` / `data-review-toggle`、
  `resolveReviewTarget` の 2 経路(`route.query.template` / `tabMemory.pathFor('edit')`)。
- モックの流儀は旧 `reviewQueueView.test.ts`(`git show 40496bb:editor/web/test/reviewQueueView.test.ts`)
  と同じ: `vi.mock('@/api/repositories')` で `useReviewRepo` / `useTemplateRepo` / `useNoteRepo`、
  `vi.mock('vue-router')` で `useRoute`(`query` を差し替え可能な reactive)と `useRouter`(`push`)、
  `vi.mock('@/stores/auth')`(`isApprover`)、`vi.mock('@/stores/tabMemory')`(`pathFor`)、
  `vi.mock('@/stores/pendingReviews')`(`refresh`)。`ReviewDetail` と `CommentPanel` は
  `global.stubs` でスタブ(組版 iframe を持つため)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// editor/web/test/reviewTabView.test.ts
// =============================================================================
// reviewTabView.test.ts — 承認タブの対象解決・要約箱・アコーディオン・ロール別見出し
// =============================================================================
// 組版 iframe を持つ `ReviewDetail` と `CommentPanel` はスタブにし、一覧の状態機械だけを
// 固定する(実描画は e2e `review_tab.spec.ts` が覆う)。
import { ok, type ReviewRequestMeta } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import ReviewTabView from '@/features/reviews/ReviewTabView.vue';

const listReviewsFn = vi.fn();
const getTemplateFn = vi.fn();
const listNotesFn = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
const route = reactive({ query: {} as Record<string, string> });
const isApprover = { value: true };
const editPath = { value: undefined as string | undefined };

vi.mock('@/api/repositories', () => ({
  useReviewRepo: () => ({ listReviews: listReviewsFn }),
  useTemplateRepo: () => ({ getTemplate: getTemplateFn }),
  useNoteRepo: () => ({ listNotes: listNotesFn }),
}));
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push }) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isApprover }) }));
vi.mock('@/stores/tabMemory', () => ({ useTabMemoryStore: () => ({ pathFor: () => editPath.value }) }));
vi.mock('@/stores/pendingReviews', () => ({ usePendingReviewsStore: () => ({ refresh }) }));

const TPL = 'AM01_510037_20240710_交付版';

function meta(patch: Partial<ReviewRequestMeta>): ReviewRequestMeta {
  return {
    id: 'rv1',
    templateId: TPL,
    attributes: { companyCode: 'AM01', fundCode: '510037', baseDate: '20240710', editionType: '交付版' },
    fundCode: '510037',
    origin: 'edit',
    status: 'pending',
    submittedBy: 'editor1',
    submittedAt: '2026-09-03T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: null,
    ...patch,
  };
}

beforeEach(() => {
  listReviewsFn.mockReset().mockResolvedValue(ok([]));
  getTemplateFn.mockReset().mockResolvedValue(ok({ id: TPL, html: '<div class="page"><p></p></div>', filled: '', css: '' }));
  listNotesFn.mockReset().mockResolvedValue(ok([]));
  push.mockClear();
  refresh.mockClear();
  route.query = {};
  isApprover.value = true;
  editPath.value = undefined;
});

async function mountTab(metas: ReviewRequestMeta[]) {
  listReviewsFn.mockResolvedValue(ok(metas));
  const w = mount(ReviewTabView, {
    global: { stubs: { ReviewDetail: true, CommentPanel: true, AttributeBar: true, FundCodeName: true } },
  });
  await flushPromises();
  return w;
}

describe('対象テンプレートの解決', () => {
  it('query も編集タブの記憶も無ければ誘導の空状態を出す', async () => {
    const w = await mountTab([]);
    expect(w.text()).toContain('編集タブでテンプレートを開いてから');
    expect(w.find('[data-review-summary]').exists()).toBe(false);
  });

  it('編集タブの直前画面 /edit/:id から対象を取る', async () => {
    editPath.value = `/edit/${encodeURIComponent(TPL)}`;
    const w = await mountTab([meta({})]);
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
  });

  it('query の template が編集タブの記憶より優先される', async () => {
    editPath.value = '/edit/OTHER';
    route.query = { template: TPL };
    const w = await mountTab([meta({})]);
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
  });
});

describe('要約箱と絞り込み', () => {
  it('3 箱の件数を対象テンプレートの申請から数え、既定は承認待ちだけを並べる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'a' }),
      meta({ id: 'b', status: 'approved' }),
      meta({ id: 'c', status: 'rejected' }),
      meta({ id: 'd', templateId: 'OTHER' }),
    ]);
    expect(w.find('[data-summary="pending"]').text()).toContain('1');
    expect(w.find('[data-summary="approved"]').text()).toContain('1');
    expect(w.find('[data-summary="rejected"]').text()).toContain('1');
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
  });

  it('箱をもう一度押すと絞り込みが外れ、新しい順に全件並ぶ', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'old', submittedAt: '2026-09-01T00:00:00.000Z' }),
      meta({ id: 'new', status: 'approved', submittedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    await w.find('[data-summary="pending"]').trigger('click');
    const items = w.findAll('[data-review-item]');
    expect(items.map((i) => i.attributes('data-review-item'))).toEqual(['new', 'old']);
  });
});

describe('アコーディオン', () => {
  it('先頭だけ展開され、3 件目を開くと最古が閉じる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b' }), meta({ id: 'c' })]);
    const expandedCount = () => w.findAllComponents({ name: 'ReviewDetail' }).length;
    expect(expandedCount()).toBe(1);
    await w.findAll('[data-review-toggle]')[1].trigger('click');
    await w.findAll('[data-review-toggle]')[2].trigger('click');
    expect(expandedCount()).toBe(2);
  });

  it('絞り込みを切り替えると見えない id を捨て、可視の先頭を開き直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b', status: 'approved' })]);
    await w.find('[data-summary="approved"]').trigger('click');
    expect(w.findAllComponents({ name: 'ReviewDetail' })).toHaveLength(1);
    expect(w.find('[data-review-item="b"]').exists()).toBe(true);
  });
});

describe('ロール別の見出しと決着後', () => {
  it('編集者には「申請状況」を出す', async () => {
    isApprover.value = false;
    route.query = { template: TPL };
    const w = await mountTab([meta({})]);
    expect(w.find('h2').text()).toBe('申請状況');
  });

  it('承認待ちが 0 件になると「編集タブへ戻る」を出し、pendingReviews を取り直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    const detail = w.findComponent({ name: 'ReviewDetail' });
    detail.vm.$emit('decided', meta({ id: 'a', status: 'approved', reviewedBy: 'approver', reviewedAt: 'x' }));
    await flushPromises();
    expect(refresh).toHaveBeenCalled();
    expect(w.text()).toContain('編集タブへ戻る');
  });
});
```

`ReviewTabView.vue` の `<li>` は `:data-review-item="m.id"` を既に持つ前提(持たない場合は
Task 1 で `m.id` を値に入れる 1 行の変更を含める)。

- [ ] **Step 2: RED を確認** — `pnpm exec vitest run --project web editor/web/test/reviewTabView.test.ts`
- [ ] **Step 3: 通るまで最小の修正**(スタブ名・`data-review-item` 値・`h2` の有無など。挙動は変えない)
- [ ] **Step 4: coverage include に追加し `pnpm run test:coverage` で 85% を確認**
- [ ] **Step 5: コミット** `test(editor): 承認タブの状態機械を mount テストで固定する`

---

### Task 2: `useComments.reload` の世代ガード

**Files:**
- Modify: `editor/web/src/features/editor/useComments.ts`
- Modify: `editor/web/test/useComments.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — 2 回の `reload()` を同時に呼び、先に発行した方が後から解決
  しても `all` が後発の結果になること(fake repo の `listNotes` を `Promise` 2 本で手動解決)。
- [ ] **Step 2: 実装** — `useLatest()` を composable 内に持ち、`reload` の先頭で `begin()`、
  `await` 後に `isLatest()` でなければ捨てる。`add`/`reply`/`update`/`remove` の後段 `reload()` も
  同じ関数を通るので追加の処置は不要。why: 対象テンプレートの高速切替で古い版の投稿が
  一覧へ残る。
- [ ] **Step 3: GREEN → コミット** `fix(editor): コメント一覧の再読込を世代で守る`

---

### Task 3: 前後でページ数が違う申請のページジャンプ

**Files:**
- Modify: `editor/web/src/features/reviews/services/reviewCompareDocs.ts`
- Modify: `editor/web/test/reviewCompareDocs.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — before 3 ページ / after 2 ページ(縮退なし)のとき
  `pageAnchors.length === 3` で、index 2 は before 側の id、index 0〜1 は after 側の id。
- [ ] **Step 2: 実装** — `pageAnchors` を「index ごとに after → before の順で引く」マージにする
  (`Math.max(after.pageIds.length, before.pageIds.length)` まで)。`ReviewVisualCompare.gotoPage`
  は両面へ同じ id を送るので、片面に無い id はそのパネルが無視する(既存挙動)。
- [ ] **Step 3: GREEN → コミット** `fix(editor): ページ数が前後で違う申請でもコメント行から該当ページへ飛べるようにする`

---

### Task 4: a11y — 切替の tablist 化と入力欄のラベル

**Files:**
- Modify: `editor/web/src/features/editor/Inspector.vue`(「プロパティ | コメント」)
- Modify: `editor/web/src/features/editor/comments/CommentPanel.vue`
- Modify: `editor/web/src/features/editor/NoteBubble.vue`
- Modify: `editor/web/test/commentPanel.test.ts`、`editor/web/test/reviewTabView.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — `CommentPanel`: `textarea[data-add-content]` と
  `textarea[data-reply-content]` に `aria-label`(「新しいコメント」「返信」)。`ReviewTabView`: 要約箱に
  `aria-pressed`(既存)を固定。
- [ ] **Step 2: 実装** — `Inspector.vue` の 2 ボタンを `role="tablist"` の中の `role="tab"` +
  `:aria-selected` にし、左右矢印キーで切替(`@keydown.left/.right`)。`CommentPanel` /
  `NoteBubble` の textarea に `aria-label`。既存の `data-*` と文言は変えない。
- [ ] **Step 3: e2e スモーク** — `note_bubble.spec.ts` / `comment_panel.spec.ts` を実行(セレクタは
  `data-pane-tab` のまま)。
- [ ] **Step 4: コミット** `feat(editor): 右ペインの切替を tablist にし入力欄へ aria-label を付ける`

---

### Task 5: 承認タブ行ヘッダの構造是正(`button` 内の `div`)

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue`
- Modify: `editor/web/test/reviewTabView.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — `[data-review-toggle]` の中に `div` が無いこと
  (`w.find('[data-review-toggle] div').exists() === false`)。
- [ ] **Step 2: 実装** — 行ヘッダを `<div class="flex …">` にし、`<button data-review-toggle>` は
  chevron + 状態バッジ + 「開閉」の aria-label だけを持つ小さなボタンにする。`AttributeBar` と
  申請者・日時はボタンの外(同じ行)に置き、行全体の `@click` で `toggle(m.id)` を呼ぶ(ボタンは
  `@click.stop` で二重発火を防ぐ)。e2e `review_tab.spec.ts` は `[data-review-toggle]` を押す
  ので互換。
- [ ] **Step 3: コミット** `fix(editor): 承認タブの行ヘッダをボタン入れ子にしない構造へ直す`

---

### Task 6: e2e の固定待ちをロケータ待ちへ

**Files:**
- Modify: `editor/e2e/review_tab.spec.ts`

- [ ] **Step 1**: `waitForTimeout(800/500/1000)` を `expect(locator).toHaveCount/…` の自動待ちに置換。
  `/edit/<id>` 後の 2000ms は `frameLocator('iframe.gjs-frame').locator('.page')` の可視待ちへ。
- [ ] **Step 2**: `--repeat-each=3` で安定を確認 → コミット `test(editor): 承認タブ e2e の固定待ちを要素待ちへ置き換える`

---

### Task 7: 「承認キュー」語の掃除(コード内の残り)

**Files:**
- Modify: `editor/shared/src/schemas.ts`、`editor/shared/src/repositories/ReviewRepository.ts`(JSDoc)
- 対象外: `docs/editor/承認ワークフロー設計.md`(2026-06 の経緯メモ。歴史記録として据え置き)

- [ ] **Step 1**: `grep -rn "承認キュー" editor/` で残りを列挙し、JSDoc を「申請一覧」「承認タブ」へ。
  `pnpm --filter @editor/shared run build && pnpm --filter server run openapi:gen` で OpenAPI の
  description が変わるなら `openapi.json` も再生成してコミットに含める。
- [ ] **Step 2**: コミット `docs(editor): 契約の JSDoc から承認キューの語を外す`

---

### Task 8: 仕上げ

- [ ] `pnpm run ci` 全段階 PASS。
- [ ] 設計正典に変更が要るのは Task 3 の整列規則だけ(「`pageAnchors` は index ごとに after → before」の
  1 文を承認タブの中核原則へ追記)。手引き・設計書は変更なし。
- [ ] push(pre-push CI)→ PR(squash)。`main` との squash 分岐は CLAUDE.md 手順。

---

## 計画の自己レビュー

- 残作業一覧の 3〜10 のうち、判断が要る 7・9 は「判断待ち」へ分離し、残りを Task 1〜7 に写した。
- Task 1 のセレクタ(`data-summary` / `data-review-item` / `data-review-toggle`)は現行の
  `ReviewTabView.vue` に存在(`:data-review-item="m.id"` は要確認)。
- Task 5 は e2e `review_tab.spec.ts` のセレクタ互換を保つ。
- 各 Task は独立(順序依存なし)だが、Task 1 を先に入れると Task 4・5 の回帰網になる。
