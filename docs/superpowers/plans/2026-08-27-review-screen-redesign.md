# 精査画面の事務担当者向け全面改修 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精査（承認）画面を IT リテラシーのない承認者向けに再構成する — 保留状態・一覧サマリ・修正前後のブラウザ内組版比較・警告の業務語集約・パーツ業務名表示。

**Architecture:** shared の `ReviewStatus`/契約拡張 → server の hold ルート → web の repo ミラー → 精査画面の template 再構成（既存 `useReviewDiff`/`reviewDiffService` の骨格は維持、`PreviewPanel` を 2 面流用）。差分の正典（textOps）・警告の完全性・iframe sandbox 構成は一切変えない。

**Tech Stack:** TypeScript / Zod / Fastify / Vue 3 + Pinia / vivliostyle preview-host / vitest (+ @vue/test-utils)

**Spec:** `docs/superpowers/specs/2026-08-27-review-screen-redesign-design.md`

## Global Constraints

- 状態の内部名は変えない（`rejected` のまま。UI 文言だけ「差し戻し」）。新状態の内部名は `held`。
- 警告（cssChanged / printOnlyCss / truncated / hiddenRowCount / coarse）は**消さない**。折りたたみは表示状態のみ（条件が真なら DOM 常在）。
- iframe は既存構成を維持: 差分行 iframe = `sandbox="allow-scripts"`、`PreviewPanel` = preview-host + `sandbox="allow-scripts"`。`allow-same-origin` を足さない。
- `buildDiffDoc` は非冪等（レイヤ名乱数）— srcdoc は computed で 1 度だけ組む既存規律を維持。
- DB sproc 変更なし。申請の永続化はファイル（`dataRoot/reviews/<reqId>/meta.json`）と localStorage。
- 新規テスト対象ファイルはルート `vitest.config.ts` の coverage include へ追加する（editor/README の規律・85% 閾値）。
- `editor/**` を変更したコミット前は `pnpm exec biome check --write editor/<対象ファイル>` を先行実行する（lint-staged 事故回避）。
- 型チェックは `@editor/shared` の先行ビルドが前提（`pnpm --dir editor typecheck` は込み）。
- テスト実行はワークスペースごと: `pnpm --dir editor exec vitest run --project shared|server|web [ファイル]`。
- コメントは `docs/コメント規約.md` に従う（なぜを書く・日本語散文・経緯を書かない）。

---

### Task 1: shared — `held` 状態と `changedSummary` のスキーマ・契約・API パス

**Files:**
- Modify: `editor/shared/src/schemas.ts:326-386`
- Modify: `editor/shared/src/repositories/ReviewRepository.ts`
- Modify: `editor/shared/src/api-paths.ts:56-60`
- Test: `editor/shared/test/review.test.ts`（新規）

**Interfaces:**
- Produces: `ReviewStatus = 'pending'|'approved'|'rejected'|'held'`、`ReviewRequestMeta` に `heldBy: string|null` / `heldAt: string|null` / `holdComment: string|null`（レガシー meta.json では undefined になりうる — 消費側は truthy 判定で扱う）、`ReviewChangedSummary = {count: number, names: string[]}`、`ReviewRequestMeta.changedSummary?: ReviewChangedSummary|null`、`SubmitReviewBody.changedSummary?`、`ReviewRepository.holdReview(reqId, decision): Promise<Result<ReviewRequestMeta>>`、`apiPaths.reviewRequestHold = '/review-requests/:reqId/hold'`

- [ ] **Step 1: 失敗するテストを書く**

`editor/shared/test/review.test.ts`:

```ts
// =============================================================================
// review.test.ts — 承認ワークフローのスキーマ拡張(保留・変更概要)の検証
// =============================================================================
import { describe, expect, it } from 'vitest';
import { ReviewRequestMeta, ReviewStatus, SubmitReviewBody } from '../src/schemas.js';

const baseMeta = {
  id: 'rv1',
  templateId: 'AM01_510037_20240710_交付版',
  attributes: {
    companyCode: 'AM01',
    fundCode: '510037',
    baseDate: '20240710',
    version: '交付版',
  },
  fundCode: '510037',
  origin: 'edit',
  status: 'pending',
  submittedBy: 'editor1',
  submittedAt: '2026-08-27T00:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  comment: null,
  baseHash: null,
};

describe('ReviewStatus', () => {
  it('held を受理する', () => {
    expect(ReviewStatus.parse('held')).toBe('held');
  });
});

describe('ReviewRequestMeta', () => {
  it('保留フィールドと変更概要を保持する', () => {
    const meta = ReviewRequestMeta.parse({
      ...baseMeta,
      status: 'held',
      heldBy: 'approver1',
      heldAt: '2026-08-27T01:00:00.000Z',
      holdComment: '数値の出所を確認中',
      changedSummary: { count: 2, names: ['運用実績の表', 'ご挨拶文'] },
    });
    expect(meta.heldBy).toBe('approver1');
    expect(meta.changedSummary?.names).toHaveLength(2);
  });

  it('レガシー meta(新フィールド無し)も受理する', () => {
    const meta = ReviewRequestMeta.parse(baseMeta);
    expect(meta.heldBy ?? null).toBeNull();
    expect(meta.changedSummary ?? null).toBeNull();
  });
});

describe('SubmitReviewBody', () => {
  it('changedSummary は任意で、件数は非負整数のみ', () => {
    const body = {
      templateId: 'AM01_510037_20240710_交付版',
      html: '<p>x</p>',
      css: '',
      fundCode: '510037',
      origin: 'edit',
    };
    expect(SubmitReviewBody.parse(body).changedSummary).toBeUndefined();
    expect(() =>
      SubmitReviewBody.parse({ ...body, changedSummary: { count: -1, names: [] } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project shared test/review.test.ts`
Expected: FAIL（`held` が enum 外 / フィールド未定義）

- [ ] **Step 3: schemas.ts を拡張**

`editor/shared/src/schemas.ts` の 328-330 行を置換:

```ts
export const ReviewStatus = z
  .enum(['pending', 'approved', 'rejected', 'held'])
  .meta({ id: 'ReviewStatus' });
```

`ReviewOrigin` 定義の直後（335 行付近）へ追加:

```ts
/**
 * 申請時に申請者ブラウザが計算した変更概要(パーツ数と業務名)。一覧の先出し表示専用の
 * **参考情報**で、承認判断には使わない — 承認は精査画面がその場で計算する実差分に基づく。
 * 申請者由来の自己申告値であることを消費側は前提にする(改竄されても表示が変わるだけ)。
 */
export const ReviewChangedSummary = z
  .object({
    count: z.number().int().min(0),
    names: z.array(z.string().max(200)).max(50),
  })
  .meta({ id: 'ReviewChangedSummary' });
```

`ReviewRequestMeta`（338-353 行）の `baseHash` の後へ 4 フィールド追加:

```ts
    // 保留(held)の記録。レガシー申請の meta.json には無いため、消費側は undefined も
    // null と同様に「保留情報なし」として扱う(truthy 判定)。
    heldBy: z.string().nullable().optional().meta({ description: '保留した承認者。無ければ null' }),
    heldAt: z.string().nullable().optional(),
    holdComment: z.string().nullable().optional().meta({ description: '保留メモ' }),
    changedSummary: ReviewChangedSummary.nullable().optional(),
```

`SubmitReviewBody`（367-378 行）の `origin` の後へ追加:

```ts
    changedSummary: ReviewChangedSummary.optional().meta({
      description: '申請者側で計算した変更概要(参考表示用の自己申告)',
    }),
```

- [ ] **Step 4: 契約と API パスを追加**

`editor/shared/src/repositories/ReviewRepository.ts` の `rejectReview` の後へ:

```ts
  /**
   * 保留する(approver|admin のみ)。判断を保留して後で戻る・他者へ相談するための状態で、
   * 承認/差し戻しは pending と held のどちらからでも行える(保留解除の専用操作は無い)。
   */
  holdReview(reqId: string, decision: ReviewDecisionRequest): Promise<Result<ReviewRequestMeta>>;
```

`editor/shared/src/api-paths.ts` の 60 行 `reviewRequestReject` の後へ:

```ts
  reviewRequestHold: '/review-requests/:reqId/hold',
```

- [ ] **Step 5: パスを通す**

Run: `pnpm --dir editor exec vitest run --project shared test/review.test.ts`
Expected: PASS

このタスクの型変更で server/web の `holdReview` 未実装が typecheck エラーになるのは Task 2/3 で解消する（このタスクでは shared のテストのみ green を確認）。

- [ ] **Step 6: coverage include とコミット**

ルート `vitest.config.ts` は `editor/shared/src/schemas.ts` を include 済み（33 行）— 追加不要を確認のみ。

```bash
pnpm exec biome check --write editor/shared/src/schemas.ts editor/shared/src/repositories/ReviewRepository.ts editor/shared/src/api-paths.ts editor/shared/test/review.test.ts
git add editor/shared
git commit -m "feat(editor): 承認ワークフローに保留(held)状態と変更概要(changedSummary)のスキーマを追加"
```

---

### Task 2: server — hold ルート・遷移拡張・上限合算

**Files:**
- Modify: `editor/server/src/repositories/reviewRepo.ts`
- Modify: `editor/server/src/routes/reviews.routes.ts`
- Modify: `editor/server/src/routes/routeGuards.ts:104-108`
- Modify: `editor/server/src/openapi/document.ts:470-486` 付近
- Modify: `editor/server/src/files/reviewFiles.ts:101-104`
- Test: `editor/server/test/reviews.test.ts`（既存へ追記）

