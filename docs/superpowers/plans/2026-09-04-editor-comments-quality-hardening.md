# editor コメント機能・承認タブ 品質強化 Implementation Plan(改訂 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-09-03 に入れたコメント機能と承認タブ(PR #64、`main` の `7ff3f1c`)について、最終レビューと
反対目線レビュー 2 回で残った「動作はするが補強が要る」項目を潰す。機能追加はしない。

**Architecture:** 変更は `editor/web`(+ shared のコメント 4 箇所)に閉じる。順序は依存に従う:
承認タブの mount テスト(回帰網)→ 行ヘッダの構造是正 → コメント宛先の区画別化 → `focusPart` の
沈黙失敗の可視化 → a11y の小修正 → 競合ガード → ページ整列 → e2e の待ち方 → 語の掃除 → 仕上げ。
仕様判断が要る 1 件(要約箱の語)は**判断待ち**。

**Tech Stack:** Vue 3.5 / vitest + @vue/test-utils 2.5 / Playwright / TypeScript

**Spec:** `docs/superpowers/specs/2026-09-03-editor-reader-comments-design.md`(§4・§5)。本計画は
§5.4「各区画の右にコメントパネル」を保ち、宛先の状態と投稿先の指定だけを区画ごとに分ける(§5.4 の補足)。

## Global Constraints

- 作業ディレクトリはリポジトリルート `C:\Users\caads\workspace`。ブランチは常設
  `chore/deps-latest-offline-bundle`。
- テストはルートから `pnpm exec vitest run --project web <file>`、e2e は
  `pnpm exec playwright test -c editor/playwright.config.ts <spec>`、型は `pnpm run typecheck:editor`
  (**`editor/web/test/**` は typecheck 対象外**。fixture の形は契約を読んで手で合わせ、`as` で隠さない)。
- `editor/**` を変更したコミットの直前に **必ず** `pnpm exec biome check --write editor/<変更ファイル…>`。
- コミットは日本語 Conventional Commits + 空行 + `Claude-Session:` 行。auto-push は通常動作
  (コミットごとに pre-push CI 11〜12 分)。連続コミット中は `.claude/auto-push.paused` を置き、
  最後に外して 1 回 push する。
- コメントは `docs/コメント規約.md`(なぜを書く・経緯を書かない・TODO を残さない・新規 `.ts/.vue` は
  箱型ヘッダ)。
- coverage の閾値 85% は**全体(グローバル)**で per-file ではない(`vitest.config.ts` の `thresholds`)。
  新規にテストしたソースは `include` へ足す。
- 2 系統の原則・overlay の `pointer-events` 規約・iframe の sandbox 構成は変えない。
- e2e が掴むセレクタ(`[data-summary]` / `[data-review-item]` / `[data-review-toggle]` /
  `[data-pane-tab]` / `data-add-*` / `data-note-*`)と可視文言は変えない。
- 見える UI 文言の取捨はユーザー判断(判断待ち 1 件は本計画外)。
- web の単体テストで `template:` 文字列の stub を使えるのは、`vue` の Node 解決が full build
  (`index.mjs` → `dist/vue.cjs.js`、compile 込み)だから。`resolve.conditions` を変えると黙って壊れる
  ので、stub は `h()` の render 関数で書く(本計画のコードはそうしている)。
- 承認タブのパーツ列挙(`partLabels` / `partPages`)は**確定版の構造**(`ReviewTabView.loadParts`)から
  作る。申請側にだけ在る追加パーツにはコメントを宛てられない(本質的制約。Task 4・10 で明記)。

---

## 判断待ち(本計画では着手しない)

| 項目 | 現状 | 選択肢 |
|---|---|---|
| 要約箱の語「却下」と行バッジ「差し戻し」の併存 | 箱はユーザー指定語、バッジは既存語彙 | (a) 箱を「差し戻し」へ統一 (b) 現状維持 + 箱に tooltip「差し戻し済みの申請」 |

