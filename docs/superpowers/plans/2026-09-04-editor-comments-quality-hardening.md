# editor コメント機能・承認タブ 品質強化 Implementation Plan(改訂 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-09-03 に入れたコメント機能と承認タブ(PR #64、`main` の `7ff3f1c`)について、最終レビューと
反対目線レビューで残った「動作はするが補強が要る」項目を潰す。機能追加はしない。

**Architecture:** 変更は `editor/web` に閉じる。順序は依存に従う: 承認タブの mount テスト(回帰網)→
行ヘッダの構造是正 → コメント宛先の区画別化 → `focusPart` の沈黙失敗の可視化 → a11y の小修正 →
競合ガード → ページ整列 → e2e の待ち方 → 語の掃除。仕様判断が要る 1 件(要約箱の語)は**判断待ち**。

**Tech Stack:** Vue 3 / vitest + @vue/test-utils 2.5 / Playwright / TypeScript

**Spec:** `docs/superpowers/specs/2026-09-03-editor-reader-comments-design.md`(§4・§5)。本計画は
§5.4「各区画の右にコメントパネル」を保ち、宛先の状態だけを区画ごとに分ける(§5.4 の補足)。

## Global Constraints

- 作業ディレクトリはリポジトリルート `C:\Users\caads\workspace`。ブランチは常設
  `chore/deps-latest-offline-bundle`。
- テストはルートから `pnpm exec vitest run --project web <file>`、e2e は
  `pnpm exec playwright test -c editor/playwright.config.ts <spec>`、型は `pnpm run typecheck:editor`
  (**`editor/web/test/**` は typecheck 対象外**。fixture の形は目視で契約に合わせる)。
- `editor/**` を変更したコミットの直前に **必ず** `pnpm exec biome check --write editor/<変更ファイル…>`。
- コミットは日本語 Conventional Commits + 空行 + `Claude-Session:` 行。auto-push は通常動作
  (コミットごとに pre-push CI 11〜12 分)。連続コミット中は `.claude/auto-push.paused` を置き、
  最後に外して 1 回 push する。
- コメントは `docs/コメント規約.md`(なぜを書く・経緯を書かない・新規 `.ts/.vue` は箱型ヘッダ)。
- coverage の閾値 85% は**全体(グローバル)**で per-file ではない(`vitest.config.ts` の `thresholds`)。
  新規にテストしたソースは `include` へ足す。
- 2 系統の原則・overlay の `pointer-events` 規約・iframe の sandbox 構成は変えない。
- e2e が掴むセレクタ(`[data-summary]` / `[data-review-item]` / `[data-review-toggle]` /
  `[data-pane-tab]` / `data-add-*` / `data-note-*`)と可視文言は変えない。
- 見える UI 文言の取捨はユーザー判断(判断待ち 1 件は本計画外)。

---

## 判断待ち(本計画では着手しない)

| 項目 | 現状 | 選択肢 |
|---|---|---|
| 要約箱の語「却下」と行バッジ「差し戻し」の併存 | 箱はユーザー指定語、バッジは既存語彙 | (a) 箱を「差し戻し」へ統一 (b) 現状維持 + 箱に tooltip「差し戻し済みの申請」 |

(旧「2 区画で同一の CommentPanel が 2 枚」は、宛先の共有が挙動の欠陥である点を Task 3 で解消し、
パネルの枚数自体は spec §5.4 のまま据え置く。)