**Interfaces:**
- Consumes: Task 1 の `ReviewStatus 'held'` / `apiPaths.reviewRequestHold` / meta 新フィールド
- Produces: `reviews.holdReview(reqId, decision, actor): Promise<ReviewRequestMeta>`（server 内部）、`POST /api/review-requests/:reqId/hold`（approver 限定・監査 `review.hold`）、approve/reject は `pending|held` から可、`countPendingReviews` は pending+held 合算

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/reviews.test.ts` の既存 describe 群と同じセットアップ（既存の submit→approve テストのヘルパ・actor 定義をそのまま使う。ファイル冒頭の import に `holdReview` を追加）に、以下を追記:

```ts
describe('holdReview(保留)', () => {
  it('pending を held にし、保留者・日時・メモを記録する', async () => {
    const meta = await submitReview(validSubmitBody(), editorActor);
    const held = await holdReview(meta.id, { comment: '出所確認中' }, approverActor);
    expect(held.status).toBe('held');
    expect(held.heldBy).toBe(approverActor.username);
    expect(held.holdComment).toBe('出所確認中');
    expect(held.heldAt).toBeTruthy();
  });

  it('held から承認できる', async () => {
    const meta = await submitReview(validSubmitBody(), editorActor);
    await holdReview(meta.id, {}, approverActor);
    const result = await approveReview(meta.id, {}, approverActor);
    expect(result.meta).toBeTruthy();
  });

  it('held から差し戻し(reject)できる', async () => {
    const meta = await submitReview(validSubmitBody(), editorActor);
    await holdReview(meta.id, {}, approverActor);
    const rejected = await rejectReview(meta.id, { comment: '理由' }, approverActor);
    expect(rejected.status).toBe('rejected');
  });

  it('approved/rejected の申請は保留できない(409)', async () => {
    const meta = await submitReview(validSubmitBody(), editorActor);
    await rejectReview(meta.id, { comment: '理由' }, approverActor);
    await expect(holdReview(meta.id, {}, approverActor)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('held の再保留はメモ更新として通る', async () => {
    const meta = await submitReview(validSubmitBody(), editorActor);
    await holdReview(meta.id, { comment: '1回目' }, approverActor);
    const again = await holdReview(meta.id, { comment: '2回目' }, approverActor);
    expect(again.holdComment).toBe('2回目');
  });
});

describe('未処理上限は pending+held の合算', () => {
  it('countPendingReviews は held も数える', async () => {
    const meta = await submitReview(validSubmitBody(), editorActor);
    await holdReview(meta.id, {}, approverActor);
    expect(await countPendingReviews()).toBe(1);
  });
});
```

※ `validSubmitBody()` / `editorActor` / `approverActor` は既存テストのヘルパ名に合わせる（実ファイルを開いて同名のものを使う。無ければ既存テストの申請ボディ組み立てを関数化して流用する）。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project server test/reviews.test.ts`
Expected: FAIL（`holdReview` が存在しない）

- [ ] **Step 3: reviewRepo.ts を実装**

`editor/server/src/repositories/reviewRepo.ts`:

(a) 承認/却下の pending 検査を共通化して held を許す。165-166 行と 247-248 行の検査を次のヘルパ呼び出しへ置換し、ヘルパをファイル内(`canSeeAll` の後)へ追加:

```ts
/**
 * 承認・差し戻し・保留が受け付ける現在状態の検査。保留(held)は「判断を後回しにした
 * pending」であり、決着(approved/rejected)済みだけを 409 で拒む。
 */
function assertUndecided(review: ReviewRequest): void {
  if (review.status === 'approved' || review.status === 'rejected')
    throw conflict(
      `この申請は既に${review.status === 'approved' ? '承認' : '差し戻し'}済みです`,
    );
}
```

approveReview 内 165-166 行を `assertUndecided(review);` に、rejectReview 内 247-248 行も同様に置換。

(b) `rejectReview` の後へ `holdReview` を追加:

```ts
/**
 * 保留する(approver|admin のみ。ルートで施錠済み)。実ファイルは更新しない。
 * 自己申請の保留は許す(承認と違い実反映を伴わず、職務分掌の対象でない)。
 * held の再保留はメモ更新として通す。
 */
export async function holdReview(
  reqId: string,
  decision: ReviewDecisionRequest,
  actor: ReviewActor,
): Promise<ReviewRequestMeta> {
  return withReviewLock(async () => {
    const review = await readReview(reqId);
    if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
    assertUndecided(review);
    return updateReviewMeta(reqId, {
      status: 'held',
      heldBy: actor.username,
      heldAt: new Date().toISOString(),
      holdComment: decision.comment ?? null,
    });
  });
}
```

(c) `submitReview` が `changedSummary` を保存するようにする。107-123 行の `review` オブジェクトへ 1 行追加（`baseHash` の後）:

```ts
    ...(req.changedSummary !== undefined ? { changedSummary: req.changedSummary } : {}),
```

- [ ] **Step 4: countPendingReviews を合算に変更**

`editor/server/src/files/reviewFiles.ts` の 101-104 行:

```ts
/**
 * 未処理申請の件数。上限判定に使う(一覧と同じ走査上限が掛かる)。保留(held)も数える —
 * 保留は決着ではなく、除外すると保留を経由して上限(MAX_PENDING_REVIEWS)を回避できる。
 */
export async function countPendingReviews(): Promise<number> {
  const metas = await listReviewMetas();
  return metas.filter((m) => m.status === 'pending' || m.status === 'held').length;
}
```

- [ ] **Step 5: ルート・ガード・OpenAPI**

`editor/server/src/routes/reviews.routes.ts` の reject ルートの後へ:

```ts
  // 保留(精査者限定)。実ファイルは更新しない。判断を保留して後で戻るための状態遷移。
  app.post<ReqIdParams & { Body: z.infer<typeof ReviewDecisionBody> }>(
    apiPaths.reviewRequestHold,
    { preHandler: [requireAuth, requireApprover, validate(ReviewDecisionBody)] },
    async (request) => {
      const reqId = request.params.reqId;
      return auditedRethrow(
        request,
        'review.hold',
        () => reviews.holdReview(reqId, request.body, actor(request)),
        {
          success: (meta) => ({ resource: { reqId, templateId: meta.templateId } }),
          failure: () => ({ resource: { reqId } }),
          failureMessage: 'hold failed',
        },
      );
    },
  );
```

`editor/server/src/routes/routeGuards.ts` の 108 行の後へ:

```ts
  [`POST ${api(apiPaths.reviewRequestHold)}`]: 'approver',
```

`editor/server/src/openapi/document.ts` の reject 定義（470-486 行）の後へ:

```ts
      [toOpenApiPath(apiPaths.reviewRequestHold)]: {
        post: {
          tags: ['reviews'],
          summary: '保留(精査者限定・実ファイル非更新)',
          operationId: 'holdReview',
          requestParams: { path: z.object({ reqId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.ReviewDecisionBody } } },
          responses: {
            '200': json('保留後の申請メタ', s.ReviewRequestMeta),
            ...ERR_400,
            ...ERR_401,
            ...ERR_403,
            ...ERR_404,
            ...ERR_409,
          },
        },
      },
```

- [ ] **Step 6: パスを通す**

Run: `pnpm --dir editor exec vitest run --project server test/reviews.test.ts` → PASS
Run: `pnpm --dir editor exec vitest run --project server test/routeGuards.test.ts`（宣言表整合が既存テストにある場合）と `test/mustChangePassword.test.ts` は触らない — server プロジェクト全体を一度回す: `pnpm --dir editor exec vitest run --project server` → PASS

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/server/src editor/server/test/reviews.test.ts
git add editor/server editor/shared
git commit -m "feat(editor): 確定保存申請の保留(hold)ルートを追加し、承認/差し戻しを held からも受け付ける"
```

---

### Task 3: web — repo ミラー（rest/local）と pendingReviews ストア

**Files:**
- Modify: `editor/web/src/api/rest/reviewRepo.ts`
- Modify: `editor/web/src/api/local/reviewRepo.ts`
- Modify: `editor/web/src/stores/pendingReviews.ts:26-29`
- Test: `editor/web/test/localReviewRepo.test.ts`（既存があれば追記、無ければ新規）

**Interfaces:**
- Consumes: Task 1 の `holdReview` 契約
- Produces: `restReviewRepo.holdReview` / `localReviewRepo.holdReview`（`Result<ReviewRequestMeta>`）、`usePendingReviewsStore` は pending+held を保持

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/localReviewRepo.test.ts`（既存の local repo テストのセットアップ規約 — localStorage モック・ログインユーザー設定 — に合わせる。既存ファイルが無い場合は `web/test` の他の local repo テストを手本に新規作成）:

```ts
describe('localReviewRepo.holdReview', () => {
  it('pending を held にし、held から承認できる', async () => {
    const submitted = await localReviewRepo.submitReview(validSubmitReq());
    expect(isOk(submitted)).toBe(true);
    if (!isOk(submitted)) return;
    const held = await localReviewRepo.holdReview(submitted.value.id, { comment: 'メモ' });
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value.status).toBe('held');
    expect(held.value.holdComment).toBe('メモ');
    // held からの承認(approver ユーザーへ切替済みの前提で)
    const approved = await localReviewRepo.approveReview(submitted.value.id, {});
    expect(isOk(approved)).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/localReviewRepo.test.ts`
Expected: FAIL（`holdReview` 未実装）

- [ ] **Step 3: rest/local 実装**

`editor/web/src/api/rest/reviewRepo.ts` の `rejectReview` の後へ:

```ts
  holdReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attemptRest(() =>
      apiFetch<ReviewRequestMeta>(buildPath(apiPaths.reviewRequestHold, { reqId }), {
        method: 'POST',
        body: decision,
      }),
    ),
```

`editor/web/src/api/local/reviewRepo.ts`:

(a) approve/reject の `if (review.status !== 'pending')` を両方 `if (review.status === 'approved' || review.status === 'rejected')` へ置換（メッセージは「この申請は既に処理済みです」のまま）。

(b) `rejectReview` の後へ:

```ts
  holdReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attempt(() => {
      const reviews = readReviews();
      const review = reviews[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      if (review.status === 'approved' || review.status === 'rejected')
        throw conflict('この申請は既に処理済みです');
      const who = currentUser()?.displayName ?? '不明';
      const next: ReviewRequest = {
        ...review,
        status: 'held',
        heldBy: who,
        heldAt: now(),
        holdComment: decision.comment ?? null,
      };
      reviews[reqId] = next;
      write(K.reviews, reviews);
      return delay(toReviewMeta(next));
    }),
```

(c) local `submitReview` の `review` オブジェクトへ `baseHash` の後に追加:

```ts
        ...(req.changedSummary !== undefined ? { changedSummary: req.changedSummary } : {}),
```

- [ ] **Step 4: pendingReviews ストアを pending+held に**

`editor/web/src/stores/pendingReviews.ts` の `refresh`（26-29 行）:

```ts
  async function refresh(): Promise<void> {
    // 保留(held)も「処理が済んでいない申請」としてバッジに数える。status 絞りをサーバへ
    // 渡さず全件を取り client で絞る(2 状態の OR をクエリ 1 回で表現できないため)。
    const res = await reviews.listReviews({});
    items.value = isOk(res)
      ? res.value.filter((m) => m.status === 'pending' || m.status === 'held')
      : [];
  }
```

ファイル冒頭コメント（10 行付近の `status: 'pending'`）も「pending|held」へ追随させる。

- [ ] **Step 5: パスを通す**

Run: `pnpm --dir editor exec vitest run --project web test/localReviewRepo.test.ts` → PASS
Run: `pnpm --dir editor typecheck` → PASS（shared/server/web の `holdReview` が揃い型が閉じる）

- [ ] **Step 6: coverage include とコミット**

ルート `vitest.config.ts` の include（151 行付近）へ、未収載なら `editor/web/src/api/local/reviewRepo.ts` と `editor/web/src/api/rest/reviewRepo.ts` を追加（既に載っているか確認してから）。

```bash
pnpm exec biome check --write editor/web/src/api editor/web/src/stores/pendingReviews.ts editor/web/test/localReviewRepo.test.ts
git add editor/web vitest.config.ts
git commit -m "feat(editor): web の保留(hold)実装と承認待ちバッジの pending+held 合算"
```

---

### Task 4: パーツ業務名の突合（`partNames.ts` + reviewDiffService 統合）

**Files:**
- Create: `editor/web/src/features/reviews/services/partNames.ts`
- Modify: `editor/web/src/features/reviews/services/reviewDiffService.ts`
- Test: `editor/web/test/partNames.test.ts`（新規）

**Interfaces:**
- Consumes: `blockKey` のキー形式 `<rawKey>#n`（rawKey は `data-part-id` 最優先）、`PartRepository.listParts({})` の `PartCatalogItem { id, name, … }`、`DiffBlock.label`（「ページN・パーツM」）
- Produces: `partIdFromBlockKey(key: string): string | null`（純関数）、`businessLabel(key: string, fallbackLabel: string, nameById: ReadonlyMap<string, string>): string`（純関数）、`loadPartNameMap(parts: PartRepository): Promise<ReadonlyMap<string, string>>`（失敗時は空 Map へ degrade）。`ReviewPartRow.label` が業務名になる（突合不能時は現行表記のまま）

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/partNames.test.ts`:

```ts
// =============================================================================
// partNames.test.ts — 差分行キー → パーツ業務名の突合(精査画面のラベル)
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  businessLabel,
  partIdFromBlockKey,
} from '@/features/reviews/services/partNames';

describe('partIdFromBlockKey', () => {
  it('data-part-id 由来のキーから id を取り出す', () => {
    expect(partIdFromBlockKey('note-fund-status#1')).toBe('note-fund-status');
  });
  it('タグ名・クラス由来のキーは null(カタログ突合の対象外)', () => {
    expect(partIdFromBlockKey('.section#2')).toBeNull();
    expect(partIdFromBlockKey('table#1')).toBeNull();
    expect(partIdFromBlockKey('div#3')).toBeNull();
  });
});

describe('businessLabel', () => {
  const names = new Map([['note-fund-status', '当ファンドの状況']]);
  it('カタログ名 + ページ番号で表示する', () => {
    expect(businessLabel('note-fund-status#1', 'ページ3・パーツ2', names)).toBe(
      '当ファンドの状況（3 ページ目）',
    );
  });
  it('突合できないキーは現行ラベルへフォールバック', () => {
    expect(businessLabel('.section#1', 'ページ1・パーツ1', names)).toBe('ページ1・パーツ1');
    expect(businessLabel('unknown-id#1', 'ページ1・パーツ2', names)).toBe('ページ1・パーツ2');
  });
  it('ページ番号が読めないラベルでも名前だけは出す', () => {
    expect(businessLabel('note-fund-status#1', 'ページ1', names)).toBe(
      '当ファンドの状況（1 ページ目）',
    );
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/partNames.test.ts`
Expected: FAIL（モジュール不存在）

- [ ] **Step 3: partNames.ts を実装**

`editor/web/src/features/reviews/services/partNames.ts`:

```ts
// =============================================================================
// partNames.ts — 差分行キー → パーツカタログ業務名の突合(精査画面のラベル)
// =============================================================================
// 差分行のキーは `blockKey.ts` の `occurrenceKey`(= `<rawKey>#n`)で、rawKey は
// `data-part-id` を最優先に採る。よって `data-part-id` 付きパーツのキーはカタログの
// パーツ id と一致し、`listParts` の `name`(名称・利用者向け)へ突合できる。承認者は
// 「ページN・パーツM」という機械採番よりパーツの業務名で変更箇所を認知するため、
// 突合できた行だけ業務名で表示する(できない行は現行表記へフォールバック)。
import { isErr, type PartRepository } from '@editor/shared';

/**
 * 差分行キーからカタログ突合用のパーツ id を取り出す。`rawKey` が element id・クラス・
 * タグ名由来のキー(`.class` / 小文字タグ名)はカタログ id ではないので null を返す。
 * カタログ id は `data-part-id` の値で、HTML タグ名と衝突しない語彙(ハイフン区切り等)を
 * 前提にできないため、「`.` 始まりと既知タグ名だけ除外」ではなく **name 表に居るか**を
 * `businessLabel` 側の突合で最終判定する(ここでは明らかな非 id だけ落とす)。
 */
export function partIdFromBlockKey(key: string): string | null {
  const base = key.replace(/#\d+$/, '');
  if (!base || base.startsWith('.')) return null;
  // 小文字英字のみの短い語はタグ名由来の可能性が高いが、確定はできないので通し、
  // name 表との突合(businessLabel)に委ねる。div/table 等の頻出タグだけは明確に落とす。
  const COMMON_TAGS = new Set([
    'div', 'p', 'table', 'section', 'article', 'header', 'footer', 'ul', 'ol', 'figure',
  ]);
  if (COMMON_TAGS.has(base)) return null;
  return base;
}

/**
 * 行の表示ラベル。カタログ名へ突合できたら「<業務名>（N ページ目）」、できなければ
 * 現行の機械採番ラベルをそのまま返す(黙って情報を減らさない)。
 */
export function businessLabel(
  key: string,
  fallbackLabel: string,
  nameById: ReadonlyMap<string, string>,
): string {
  const id = partIdFromBlockKey(key);
  const name = id ? nameById.get(id) : undefined;
  if (!name) return fallbackLabel;
  const page = /ページ(\d+)/.exec(fallbackLabel)?.[1];
  return page ? `${name}（${page} ページ目）` : name;
}

/**
 * カタログ全件から id → 業務名の表を作る。取得失敗は空 Map へ degrade する —
 * ラベルが機械採番へ戻るだけで、精査そのものは止めない(ベストエフォート)。
 */
export async function loadPartNameMap(
  parts: PartRepository,
): Promise<ReadonlyMap<string, string>> {
  const res = await parts.listParts({});
  if (isErr(res)) return new Map();
  return new Map(res.value.map((p) => [p.id, p.name]));
}
```

- [ ] **Step 4: パスを通す**

Run: `pnpm --dir editor exec vitest run --project web test/partNames.test.ts` → PASS

- [ ] **Step 5: reviewDiffService へ統合**

`editor/web/src/features/reviews/services/reviewDiffService.ts`:

- import 追加: `import { usePartRepo } from '@/api/repositories';`（`useReviewRepo` と同じ場所からの export 名を確認 — `repositories.ts` に part repo の hook がある）と `import { businessLabel, loadPartNameMap } from './partNames';`
- `createReviewDiffService(reviews, compare, parts: PartRepository)` へ引数を 1 つ追加し、`useReviewDiffService` で `usePartRepo()` を渡す。
- `buildDiff` 内、`htmlWorker.buildHtmlDiff` の前後どちらかで `const nameById = await loadPartNameMap(parts);` を取得し、rows の組み立て（160-170 行）の `label` を変更:

```ts
          label: businessLabel(b.key, b.label, nameById),
```

- [ ] **Step 6: 全体テストとコミット**

Run: `pnpm --dir editor exec vitest run --project web` → PASS（既存 reviewDiffService テストがラベル文字列を固定していたら期待値を更新）

ルート `vitest.config.ts` include へ `editor/web/src/features/reviews/services/partNames.ts` を追加。

```bash
pnpm exec biome check --write editor/web/src/features/reviews editor/web/test/partNames.test.ts
git add editor/web vitest.config.ts
git commit -m "feat(editor): 精査画面のパーツ行ラベルをカタログ業務名で表示(突合不能時は従来表記)"
```

---

### Task 5: changedSummary の申請時計算と PreviewView 配線

**Files:**
- Create: `editor/web/src/features/reviews/services/changedSummary.ts`
- Modify: `editor/web/src/features/preview/PreviewView.vue:107-116`
- Test: `editor/web/test/changedSummary.test.ts`（新規）

**Interfaces:**
- Consumes: `compareService.renderTemplateBody` / `renderVersionHtml('baseline:…')`、`htmlWorker.buildHtmlDiff`、Task 4 の `loadPartNameMap` / `businessLabel`、Task 1 の `ReviewChangedSummary`
- Produces: `computeChangedSummary(args: {templateId, html, css, fundCode, origin}): Promise<ReviewChangedSummary | null>` — **失敗はすべて null（申請を止めない）**

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/changedSummary.test.ts`（compare/worker はモック。web/test の既存モック手法 — `vi.mock('@/workers', …)` — に合わせる）:

```ts
// =============================================================================
// changedSummary.test.ts — 申請時の変更概要(自己申告・参考情報)の計算
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@editor/shared';
import { computeChangedSummaryWith } from '@/features/reviews/services/changedSummary';

const diff = {
  truncated: false,
  pages: [
    {
      blocks: [
        { key: 'note-a#1', label: 'ページ1・パーツ1', status: 'changed' },
        { key: '.x#1', label: 'ページ1・パーツ2', status: 'same' },
        { key: 'note-b#1', label: 'ページ2・パーツ1', status: 'added' },
      ],
    },
  ],
};

const deps = {
  renderAfter: vi.fn(async () => ok({ html: '<p>a</p>', css: '' })),
  renderBefore: vi.fn(async () => ok({ html: '<p>b</p>', css: '' })),
  buildHtmlDiff: vi.fn(async () => diff),
  loadNames: vi.fn(async () => new Map([['note-a', '運用実績の表']])),
};

describe('computeChangedSummaryWith', () => {
  it('変更ブロックの件数と業務名(重複除去)を返す', async () => {
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' },
      deps,
    );
    expect(s).toEqual({ count: 2, names: ['運用実績の表', 'ページ2・パーツ1'] });
  });

  it('内部で例外が出ても null(申請を止めない)', async () => {
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '', css: '', fundCode: 'f', origin: 'edit' },
      { ...deps, buildHtmlDiff: vi.fn(async () => { throw new Error('x'); }) },
    );
    expect(s).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/changedSummary.test.ts` → FAIL

- [ ] **Step 3: 実装**

`editor/web/src/features/reviews/services/changedSummary.ts`:

```ts
// =============================================================================
// changedSummary.ts — 申請時に計算する変更概要(一覧の先出し表示用・自己申告)
// =============================================================================
// 一覧(承認キュー)で「変更 N か所(業務名…)」を開く前に見せるための概要。差分計算は
// web 側にしか無く一覧表示のたびに全件計算はできないため、**申請者のブラウザが申請時に
// 1 回計算して meta に保存**する。参考情報であり承認判断には使わない(精査画面はその場で
// 実差分を計算する)。計算のどこで失敗しても null を返し、申請そのものは決して止めない。
import { isErr, type ReviewChangedSummary, type Result } from '@editor/shared';
import { usePartRepo, useReviewRepo } from '@/api/repositories';
import { useCompareService } from '@/features/compare/services/compareService';
import { htmlWorker } from '@/workers';
import { businessLabel, loadPartNameMap } from './partNames';

interface SummaryInput {
  templateId: string;
  html: string;
  css: string;
  fundCode: string;
  origin: 'edit' | 'create';
}

/** 依存の束(テストで差し替える点)。実運用は `computeChangedSummary` が既定を組む。 */
export interface SummaryDeps {
  renderAfter: (html: string, css: string, fundCode: string) => Promise<Result<{ html: string; css: string }>>;
  renderBefore: (templateId: string) => Promise<Result<{ html: string; css: string }>>;
  buildHtmlDiff: (
    beforeHtml: string,
    afterHtml: string,
    cssBefore: string,
    cssAfter: string,
  ) => Promise<{ pages: { blocks: { key: string; label: string; status: string }[] }[] }>;
  loadNames: () => Promise<ReadonlyMap<string, string>>;
}

/** 概要に載せる名前の上限。超過分は count だけが伝える(names は先頭から切る)。 */
const MAX_NAMES = 10;

export async function computeChangedSummaryWith(
  input: SummaryInput,
  deps: SummaryDeps,
): Promise<ReviewChangedSummary | null> {
  try {
    const afterRes = await deps.renderAfter(input.html, input.css, input.fundCode);
    if (isErr(afterRes)) return null;
    let beforeHtml = '';
    let cssBefore = afterRes.value.css;
    if (input.origin === 'edit') {
      const beforeRes = await deps.renderBefore(input.templateId);
      if (!isErr(beforeRes)) {
        beforeHtml = beforeRes.value.html;
        cssBefore = beforeRes.value.css;
      }
    }
    const diff = await deps.buildHtmlDiff(
      beforeHtml,
      afterRes.value.html,
      cssBefore,
      afterRes.value.css,
    );
    const nameById = await deps.loadNames();
    const changed = diff.pages.flatMap((p) => p.blocks).filter((b) => b.status !== 'same');
    const names = [...new Set(changed.map((b) => businessLabel(b.key, b.label, nameById)))];
    return { count: changed.length, names: names.slice(0, MAX_NAMES) };
  } catch {
    return null;
  }
}

/** 実運用の入口。compare / worker / パーツカタログを既定依存として束ねる。 */
export async function computeChangedSummary(
  input: SummaryInput,
): Promise<ReviewChangedSummary | null> {
  const compare = useCompareService();
  const parts = usePartRepo();
  void useReviewRepo; // 依存の対称性のための参照はしない(消すなら import ごと)
  return computeChangedSummaryWith(input, {
    renderAfter: (html, css, fundCode) => compare.renderTemplateBody(html, css, fundCode),
    renderBefore: (templateId) => compare.renderVersionHtml(`baseline:${templateId}`),
    buildHtmlDiff: (b, a, cb, ca) => htmlWorker.buildHtmlDiff(b, a, cb, ca),
    loadNames: () => loadPartNameMap(parts),
  });
}
```

※ `useReviewRepo` の参照は不要なので実装時に import ごと外す（上のコードから該当 2 行を削る）。`usePartRepo` の実際の export 名は `editor/web/src/api/repositories.ts` を開いて確認し、違えば合わせる。

- [ ] **Step 4: パスを通す**

Run: `pnpm --dir editor exec vitest run --project web test/changedSummary.test.ts` → PASS

- [ ] **Step 5: PreviewView へ配線**

`editor/web/src/features/preview/PreviewView.vue` の `submitForReview`（107-116 行）を変更。import に `computeChangedSummary` を追加し:

```ts
  // 一覧の先出し表示用の変更概要(ベストエフォート・失敗は null で申請は続行)。
  const changedSummary = await computeChangedSummary({
    templateId: props.id,
    html: restoredHtml.value,
    css: css.value,
    fundCode: fundCode.value,
    origin: origin.value,
  });
  const submitted = await runSubmit(() =>
    reviews.submitReview({
      templateId: props.id,
      html: restoredHtml.value,
      css: css.value,
      fundCode: fundCode.value,
      // レンダリング済みドキュメントを、申請の記入済みレポートインスタンスとして保持する。
      filledHtml: previewDoc.value,
      origin: origin.value,
      ...(changedSummary ? { changedSummary } : {}),
    }),
  );
```

- [ ] **Step 6: 全体テスト・コミット**

Run: `pnpm --dir editor exec vitest run --project web` → PASS
ルート `vitest.config.ts` include へ `editor/web/src/features/reviews/services/changedSummary.ts` を追加。

```bash
pnpm exec biome check --write editor/web/src/features editor/web/test/changedSummary.test.ts
git add editor/web vitest.config.ts
git commit -m "feat(editor): 申請時に変更概要(changedSummary)を計算して保存(一覧の先出し表示用)"
```

---

### Task 6: 通知集約コンポーネント `ReviewNoticeBar.vue`

**Files:**
- Create: `editor/web/src/features/reviews/ReviewNoticeBar.vue`
- Test: `editor/web/test/reviewNoticeBar.test.ts`（新規）

**Interfaces:**
- Consumes: `useReviewDiff` の `cssChanged/cssBefore/cssAfter/printOnlyCss/truncated` と View の `hiddenRowCount`
- Produces: props `{ cssChanged: boolean; cssBefore: string; cssAfter: string; printOnlyCss: boolean; truncated: boolean; hiddenRowCount: number }`、emit `openPdf: []`（「PDF を開いて確認」）。該当 0 件なら何も描画しない。**該当する項目は v-if で存在ごと消さず、`<details>` の折りたたみでのみ隠す**

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/reviewNoticeBar.test.ts`:

```ts
// =============================================================================
// reviewNoticeBar.test.ts — 精査画面の通知集約(業務語 1 行 + 詳細折りたたみ)
// =============================================================================
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ReviewNoticeBar from '@/features/reviews/ReviewNoticeBar.vue';

const noneProps = {
  cssChanged: false,
  cssBefore: '',
  cssAfter: '',
  printOnlyCss: false,
  truncated: false,
  hiddenRowCount: 0,
};

describe('ReviewNoticeBar', () => {
  it('該当 0 件なら何も描画しない', () => {
    const w = mount(ReviewNoticeBar, { props: noneProps });
    expect(w.find('details').exists()).toBe(false);
  });

  it('件数を集約した 1 行見出しを出す', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, cssChanged: true, cssBefore: 'a{}', cssAfter: 'b{}', truncated: true },
    });
    expect(w.find('summary').text()).toContain('2 件');
  });

  it('書式設定の変更は常に先頭で、CSS 前後がさらに折りたたみで DOM に常在する', () => {
    const w = mount(ReviewNoticeBar, {
      props: {
        ...noneProps,
        cssChanged: true,
        cssBefore: '.old{}',
        cssAfter: '.new{}',
        printOnlyCss: true,
      },
    });
    const items = w.findAll('[data-notice-item]');
    expect(items[0].text()).toContain('書式設定');
    // 折りたたみでも中身は DOM に居る(完全性要件: 隠しても消さない)
    expect(w.text()).toContain('.old{}');
    expect(w.text()).toContain('.new{}');
  });

  it('印刷用書式の項目は PDF 確認の導線(openPdf)を出す', async () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, printOnlyCss: true } });
    await w.find('[data-open-pdf]').trigger('click');
    expect(w.emitted('openPdf')).toHaveLength(1);
  });

  it('一覧打ち切り(hiddenRowCount)は分割再申請の依頼文で出す', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, hiddenRowCount: 5 } });
    expect(w.text()).toContain('分けて出し直す');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/reviewNoticeBar.test.ts` → FAIL

- [ ] **Step 3: 実装**

`editor/web/src/features/reviews/ReviewNoticeBar.vue`:

```vue
<script setup lang="ts">
// =============================================================================
// ReviewNoticeBar.vue — 精査画面の技術的警告を業務語 1 行へ集約する通知バー
// =============================================================================
// 旧画面はバナー 4 種(truncated / printOnlyCss / cssChanged / 行打ち切り)が個別に並び、
// 「ファンド共通 CSS」「語句単位の着色」等の実装語彙が承認者(事務担当者)へ直接出ていた。
// 本コンポーネントは全種を「⚠ 画面だけでは確認しきれない変更が N 件」の 1 行へ束ね、
// 展開で業務語の説明を出す。**該当項目を v-if で消すのは条件そのものが偽のときだけ**で、
// 真である限り DOM に常在させる(折りたたみは表示状態のみ) — 設計正典「承認者が見る画面の
// 完全性は 1 つの要件」の担保。書式設定(cssChanged)だけが「見た目比較に出ないかも
// しれない変更」なので常に先頭・強調とする。
import { computed } from 'vue';