---

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `editor/web/test/reviewTabView.test.ts` | 新規 | 承認タブの mount テスト |
| `vitest.config.ts` | 修正 | `ReviewTabView.vue` を coverage include へ |
| `editor/web/src/components/AttributeBar.vue` | 修正 | `inline` prop(`span` ルート) |
| `editor/web/src/features/reviews/ReviewTabView.vue` | 修正 | 行ヘッダ(`inline` AttributeBar・`aria-expanded`)・宛先の区画別化・`focusPart` の可視化 |
| `editor/web/src/features/reviews/ReviewDetail.vue` | 修正 | `gotoPage` が文字差分タブでも見た目比較へ切り替えて送る |
| `editor/web/src/features/reviews/ReviewVisualCompare.vue` | 修正 | ページ送りの準備待ち(保留 index) |
| `editor/web/src/features/editor/useComments.ts` / `test/useComments.test.ts` | 修正 | `add` の `pathKey` 明示、`reload` の世代ガード |
| `editor/web/src/features/editor/comments/CommentPanel.vue` | 修正 | 到達不能行の明示、編集欄の `aria-label` |
| `editor/web/src/features/editor/EditorView.vue` | 影響 | `CommentPanel` の `focus` が到達不能行で来なくなる(無害、Files に記録) |
| `editor/web/src/features/editor/NoteBubble.vue` | 修正 | 編集欄の `aria-label` |
| `editor/web/src/features/editor/Inspector.vue` | 修正 | 切替ボタンの `aria-pressed` |
| `editor/web/test/commentPanel.test.ts` | 修正 | 上記の固定 |
| `editor/web/src/features/reviews/services/reviewCompareDocs.ts` / `test/reviewCompareDocs.test.ts` | 修正 | `pageAnchors` の延長 |
| `editor/e2e/review_tab.spec.ts` | 修正 | 固定待ちの個別置換 |
| `editor/shared/src/schemas.ts` / `index.ts` / `repositories/ReviewRepository.ts`、`editor/server/test/reviews.metaFailure.test.ts` | 修正 | 「承認キュー」語 |
| `docs/editor/src/設計正典.md`、`docs/editor/images/*.png`、`docs/editor/*.html` | 修正 | 仕上げ |

---

### Task 1: 承認タブの mount テスト

**Files:**
- Create: `editor/web/test/reviewTabView.test.ts`
- Modify: `vitest.config.ts`(include に `'editor/web/src/features/reviews/ReviewTabView.vue'`)

**Interfaces:**
- Consumes: `ReviewTabView.vue` の `data-summary` / `:data-review-item="m.id"` / `data-review-toggle`(いずれも存在)、
  `resolveReviewTarget` の 2 経路(`route.query.template` / `tabMemory.pathFor('edit')`)、宛先 select
  (`aria-label="コメントの宛先パーツ"`)。
- モック: `@/api/repositories`(`useReviewRepo.listReviews` / `useTemplateRepo.getTemplate` +
  `getSampleData`(`FundCodeName` → `useFundNames` が呼ぶ。Task 2 で行ヘッダに `FundCodeName` が入るため
  最初から用意)/ `useNoteRepo.listNotes`)、`vue-router`(`useRoute` は `reactive({ query })`、`useRouter`
  は `{ push }`)、`@/stores/auth`(`reactive({ isApprover })` を返す。旧キューテストの `{ value }` 直渡しは
  常に truthy で編集者ロールを検証できない)、`@/stores/tabMemory`(`pathFor`)、`@/stores/pendingReviews`
  (`refresh`)。
- stub: `ReviewDetail` は `gotoPage: vi.fn()` を expose するカスタム stub(自動 stub は `gotoPage` を持たず
  `focusPart` が TypeError になる)。`CommentPanel` は `focus` を emit できるカスタム stub。`AttributeBar` /
  `FundCodeName` は `true`。stub は `h()` の render 関数で書く(Global Constraints 参照)。
- fixture: `getTemplate` は契約 `Template = { meta, html, css, filled }`、`meta` は `TemplateMeta` =
  `{ id, attributes, fileName, status: 'draft'|'published', updatedAt, updatedBy }` を**全部**埋める。`as` は使わない。
  `html` の `<h1>` に `id` を付けない(構造キーは `id` を優先するため、`id="cover"` だと `.page#1/cover#1` になる)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// editor/web/test/reviewTabView.test.ts
// =============================================================================
// reviewTabView.test.ts — 承認タブの対象解決・要約箱・アコーディオン・ロール別見出し・宛先
// =============================================================================
// 組版 iframe を持つ `ReviewDetail` と `CommentPanel` は render 関数の stub にし、一覧の状態機械と
// 宛先の受け渡しだけを固定する(実描画は e2e `review_tab.spec.ts` が覆う)。stub からも `focus` を
// emit し、stub 化で通らなくなる `focusPart` / `goEdit` の経路を通す。
import { ok, type ReviewRequestMeta, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import ReviewTabView from '@/features/reviews/ReviewTabView.vue';

const listReviewsFn = vi.fn();
const getTemplateFn = vi.fn();
const getSampleDataFn = vi.fn();
const listNotesFn = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
const gotoPage = vi.fn();
const route = reactive({ query: {} as Record<string, string> });
const auth = reactive({ isApprover: true });
const editPath = { value: undefined as string | undefined };

vi.mock('@/api/repositories', () => ({
  useReviewRepo: () => ({ listReviews: listReviewsFn }),
  useTemplateRepo: () => ({ getTemplate: getTemplateFn, getSampleData: getSampleDataFn }),
  useNoteRepo: () => ({ listNotes: listNotesFn }),
}));
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push }) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/tabMemory', () => ({ useTabMemoryStore: () => ({ pathFor: () => editPath.value }) }));
vi.mock('@/stores/pendingReviews', () => ({ usePendingReviewsStore: () => ({ refresh }) }));