---

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `editor/web/test/reviewTabView.test.ts` | 新規 | 承認タブの mount テスト |
| `vitest.config.ts` | 修正 | `ReviewTabView.vue` を coverage include へ |
| `editor/web/src/features/reviews/ReviewTabView.vue` | 修正 | 行ヘッダ構造・`aria-expanded`・宛先の区画別化・`focusPart` の可視化 |
| `editor/web/src/features/reviews/ReviewDetail.vue` | 修正 | `gotoPage` が文字差分タブでも見た目比較へ切り替えて送る |
| `editor/web/src/features/editor/comments/CommentPanel.vue` | 修正 | 到達不能パーツ行の明示、編集欄の `aria-label` |
| `editor/web/src/features/editor/NoteBubble.vue` | 修正 | 編集欄の `aria-label` |
| `editor/web/src/features/editor/Inspector.vue` | 修正 | 切替ボタンの `aria-pressed` |
| `editor/web/test/commentPanel.test.ts` | 修正 | 上記の固定 |
| `editor/web/src/features/editor/useComments.ts` / `test/useComments.test.ts` | 修正 | `reload` の世代ガード |
| `editor/web/src/features/reviews/services/reviewCompareDocs.ts` / `test/reviewCompareDocs.test.ts` | 修正 | `pageAnchors` の延長 |
| `editor/web/test/reviewPartMaps.test.ts` | 修正 | `filled` 非空側 |
| `editor/e2e/review_tab.spec.ts` | 修正 | 固定待ちの個別置換 |
| `editor/shared/src/schemas.ts` / `index.ts` / `repositories/ReviewRepository.ts`、`editor/server/test/reviews.metaFailure.test.ts` | 修正 | 「承認キュー」語 |

---

### Task 1: 承認タブの mount テスト

**Files:**
- Create: `editor/web/test/reviewTabView.test.ts`
- Modify: `vitest.config.ts`(include に `'editor/web/src/features/reviews/ReviewTabView.vue'`)

**Interfaces:**
- Consumes: `ReviewTabView.vue` の `data-summary` / `:data-review-item="m.id"` / `data-review-toggle`(いずれも存在)、
  `resolveReviewTarget` の 2 経路(`route.query.template` / `tabMemory.pathFor('edit')`)。
- モック: `@/api/repositories`(`useReviewRepo.listReviews` / `useTemplateRepo.getTemplate` /
  `useNoteRepo.listNotes` — マウント時に呼ばれるのはこの 3 つだけ)、`vue-router`(`useRoute` は
  `reactive({ query })`、`useRouter` は `{ push }`)、`@/stores/auth`(**getter** で `isApprover` を返す。
  旧キューテストの `{ value }` 直渡しは常に truthy で編集者ロールを検証できない)、
  `@/stores/tabMemory`(`pathFor`)、`@/stores/pendingReviews`(`refresh`)。`ReviewDetail` /
  `CommentPanel` / `AttributeBar` は `global.stubs` でスタブ(`<script setup>` のローカル import でも
  VTU 2.5 は `setupState` から名前解決するので `findAllComponents({ name: 'ReviewDetail' })` が効く)。
- `getTemplate` の fixture は契約 `Template = { meta, html, css, filled }` の形にする(test は typecheck
  対象外で嘘の形が通ってしまう)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// editor/web/test/reviewTabView.test.ts
// =============================================================================
// reviewTabView.test.ts — 承認タブの対象解決・要約箱・アコーディオン・ロール別見出し
// =============================================================================
// 組版 iframe を持つ `ReviewDetail` と `CommentPanel` はスタブにし、一覧の状態機械だけを
// 固定する(実描画は e2e `review_tab.spec.ts` が覆う)。stub からも `focus` を emit して、
// スタブ化で死ぬ `focusPart` / `goEdit` の経路を通す。
import { ok, type ReviewRequestMeta, type Template } from '@editor/shared';
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
const auth = reactive({ isApprover: true });
const editPath = { value: undefined as string | undefined };

vi.mock('@/api/repositories', () => ({
  useReviewRepo: () => ({ listReviews: listReviewsFn }),
  useTemplateRepo: () => ({ getTemplate: getTemplateFn }),
  useNoteRepo: () => ({ listNotes: listNotesFn }),
}));
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push }) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/tabMemory', () => ({ useTabMemoryStore: () => ({ pathFor: () => editPath.value }) }));
vi.mock('@/stores/pendingReviews', () => ({ usePendingReviewsStore: () => ({ refresh }) }));

const TPL = 'AM01_510037_20240710_交付版';
const ATTRS = { companyCode: 'AM01', fundCode: '510037', baseDate: '20240710', editionType: '交付版' };