const props = defineProps<{
  cssChanged: boolean;
  cssBefore: string;
  cssAfter: string;
  printOnlyCss: boolean;
  truncated: boolean;
  hiddenRowCount: number;
}>();

const emit = defineEmits<{ openPdf: [] }>();

const count = computed(
  () =>
    (props.cssChanged ? 1 : 0) +
    (props.printOnlyCss ? 1 : 0) +
    (props.truncated ? 1 : 0) +
    (props.hiddenRowCount > 0 ? 1 : 0),
);
</script>

<template>
  <details
    v-if="count > 0"
    open
    class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
  >
    <summary class="cursor-pointer font-medium">
      ⚠ 画面だけでは確認しきれない変更が {{ count }} 件あります（開いて確認）
    </summary>
    <ol class="mt-2 space-y-3">
      <li v-if="cssChanged" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">このファンドの書式設定も変更されています</p>
        <p class="mt-1 text-xs text-amber-800">
          文字の大きさ・色・配置などの決まりが変更されました。このファンドの
          <strong>他の版種（全体版など）の見た目にも影響する</strong>可能性があります。
          左右の見た目比較に差がないか、特に注意して確認してください。
        </p>
        <details class="mt-1 text-xs">
          <summary class="cursor-pointer text-amber-900 underline">
            書式の変更内容を表示（変更前｜変更後）
          </summary>
          <div class="mt-2 grid gap-3 md:grid-cols-2">
            <figure class="min-w-0 space-y-1">
              <figcaption>変更前（現在の本番）</figcaption>
              <pre class="max-h-64 overflow-auto rounded border bg-white p-2 text-foreground"><code>{{ cssBefore }}</code></pre>
            </figure>
            <figure class="min-w-0 space-y-1">
              <figcaption>変更後（申請された内容）</figcaption>
              <pre class="max-h-64 overflow-auto rounded border bg-white p-2 text-foreground"><code>{{ cssAfter }}</code></pre>
            </figure>
          </div>
        </details>
      </li>
      <li v-if="printOnlyCss" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">画面では確認できない印刷用の書式が含まれています</p>
        <p class="mt-1 text-xs text-amber-800">
          一部の書式は PDF にしたときだけ反映されます。右の「修正後」は PDF と同じ仕組みで
          表示していますが、心配な場合は
          <button type="button" data-open-pdf class="underline" @click="emit('openPdf')">
            PDF を開いて確認
          </button>
          してください。
        </p>
      </li>
      <li v-if="truncated" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">「文字の変更の一覧」に表示しきれなかった項目があります</p>
        <p class="mt-1 text-xs text-amber-800">
          変更がとても多いため、一覧には全件を表示できていません。
          <strong>左右の見た目比較ではすべてのページを確認できます</strong>ので、そちらで
          全ページをご確認ください。
        </p>
      </li>
      <li v-if="hiddenRowCount > 0" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">変更箇所が多すぎるため、一覧の一部を表示できません</p>
        <p class="mt-1 text-xs text-amber-800">
          残り {{ hiddenRowCount }} 件が一覧に出ていません。左右の見た目比較で確認するか、
          編集者に<strong>申請をいくつかに分けて出し直す</strong>よう依頼してください。
        </p>
      </li>
    </ol>
  </details>