const TPL = 'AM01_510037_20240710_交付版';
const ATTRS = { companyCode: 'AM01', fundCode: '510037', baseDate: '20240710', editionType: '交付版' };
const COVER = '.page#1/h1#1';

function meta(patch: Partial<ReviewRequestMeta>): ReviewRequestMeta {
  return {
    id: 'rv1', templateId: TPL, attributes: ATTRS, fundCode: '510037', origin: 'edit', status: 'pending',
    submittedBy: 'editor1', submittedAt: '2026-09-03T00:00:00.000Z', reviewedBy: null, reviewedAt: null,
    comment: null, baseHash: null, ...patch,
  };
}

/** 契約どおりの `Template`。`filled` は REST と同じく空にし、`html` の構造からパーツを引く。 */
function template(patch: Partial<Template> = {}): Template {
  return {
    meta: {
      id: TPL, attributes: ATTRS, fileName: `${TPL}.html`, status: 'published',
      updatedAt: '2026-09-03T00:00:00.000Z', updatedBy: 'editor1',
    },
    html: '<div class="page"><h1></h1><p></p></div>',
    css: '',
    filled: '',
    ...patch,
  };
}

/** `ReviewDetail` の代役。`gotoPage` を expose して `focusPart` の到達を数えられるようにする。 */
const ReviewDetailStub = defineComponent({
  name: 'ReviewDetail',
  props: { reqId: { type: String, required: true } },
  emits: ['decided'],
  setup(_, { expose }) {
    expose({ gotoPage });
    return () => h('div', { 'data-stub-detail': '' });
  },
});

/** `CommentPanel` の代役。ボタン 1 つで `focus` を emit する。 */
const CommentPanelStub = defineComponent({
  name: 'CommentPanel',
  props: ['entries', 'selectedKey', 'canAdd', 'partLabels', 'compact'],
  emits: ['focus'],
  setup(_, { emit }) {
    return () => h('button', { 'data-stub-focus': '', onClick: () => emit('focus', COVER) });
  },
});

beforeEach(() => {
  listReviewsFn.mockReset().mockResolvedValue(ok([]));
  getTemplateFn.mockReset().mockResolvedValue(ok(template()));
  getSampleDataFn.mockReset().mockResolvedValue(ok({}));
  listNotesFn.mockReset().mockResolvedValue(ok([]));
  push.mockClear();
  refresh.mockClear();
  gotoPage.mockClear();
  route.query = {};
  auth.isApprover = true;
  editPath.value = undefined;
});

async function mountTab(metas: ReviewRequestMeta[]) {
  listReviewsFn.mockResolvedValue(ok(metas));
  const w = mount(ReviewTabView, {
    global: {
      stubs: { ReviewDetail: ReviewDetailStub, CommentPanel: CommentPanelStub, AttributeBar: true, FundCodeName: true },
    },
  });
  await flushPromises();
  return w;
}

describe('対象テンプレートの解決', () => {
  it('query も編集タブの記憶も無ければ誘導の空状態を出し、「編集タブへ」で一覧へ戻る', async () => {
    const w = await mountTab([]);
    expect(w.text()).toContain('編集タブでテンプレートを開いてから');
    expect(w.find('[data-review-summary]').exists()).toBe(false);
    await w.find('button').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'edit' });
  });

  it('編集タブの直前画面 /edit/:id から対象を取り、「編集画面へ」はその id へ飛ぶ', async () => {
    editPath.value = `/edit/${encodeURIComponent(TPL)}`;
    const w = await mountTab([meta({})]);
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    await w.findAll('button').find((b) => b.text() === '編集画面へ')?.trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'editor', params: { id: TPL } });
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
    const expandedCount = () => w.findAll('[data-stub-detail]').length;
    expect(expandedCount()).toBe(1);
    await w.findAll('[data-review-toggle]')[1].trigger('click');
    await w.findAll('[data-review-toggle]')[2].trigger('click');
    expect(expandedCount()).toBe(2);
    expect(w.find('[data-review-item="a"] [data-stub-detail]').exists()).toBe(false);
  });

  it('絞り込みを切り替えると見えない id を捨て、可視の先頭を開き直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b', status: 'approved' })]);
    await w.find('[data-summary="approved"]').trigger('click');
    expect(w.findAll('[data-stub-detail]')).toHaveLength(1);
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
    w.findComponent(ReviewDetailStub).vm.$emit('decided', meta({ id: 'a', status: 'approved', reviewedBy: 'approver', reviewedAt: 'x' }));
    await flushPromises();
    expect(refresh).toHaveBeenCalled();
    expect(w.text()).toContain('編集タブへ戻る');
  });
});