function meta(patch: Partial<ReviewRequestMeta>): ReviewRequestMeta {
  return {
    id: 'rv1', templateId: TPL, attributes: ATTRS, fundCode: '510037', origin: 'edit', status: 'pending',
    submittedBy: 'editor1', submittedAt: '2026-09-03T00:00:00.000Z', reviewedBy: null, reviewedAt: null,
    comment: null, baseHash: null, ...patch,
  };
}

/** 契約どおりの `Template`。`filled` は REST と同じく空にし、`html` の構造からパーツを引く。 */
function template(): Template {
  return {
    meta: { id: TPL, attributes: ATTRS, fundCode: '510037', updatedAt: '2026-09-03T00:00:00.000Z', updatedBy: 'x' } as Template['meta'],
    html: '<div class="page"><h1 id="cover"></h1><p></p></div>',
    css: '',
    filled: '',
  };
}

beforeEach(() => {
  listReviewsFn.mockReset().mockResolvedValue(ok([]));
  getTemplateFn.mockReset().mockResolvedValue(ok(template()));
  listNotesFn.mockReset().mockResolvedValue(ok([]));
  push.mockClear();
  refresh.mockClear();
  route.query = {};
  auth.isApprover = true;
  editPath.value = undefined;
});

const CommentPanelStub = {
  name: 'CommentPanel',
  props: ['entries', 'selectedKey', 'canAdd', 'partLabels', 'compact'],
  emits: ['focus'],
  template: '<button data-stub-focus @click="$emit(\'focus\', \'.page#1/h1#1\')" />',
};

async function mountTab(metas: ReviewRequestMeta[]) {
  listReviewsFn.mockResolvedValue(ok(metas));
  const w = mount(ReviewTabView, {
    global: { stubs: { ReviewDetail: true, CommentPanel: CommentPanelStub, AttributeBar: true } },
  });
  await flushPromises();
  return w;
}
```

`meta.meta` の正確な形は `editor/shared/src/schemas.ts` の `TemplateMeta` を見て合わせる(不足フィールドは
契約どおり埋める。`as` で誤魔化さない)。以下の `describe` を続ける。

```ts
describe('対象テンプレートの解決', () => {
  it('query も編集タブの記憶も無ければ誘導の空状態を出し、「編集タブへ」で一覧へ戻る', async () => {
    const w = await mountTab([]);
    expect(w.text()).toContain('編集タブでテンプレートを開いてから');
    expect(w.find('[data-review-summary]').exists()).toBe(false);
    await w.find('button').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'edit' });
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
      meta({ id: 'a' }), meta({ id: 'b', status: 'approved' }), meta({ id: 'c', status: 'rejected' }),
      meta({ id: 'd', templateId: 'OTHER' }),
    ]);
    expect(w.find('[data-summary="pending"]').text()).toContain('1');
    expect(w.find('[data-summary="approved"]').text()).toContain('1');
    expect(w.find('[data-summary="rejected"]').text()).toContain('1');
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    expect(w.find('[data-summary="pending"]').attributes('aria-pressed')).toBe('true');
  });

  it('箱をもう一度押すと絞り込みが外れ、新しい順に全件並ぶ', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'old', submittedAt: '2026-09-01T00:00:00.000Z' }),
      meta({ id: 'new', status: 'approved', submittedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    await w.find('[data-summary="pending"]').trigger('click');
    expect(w.findAll('[data-review-item]').map((i) => i.attributes('data-review-item'))).toEqual(['new', 'old']);
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
    expect(w.findAll('[data-review-toggle]')[0].attributes('aria-expanded')).toBe('false');
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
    auth.isApprover = false;
    route.query = { template: TPL };
    const w = await mountTab([meta({})]);
    expect(w.find('h2').text()).toBe('申請状況');
  });

  it('承認待ちが 0 件になると「編集タブへ戻る」を出し、pendingReviews を取り直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    w.findComponent({ name: 'ReviewDetail' }).vm.$emit('decided', meta({ id: 'a', status: 'approved', reviewedBy: 'approver', reviewedAt: 'x' }));
    await flushPromises();
    expect(refresh).toHaveBeenCalled();
    expect(w.text()).toContain('編集タブへ戻る');
  });

  it('コメント一覧の行から宛先が選ばれる(stub の focus 経由)', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-focus]').trigger('click');
    expect((w.find('select[aria-label="コメントの宛先パーツ"]').element as HTMLSelectElement).value).toBe('.page#1/h1#1');
  });
});
```

`aria-expanded` の期待は Task 2 で付くまで失敗する。Task 1 では**その 1 行だけ**を `it.todo` にせず、
Task 2 完了後に有効化する(Task 1 のコミット時点では該当 `expect` をコメントアウトして TODO を残さない
= 行ごと Task 2 で追加する形にする)。

- [ ] **Step 2: RED を確認** — `pnpm exec vitest run --project web editor/web/test/reviewTabView.test.ts`
- [ ] **Step 3: 通るまで最小の修正**(スタブ名・`h2` の有無・`meta.meta` の形。挙動は変えない)
- [ ] **Step 4: include に追加し `pnpm run test:coverage` で全体閾値を確認**(閾値はグローバル)
- [ ] **Step 5: コミット** `test(editor): 承認タブの状態機械を mount テストで固定する`

---

### Task 2: 行ヘッダの構造是正(`button` 内の `div`)と `aria-expanded`

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue`(行ヘッダ)
- Modify: `editor/web/test/reviewTabView.test.ts`