</template>
```

- [ ] **Step 4: パスを通す・コミット**

Run: `pnpm --dir editor exec vitest run --project web test/reviewNoticeBar.test.ts` → PASS

```bash
pnpm exec biome check --write editor/web/src/features/reviews/ReviewNoticeBar.vue editor/web/test/reviewNoticeBar.test.ts
git add editor/web
git commit -m "feat(editor): 精査画面の警告を業務語1行+折りたたみへ集約する ReviewNoticeBar を追加"
```

---

### Task 7: 前後比較文書の組み立て `reviewCompareDocs.ts`（マーカー + アンカー）

**Files:**
- Create: `editor/web/src/features/reviews/services/reviewCompareDocs.ts`
- Test: `editor/web/test/reviewCompareDocs.test.ts`（新規）

**Interfaces:**
- Consumes: `reviewDiffService` が持つ before/after の完全 HTML と CSS（`renderVersionHtml`/`renderTemplateBody` の戻り値）、変更行の `key` 集合、`blockKey.ts` の `occurrenceKey`
- Produces: `buildCompareDocs(args): { beforeDoc: string; afterDoc: string; anchors: string[] }`。`args = { beforeHtml, afterHtml, cssBefore, cssAfter, changedKeys: ReadonlySet<string>, marker: boolean }`。変更ブロックへ `data-review-marker` 属性 + `id="review-anchor-<n>"` を付与し、マーカー CSS は**CSPRNG レイヤ名のカスケードレイヤ + `!important`**（`display` は使わない）。`anchors` は文書内の出現順

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/reviewCompareDocs.test.ts`:

```ts
// =============================================================================
// reviewCompareDocs.test.ts — 精査画面の左右組版比較に渡す完全文書の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import { buildCompareDocs } from '@/features/reviews/services/reviewCompareDocs';

const afterHtml =
  '<div class="page"><div data-part-id="note-a">A2</div><p>same</p></div>';
const beforeHtml =
  '<div class="page"><div data-part-id="note-a">A1</div><p>same</p></div>';

function build(marker = true) {
  return buildCompareDocs({
    beforeHtml,
    afterHtml,
    cssBefore: '.page{margin:0}',
    cssAfter: '.page{margin:0}',
    changedKeys: new Set(['note-a#1']),
    marker,
  });
}

describe('buildCompareDocs', () => {
  it('完全な HTML 文書(CSS 内蔵)を返す', () => {
    const { beforeDoc, afterDoc } = build();
    for (const doc of [beforeDoc, afterDoc]) {
      expect(doc).toContain('<!doctype html>');
      expect(doc).toContain('.page{margin:0}');
    }
  });

  it('変更ブロックにマーカー属性とアンカー id を付与する', () => {
    const { afterDoc, anchors } = build();
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['review-anchor-1']);
    expect(afterDoc).toContain('id="review-anchor-1"');
  });

  it('マーカー CSS はカスケードレイヤ + !important で、レイヤ名は毎回変わる', () => {
    const a = build().afterDoc;
    const b = build().afterDoc;
    expect(a).toMatch(/@layer\s+rvm[0-9a-f]+/);
    expect(a).toContain('!important');
    expect(a).not.toContain('display:');
    const layer = (d: string) => /@layer\s+(rvm[0-9a-f]+)/.exec(d)?.[1];
    expect(layer(a)).not.toBe(layer(b));
  });

  it('marker: false ではマーカー CSS を入れない(アンカー id は残す)', () => {
    const { afterDoc, anchors } = build(false);
    expect(afterDoc).not.toContain('@layer');
    expect(anchors).toEqual(['review-anchor-1']);
  });

  it('変更キーが無い側(before に無い added 等)でも壊れない', () => {
    const { beforeDoc } = buildCompareDocs({
      beforeHtml: '',
      afterHtml,
      cssBefore: '',
      cssAfter: '',
      changedKeys: new Set(['note-a#1']),
      marker: true,
    });
    expect(beforeDoc).toContain('<!doctype html>');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/reviewCompareDocs.test.ts` → FAIL

- [ ] **Step 3: 実装**

`editor/web/src/features/reviews/services/reviewCompareDocs.ts`:

```ts
// =============================================================================
// reviewCompareDocs.ts — 精査画面の左右組版比較(PreviewPanel×2)へ渡す完全文書
// =============================================================================
// 精査画面の主役は「修正前｜修正後」を実際の帳票と同じ組版(vivliostyle)で並べる比較で、
// 本モジュールは compare サービスが返す本文 HTML + CSS を PreviewPanel が受け取れる
// 完全文書へ包み、変更ブロックへマーカーとアンカーを付ける。
//
// - マーカーは既存の差分装飾と同じ「CSPRNG レイヤ名のカスケードレイヤ + !important」で
//   守る(申請者 CSS は同レイヤ名を当てられない限り上書きできない)。`display` は
//   上書きしない(表セルのレイアウトを壊す)。
// - ここで作る文書は**表示専用**で、申請へ保存されるバイト列(html/css/filledHtml)には
//   一切触れない。DOM 経由の再直列化はこの表示境界だけで行う。
// - 変更ブロックの同定は差分エンジンと同じ `occurrenceKey`(blockKey.ts)を使う。キーの
//   算出規則が割れると「差分一覧では変更なのにマーカーが付かない」ズレになるため、
//   独自の突合を書かない。
import { occurrenceKey } from '@/lib/blockKey';

export interface CompareDocsInput {
  beforeHtml: string;
  afterHtml: string;
  cssBefore: string;
  cssAfter: string;
  /** 変更(changed/added/removed)ブロックのキー集合(`reviewDiffService` の rows 由来)。 */
  changedKeys: ReadonlySet<string>;
  /** 黄マーカーを描くか。false でも位置ジャンプ用のアンカー id は付ける。 */
  marker: boolean;
}

export interface CompareDocs {
  beforeDoc: string;
  afterDoc: string;
  /** after 文書内の出現順のアンカー id(「次の変更箇所へ」の巡回に使う)。 */
  anchors: string[];
}

/** `.page` 直下の top-level block を列挙し、変更キーに一致する要素へ印を付ける。 */
function annotate(
  html: string,
  changedKeys: ReadonlySet<string>,
): { html: string; anchors: string[] } {
  if (!html.trim()) return { html, anchors: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors: string[] = [];
  let seq = 0;
  for (const page of Array.from(doc.querySelectorAll('.page'))) {
    const blocks = Array.from(page.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    for (const el of blocks) {
      if (!changedKeys.has(occurrenceKey(el, blocks))) continue;
      seq += 1;
      const id = `review-anchor-${seq}`;
      el.setAttribute('data-review-marker', '');
      // 既存 id は差分キーの一部でありうるため上書きしない(未設定のときだけ振る)。
      if (!el.id) el.id = id;
      anchors.push(el.id);
    }
  }
  return { html: doc.body.innerHTML, anchors };
}

/** マーカー装飾。レイヤ名は文書ごとに CSPRNG で変え、申請者 CSS からの同名上書きを防ぐ。 */
function markerCss(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const layer = `rvm${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return [
    `@layer ${layer};`,
    `@layer ${layer} {`,
    '[data-review-marker] {',
    '  background-color: #FFF3BF !important;',
    '  outline: 2px solid #E8B931 !important;',
    '  outline-offset: 1px !important;',
    '}',
    '}',
  ].join('\n');
}