describe('コメントの宛先', () => {
  it('一覧の行(stub の focus)で宛先が選ばれ、該当ページへ送られる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-focus]').trigger('click');
    expect((w.find('select[aria-label="コメントの宛先パーツ"]').element as HTMLSelectElement).value).toBe(COVER);
    expect(gotoPage).toHaveBeenCalledWith(0);
  });

  it('宛先の選択肢は filled があれば filled の構造から、無ければ html の構造から作る', async () => {
    route.query = { template: TPL };
    getTemplateFn.mockResolvedValue(ok(template({
      html: '<div class="page"><h1></h1></div>',
      filled: '<div class="page"><h1></h1><p></p><table></table></div>',
    })));
    const w = await mountTab([meta({ id: 'a' })]);
    expect(w.findAll('select[aria-label="コメントの宛先パーツ"] option')).toHaveLength(1 + 3);
  });
});
```

`aria-expanded` の期待は Task 1 では書かない。Task 2 Step 1 で行ごと追加する。

- [ ] **Step 2: RED を確認** — `pnpm exec vitest run --project web editor/web/test/reviewTabView.test.ts`
- [ ] **Step 3: 通るまで最小の修正**(stub の解決・`h2` の有無・fixture の形。挙動は変えない)
- [ ] **Step 4: include に追加し `pnpm run test:coverage` で全体閾値を確認**(閾値はグローバル)
- [ ] **Step 5: コミット** `test(editor): 承認タブの状態機械と宛先の受け渡しを mount テストで固定する`

---

### Task 2: 行ヘッダの構造是正(`button` 内の `div`)と `aria-expanded`

**Files:**
- Modify: `editor/web/src/components/AttributeBar.vue`(`inline?: boolean` prop)
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue`(行ヘッダ)
- Modify: `editor/web/test/reviewTabView.test.ts`

方針: `<button data-review-toggle>` を 1 つのまま保ち、中の `AttributeBar`(ルートが `div`)を
`inline` 指定で `span` ルート・`span` 列に描く。`FundCodeName` は `span` 2 つのフラグメントなので
そのまま `button` 内に置ける。ローカルの二重実装はしない(名前解決の配線を共有部品に一本化)。
`AttributeBar` の他の利用者は `PreviewView.vue` の 1 箇所で、既定 `false` なら無影響。
div クリック + `@click.stop` の二重構造は作らない(ハンドラ無しの `@click.stop` は e2e の
`[data-review-toggle]` クリックを無効にする)。**`aria-label` は付けない** — 行ボタンの暗黙の名前
(バッジ・属性・申請者・日時)を上書きして支援技術から消すため。開閉の意図は先頭の
`<span class="sr-only">開閉</span>` で足す。

- [ ] **Step 1: 失敗するテストを書く** — `reviewTabView.test.ts` の「先頭だけ展開され…」に
  `expect(w.find('[data-review-toggle] div').exists()).toBe(false)`、
  `expect(w.findAll('[data-review-toggle]')[0].attributes('aria-expanded')).toBe('false')`、
  `expect(w.findAll('[data-review-toggle]')[2].attributes('aria-expanded')).toBe('true')` を足す
  (`AttributeBar: true` の stub は `<attribute-bar-stub>` を描くので `div` 不在の検査は stub 越しでも
  意味を持つ: `stubs` から `AttributeBar` を外し `FundCodeName: true` だけにして実体を描かせる)。
- [ ] **Step 2: 実装** — `AttributeBar.vue`: `inline` が真のときルートと各列を `span`
  (`inline-flex`)で描く(why: `button` の内容モデルは phrasing content に限られる)。`ReviewTabView.vue`:
  `<AttributeBar inline …>`、`<button … :aria-expanded="expanded.includes(m.id)">` の先頭に
  `<span class="sr-only">開閉</span>`。
- [ ] **Step 3: e2e** — `review_tab.spec.ts` を実行(セレクタ互換の確認)。
- [ ] **Step 4: コミット** `fix(editor): 承認タブの行ヘッダをボタン内に div を持たない構造にし aria-expanded を付ける`

---

### Task 3: コメント宛先の区画別化(表示中の宛先へ投稿する)