方針は**安い方**を採る: `<button data-review-toggle>` を 1 つのまま保ち、中の `AttributeBar`(ルートが
`div`)を span 構成の属性表示に置き換える。div クリック + `@click.stop` の二重構造は作らない
(ハンドラ無しの `@click.stop` は e2e `review_tab.spec.ts` の `[data-review-toggle]` クリックを無効にする)。

- [ ] **Step 1: 失敗するテストを書く** — `reviewTabView.test.ts` に
  `expect(w.find('[data-review-toggle] div').exists()).toBe(false)` と、Task 1 で保留した
  `aria-expanded` の期待(`'true'` / `'false'`)を足す。
- [ ] **Step 2: 実装** — 行ヘッダの `<AttributeBar>` を、`AttributeBar.vue` と同じ 4 項目
  (委託会社コード / ファンドコード(`FundCodeName`) / 基準日 / 版種)を `span` だけで横並びにする
  ローカル markup に置き換える(`AttributeBar` の見た目クラスを流用。共有部品にしたい場合は
  `AttributeBar.vue` に `inline` prop を足して `span` ルートで描く方を選び、二重実装を避ける)。
  `<button>` に `:aria-expanded="expanded.includes(m.id)"` と、行を識別できる
  `:aria-label="\`申請 ${m.submittedBy} ${formatDateTimeShort(m.submittedAt)} を開閉\`"` を付ける。
- [ ] **Step 3: e2e** — `review_tab.spec.ts` を実行(セレクタ互換の確認)。
- [ ] **Step 4: コミット** `fix(editor): 承認タブの行ヘッダをボタン内に div を持たない構造にし aria-expanded を付ける`

---

### Task 3: コメント宛先の区画別化

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue`
- Modify: `editor/web/test/reviewTabView.test.ts`

現状は `selectedKey` が 1 つで、2 区画を同時展開すると片方の 宛先 select がもう片方も動かす。
コメント自体はテンプレート単位で共有(spec)だが、**宛先の選択は区画ごと**が正しい。

- [ ] **Step 1: 失敗するテストを書く** — 2 件展開し、1 区画目の select を選んでも 2 区画目の select は
  `null` のまま。
- [ ] **Step 2: 実装** — `selectedKey` を `reactive<Record<string, string | null>>({})`(reqId → key)に
  し、`focusPart(reqId, key)` / select の `v-model` / `useComments` の `currentKey` getter を
  「直近に操作した区画」のキーで解決する(`activeReqId` ref を 1 つ持ち、select 操作と `focus` で更新)。
  `targetId` 変化時のリセットは両方を空にする。why: 一覧はテンプレ共有でも、投稿先を選ぶ操作は
  区画(申請)の文脈で行う。
- [ ] **Step 3: コミット** `fix(editor): 承認タブのコメント宛先を区画ごとに持つ`

---

### Task 4: `focusPart` の沈黙失敗を可視化する

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue`、`ReviewDetail.vue`
- Modify: `editor/web/src/features/editor/comments/CommentPanel.vue`、`editor/web/test/commentPanel.test.ts`