function wrapDoc(bodyHtml: string, css: string, marker: boolean): string {
  const markerBlock = marker ? `<style>${markerCss()}</style>` : '';
  // マーカーのレイヤ宣言は申請者 CSS より**前**に出す(重要宣言はレイヤ優先順位が逆転する
  // 性質を使うため、先に宣言した側が勝つ)。
  return `<!doctype html><html><head><meta charset="utf-8">${markerBlock}<style>${css}</style></head><body>${bodyHtml}</body></html>`;
}

export function buildCompareDocs(input: CompareDocsInput): CompareDocs {
  const before = annotate(input.beforeHtml, input.changedKeys);
  const after = annotate(input.afterHtml, input.changedKeys);
  return {
    beforeDoc: wrapDoc(before.html, input.cssBefore, input.marker),
    afterDoc: wrapDoc(after.html, input.cssAfter, input.marker),
    anchors: after.anchors.length > 0 ? after.anchors : before.anchors,
  };
}
```

- [ ] **Step 4: パスを通す・コミット**

Run: `pnpm --dir editor exec vitest run --project web test/reviewCompareDocs.test.ts` → PASS
ルート `vitest.config.ts` include へ `editor/web/src/features/reviews/services/reviewCompareDocs.ts` を追加。

```bash
pnpm exec biome check --write editor/web/src/features/reviews editor/web/test/reviewCompareDocs.test.ts
git add editor/web vitest.config.ts
git commit -m "feat(editor): 精査の左右組版比較用の完全文書組み立て(変更マーカー+アンカー)を追加"
```

---

### Task 8: preview-host の `goto-anchor` 命令

**Files:**
- Modify: `editor/shared/src/preview/hostProtocol.ts:54`
- Modify: `editor/server/src/vivliostyle/previewHost.ts:265-290` 付近（BOOT_SCRIPT の `command`）
- Modify: `editor/web/src/features/preview/PreviewPanel.vue:203-252`
- Test: `editor/web/test/previewPanel.test.ts`（既存へ追記）

**Interfaces:**
- Consumes: 既存 postMessage 契約（`PREVIEW_MSG_CMD` / `PreviewCommand`）
- Produces: `PreviewCommand` に `'gotoAnchor'`（引数 `anchor: string`）、`PreviewPanel` の `defineExpose` に `gotoAnchor(id: string)`。ホスト側で移動が失敗しても**例外を親へ返さない**（フォールバック = 何も起きない。マーカー + 手動ページ送りで代替）

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/previewPanel.test.ts` の既存 describe（postMessage 送信の検証がある）へ追記。既存テストが `wrapper.vm.nextPage()` 等で `postMessage` 内容を検証しているパターンに合わせる:

```ts
  it('gotoAnchor は cmd と anchor を子へ送る', async () => {
    // 既存テストと同じ手順で READY を受信済みにしてから
    wrapper.vm.gotoAnchor('review-anchor-2');
    expect(lastPostedMessage()).toMatchObject({
      type: PREVIEW_MSG_CMD,
      cmd: 'gotoAnchor',
      anchor: 'review-anchor-2',
    });
  });
```

※ `lastPostedMessage()` は既存テストの postMessage 捕捉ヘルパ名に合わせる。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/previewPanel.test.ts` → FAIL

- [ ] **Step 3: 契約・ホスト・パネルを実装**

`editor/shared/src/preview/hostProtocol.ts` 54 行:

```ts
/** 親から子へ送れる操作。`goToPage` はページ番号、`gotoAnchor` は要素 id を引数に取る。 */
export type PreviewCommand =
  | 'prevPage'
  | 'nextPage'
  | 'goToPage'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'gotoAnchor';
```

`editor/server/src/vivliostyle/previewHost.ts` BOOT_SCRIPT の `command(cmd,page)` を `command(cmd,page,anchor)` にし、`fit` 分岐の後へ追加（受信部 288 行の呼び出しも `command(d.cmd,d.page,d.anchor)` へ変更）:

```js
      else if(cmd==='gotoAnchor'){
        // 変更箇所ジャンプ。core の内部リンク移動(navigateToInternalUrl 相当)は版により
        // API が異なるため、まず href 形式の navigate を試し、無ければ**ページ内検索**で
        // 要素の属するページへ goToPage する。どちらも失敗したら黙って何もしない
        // (親はフォールバック = マーカー + 手動ページ送りで代替できる)。
        try{
          if(typeof anchor==='string'&&/^[A-Za-z0-9_-]+$/.test(anchor)){
            viewer.navigateToInternalUrl('#'+anchor);
          }
        }catch(e){/* 移動失敗は無視(操作不能へ倒さない) */}
      }
```

※ BOOT_SCRIPT 実装時に `viewer` オブジェクトの実 API 名を同ファイル内の既存呼び出し（`navigateToPage` 等）の定義元で確認し、内部リンク移動に相当するメソッドが無い場合はこの分岐を「`document.getElementById(anchor)` の属するページ index を数えて `goToPage` と同じ処理を呼ぶ」実装に差し替える。**どの実装でも try/catch で包み、失敗を子から親へ伝播させない。**

`editor/web/src/features/preview/PreviewPanel.vue` の `send` の下へ:

```ts
function gotoAnchor(id: string) {
  if (useFallback.value) return;
  postToHost({ type: PREVIEW_MSG_CMD, cmd: 'gotoAnchor', anchor: id });
}
```

`defineExpose` を `{ prevPage, nextPage, goToPage, zoomIn, zoomOut, fit, gotoAnchor }` へ。

- [ ] **Step 4: パスを通す・コミット**

Run: `pnpm --dir editor exec vitest run --project web test/previewPanel.test.ts` → PASS
Run: `pnpm --dir editor typecheck` → PASS

```bash
pnpm exec biome check --write editor/shared/src/preview/hostProtocol.ts editor/web/src/features/preview/PreviewPanel.vue
git add editor/shared editor/server editor/web
git commit -m "feat(editor): プレビューホストに変更箇所ジャンプ(gotoAnchor)命令を追加"
```

---

### Task 9: 精査画面の再構成（`ReviewVisualCompare.vue` + `ReviewDiffView.vue` + `useReviewDiff` hold）

**Files:**
- Create: `editor/web/src/features/reviews/ReviewVisualCompare.vue`
- Modify: `editor/web/src/features/reviews/useReviewDiff.ts`
- Modify: `editor/web/src/features/reviews/ReviewDiffView.vue`
- Test: `editor/web/test/reviewDiffView.wording.test.ts`（新規・文言/構成ガード）

**Interfaces:**
- Consumes: Task 6 `ReviewNoticeBar`、Task 7 `buildCompareDocs`、Task 8 `gotoAnchor`、Task 3 `holdReview`
- Produces: `useReviewDiff` が `hold(comment?): Promise<Result<ReviewRequestMeta>>` を返す。`ReviewVisualCompare` props `{ beforeHtml, afterHtml, cssBefore, cssAfter, changedKeys: string[], isCreate: boolean }`。`ReviewDiffView` はタブ切替（既定 = 見た目比較）+ 通知バー + アクションバー（保留/差し戻す/承認する）

- [ ] **Step 1: useReviewDiff へ hold を追加（テスト先行）**

`editor/web/test/reviewDiffView.wording.test.ts`（コンポーネントの重い mount は避け、ソース走査 + composable 単体で固定する。`twoSystems.guard.test.ts` と同じソース走査流儀）:

```ts
// =============================================================================
// reviewDiffView.wording.test.ts — 精査画面の構成・文言ガード(事務担当者向け改修)
// =============================================================================
// 実装概念の露出(旧文言)への退行と、警告の完全性(通知バーの常在)を機械検証する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(resolve(__dirname, '..', 'src', p), 'utf8');

describe('ReviewDiffView の構成', () => {
  const view = src('features/reviews/ReviewDiffView.vue');

  it('技術語彙の警告文言を直接出さない(通知バーへ集約済み)', () => {
    expect(view).not.toContain('ファンド共通 CSS');
    expect(view).not.toContain('語句単位の着色');
  });

  it('通知バー・見た目比較・保留ボタンを組み込んでいる', () => {
    expect(view).toContain('ReviewNoticeBar');
    expect(view).toContain('ReviewVisualCompare');
    expect(view).toContain('保留する');
    expect(view).toContain('差し戻す');
  });

  it('差分行 iframe の sandbox 構成を変えていない', () => {
    expect(view).toContain('sandbox="allow-scripts"');
    expect(view).not.toContain('allow-same-origin');
  });
});