**Files:**
- Modify: `editor/web/src/features/editor/useComments.ts`、`editor/web/test/useComments.test.ts`
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue`
- Modify: `editor/web/test/reviewTabView.test.ts`

現状は `selectedKey` が 1 つで、2 区画を同時展開すると片方の宛先 select がもう片方も動かす。
「直近に操作した区画」で解決する案は、A で本文を打ち B の select を触って A の追加を押すと B 宛に
投稿される(表示と結果がずれる)ので採らない。**投稿先は呼び出し側が明示する**。

- [ ] **Step 1: 失敗するテストを書く**
  - `useComments.test.ts`: `add('本文', {}, SUMMARY)` は `currentKey()` が `COVER` でも `SUMMARY` 宛に
    `addNote` を呼ぶ。第 3 引数省略時は従来どおり `currentKey()`。
  - `reviewTabView.test.ts`: 2 件展開し、1 区画目の select を選んでも 2 区画目の select は先頭の
    「宛先を選ぶ」が選択されたまま —
    `expect((w.findAll('select[aria-label="コメントの宛先パーツ"]')[1].element as HTMLSelectElement).selectedIndex).toBe(0)`
    (`<option :value="null">` は `value` 属性が除去されるため `element.value` は `''` でなく `'宛先を選ぶ'`。
    `''` を期待すると「モデル値が `undefined` で選択が全滅した壊れた状態」を追認してしまう)。
    `CommentPanelStub` に `add` emit も足し、1 区画目の `add` が `addNote` を 1 区画目の宛先で呼ぶ
    (`useNoteRepo` モックに `addNote: vi.fn(async () => ok(entry))` を追加)。
- [ ] **Step 2: 実装**
  - `useComments.add(content, opts = {}, pathKey?: string)`: `pathKey ?? currentKey()` を宛先にする。why:
    承認タブは区画(申請)ごとに宛先を持ち、表示中の宛先へ投稿する(2 区画目の呼び出し元が実在する)。
    `reply/update/remove/setStatus` は `entry` 由来なので変更なし。
  - `ReviewTabView.vue`: `selectedKey` を `reactive<Record<string, string | null>>({})`(reqId → key)に。
    **区画のキーは `null` で初期化する**: `watch(items, (list) => { for (const m of list) if (!(m.id in selectedKey)) selectedKey[m.id] = null; }, { immediate: true })`。
    この `watch` は `items`(computed)の定義より**後**、§3 アコーディオンの既存 `watch(items)` の隣に置く
    (`selectedKey` の宣言位置に置くと `items` が TDZ で ReferenceError)。
    未初期化(`undefined`)のままだと Vue の `setSelected` が `looseEqual(null, undefined)` で外れて
    `selectedIndex = -1` になり、閉じた select から「宛先を選ぶ」が消える(可視文言の退行)。
    select の `v-model="selectedKey[m.id]"`、`:selected-key="selectedKey[m.id] ?? null"`、
    `:can-add="(selectedKey[m.id] ?? null) !== null"`、`@add="(content, kind) => comments.add(content, { kind }, selectedKey[m.id] ?? undefined)"`、
    `focusPart(m.id, key)` は `selectedKey[m.id] = key` + ページ送り。`targetId` 変化時は全キーを消す。
    `useComments` の `currentKey` getter は `() => null` にする(承認タブでは明示指定のみ)。
- [ ] **Step 3: コミット** `fix(editor): 承認タブのコメント宛先を区画ごとに持ち表示中の宛先へ投稿する`

---

### Task 4: `focusPart` の沈黙失敗を可視化する

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewVisualCompare.vue`、`ReviewDetail.vue`、`ReviewTabView.vue`
- Modify: `editor/web/src/features/editor/comments/CommentPanel.vue`、`editor/web/test/commentPanel.test.ts`
- 影響: `editor/web/src/features/editor/EditorView.vue`(到達不能行で `focus` が来なくなる。無害)

現状の沈黙: ①確定版に無いパーツ(`focusPart` が return)②文字差分タブ表示中(`ReviewDetail.gotoPage`
が return)③確定版の構造が引けない(`partLabels` が空)とき全行が無反応 ④`ReviewDetail` が `loading` 中は
`ReviewVisualCompare` が未マウント(`ReviewDetail.vue` の `v-if="loading"` / `v-else-if="review"`)で、
区画を開いた直後に行を押すと `visualRef` が無く要求ごと落ちる。加えて、タブを見た目比較へ
切り替えた**直後**は `PreviewPanel` が未準備(`gotoAnchor` はキューを持たず即 postMessage、子は viewer
未準備で捨てる)なので、切替してすぐ送っても別の沈黙になる → 準備待ちは `ReviewDetail`(マウント待ち)と
`ReviewVisualCompare`(組版待ち)の 2 段で持つ。