現状 3 つの沈黙: ①確定版に無いパーツ(`focusPart` が return)②文字差分タブ表示中(`ReviewDetail.gotoPage`
が return)③`origin: 'create'` の申請は確定版が無く `partLabels` が空で全行が無反応。

- [ ] **Step 1: 失敗するテストを書く** — `commentPanel.test.ts`: `partLabels` に無いキーの行は
  `aria-disabled="true"` と title「この版の構造には無いパーツです」を持ち、クリックしても `focus` を
  emit しない(既存の「削除済みパーツ」表示テストを拡張)。`reviewTabView.test.ts`: `ReviewDetail` stub に
  `gotoPage` spy を持たせ、`focus` 後に呼ばれること。
- [ ] **Step 2: 実装** — `CommentPanel`: 到達不能行は emit しない + `aria-disabled`/title。
  `ReviewDetail.gotoPage`: 文字差分タブなら `activeTab = 'visual'` に切り替えてから
  `nextTick` 後に `visualRef.gotoPage(index)`(「行リストにページの概念が無い」ので見た目比較へ
  寄せる、を why に書く)。`ReviewTabView`: `origin === 'create'` の申請は宛先 select と `CommentPanel`
  の `canAdd` を無効にし、区画のコメント列上部に 1 行「新規作成の申請にはパーツ宛のコメントを
  付けられません(確定版がありません)」を出す。
- [ ] **Step 3: コミット** `fix(editor): 承認タブでコメント行の移動が効かない条件を明示する`

---

### Task 5: a11y の小修正

**Files:**
- Modify: `editor/web/src/features/editor/Inspector.vue`(切替 2 ボタンに `:aria-pressed`。tablist 化は
  しない — `aria-controls`/tabpanel/roving tabindex を伴わない `role=tab` は退行。矢印キーの慣行も無い)
- Modify: `editor/web/src/features/editor/comments/CommentPanel.vue`(**編集用** textarea 2 箇所:
  親編集・返信編集に `aria-label="コメントを編集"` / `"返信を編集"`。新規・返信入力は placeholder が
  名前になっているので触らない)