describe('ReviewVisualCompare の隔離構成', () => {
  it('PreviewPanel を使い、独自 iframe を作らない', () => {
    const cmp = src('features/reviews/ReviewVisualCompare.vue');
    expect(cmp).toContain('PreviewPanel');
    expect(cmp).not.toContain('<iframe');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/reviewDiffView.wording.test.ts` → FAIL

- [ ] **Step 3: useReviewDiff に hold と比較用データを追加**

`editor/web/src/features/reviews/useReviewDiff.ts`:

- `reject` の下へ:

```ts
  /** 保留(実ファイル非更新)。判断を後回しにして一覧へ戻るための遷移。 */
  function hold(comment?: string): Promise<Result<ReviewRequestMeta>> {
    return runDecide(() => reviews.holdReview(reqId(), { comment }));
  }
```

- `buildDiff` の結果から見た目比較の素材を公開する。`reviewDiffService.ts` の `ReviewDiffData` に before/after の**本文 HTML** を追加する:
  - `interface ReviewDiffData` へ `beforeBodyHtml: string; afterBodyHtml: string;` を追加し、`buildDiff` の `return ok({...})` に `beforeBodyHtml: beforeHtml, afterBodyHtml: after.html,` を追加。
  - `useReviewDiff` に `const beforeBodyHtml = ref(''); const afterBodyHtml = ref('');` を足して `load` で反映し、return へ `beforeBodyHtml, afterBodyHtml, hold` を追加。

- [ ] **Step 4: ReviewVisualCompare.vue を実装**

`editor/web/src/features/reviews/ReviewVisualCompare.vue`:

```vue
<script setup lang="ts">
// =============================================================================
// ReviewVisualCompare.vue — 精査画面の主役: 修正前｜修正後の左右組版比較
// =============================================================================
// PreviewPanel(隔離 preview-host iframe)を 2 面並べ、実際の帳票と同じ組版で前後を
// 見せる。ページ送りは左右連動、変更ブロックは黄マーカー(トグルで消して素の見た目も
// 確認できる — 完全性要件)。新規作成申請(isCreate)は前面が存在しないため単面表示。
// 文書の組み立て(マーカー・アンカー)は `reviewCompareDocs.ts` に委譲する。
import { ChevronLeft, ChevronRight, MapPin } from '@lucide/vue';
import { computed, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import PreviewPanel from '@/features/preview/PreviewPanel.vue';
import { buildCompareDocs } from './services/reviewCompareDocs';

const props = defineProps<{
  beforeHtml: string;
  afterHtml: string;
  cssBefore: string;
  cssAfter: string;
  changedKeys: string[];
  isCreate: boolean;
}>();

const showMarker = ref(true);

// マーカーのレイヤ名は乱数だが、docs は入力とトグルにのみ依存する computed で組む
// (`ReviewDiffView` の renderedRows と同じ規律 — 無関係な再描画で全再組版を起こさない)。
const docs = computed(() =>
  buildCompareDocs({
    beforeHtml: props.beforeHtml,
    afterHtml: props.afterHtml,
    cssBefore: props.cssBefore,
    cssAfter: props.cssAfter,
    changedKeys: new Set(props.changedKeys),
    marker: showMarker.value,
  }),
);

const beforePanel = ref<InstanceType<typeof PreviewPanel>>();
const afterPanel = ref<InstanceType<typeof PreviewPanel>>();
const beforeState = ref({ currentPage: 1, pageCount: 0, atFirst: true, atLast: false });
const afterState = ref({ currentPage: 1, pageCount: 0, atFirst: true, atLast: false });

/** ページ送りは左右へ同時に送る(片面が短い場合は末尾で止まるだけ)。 */
function prev() {
  beforePanel.value?.prevPage();
  afterPanel.value?.prevPage();
}
function next() {
  beforePanel.value?.nextPage();
  afterPanel.value?.nextPage();
}

/** 「次の変更箇所へ」— アンカー巡回。移動が効かない環境ではマーカー+手動送りで代替。 */
const anchorIndex = ref(-1);
function nextAnchor() {
  const anchors = docs.value.anchors;
  if (anchors.length === 0) return;
  anchorIndex.value = (anchorIndex.value + 1) % anchors.length;
  const id = anchors[anchorIndex.value];
  beforePanel.value?.gotoAnchor(id);
  afterPanel.value?.gotoAnchor(id);
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" :disabled="afterState.atFirst" @click="prev">
        <ChevronLeft class="h-4 w-4" /> 前のページ
      </Button>
      <Button variant="outline" size="sm" :disabled="afterState.atLast" @click="next">
        次のページ <ChevronRight class="h-4 w-4" />
      </Button>
      <Button
        v-if="docs.anchors.length > 0"
        variant="outline"
        size="sm"
        @click="nextAnchor"
      >
        <MapPin class="h-4 w-4" /> 次の変更箇所へ
      </Button>
      <span class="text-xs text-muted-foreground">
        {{ afterState.currentPage }} / {{ afterState.pageCount || '?' }} ページ（左右連動）
      </span>
      <label class="ml-auto flex cursor-pointer items-center gap-1.5">
        <Checkbox v-model="showMarker" />
        <span class="text-xs">変更箇所に印を付ける</span>
      </label>
    </div>
    <div class="grid gap-3" :class="isCreate ? '' : 'md:grid-cols-2'">
      <figure v-if="!isCreate" class="min-w-0 space-y-1">
        <figcaption class="text-xs font-medium text-muted-foreground">
          修正前（現在の本番）
        </figcaption>
        <div class="h-[70vh] overflow-hidden rounded border">
          <PreviewPanel
            ref="beforePanel"
            :html="docs.beforeDoc"
            @state="(s) => (beforeState = s)"
          />
        </div>
      </figure>
      <figure class="min-w-0 space-y-1">
        <figcaption class="text-xs font-medium text-accent-foreground">
          {{ isCreate ? '新規作成される内容' : '修正後（申請された内容）' }}
        </figcaption>
        <div class="h-[70vh] overflow-hidden rounded border">
          <PreviewPanel
            ref="afterPanel"
            :html="docs.afterDoc"
            @state="(s) => (afterState = s)"
          />
        </div>
      </figure>
    </div>
  </div>
</template>
```

- [ ] **Step 5: ReviewDiffView.vue を再構成**

`editor/web/src/features/reviews/ReviewDiffView.vue` の template・script を再構成する。**既存の script ロジック（renderedRows / buildDoc / notifySyncResult / notifyNoteMasterResult / approve / reject / canDecide / goBack）は保持**し、次を変更:

(a) script 追加:

```ts
import ReviewNoticeBar from './ReviewNoticeBar.vue';
import ReviewVisualCompare from './ReviewVisualCompare.vue';
// useReviewDiff の分割代入へ beforeBodyHtml / afterBodyHtml / hold を追加

// 表示タブ。既定は見た目比較(事務担当者の主観点は「最終の見た目がどうなるか」)。
const activeTab = ref<'visual' | 'text'>('visual');
const changedKeys = computed(() =>
  rows.value.filter((r) => r.status !== 'same').map((r) => r.key),
);
/** 変更要約 1 行(実差分由来。changedSummary 自己申告とは独立)。 */
const changedNames = computed(() => {
  const names = [...new Set(rows.value.filter((r) => r.status !== 'same').map((r) => r.label))];
  return names.slice(0, 5);
});

async function holdRequest() {
  const res = await hold(comment.value.trim() || undefined);
  if (isOk(res)) {
    toastSuccess('保留しました（一覧の「保留中」から確認を再開できます）');
    router.push({ name: 'reviews' });
  }
}

/** 通知バーの「PDF を開いて確認」— 修正後 1 文書を既存 build API で開く。 */
async function openPdf() {
  // features/merge の mergePdfService か lib/pdfDocument の既存 PDF 生成ヘルパを流用し、
  // review.value.filledHtml ?? afterBodyHtml を POST /api/build へ渡して Blob を window.open
  // する。実装時に PreviewView の PDF 出力ボタンの既存実装を探して同じ経路を使うこと
  // (新しい PDF 生成経路を作らない)。
}
```

(b) template の再構成（229 行の見出し・警告バナー群 264-305 行・行リストの位置を組み替え）:

- 見出し「確定保存の精査」→「申請内容の確認」
- 集計行（248-259 行）を変更要約 1 行へ:

```html
      <p class="text-sm">
        変更されたのは
        <strong>{{ summary.changed + summary.added + summary.removed }} か所</strong>
        <template v-if="changedNames.length">
          : <span class="font-medium text-accent-foreground">{{ changedNames.join('、') }}</span>
        </template>
      </p>
```

- 警告バナー 3 種（truncated 264-271 / printOnlyCss 276-282 / cssChanged 287-305）を削除し、1 行へ:

```html
      <ReviewNoticeBar
        :css-changed="cssChanged"
        :css-before="cssBefore"
        :css-after="cssAfter"
        :print-only-css="printOnlyCss"
        :truncated="truncated"
        :hidden-row-count="hiddenRowCount"
        @open-pdf="openPdf"
      />
```

- タブ切替 + 見た目比較（EmptyState の前に配置）:

```html
      <div class="flex items-center gap-1.5">
        <Button
          :variant="activeTab === 'visual' ? 'default' : 'outline'"
          size="sm"
          @click="activeTab = 'visual'"
        >
          見た目で比較
        </Button>
        <Button
          :variant="activeTab === 'text' ? 'default' : 'outline'"
          size="sm"
          @click="activeTab = 'text'"
        >
          文字の変更を一覧で見る
        </Button>
      </div>

      <ReviewVisualCompare
        v-if="activeTab === 'visual'"
        :before-html="beforeBodyHtml"
        :after-html="afterBodyHtml"
        :css-before="cssBefore"
        :css-after="cssAfter"
        :changed-keys="changedKeys"
        :is-create="review.origin === 'create'"
      />
```

- 既存のパーツ行リスト（EmptyState 309-318 / `<ul>` 322-416 / hiddenRowCount バナー 420-426 — バナーは NoticeBar 移管済みのため削除）を `<template v-else>`（activeTab === 'text'）で包む。coarse 注記の文言（339 行）を「この箇所は変更が大きいため、変わった文字の色付けはせず全文を並べています」へ変更。
- アクションバー（429-454 行）: ラベルを「コメント（差し戻し時は必須。保留時はメモとして残ります）」へ、ボタンを 3 つに:

```html
        <div class="flex items-center justify-end gap-2">
          <Button variant="outline" :disabled="deciding" @click="holdRequest">保留する</Button>
          <Button variant="outline" :disabled="deciding" @click="reject">
            <Loader2 v-if="deciding" class="h-4 w-4 animate-spin" />
            <X v-else class="h-4 w-4" /> 差し戻す
          </Button>
          <Button :disabled="deciding" @click="approve">
            <Loader2 v-if="deciding" class="h-4 w-4 animate-spin" />
            <Check v-else class="h-4 w-4" /> 承認する
          </Button>
        </div>
```

- `canDecide`（111 行）を held 対応へ: `review.value?.status === 'pending' || review.value?.status === 'held'`
- reject のエラーメッセージ「却下には理由の入力が必要です。」→「差し戻しには理由の入力が必要です。」、toast「却下しました」→「差し戻しました」
- 処理済み表示（457-465 行）の分岐へ held を足す（`保留中` は canDecide が真なので通常この分岐に来ない — status ラベルの Record を `approved: '承認済' / rejected: '差し戻し済'` へ）。

(c) `openPdf` は実装時に PreviewView の PDF 出力実装（`features/preview` 配下の build API 呼び出し）を探して同じ関数を呼ぶ。**新しい PDF 生成経路・新しい fetch 実装を書かない。**

- [ ] **Step 6: パスを通す**

Run: `pnpm --dir editor exec vitest run --project web test/reviewDiffView.wording.test.ts` → PASS
Run: `pnpm --dir editor exec vitest run --project web` → PASS（`xssGuards` / `iframeSandbox.guard` / `twoSystems.guard` を含め全 green。ガードが `ReviewDiffView` のソース断言を持つ場合は新構成の該当行に合わせて**断言の対象を移すだけ**にする — 検査の弱体化はしない）

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/reviews editor/web/test/reviewDiffView.wording.test.ts
git add editor/web
git commit -m "feat(editor): 精査画面を見た目比較主体に再構成(通知集約・保留・業務語文言)"
```

---

### Task 10: 一覧画面の再構成（`ReviewQueueView.vue`）

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewQueueView.vue`
- Test: `editor/web/test/reviewQueueView.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の `held` / `changedSummary` / `holdComment`
- Produces: サマリ 4 箱（承認待ち / 保留中 / 承認済み / 差し戻し）= フィルタ兼用、カードに変更概要と保留メモ、ボタン文言「内容を確認する」「確認を再開する」

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/reviewQueueView.test.ts`（repo をモックして mount。`templateTable.test.ts` の mount + モック流儀に合わせる）:

```ts
// =============================================================================
// reviewQueueView.test.ts — 承認キュー一覧のサマリ・保留・変更概要表示
// =============================================================================
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
// モック構成は templateTable.test.ts と同じ流儀:
// - useReviewRepo を vi.mock して listReviews が全状態のメタ配列を返す
// - useAuthStore を approver で用意
// - vue-router は createRouter/createMemoryHistory の最小構成

const metas = [
  meta({ id: 'a', status: 'pending', changedSummary: { count: 2, names: ['運用実績の表'] } }),
  meta({ id: 'b', status: 'held', holdComment: '出所確認中' }),
  meta({ id: 'c', status: 'approved' }),
  meta({ id: 'd', status: 'rejected' }),
];

describe('ReviewQueueView', () => {
  it('サマリ 4 箱に全状態の件数を出す', async () => {
    const w = await mountQueue(metas);
    const boxes = w.findAll('[data-summary-box]');
    expect(boxes).toHaveLength(4);
    expect(boxes[0].text()).toContain('1'); // 承認待ち
    expect(boxes[1].text()).toContain('1'); // 保留中
  });

  it('カードに変更概要(自己申告)を参考表示する', async () => {
    const w = await mountQueue(metas);
    expect(w.text()).toContain('変更 2 か所');
    expect(w.text()).toContain('運用実績の表');
  });

  it('保留カードに保留メモと「確認を再開する」を出す', async () => {
    const w = await mountQueue(metas, 'held');
    expect(w.text()).toContain('出所確認中');
    expect(w.text()).toContain('確認を再開する');
  });

  it('「精査する」の文言を出さない', async () => {
    const w = await mountQueue(metas);
    expect(w.text()).not.toContain('精査する');
    expect(w.text()).toContain('内容を確認する');
  });
});
```

（`meta()` / `mountQueue()` はテストファイル内ヘルパとして実装。`meta()` は Task 1 のテストの `baseMeta` と同形のオブジェクトへ patch を被せる。）

- [ ] **Step 2: 失敗を確認**

Run: `pnpm --dir editor exec vitest run --project web test/reviewQueueView.test.ts` → FAIL

- [ ] **Step 3: 実装**

`editor/web/src/features/reviews/ReviewQueueView.vue` を再構成:

- 取得を**全件 1 回**へ: `load()` は `reviews.listReviews({})` で全状態を取り `all = ref<ReviewRequestMeta[]>([])` に保持。表示は `items = computed(() => statusFilter === 'all' ? all : all.filter(m => m.status === statusFilter))`。
- サマリ（フィルタボタン群 94-104 行を置換）:

```html
    <div class="flex flex-wrap gap-3">
      <button
        v-for="f in SUMMARY_FILTERS"
        :key="f.value"
        type="button"
        data-summary-box
        class="min-w-[110px] rounded-lg border px-4 py-2 text-center"
        :class="statusFilter === f.value ? 'border-primary bg-primary/5' : 'border-border bg-card'"
        @click="statusFilter = f.value"
      >
        <span class="block text-xl font-bold">{{ countOf(f.value) }}</span>
        <span class="text-xs text-muted-foreground">{{ f.label }}</span>
      </button>
    </div>
```

```ts
const SUMMARY_FILTERS: { label: string; value: ReviewStatus }[] = [
  { label: '承認待ち', value: 'pending' },
  { label: '保留中', value: 'held' },
  { label: '承認済み', value: 'approved' },
  { label: '差し戻し', value: 'rejected' },
];
const countOf = (s: ReviewStatus) => all.value.filter((m) => m.status === s).length;
```

（「すべて」は既定表示から外し、`statusFilter` 初期値は `'pending'`。同じ箱の再クリックで `'all'` へトグルする実装でもよい — 実装者の判断で単純な方を選ぶ。）
- `STATUS_META` へ held を追加: `held: { label: '保留中', variant: 'secondary' }`（`Badge` の variant に `secondary` があることは 136 行で確認済み）。
- カード本体へ 2 行追加（AttributeBar の下）:

```html
        <div class="w-full pl-1 text-xs text-muted-foreground">
          <span v-if="r.changedSummary">
            変更 {{ r.changedSummary.count }} か所
            <template v-if="r.changedSummary.names.length">
              （{{ r.changedSummary.names.join('・') }}）
            </template>
          </span>
          <span v-if="r.status === 'held' && r.holdComment" class="block">
            保留メモ: {{ r.holdComment }}
          </span>
        </div>
```

- ボタン文言（146-148 行）:

```html
        <Button
          size="sm"
          :variant="(r.status === 'pending' || r.status === 'held') && auth.isApprover ? 'default' : 'outline'"
          @click="openDetail(r.id)"
        >
          {{
            !auth.isApprover ? '内容を見る'
            : r.status === 'held' ? '確認を再開する'
            : r.status === 'pending' ? '内容を確認する'
            : '内容を見る'
          }}
        </Button>
```

- 説明文（84-89 行）の「精査し」→「確認し」、履歴行（140-144 行）の `'承認' : '却下'` → `'承認' : '差し戻し'`。

- [ ] **Step 4: パスを通す・コミット**

Run: `pnpm --dir editor exec vitest run --project web test/reviewQueueView.test.ts` → PASS
Run: `pnpm --dir editor exec vitest run --project web` → PASS

```bash
pnpm exec biome check --write editor/web/src/features/reviews/ReviewQueueView.vue editor/web/test/reviewQueueView.test.ts
git add editor/web
git commit -m "feat(editor): 承認キュー一覧にサマリ4箱・保留表示・変更概要の先出しを追加"
```

---

### Task 11: e2e 追随・ドキュメント更新・総合 CI

**Files:**
- Modify: `editor/e2e/capture_docs.spec.ts:133-151`（ボタン文言追随）
- Modify: `docs/editor/src/操作手順書.md` 第 7 章
- Modify: `docs/editor/src/設計書.md` 6 章（承認ワークフロー節・501 行付近）
- Modify: `docs/editor/src/設計正典.md`（中核原則の該当行があれば追随確認のみ）
- Regenerate: `docs/editor/*.html`

**Interfaces:**
- Consumes: Task 9/10 の UI 文言（「内容を確認する」「保留する」「差し戻す」）

- [ ] **Step 1: e2e の文言追随**

`editor/e2e/capture_docs.spec.ts` 151 行の `getByRole('button', { name: '精査する' })` を `{ name: '内容を確認する' }` へ変更。同 spec 内に「却下」「承認する」等の他の文言参照が無いか `精査|却下` で grep して全て追随。ほかの e2e spec（`editor/e2e/*.spec.ts`）も同様に grep して追随する。

- [ ] **Step 2: 操作手順書 第 7 章の書き替え**

`docs/editor/src/操作手順書.md` 第 7 章（181-202 行付近）を新画面の手順へ:
- 「精査する」→「内容を確認する」、承認/却下 →「承認する」「差し戻す」+「保留する」の説明
- 見た目比較（左右・ページ送り連動・変更箇所の印・次の変更箇所へ）を主手順に、「文字の変更を一覧で見る」を補助として記述
- 通知バー「⚠ 画面だけでは確認しきれない変更」の読み方（特に書式設定の変更は他版種へ影響）
- 保留の使い方（メモ・一覧の「保留中」から再開）
- 章末「うまくいかないとき」へ「承認する/差し戻すボタンが出ない」条件に保留中も操作可能である旨を追記

文体は既存手順書に合わせる（です・ます調、読者 = 事務担当者）。

- [ ] **Step 3: 設計書 6 章へ追記**

`docs/editor/src/設計書.md` の承認ワークフロー節（474-501 行付近）へ:
- 状態遷移図に `held` を追加（pending ⇄ held → approved/rejected）
- 精査画面の構成（見た目比較 = PreviewPanel×2 / 文字の変更一覧 = 従来 diff / 通知集約 / changedSummary は参考表示）を 1 段落で追記

- [ ] **Step 4: 冊子 HTML 再生成**

Run: `python docs/_build/build_all.py --project editor`
生成物（`docs/editor/editor_手引き.html` / `editor_設計.html`）をコミット対象へ。

- [ ] **Step 5: 総合 CI**

Run: `pnpm --dir editor run ci`
Expected: PASS。`capture_docs.spec.ts` が `docs/editor/images/` を再撮影して byte 差分を作る — 差分は「再撮影」としてそのままコミットする。スクリーンショットが変わったら `python docs/_build/build_all.py --project editor` を**再実行**して HTML を追随させる（画像は base64 インライン）。

- [ ] **Step 6: コミット**

```bash
git add editor/e2e docs/editor
git commit -m "docs(editor): 精査画面改修に伴う手順書7章・設計書6章の更新と e2e 文言追随"
```

---

## Self-Review 済み事項

- 仕様カバレッジ: 設計書 §2(Task 1-3) / §3(Task 10) / §4(Task 7-9) / §5(Task 6) / §6(Task 8) / §7(Task 4-5) / §8(Task 9-10) / §10(各タスクのテスト) / §11(Task 11)。§9 は Global Constraints と各タスクのガードテストが担う。
- 型整合: `holdReview(reqId, decision)` の署名は shared 契約(Task 1)・server(Task 2)・rest/local(Task 3)・useReviewDiff(Task 9)で一致。`ReviewChangedSummary` は Task 1 定義を Task 5/10 が消費。`gotoAnchor(id: string)` は Task 8 定義を Task 9 が消費。
- 既知の実装時判断点（placeholder ではなく、実装者がその場のコードに合わせる指示）:
  - Task 2 Step 1 のテストヘルパ名は既存 `reviews.test.ts` に合わせる。
  - Task 8 の BOOT_SCRIPT 内部 API 名は同ファイルの既存実装から確認（フォールバック方針は固定）。
  - Task 9 の `openPdf` は既存 PDF 生成経路の流用（新経路禁止を明記済み）。