- [ ] **Step 1: 失敗するテストを書く**
  - `commentPanel.test.ts`: `partLabels` に無いキーの行は `aria-disabled="true"` と
    title「削除済みパーツ(この版の構造にありません)」を持ち(既存の表示語「削除済みパーツ」に揃える。
    同じ状態を別の言葉で呼ばない)、クリックしても `focus` を emit しない。既存テスト「行のクリックで
    focus(pathKey) を emit する」の行は `partLabels` に在るキーなので従来どおり emit する。
  - `reviewTabView.test.ts`: (a) `getTemplate` が失敗(`unexpected('読み取り失敗')` を `err` で返す。
    `as` は使わない)のとき、区画のコメント列に「このテンプレートの確定版がまだ無いため、パーツ宛の
    コメントは付けられません」が出て select が `disabled`。(b) `getTemplate` が未解決(手動解決の
    Promise)の間は文言が**出ず**、select は `disabled`。
  - 「区画を開いた直後の準備待ち」は `ReviewDetail` の内部状態(`pendingIndex` / `watch(visualRef)`)で、
    `ReviewTabView` のテストでは `ReviewDetail` を stub 化するため観測できない(関数 ref は `setRef` 時に
    公開インスタンスを確定するので、stub 側の `expose` を遅らせても親の参照は更新されない)。
    `ReviewDetail` の mount テストは置かない方針(自己レビュー参照)なので、この 2 段の準備待ちには単体網を
    置かず、`ReviewVisualCompare` 側の保留は `reviewCompareDocs` 相当の純粋部分を持たないため e2e
    `review_tab.spec.ts` の「行クリック → 該当ページ表示」で覆う(Task 8 でケースを 1 本足す:
    区画を開いた直後にコメント行を押し、`afterState`/`beforeState` の準備後に両面のページ番号が動く)。
- [ ] **Step 2: 実装**
  - `CommentPanel`: 到達不能行は emit しない + `aria-disabled` + title。
  - `ReviewVisualCompare`: `pendingPageIndex = ref<number | null>(null)` を持ち、`gotoPage(index)` の
    即送信条件は `afterState.pageCount > 0 && (isCreate || beforeState.pageCount > 0)`。単面表示
    (`isCreate`)で残るのは **after 面**(`v-if="!isCreate"` が付くのは before の figure)なので before は
    見ない。2 面では**両方が準備できるまで保留**する — `gotoPage` は左右へ同じ id を送るため、片面だけ
    送ると左右のページがずれ、ページ番号表示は `afterState` 由来の 1 つしか無いので承認者に「前後で
    内容が違う」と誤読させる。flush は `watch([afterState, beforeState])` で 1 回だけ、後から呼ばれた
    `gotoPage` が保留を上書きする(最新勝ち)。`PreviewPanel` が fallback へ倒れた場合は `pageCount` が
    0 のままで永久に flush されない(破棄処理は無く、次のクリックで上書きされるだけ。コメントに実態を書く)。
  - `ReviewDetail.gotoPage`: `activeTab.value = 'visual'` にし、`visualRef` が無ければ `pendingIndex` に
    保留して `watch(visualRef, …, { flush: 'post' })`(マウント後に子の `gotoPage` が呼べる)で 1 回
    flush して `pendingIndex = null` に戻す、在れば `nextTick` 後に委譲。組版の準備待ちは
    `ReviewVisualCompare` 側が担う旨、および単体網が無いぶん「flush 後は必ず `null` へ戻す・`watch` は
    1 回だけ送る」をコメントで明示する。`defineExpose` のコメントも「見た目比較へ切り替えて該当ページへ
    送る」に直す。
  - `ReviewTabView`: `partsLoaded = ref(false)` を足す。`loadParts` の現行
    `if (!isLatest() || !isOk(tpl)) return;` を `if (!isLatest()) return; partsLoaded.value = true; if (!isOk(tpl)) return;`
    の順に分割する(取得失敗でも「確定版がまだ無い」文言を出すため。`targetId` 変化時に false へ戻す)。判定は `partsLoaded && partLabels.size === 0`(`m.origin` は
    見ない — `partLabels` はテンプレ単位。読み込み中に真になると正常なテンプレでも文言が一瞬出る)。
    該当時は select を `disabled`、`can-add` を false、コメント列上部に上記 1 行。読み込み中は select を
    `disabled` にして文言は出さない。why に「宛先は確定版の構造から作るため、申請側にだけ在る追加パーツ
    にも宛てられない」を書く。