- Modify: `editor/web/src/features/editor/NoteBubble.vue`(編集用 textarea 2 箇所に同じ `aria-label`)
- Modify: `editor/web/test/commentPanel.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — 行展開 → 編集開始で `textarea[aria-label="コメントを編集"]` が
  存在する。
- [ ] **Step 2: 実装 → GREEN → e2e `note_bubble.spec.ts` / `comment_panel.spec.ts` を実行**
- [ ] **Step 3: コミット** `feat(editor): コメント編集欄に aria-label を付け右ペイン切替に aria-pressed を付ける`

---

### Task 6: `useComments.reload` の世代ガード

**Files:**
- Modify: `editor/web/src/features/editor/useComments.ts`、`editor/web/test/useComments.test.ts`

競合は実在(`useTemplateEditor` の版読込と承認タブの `watch(targetId)`)。変異後の `reload()` は
新しい世代なので壊れない。`!tid` の早期 return は同期なのでガード不要(コメントに書く)。

- [ ] **Step 1: 失敗するテストを書く** — fake repo の `listNotes` を手動解決の Promise 2 本にし、先発が
  後から解決しても `all` は後発の結果。
- [ ] **Step 2: 実装** — `useLatest()` を composable 内に 1 つ持ち、`reload` の `await` 後に `isLatest()`
  でなければ捨てる。
- [ ] **Step 3: コミット** `fix(editor): コメント一覧の再読込を世代で守る`

---

### Task 7: 前後でページ数が違う申請の `pageAnchors`

**Files:**
- Modify: `editor/web/src/features/reviews/services/reviewCompareDocs.ts`、`test/reviewCompareDocs.test.ts`
- Modify: `editor/web/test/reviewPartMaps.test.ts`(`filled` 非空側の 1 ケース)

縮退は片側ごとに自分の期待ページ数で判定するので、前 3 / 後 2 は縮退せずに成立する。id は index 由来で
両側一致 → 修正は `pageAnchors[i] = after.pageIds[i] ?? before.pageIds[i]` で配列を長い方まで延ばすだけ。
飛ぶのは**修正前パネルだけ**(修正後にそのページは無い)。なお `partPages` は確定版由来で第 3 の文書
であり、根本は Task 4 の可視化で受ける。

- [ ] **Step 1: 失敗するテストを書く** — before 3 / after 2(縮退なし)で `pageAnchors.length === 3`、
  index 2 は before 側の id。`reviewPartMaps.test.ts` に `filled` 非空の HTML から引くケース。
- [ ] **Step 2: 実装(1 行 + コメント)** → コミット
  `fix(editor): ページ数が前後で違う申請でも修正前側の該当ページへ送る`

---

### Task 8: e2e の固定待ちを個別に置き換える

**Files:**
- Modify: `editor/e2e/review_tab.spec.ts`

| 箇所 | 扱い |
|---|---|
| 承認タブクリック後 800ms / toggle 後 500ms / 差し戻し後 1000ms | 削除(直後の `expect` が自動リトライ) |
| `login` の 800ms | 削除しない。ログイン後の着地(アプリヘッダのタブ群)のロケータ待ちへ置換 |
| `submitOnce` の 1000ms | 完了シグナル(成功 toast の出現 or 申請ダイアログの消失)待ちへ置換 |
| `/edit/:id` 後の 2000ms | `frameLocator('iframe.gjs-frame').locator('.page')` の可視待ちへ。GrapesJS 初期化完了を待つ意図をコメントに残す |

- [ ] **Step 1: 置換 → `--repeat-each=3` で安定確認 → コミット** `test(editor): 承認タブ e2e の固定待ちを要素待ちへ置き換える`

---

### Task 9: 「承認キュー」語の掃除

**Files:**
- Modify: `editor/shared/src/schemas.ts`(2 箇所)、`editor/shared/src/index.ts`(1 箇所)、
  `editor/shared/src/repositories/ReviewRepository.ts`(1 箇所)、`editor/server/test/reviews.metaFailure.test.ts`(1 箇所)
- 対象外: `docs/editor/承認ワークフロー設計.md`(2026-06 の経緯メモ)

いずれも JSDoc / コメントで、OpenAPI(`.meta({ description })`)には出ない → 再生成は不要。

- [ ] **Step 1**: `grep -rn "承認キュー" editor/` で 5 箇所を「申請一覧」「承認タブ」へ → `pnpm run check:comments`
- [ ] **Step 2**: コミット `docs(editor): コードコメントから承認キューの語を外す`

---

### Task 10: 仕上げ

- [ ] `pnpm run ci` 全段階 PASS。
- [ ] 設計正典の承認タブ中核原則へ 2 文追記: 「`pageAnchors` は index ごとに after → before で引き、
  修正前にしか無いページは修正前パネルだけが動く」「コメント宛先の選択は区画(申請)ごと」。
- [ ] push → PR(squash)。`main` との squash 分岐は CLAUDE.md 手順。

---

## 計画の自己レビュー

- 反対目線レビューの指摘を反映: `isApprover` モックを getter/reactive に(旧テストの穴)/ `Template`
  契約どおりの fixture / `data-review-item` は既存 / 閾値はグローバル / tablist・矢印キーは不採用 /
  `aria-label` は無名の編集欄 4 箇所へ / 行ヘッダは単一 button + span 構成で `@click.stop` を使わない /
  `aria-expanded` 追加 / `pageAnchors` は 1 行 / OpenAPI 再生成は不要 / `focusPart` の沈黙 3 種を新 Task /
  宛先の共有を新 Task。
- 順序依存: Task 1 → 2 → 3 → 4(いずれも `reviewTabView.test.ts` を触る)。5〜9 は独立。
- e2e が掴むセレクタと可視文言は全 Task で不変。