- [ ] **Step 3: コミット** `fix(editor): 承認タブでコメント行の移動が効かない条件を明示し見た目比較の準備を待って送る`

---

### Task 5: a11y の小修正

**Files:**
- Modify: `editor/web/src/features/editor/Inspector.vue`(切替 2 ボタンに `:aria-pressed`。同ファイルの
  整列トグルと同じ流儀。tablist 化はしない — `aria-controls`/tabpanel/roving tabindex を伴わない `role=tab`
  は退行。矢印キーの慣行も無い)
- Modify: `editor/web/src/features/editor/comments/CommentPanel.vue`(**編集用** textarea 2 箇所:
  親編集 `aria-label="コメント本文の編集"`、返信編集 `"返信本文の編集"`。新規・返信入力は placeholder が
  名前になっているので触らない。既存ボタン「このコメントを編集」と部分一致しない語にする)
- Modify: `editor/web/src/features/editor/NoteBubble.vue`(編集用 textarea 2 箇所に同じ `aria-label`)
- Modify: `editor/web/test/commentPanel.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — 行展開 → 編集開始で `textarea[aria-label="コメント本文の編集"]` が
  存在する。
- [ ] **Step 2: 実装 → GREEN → e2e `note_bubble.spec.ts` / `comment_panel.spec.ts` を実行**
- [ ] **Step 3: コミット** `feat(editor): コメント編集欄に aria-label を付け右ペイン切替に aria-pressed を付ける`

---

### Task 6: `useComments.reload` の世代ガード

**Files:**
- Modify: `editor/web/src/features/editor/useComments.ts`、`editor/web/test/useComments.test.ts`

競合は実在(`useTemplateEditor` の版読込と承認タブの `watch(targetId)`)。変異後の `reload()` は
新しい世代なので壊れない。**`begin()` は `reload` の第 1 文(`!tid` の早期 return より前)に置く** —
後ろに置くと「旧 tid の reload が in-flight → tid が空になり `all = []`(世代は進まない)→ 旧応答が
最新扱いで復活」の順で古いデータが戻る。前例は `ReviewTabView.loadParts`(`if (!id) return` より前に `begin()`)。

- [ ] **Step 1: 失敗するテストを書く** — fake repo の `listNotes` を手動解決の Promise 2 本にし、先発が
  後から解決しても `all` は後発の結果。加えて「in-flight 中に `templateId` が空になった後、旧応答が
  解決しても `all` は空のまま」。
- [ ] **Step 2: 実装** → GREEN → コミット `fix(editor): コメント一覧の再読込を世代で守る`

---

### Task 7: 前後でページ数が違う申請の `pageAnchors`

**Files:**
- Modify: `editor/web/src/features/reviews/services/reviewCompareDocs.ts`、`test/reviewCompareDocs.test.ts`

縮退は片側ごとに自分の期待ページ数で判定するので、前 3 / 後 2 は縮退せずに成立する。修正は
`pageAnchors[i] = after.pageIds[i] ?? before.pageIds[i]` で配列を長い方まで延ばすだけ。飛ぶのは
**修正前パネルだけ**(修正後にそのページは無い)。既知の帰結を 2 つコメントに書く: ①`annotatePages` は
著者由来の id を温存するため、同じ index で片側だけ著者 id のとき `after[i]` は before パネルでは
解決されず何も起きない ②`previewHost` のアンカー検査 `/^[A-Za-z0-9_-]+$/` に合わない著者 id は
無視される(根治は `data-review-anchor` 属性で id と分離する案だが本計画の範囲外)。

- [ ] **Step 1: 失敗するテストを書く** — before 3 / after 2(縮退なし)で `pageAnchors.length === 3`、
  index 2 は before 側の id。
- [ ] **Step 2: 実装(1 行 + コメント)** → コミット
  `fix(editor): ページ数が前後で違う申請でも修正前側の該当ページへ送る`

---

### Task 8: e2e の固定待ちを個別に置き換える

**Files:**
- Modify: `editor/e2e/review_tab.spec.ts`

| 箇所 | 扱い |
|---|---|
| 承認タブクリック後 800ms / toggle 後 500ms / 差し戻し後 1000ms | 削除(直後の `expect` が自動リトライ) |
| `login` の 800ms | ログイン後の着地をロケータ待ちへ: `await page.locator('header nav a').first().waitFor()`(`MainLayout.vue` の `nav` はロール非依存で全ロールに出る。`tabbed_layout.spec.ts` の `login` には待ちが無いので流用元は無い) |
| `submitOnce` の 1000ms | `await expect(page.getByRole('status').filter({ hasText: '確定保存を申請しました' })).toBeVisible()`(`PreviewView.vue` の `toastSuccess`、`Toaster.vue` は `role="status"`。`submitOnce` は冒頭で `goto` するので前回の toast は残らない) |
| `/edit/:id` 後の 2000ms | `frameLocator('iframe.gjs-frame').locator('.page').first()` の可視待ちへ。GrapesJS 初期化完了を待つ意図をコメントに残す |

- [ ] **Step 1: 置換 → `--repeat-each=3` で安定確認**
- [ ] **Step 2: 準備待ちの e2e を 1 本足す**(Task 4 の 2 段の保留は単体網が無いのでここで覆う):
  申請の区画を開いた**直後**に(組版完了を待たずに)コメント列の行を押す → 両面の
  `[data-vivliostyle-page-container]` が出た後、`ReviewVisualCompare` のページ番号表示が該当ページに
  なっていること。行を押す前提としてコメントを 1 件作る必要があるので、`submitOnce` の前に編集画面で
  2 ページ目のパーツへコメントを付けておく(`comment_panel.spec.ts` の `addComment` ヘルパを流用)。
  文字差分タブへ切り替えてから行を押す変種も 1 ケース(タブが見た目比較へ戻ることを確認)。
- [ ] **Step 3: コミット** `test(editor): 承認タブ e2e の固定待ちを要素待ちへ置き換え、行クリックの準備待ちを固定する`

---

### Task 9: 「承認キュー」語の掃除

**Files:**
- Modify: `editor/shared/src/schemas.ts`(2 箇所)、`editor/shared/src/index.ts`(1 箇所)、
  `editor/shared/src/repositories/ReviewRepository.ts`(1 箇所)、`editor/server/test/reviews.metaFailure.test.ts`(1 箇所)
- 対象外: `docs/editor/承認ワークフロー設計.md`(2026-06 の経緯メモ)、`editor/shared/dist/**`(生成物・未追跡)

いずれも JSDoc / コメントで、OpenAPI(`.meta({ description })`)には出ない → 再生成は不要。

- [ ] **Step 1**: `grep -rn "承認キュー" editor/shared/src editor/server/test` で 5 箇所を「申請一覧」「承認タブ」へ →
  `pnpm run check:comments`
- [ ] **Step 2**: コミット `docs(editor): コードコメントから承認キューの語を外す`

---

### Task 10: 仕上げ

- [ ] `pnpm run ci` 全段階 PASS。
- [ ] 設計正典の承認タブ中核原則へ 3 文追記: 「`pageAnchors` は index ごとに after → before で引き、
  修正前にしか無いページは修正前パネルだけが動く」「コメント宛先の選択は区画(申請)ごとで、投稿先は
  呼び出し側が明示する。宛先は確定版の構造から作るため、申請側にだけ在る追加パーツには宛てられない」
  「行クリックは文字差分タブ表示中でも見た目比較へ切り替えて送り、確定版に無いパーツの行は不活性にする」。
- [ ] e2e(`capture_docs.spec.ts`)が `docs/editor/images/*.png` を再撮影する。差分が出た画像は
  「再撮影」としてコミットし、画像が変わったら `py -3.13 docs/_build/build_all.py --project editor` で
  HTML も作り直して同じコミットに含める。
- [ ] push → PR(squash)。`main` との squash 分岐は CLAUDE.md 手順。

---

## 計画の自己レビュー

- 反対目線レビュー 2 回目の 16 点を反映: fixture を `TemplateMeta` 全項目で埋め `as` を排除 / `<h1>` の
  `id` を外し構造キーを `.page#1/h1#1` に / `ReviewDetail` stub に `gotoPage` spy / `FundCodeName` stub と
  `getSampleData` モック / `goEdit` の `targetId` あり分岐 / `filled` 非空ケースを Task 1 へ / Task 2 は
  `AttributeBar inline` に一本化し `aria-label` を外す / Task 3 は `add(…, pathKey)` の明示 / Task 4 は
  準備待ちと `partLabels.size === 0` 判定 / Task 6 は `begin()` の位置 / Task 7 は既存 id の帰結 /
  Task 8 は具体ロケータ / Task 9 は grep の範囲 / Task 10 は 3 文 + 再撮影 + `build_all` /
  `EditorView.vue` の波及を Files に記録 / `it.todo` 云々を 1 文に。
- `ReviewDetail` の mount テストは意図的に置かない(組版 iframe 2 面と実 fetch を伴い、e2e が覆う)。
- 順序依存: Task 1 → 2 → 3 → 4(いずれも `reviewTabView.test.ts` を触る)。5〜9 は独立。
- e2e が掴むセレクタと可視文言は全 Task で不変。
