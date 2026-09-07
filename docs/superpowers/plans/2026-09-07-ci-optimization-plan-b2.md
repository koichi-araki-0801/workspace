# CI 最適化 計画 B2(被覆)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** カバレッジ閾値を「全体 85%」から「**ファイルごと** 4 指標 85%」(`coverage.thresholds.perFile:
true`)へ引き上げても `pnpm run test:coverage` が緑で通る状態にし、その前提として `api/rest/*` 8
ファイルの直接テスト、`server/src/routes/*.ts` の include 追加(`templates` / `parts` / `users` の
ハンドラを通す inject テスト付き)、いずれかの指標が 85% 未満のファイル全部(2026-09-07 の再計測で
**52 ファイル**。内訳は「計測結果」節)の底上げを行う。

**Architecture:** 新しい仕組みは足さない。テストは既存のハーネス(server = 最小 Fastify +
`createDeps(sproc, sessionStub)` + `app.inject()` / web-dom = jsdom + `vi.stubGlobal('fetch')` +
`@vue/test-utils` / pie-chart = vitest node)に乗せ、未到達の分岐を**行番号で狙って**書く。本番コードの
変更は「テストから到達不能な形を到達可能にする最小の DI・export」と「型で到達不能が確定している
防御分岐の除去」の 2 種類に限る(各タスクで明記)。最後に include と `perFile: true` を入れ、全体を
1 回通して閉じる。

**Tech Stack:** pnpm 11 / Node 24 / vitest 4.1.11(v8 coverage)/ Fastify 5 / Vue 3 +
@vue/test-utils / jsdom / TypeScript 6 / Biome 2.4.16

**Spec:** `docs/superpowers/specs/2026-09-06-ci-optimization-design.md` の 8 章(被覆)と 10 章の
「計画 B2 の完了条件」(perFile 閾値で `test:coverage` 緑、`routes/*.ts` が include に入っている)。
決定の記録は `docs/superpowers/specs/2026-09-06-ci-optimization-dig.md`。前計画:
`docs/superpowers/plans/2026-09-06-ci-optimization-plan-a.md`(完了)、
`docs/superpowers/plans/2026-09-06-ci-optimization-plan-b1.md`(完了。`createSprocClient` /
`createDeps` / `test/fakes/sprocFake.ts` / `test/helpers/sessionStub.ts` はこの計画の成果)。

## Global Constraints

- **閾値は 4 指標(statements / branches / functions / lines)すべて 85%、perFile**。一時的な
  低閾値エントリも include 外しもしない(設計書 8 章の決定)。分母が極小のファイル(`syncFiles`
  branches 2、`nunjucksRender` branches 4、`atomic` functions 3)は 1 件で赤くなるので、未到達の
  1 件を必ず狙う。
- **本番コードの変更は 2 種類だけ**: ①テストからの到達を可能にする最小の DI・`export`(例:
  `egressGuard.ts` の probe 注入、`previewHost.ts` の `bundleSafeToInline` export)、②型で到達不能が
  確定している防御分岐の除去(例: `nunjucksRender.ts` の `e instanceof Error` 三項)。挙動を変える
  変更・「テストのためだけの分岐」は入れない。変更したファイルは既存テストを全部通す。
- **テストは「迂回入力が拒否される / 失敗が握り潰されない」形で書く**(既存テストの流儀)。分岐を
  踏むだけの無意味な assert(`expect(true)`)は書かない。各 `it` は挙動を 1 つ主張する。
- **命名と置き場**: server は `editor/server/test/<対象>.test.ts`、web の jsdom 依存(`window` /
  `localStorage` / `DOMParser` / `mount`)は `editor/web/test/<対象>.dom.test.ts`(project `web-dom`)、
  純粋関数は `editor/web/test/<対象>.test.ts`(project `web-node`)、pie-chart は
  `pie-chart/test/<対象>.test.ts`。既存テストファイルがある対象は**そのファイルへ追記**する(新規
  ファイルを増やすのは対象に既存テストが無いときだけ)。
- **server テストは `config` を import する前に env を一時ディレクトリへ向ける**(`DATA_ROOT` /
  `TEMPLATES_DIR` / `CSS_DIR` / `DRAFTS_DIR` / `PENDING_DIR` / `SYNC_DIR` / `LOG_DIR` /
  `AUDIT_DB=false`)。`config` は必ず dynamic import(`await import('../src/config.js')`)。履歴
  JSONL は `config.logging.dir` 配下(`<LOG_DIR>/history/*.jsonl`)なので `LOG_DIR` を逸らさないと
  作業ツリーに `editor/logs/history/` が生える。
- **web-dom で `fetch` を差し替えるときは `vi.stubGlobal('fetch', …)` + `afterEach(vi.unstubAllGlobals)`**
  (`restHttp.dom.test.ts` と同じ)。`apiFetch` は `window.location.origin` を使う(jsdom では
  `http://localhost:3000`)。
- **コメント規約**(`docs/コメント規約.md`)に従う: ファイル冒頭の装飾ボックス、「なぜ」を書く、経緯
  (日付・所見番号・過去事実)は書かない。テストのコメントも同じ。
- **コミット前に `pnpm exec biome check --write editor/<変更ファイル>` を先行実行**(lint-staged の
  ステージ入れ替わり事故の回避)。コミットメッセージは日本語、末尾に
  `Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF`。
- **タスク単位の合否は「対象ファイルを include に絞った perFile 計測」で判定する**(下の「計測の
  手順」)。全体の `pnpm run test:coverage` は Task 9 でだけ回す(約 2.5 分)。

## 計測の手順(全タスク共通)

対象ファイルだけを include にして、そのファイルに関係するテストだけを走らせる。CLI の
`--coverage.include` は設定の include を**置き換える**ので、出力の表と `ERROR: Coverage for …`
行がそのまま合否になる(全部の指標が 85% 以上なら ERROR 行が出ない)。

```bash
# 例: web-dom の 1 ファイル
pnpm exec vitest run --project web-dom --coverage \
  --coverage.include='editor/web/src/api/rest/http.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/web/test/restHttp.dom.test.ts editor/web/test/restRepos.dom.test.ts
# 例: server の 1 ファイル(include は複数指定できる)
pnpm exec vitest run --project server --coverage \
  --coverage.include='editor/server/src/routes/templates.routes.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/server/test/templates.routes.test.ts
```

`--coverage.reporter=text` の表の右端「Uncovered Line #s」が残った行。分岐だけが未到達の行は表に
出ないので、`--coverage.reporter=json` で `coverage/coverage-final.json` を出し、`b`(分岐の命中配列)
を見る。project 名は `shared` / `server` / `web-dom` / `web-node` / `pie-chart`。

## 計測結果(2026-09-07、`routes/*.ts` と `api/rest/*.ts`・`repositories.ts` を include に足して再計測)

いずれかの指標が 85% 未満のファイルは 52。設計書 8 章の一覧(9-06、38 ファイル)から計画 B1 で
解消した分を除き、`routes/*.ts`(10)と `api/rest/*.ts` + `repositories.ts`(9)を加えた数。
下の各タスクに「未到達の行 / 分岐」を書いてあるが、これは**その時点の計測**で、実装の途中で
ずれたら計測をやり直して現物を信じること。

| 領域 | ファイル(指標: 現在値) |
|---|---|
| web api/rest(Task 1) | `authRepo` `historyRepo` `noteRepo` `partRepo` `reviewRepo` `templateRepo` `userRepo`(fn 0% / st ≈10%)、`http`(br 64%)、`repositories`(fn 25%) |
| server routes(Task 2・3) | `templates`(st 75 / br 50)、`parts`(st 76 / br 33)、`users`(st 56 / fn 60)、`vivliostyle`(st 75 / br 73 / fn 83)、`history`(st 79 / br 50 / fn 75)、`notes`(st 81 / fn 83)、`reviews`(br 50)、`generate`(br 75) |
| server files / git / generate(Task 4) | `atomic`(br 75 / fn 67)、`draftFiles`(st 79 / fn 64)、`historyFiles`(fn 83)、`syncFiles`(br 50)、`pyTemplate`(br 75)、`gitRepo`(br 84) |
| server vivliostyle / security(Task 5) | `projectConfig`(st 76 / br 69)、`previewHost`(br 61)、`inlineDocScripts`(br 79)、`buildWorkerPool`(br 79)、`egressGuard`(br 75)、`templateScripts`(br 84) |
| web api/local + lib(Task 6) | `local/historyRepo`(br 80)、`local/partRepo`(br 77)、`local/reviewRepo`(br 68)、`local/templateRepo`(br 80)、`local/userRepo`(br 83)、`format`(fn 75 / br 67)、`nunjucksRender`(br 75)、`fillJinja`(br 83)、`useCascadingSelect`(br 79)、`editorSession`(br 78)、`geom`(br 84)、`partKey`(br 83) |
| web features / services(Task 7) | `templateEditorService`(fn 75)、`useAutosave`(br 84)、`mergePdfService`(fn 80)、`PreviewPanel.vue`(br 75)、`templatePreviewService`(fn 80)、`changedSummary`(fn 42 / br 60)、`partNames`(fn 75)、`reviewDiffService`(br 75)、`templateCreationService`(fn 67)、`previewSelfContain`(br 71) |
| pie-chart(Task 8) | `seaRuntime`(st 75 / br 74) |

---

### Task 1: web `api/rest/*` 8 ファイルと `repositories.ts` の直接テスト

**Files:**
- Create: `editor/web/test/restRepos.dom.test.ts`
- Modify: `editor/web/test/restHttp.dom.test.ts`(`apiFetch` の残り分岐を追記)
- Create: `editor/web/test/repositories.dom.test.ts`
- Test target: `editor/web/src/api/rest/{authRepo,historyRepo,noteRepo,partRepo,reviewRepo,templateRepo,userRepo,http}.ts`、`editor/web/src/api/repositories.ts`

**Interfaces:**
- Consumes: `apiFetch(path, { method?, query?, body? })` / `apiUrl(path)`(`rest/http.ts`)、
  `apiPaths` / `buildPath`(`@editor/shared`)、`setUnauthorizedHandler` / `armUnauthorizedNotice`
  (`@/lib/sessionExpiry`)、`REPOS_KEY` / `restRepositories` / `localRepositories` / `useAuthRepo` 他
  6 つ(`@/api/repositories`)。
- Produces: なし(テストのみ)。Task 9 が include に `editor/web/src/api/rest/*.ts` と
  `editor/web/src/api/repositories.ts` を足す。

- [ ] **Step 1: `fetch` 記録スタブを持つ `restRepos.dom.test.ts` を書く(失敗する状態)**

各 rest リポジトリのメソッドについて「叩く URL(`/api` 前置・`:param` の `encodeURIComponent`・
空/undefined のクエリは付けない)」「メソッド」「JSON ボディ」「`Result` への写像」を主張する。
`fetch` は呼び出しを記録して `200 {}`(または指定の応答)を返す。

```ts
// =============================================================================
// restRepos.dom.test.ts — rest リポジトリ 7 種が契約どおりの HTTP 要求を組み立てること
// =============================================================================
// rest 実装は `apiFetch` への薄い委譲なので、壊れ方は「パスのパラメータ名違い」「メソッド違い」
// 「ボディの形違い」の 3 つに集約される。ここでは `fetch` を記録スタブに差し替え、要求の
// 3 要素と `Result` 化(throw → err)を主張する。サーバ側の挙動は server の inject テストが持つ。
import { isErr, isOk } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restAuthRepo } from '@/api/rest/authRepo';
import { restHistoryRepo } from '@/api/rest/historyRepo';
import { restNoteRepo } from '@/api/rest/noteRepo';
import { restPartRepo } from '@/api/rest/partRepo';
import { restReviewRepo } from '@/api/rest/reviewRepo';
import { restTemplateRepo } from '@/api/rest/templateRepo';
import { restUserRepo } from '@/api/rest/userRepo';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  contentType: string | undefined;
}

/** 直近の要求を記録し、`response` を返す `fetch` スタブを立てる。 */
function stubFetch(response: () => Response = () => json({})): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: url.replace('http://localhost:3000', ''),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        contentType: headers['Content-Type'],
      });
      return response();
    }),
  );
  return calls;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('restAuthRepo', () => {
  it('login は POST /api/auth/login に資格情報をそのまま送る', async () => {
    const calls = stubFetch(() => json({ user: { username: 'u' } }));
    const r = await restAuthRepo.login({ username: 'u', password: 'p' });
    expect(calls[0]).toMatchObject({
      url: '/api/auth/login',
      method: 'POST',
      body: { username: 'u', password: 'p' },
      contentType: 'application/json',
    });
    expect(isOk(r) && r.value.user.username).toBe('u');
  });
  it('logout は POST(ボディ無し = Content-Type も付けない)、me は GET、initPassword は POST', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    expect(isOk(await restAuthRepo.logout())).toBe(true);
    expect(calls[0]).toMatchObject({ url: '/api/auth/logout', method: 'POST', body: undefined });
    expect(calls[0].contentType).toBeUndefined();
    await restAuthRepo.me();
    expect(calls[1]).toMatchObject({ url: '/api/auth/me', method: 'GET' });
    await restAuthRepo.initPassword({ username: 'u', currentPassword: 'a', newPassword: 'b' });
    expect(calls[2]).toMatchObject({ url: '/api/auth/init-password', method: 'POST' });
  });
});

describe('restTemplateRepo', () => {
  it('一覧・候補は未指定のクエリを付けず、指定分だけを query string にする', async () => {
    const calls = stubFetch(() => json([]));
    await restTemplateRepo.listTemplates({ companyCode: 'AM01', fundCode: undefined, baseDate: '' });
    expect(calls[0].url).toBe('/api/templates?companyCode=AM01');
    await restTemplateRepo.getDropdownOptions({});
    expect(calls[1].url).toBe('/api/templates/options');
  });
  it(':id は encodeURIComponent される(日本語 id)', async () => {
    const calls = stubFetch(() => json({ meta: {}, html: '', css: '', filled: '' }));
    await restTemplateRepo.getTemplate('AM01_510037_20240710_交付版');
    expect(calls[0].url).toBe(`/api/templates/${encodeURIComponent('AM01_510037_20240710_交付版')}`);
  });
  it('resolveFund は series 応答に自分以外のファンドがあるときだけ isSeriesFund=true', async () => {
    stubFetch(() => json([{ attributes: { fundCode: '510037' } }, { attributes: { fundCode: '510038' } }]));
    const r = await restTemplateRepo.resolveFund('AM01', '510037', '交付版');
    expect(isOk(r) && r.value.isSeriesFund).toBe(true);
    stubFetch(() => json([{ attributes: { fundCode: '510037' } }]));
    const only = await restTemplateRepo.resolveFund('AM01', '510037', '交付版');
    expect(isOk(only) && only.value.isSeriesFund).toBe(false);
  });
  it('listSeriesFunds は 3 引数をクエリに載せる', async () => {
    const calls = stubFetch(() => json([]));
    await restTemplateRepo.listSeriesFunds('AM01', '510037', '交付版');
    expect(calls[0].url).toBe(
      `/api/templates/series?companyCode=AM01&fundCode=510037&editionType=${encodeURIComponent('交付版')}`,
    );
  });
  it('saveDraft は PUT /templates/:id/draft にボディごと送り、204 を ok(undefined) に写す', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const req = { templateId: 'AM01_510037_20240710_交付版', html: '<p>x</p>', css: '.a{}' };
    const r = await restTemplateRepo.saveDraft(req);
    expect(isOk(r) && r.value).toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: `/api/templates/${encodeURIComponent(req.templateId)}/draft`,
      method: 'PUT',
      body: req,
    });
  });
  it('getDraft は GET、discardDraft は DELETE、getSampleData / getSyncStatus / generate はそれぞれの経路', async () => {
    const calls = stubFetch(() => json(null));
    await restTemplateRepo.getDraft('t1');
    await restTemplateRepo.discardDraft('t1');
    await restTemplateRepo.getSampleData('510037');
    await restTemplateRepo.getSyncStatus('t1');
    await restTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/templates/t1/draft',
      'DELETE /api/templates/t1/draft',
      'GET /api/funds/510037/sample-data',
      'GET /api/templates/t1/sync-status',
      'POST /api/generate',
    ]);
  });
});

describe('restPartRepo / restHistoryRepo / restNoteRepo / restReviewRepo / restUserRepo', () => {
  it('parts: 分類候補と一覧はクエリ、履歴は GET/POST', async () => {
    const calls = stubFetch(() => json([]));
    await restPartRepo.getPartClassificationOptions({ category: '表紙' });
    await restPartRepo.listParts({});
    await restPartRepo.listPartHistory('t1');
    await restPartRepo.recordPartChange('t1', 'note-a#1', '文言修正');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/parts/classification-options?category=${encodeURIComponent('表紙')}`,
      'GET /api/parts',
      'GET /api/templates/t1/part-history',
      'POST /api/templates/t1/part-history',
    ]);
    expect(calls[3].body).toEqual({ partKey: 'note-a#1', change: '文言修正' });
  });
  it('history: 3 フィード GET、PDF 記録 POST、版一覧、スナップショット(templateId は省略可)', async () => {
    const calls = stubFetch(() => json([]));
    await restHistoryRepo.getEditHistory();
    await restHistoryRepo.getPdfHistory();
    await restHistoryRepo.getCreateHistory();
    await restHistoryRepo.recordPdfExport('t1');
    await restHistoryRepo.listVersions('t1');
    await restHistoryRepo.getSnapshot('h1');
    await restHistoryRepo.getSnapshot('h1', 't1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/history/edit',
      'GET /api/history/pdf',
      'GET /api/history/create',
      'POST /api/history/pdf',
      'GET /api/templates/t1/versions',
      'GET /api/snapshots/h1',
      'GET /api/snapshots/h1?templateId=t1',
    ]);
    expect(calls[3].body).toEqual({ templateId: 't1' });
  });
  it('notes: 追加は replyTo/kind の既定(null / note)を補い、編集は PATCH、削除は DELETE', async () => {
    const calls = stubFetch(() => json({}));
    await restNoteRepo.listNotes('t1');
    await restNoteRepo.addNote('t1', 'p#1', '本文');
    await restNoteRepo.addNote('t1', 'p#1', '返信', { replyTo: 'n1', kind: 'question' });
    await restNoteRepo.updateNote('t1', 'n1', { status: 'resolved' });
    await restNoteRepo.deleteNote('t1', 'n1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/templates/t1/notes',
      'POST /api/templates/t1/notes',
      'POST /api/templates/t1/notes',
      'PATCH /api/templates/t1/notes/n1',
      'DELETE /api/templates/t1/notes/n1',
    ]);
    expect(calls[1].body).toEqual({ pathKey: 'p#1', content: '本文', replyTo: null, kind: 'note' });
    expect(calls[2].body).toEqual({ pathKey: 'p#1', content: '返信', replyTo: 'n1', kind: 'question' });
  });
  it('reviews: 申請 POST、一覧は status フィルタのみクエリ、取得 GET、承認/却下 POST', async () => {
    const calls = stubFetch(() => json({}));
    await restReviewRepo.submitReview({ templateId: 't1', html: '', css: '', fundCode: 'f', origin: 'edit' });
    await restReviewRepo.listReviews();
    await restReviewRepo.listReviews({ status: 'pending' });
    await restReviewRepo.getReview('r1');
    await restReviewRepo.approveReview('r1', { comment: 'ok' });
    await restReviewRepo.rejectReview('r1', { comment: 'ng' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/review-requests',
      'GET /api/review-requests',
      'GET /api/review-requests?status=pending',
      'GET /api/review-requests/r1',
      'POST /api/review-requests/r1/approve',
      'POST /api/review-requests/r1/reject',
    ]);
  });
  it('users: 一覧 GET、作成 POST(201 ボディをそのまま返す)、更新 PATCH、リセット POST', async () => {
    const calls = stubFetch(() => json({ user: { id: 'u1' }, temporaryPassword: 'x' }, 201));
    const created = await restUserRepo.createUser({
      username: 'u', displayName: 'U', role: 'editor', disabled: false, mustChangePassword: true,
    });
    expect(isOk(created) && created.value.temporaryPassword).toBe('x');
    await restUserRepo.listUsers();
    await restUserRepo.updateUser('u1', { displayName: 'V' });
    await restUserRepo.resetUserPassword('u1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/users',
      'GET /api/users',
      'PATCH /api/users/u1',
      'POST /api/users/u1/reset-password',
    ]);
    expect(calls[2].body).toEqual({ displayName: 'V' });
  });
  it('HTTP 失敗は throw せず err(AppError) に写る(呼び出し側は Result だけを見る)', async () => {
    stubFetch(() => json({ kind: 'not_found', message: '無い' }, 404));
    const r = await restReviewRepo.getReview('nope');
    expect(isErr(r) && r.error.kind).toBe('not_found');
    expect(isErr(r) && r.error.message).toBe('無い');
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/restRepos.dom.test.ts`
Expected: 型は通り、`stubFetch` の URL 期待値のうち少なくとも「クエリの順序」「日本語の encode」で
赤くなるものが出る(出なければ全部緑でよい — このテストは実装を変えないので、緑ならそのまま
Step 3 へ進む。実装が期待と違って赤くなった場合は**テスト側を実装に合わせる**。実装のバグと判断
したときだけ実装を直し、その旨をレポートに書く)。

- [ ] **Step 3: `restHttp.dom.test.ts` へ `apiFetch` の残り分岐を追記する**

未到達: 62(`code` が文字列でない)、65(`STATUS_KIND` に無いステータス → `unexpected`)、77 / 79
(`query` 無し・空値スキップ)、88 / 89(ボディ無し = ヘッダ無し)、92(`fetch` の reject →
`network`)、95(401 → `notifyUnauthorized`)、97(204)。

```ts
import { armUnauthorizedNotice, setUnauthorizedHandler } from '@/lib/sessionExpiry';
import { apiFetch, apiUrl } from '@/api/rest/http';

describe('apiFetch の要求組み立てと網羅', () => {
  it('apiUrl は /api を前置する', () => {
    expect(apiUrl('/build')).toBe('/api/build');
  });
  it('query の undefined と空文字は付けず、ボディ無しなら Content-Type も付けない', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/x', { query: { a: '1', b: undefined, c: '' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/x?a=1');
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
  });
  it('fetch 自体の失敗(接続不可)は network に写り、cause を保つ', async () => {
    const boom = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw boom; }));
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'network', cause: boom });
  });
  it('401 は 1 回だけセッション切れを通知し、unauthorized で reject する', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(handler).toHaveBeenCalledTimes(1);
    armUnauthorizedNotice();
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(handler).toHaveBeenCalledTimes(2);
    setUnauthorizedHandler(null);
  });
  it('写像表に無いステータス(500)は unexpected、code が文字列でなければ落とす', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'unexpected' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ kind: 'validation', message: 'm', code: 7 }), { status: 400 })),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'validation', message: 'm', code: undefined });
  });
});
```

- [ ] **Step 4: `repositories.dom.test.ts` を書く(`use*Repo` 6 本と未 provide の例外)**

```ts
// =============================================================================
// repositories.dom.test.ts — DI 合成ルートの inject と rest 配線の差し替え可能性
// =============================================================================
import { createApp, defineComponent, h } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  localRepositories, REPOS_KEY, restRepositories, useAuthRepo, useHistoryRepo, useNoteRepo,
  usePartRepo, useReviewRepo, useTemplateRepo, useUserRepo,
} from '@/api/repositories';

/** setup の中で `fn` を呼び、戻り値を取り出す(provide の有無を切り替えられる)。 */
function inSetup<T>(fn: () => T, provide: boolean): T {
  let out!: T;
  let caught: unknown;
  const Comp = defineComponent({
    setup() {
      try { out = fn(); } catch (e) { caught = e; }
      return () => h('div');
    },
  });
  const app = createApp(Comp);
  if (provide) app.provide(REPOS_KEY, restRepositories);
  app.config.errorHandler = () => {};
  app.mount(document.createElement('div'));
  if (caught) throw caught;
  return out;
}

describe('use*Repo', () => {
  it('provide 済みなら合成ルートの対応する面を返す(rest 配線も同じ形で差し替わる)', () => {
    expect(inSetup(useAuthRepo, true)).toBe(restRepositories.auth);
    expect(inSetup(useTemplateRepo, true)).toBe(restRepositories.templates);
    expect(inSetup(usePartRepo, true)).toBe(restRepositories.parts);
    expect(inSetup(useHistoryRepo, true)).toBe(restRepositories.history);
    expect(inSetup(useNoteRepo, true)).toBe(restRepositories.notes);
    expect(inSetup(useReviewRepo, true)).toBe(restRepositories.reviews);
    expect(inSetup(useUserRepo, true)).toBe(restRepositories.users);
  });
  it('local と rest は同じキー集合を持つ(差し替えで画面側が無改修で済む前提)', () => {
    expect(Object.keys(restRepositories).sort()).toEqual(Object.keys(localRepositories).sort());
  });
  it('provide されていなければ main.ts を指す例外で落ちる(黙って undefined を返さない)', () => {
    expect(() => inSetup(useAuthRepo, false)).toThrow(/provide/);
  });
});
```

- [ ] **Step 5: 3 ファイルを緑にし、perFile 計測で 9 ファイル全部が 85% 以上であることを確認する**

Run:
```bash
pnpm exec vitest run --project web-dom --coverage \
  --coverage.include='editor/web/src/api/rest/*.ts' --coverage.include='editor/web/src/api/repositories.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/web/test/restRepos.dom.test.ts editor/web/test/restHttp.dom.test.ts editor/web/test/repositories.dom.test.ts
```
Expected: `ERROR: Coverage …` 行が 0。`http.ts` の branches ≥ 85。

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write editor/web/test/restRepos.dom.test.ts editor/web/test/restHttp.dom.test.ts editor/web/test/repositories.dom.test.ts
git add editor/web/test/restRepos.dom.test.ts editor/web/test/restHttp.dom.test.ts editor/web/test/repositories.dom.test.ts
git commit -m "test(editor): rest リポジトリ 7 種と apiFetch の要求組み立てを fetch スタブで直接検証する"
```

---

### Task 2: `templates` / `parts` / `users` ルートのハンドラを通す inject テスト

**Files:**
- Create: `editor/server/test/templates.routes.test.ts`
- Create: `editor/server/test/parts.routes.test.ts`
- Create: `editor/server/test/users.routes.test.ts`
- Test target: `editor/server/src/routes/{templates,parts,users}.routes.ts`

**Interfaces:**
- Consumes: `createFakeSproc(seed)` / `DEFAULT_USERS` / `DEFAULT_FUNDS` / `DEFAULT_TEMPLATE_IDS`
  (`test/fakes/sprocFake.ts`。テンプレ台帳 sproc は `候補` / `系列` / `生成登録`、パーツは
  `分類候補` / `一覧`、サンプルデータは `取得`、ユーザーは `一覧` / `作成` / `更新` / `PWリセット`
  を写す)、`createSessionStub` / `decorateSessionStore`(`test/helpers/sessionStub.ts`)、
  `createDeps(sproc, sessionStore)`(`src/deps.ts`)、`errorHandler`(`src/middleware/errorHandler.js`)。
- Produces: なし。Task 9 が include に `editor/server/src/routes/*.ts` を足す。

**共通のハーネス**(3 ファイルとも同じ形。`generate.routes.test.ts` と同じく `AUTH_REQUIRED=true` で
実ガードを通し、セッション解決だけを差し替える):

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSproc, DEFAULT_USERS } from './fakes/sprocFake.js';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  // cookie の代わりにヘッダ x-test-user をセッション id として読む(ロール切替をヘッダで行う)。
  sessionIdFrom: (req: { headers: Record<string, unknown> }) =>
    typeof req.headers['x-test-user'] === 'string' ? req.headers['x-test-user'] : null,
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-<対象>-routes-'));
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.DRAFTS_DIR = path.join(root, 'data', 'drafts');
process.env.PENDING_DIR = path.join(root, 'data', 'pending');
process.env.SYNC_DIR = path.join(root, 'data', 'sync');
process.env.LOG_DIR = path.join(root, 'logs');

/** seed ユーザー名 → `User`(セッション id = ユーザー名として解決する)。 */
function userOf(username: string) {
  const u = DEFAULT_USERS.find((x) => x.username === username);
  if (!u) return null;
  return { id: `id-${u.username}`, username: u.username, displayName: u.displayName, role: u.role, disabled: false, mustChangePassword: false };
}
const as = (username: string) => ({ 'x-test-user': username });

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { createDeps } = await import('../src/deps.js');
  const { <対象>Routes } = await import('../src/routes/<対象>.routes.js');
  const store = createSessionStub({ getSessionUser: (sid) => userOf(sid) });
  const deps = createDeps(await createFakeSproc(), store);
  const app = Fastify();
  decorateSessionStore(app, store);
  app.setErrorHandler(errorHandler);
  await app.register(<対象>Routes, { deps });
  await app.ready();
  return app;
}
```

- [ ] **Step 1: `templates.routes.test.ts` を書く**

`beforeAll` で確定テンプレ 1 件と CSS を置く(`TEMPLATES_DIR/AM01_510037_20240710_交付版.html`、
`CSS_DIR/510037.css`)。主張:

```ts
const ID = 'AM01_510037_20240710_交付版';
beforeAll(async () => {
  fs.mkdirSync(path.join(root, 'data', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'templates', `${ID}.html`), '<html><body><p>{{ fund.name }}</p></body></html>', 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'css', '510037.css'), 'body{}', 'utf8');
  app = await buildApp();
});
afterAll(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('GET /templates/options: 台帳 sproc の候補を 4 配列へ束ねる(未ログインは 401)', async () => {
  expect((await app.inject({ method: 'GET', url: '/templates/options' })).statusCode).toBe(401);
  const res = await app.inject({ method: 'GET', url: '/templates/options?companyCode=AM01', headers: as('editor') });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.companyCodes).toEqual(['AM01']);
  expect(body.fundCodes).toContain('510037');
  expect(body.editionTypes).toEqual(expect.arrayContaining(['交付版', '全体版']));
});
it('GET /templates/series: companyCode と editionType が無ければ 400、あれば版種で絞った台帳行', async () => {
  expect((await app.inject({ method: 'GET', url: '/templates/series?companyCode=AM01', headers: as('editor') })).statusCode).toBe(400);
  const res = await app.inject({ method: 'GET', url: `/templates/series?companyCode=AM01&editionType=${encodeURIComponent('交付版')}`, headers: as('editor') });
  expect(res.statusCode).toBe(200);
  expect((res.json() as Array<{ attributes: { editionType: string } }>).every((m) => m.attributes.editionType === '交付版')).toBe(true);
});
it('GET /templates: ファイル走査由来の一覧を属性クエリで絞る(空文字のクエリは無視)', async () => {
  const all = await app.inject({ method: 'GET', url: '/templates?fundCode=', headers: as('editor') });
  expect(all.json()).toHaveLength(1);
  const none = await app.inject({ method: 'GET', url: '/templates?fundCode=999999', headers: as('editor') });
  expect(none.json()).toEqual([]);
});
it('GET /templates/:id と /funds/:fundCode/sample-data', async () => {
  const t = await app.inject({ method: 'GET', url: `/templates/${encodeURIComponent(ID)}`, headers: as('editor') });
  expect(t.statusCode).toBe(200);
  expect(t.json().meta.status).toBe('published');
  expect(t.json().css).toBe('body{}');
  expect((await app.inject({ method: 'GET', url: '/templates/AM01_999999_20240710_交付版', headers: as('editor') })).statusCode).toBe(404);
  const s = await app.inject({ method: 'GET', url: '/funds/110024/sample-data', headers: as('editor') });
  expect(s.statusCode).toBe(200);
  expect(s.json().fund.name).toBe('高金利ソブリンオープン');
});
it('PUT /templates/:id/draft: body の templateId が URL と違えば 400、一致すれば 204 で drafts に書く。GET は保存内容、DELETE は 204 で消す', async () => {
  const url = `/templates/${encodeURIComponent(ID)}/draft`;
  expect((await app.inject({ method: 'PUT', url, headers: as('editor'), payload: { templateId: 'AM01_510037_20240710_全体版', html: '<p>x</p>', css: '' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url, headers: as('editor'), payload: { templateId: ID, html: '<p>draft</p>', css: '.d{}' } })).statusCode).toBe(204);
  expect(fs.existsSync(path.join(root, 'data', 'drafts', `${ID}.html`))).toBe(true);
  const got = await app.inject({ method: 'GET', url, headers: as('editor') });
  expect(got.json()).toMatchObject({ templateId: ID, html: '<p>draft</p>', css: '.d{}' });
  expect((await app.inject({ method: 'DELETE', url, headers: as('editor') })).statusCode).toBe(204);
  expect((await app.inject({ method: 'GET', url, headers: as('editor') })).body).toBe('null');
});
it('GET /templates/:id/sync-status: 同期状態ファイルが無くても 200 で状態を返す', async () => {
  const res = await app.inject({ method: 'GET', url: `/templates/${encodeURIComponent(ID)}/sync-status`, headers: as('editor') });
  expect(res.statusCode).toBe(200);
});
```

`GET /templates/:id/draft` が無いときの応答は `null` を JSON 直列化した `'null'`(本文が `null` でも
200)。`sync-status` の応答の形は `pairSyncService.getPairSyncStatus` の戻り(実装を読んで 1 つ
フィールドを主張する。無理に形を決め打ちしない)。

- [ ] **Step 2: `parts.routes.test.ts` を書く**

```ts
it('GET /parts/classification-options と GET /parts はカタログ sproc の結果(空クエリは全件)', async () => {
  const opts = await app.inject({ method: 'GET', url: '/parts/classification-options', headers: as('editor') });
  expect(opts.statusCode).toBe(200);
  const list = await app.inject({ method: 'GET', url: `/parts?category=${encodeURIComponent('表紙')}`, headers: as('editor') });
  expect(list.statusCode).toBe(200);
  expect((list.json() as Array<{ id: string }>).some((p) => p.id === 'p-cover-title')).toBe(true);
});
it('POST /templates/:templateId/part-history は 204 で追記し、GET に user 付きで現れる', async () => {
  const url = `/templates/${encodeURIComponent(ID)}/part-history`;
  expect((await app.inject({ method: 'POST', url, headers: as('editor'), payload: { partKey: 'note-a#1', change: '文言修正' } })).statusCode).toBe(204);
  expect((await app.inject({ method: 'POST', url, headers: as('editor'), payload: { change: 'x' } })).statusCode).toBe(400);
  const got = await app.inject({ method: 'GET', url, headers: as('editor') });
  expect(got.json()).toEqual([expect.objectContaining({ templateId: ID, partKey: 'note-a#1', change: '文言修正', user: 'editor' })]);
});
it('viewer は POST できない(403)、未ログインは 401', async () => {
  // seed に viewer は居ない: `userOf` を viewer で答えるセッション id を 1 つ足す(下の userOf 拡張)。
});
```

`userOf` に `viewer` を足す: `if (username === 'viewer') return { id: 'id-viewer', username: 'viewer', displayName: '閲覧', role: 'viewer', disabled: false, mustChangePassword: false };`。

- [ ] **Step 3: `users.routes.test.ts` を書く**

```ts
it('GET /users: admin は 3 人の seed を見る。editor は 403、未ログインは 401', async () => {
  expect((await app.inject({ method: 'GET', url: '/users' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/users', headers: as('editor') })).statusCode).toBe(403);
  const res = await app.inject({ method: 'GET', url: '/users', headers: as('admin') });
  expect(res.statusCode).toBe(200);
  expect((res.json() as Array<{ username: string }>).map((u) => u.username).sort()).toEqual(['admin', 'approver', 'editor']);
  // ハッシュ列は 1 つも出ない。
  expect(JSON.stringify(res.json())).not.toMatch(/hash|salt|PW/i);
});
it('POST /users: 201 で一時パスワードを 1 回だけ返し、重複ログインIDは 409', async () => {
  const body = { username: 'newbie', displayName: '新人', role: 'editor', disabled: false, mustChangePassword: true };
  const res = await app.inject({ method: 'POST', url: '/users', headers: as('admin'), payload: body });
  expect(res.statusCode).toBe(201);
  expect(res.json().user).toMatchObject({ username: 'newbie', role: 'editor' });
  expect(res.json().temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);
  expect((await app.inject({ method: 'POST', url: '/users', headers: as('admin'), payload: body })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: '/users', headers: as('admin'), payload: { ...body, username: 'bad name' } })).statusCode).toBe(400);
});
it('PATCH /users/:id: 部分更新は未指定を据え置き、未知 id は 404', async () => {
  const list = (await app.inject({ method: 'GET', url: '/users', headers: as('admin') })).json() as Array<{ id: string; username: string; displayName: string }>;
  const editor = list.find((u) => u.username === 'editor')!;
  const res = await app.inject({ method: 'PATCH', url: `/users/${editor.id}`, headers: as('admin'), payload: { displayName: '改名' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ username: 'editor', displayName: '改名', role: 'editor' });
  expect((await app.inject({ method: 'PATCH', url: '/users/no-such-id', headers: as('admin'), payload: { displayName: 'x' } })).statusCode).toBe(404);
});
it('POST /users/:id/reset-password: 200 で新しい一時パスワード、未知 id は 404、editor は 403', async () => {
  const list = (await app.inject({ method: 'GET', url: '/users', headers: as('admin') })).json() as Array<{ id: string; username: string }>;
  const target = list.find((u) => u.username === 'approver')!;
  const res = await app.inject({ method: 'POST', url: `/users/${target.id}/reset-password`, headers: as('admin') });
  expect(res.statusCode).toBe(200);
  expect(res.json().temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);
  expect((await app.inject({ method: 'POST', url: '/users/no-such-id/reset-password', headers: as('admin') })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: `/users/${target.id}/reset-password`, headers: as('editor') })).statusCode).toBe(403);
});
```

一時パスワードの文字集合・桁数は `auth/password.ts` の `generateTemporaryPassword` を読んで正規表現を
合わせる(12 桁・誤読回避の 32 文字集合。上の `[A-Za-z0-9]{12}` は仮で、実装の集合に置き換える)。

- [ ] **Step 4: 3 ファイルを緑にし、perFile 計測で 3 ルートが 85% 以上であることを確認する**

Run:
```bash
pnpm exec vitest run --project server --coverage \
  --coverage.include='editor/server/src/routes/templates.routes.ts' \
  --coverage.include='editor/server/src/routes/parts.routes.ts' \
  --coverage.include='editor/server/src/routes/users.routes.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/server/test/templates.routes.test.ts editor/server/test/parts.routes.test.ts editor/server/test/users.routes.test.ts
```
Expected: ERROR 行 0。`templates.routes.ts` の branches(`toQuery` の 4 分岐、`series` の 3 分岐、
`actor` の `?? 'system'`)が 85% 以上。`actor` の `?? 'system'` 側は認証オンでは到達しないので、
未到達で 85% を割るなら `toQuery` の各キーを「文字列でない値(`?companyCode[]=x` の配列)」で
1 件ずつ踏む。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write editor/server/test/templates.routes.test.ts editor/server/test/parts.routes.test.ts editor/server/test/users.routes.test.ts
git add editor/server/test/templates.routes.test.ts editor/server/test/parts.routes.test.ts editor/server/test/users.routes.test.ts
git commit -m "test(editor): templates / parts / users ルートのハンドラを sproc フェイクの inject テストで通す"
```

---

### Task 3: 残りのルート(generate / history / notes / reviews / vivliostyle)の未到達経路

**Files:**
- Create: `editor/server/test/generate.routes.local.test.ts`
- Modify: `editor/server/test/history.routes.test.ts`
- Modify: `editor/server/test/notes.routes.test.ts`
- Modify: `editor/server/test/reviews.routes.test.ts`
- Create: `editor/server/test/vivliostyle.routes.preview.test.ts`
- Test target: `editor/server/src/routes/{generate,history,notes,reviews,vivliostyle}.routes.ts`

**Interfaces:**
- Consumes: Task 2 と同じハーネス。`vivliostyle.routes.ts` は `previewManager`(`src/vivliostyle/
  previewManager.js`: `start` / `get` / `stop` / `resolveFor`)と `build.js`(`buildInlinePdf` /
  `buildMergedPdf` / `buildProjectInSlot` / `withBuildSlot` / `prepareInlineDoc`)を `vi.mock` する。
- Produces: なし。

- [ ] **Step 1: `generate.routes.local.test.ts`(local モード = `AUTH_REQUIRED` 未設定)**

未到達: `generate.routes.ts:49`(`request.user` 無し → `'system'`)と `:99` の else 側(local では
台帳登録も pending 書込もしない)。`generate.routes.test.ts` を複製して env から `AUTH_REQUIRED` を
外し、`onRequest` の user 注入も外す。主張は 1 つ:

```ts
it('local モードでは生成物を返すだけで、台帳(sproc)も pending も触らない', async () => {
  const res = await generate(validBody);
  expect(res.statusCode).toBe(200);
  expect(res.json().html).toContain('生成物');
  expect(sprocCalls).toBe(0);                 // createSprocClient に渡した query の呼び出し回数
  expect(fs.readdirSync(pendingDir)).toEqual([]);
  expect(fs.readdirSync(templatesDir)).toEqual([]);
});
```

`sprocCalls` は `createSprocClient(async () => { sprocCalls += 1; return []; })` で数える。

- [ ] **Step 2: `history.routes.test.ts` へ `POST /history/pdf` を追記**

未到達: `:12`(`actor`)、`:26-29`(PDF 記録ハンドラ)。既存の `buildApp` は user を注入しないので、
`app.addHook('onRequest', …)` で `x-test-user` ヘッダから `req.user` を入れる形に `buildApp` を広げる
(ヘッダが無ければ入れない = 既存テストは不変)。`LOG_DIR` を tmp へ向けるのを忘れない。

```ts
it('POST /history/pdf は 204 で記録し、GET /history/pdf に user 付きで現れる。templateId 欠落は 400', async () => {
  expect((await app.inject({ method: 'POST', url: '/history/pdf', payload: {} })).statusCode).toBe(400);
  const ok = await app.inject({ method: 'POST', url: '/history/pdf', headers: { 'x-test-user': 'editor1' }, payload: { templateId: 'AM01_510037_20240710_交付版' } });
  expect(ok.statusCode).toBe(204);
  const list = await app.inject({ method: 'GET', url: '/history/pdf' });
  expect(list.json()).toEqual([expect.objectContaining({ templateId: 'AM01_510037_20240710_交付版', user: 'editor1' })]);
});
```

- [ ] **Step 3: `notes.routes.test.ts` へ `POST /templates/:templateId/notes` を追記**

未到達: `:29-38`(追加ハンドラ)。既存ファイルの `buildApp` と `NOTES_DIR` の向け先を読み、同じ
`app` で:

```ts
it('POST は 201 で投稿を返し、返信は replyTo と kind を保つ。pathKey 欠落は 400', async () => {
  const url = `/templates/${encodeURIComponent(ID)}/notes`;
  const parent = await app.inject({ method: 'POST', url, headers: as('editor'), payload: { pathKey: 'p#1', content: '親', replyTo: null, kind: 'note' } });
  expect(parent.statusCode).toBe(201);
  expect(parent.json()).toMatchObject({ pathKey: 'p#1', content: '親', status: 'open', replyTo: null, kind: 'note' });
  const reply = await app.inject({ method: 'POST', url, headers: as('editor'), payload: { pathKey: 'p#1', content: '子', replyTo: parent.json().id, kind: 'question' } });
  expect(reply.statusCode).toBe(201);
  expect(reply.json()).toMatchObject({ replyTo: parent.json().id, kind: 'question' });
  expect((await app.inject({ method: 'POST', url, headers: as('editor'), payload: { content: 'x' } })).statusCode).toBe(400);
});
```

`as(...)` は既存ファイルの user 注入方法に合わせる(無ければ history と同じ `onRequest` を足す)。

- [ ] **Step 4: `reviews.routes.test.ts` へ失敗経路と local 扱いを追記**

未到達: `:24`(`req.user` 無し → `system` / `admin`)、`:48`(submit の監査 failure)、`:102`(reject
の監査 failure)。

```ts
it('user 無し(local モード)の一覧は全件可視の admin 扱い', async () => {
  const res = await app.inject({ method: 'GET', url: '/review-requests' });
  expect(res.statusCode).toBe(200);
  expect((res.json() as unknown[]).length).toBeGreaterThan(0);
});
it('存在しない申請の却下は 404 で、監査の failure 経路を通る(500 にならない)', async () => {
  const res = await app.inject({ method: 'POST', url: '/review-requests/rv-none/reject', headers: asUser('approver1', 'approver'), payload: { comment: '理由' } });
  expect(res.statusCode).toBe(404);
});
it('templateId とファンドが食い違う申請は 400 で、監査の failure 経路を通る', async () => {
  const res = await app.inject({ method: 'POST', url: '/review-requests', headers: asUser('editor1', 'editor'), payload: { templateId: 'AM01_611111_20250101_交付版', html: '<p>x</p>', css: '', fundCode: '999999', origin: 'edit' } });
  expect(res.statusCode).toBe(400);
});
```

3 つ目は `reviewRepo.submitReview` がファンド帰属を検査していれば 400。検査が無く 200 で通るなら
`:48` を踏む別の失敗を使う: 確定ファイルを 1 件置いてから、その本文の `<script>` を書き換えた
html で申請する(`templateScripts` の不変性チェックが `validation` を投げる)。

- [ ] **Step 5: `vivliostyle.routes.preview.test.ts` を書く**

未到達: inline build 成功(`:101, 105`)、merge 成功(`:169, 173`)、preview start の zip 経路
(`:189-217`)と inline 経路(`:219-243`)、`GET /preview/:id`(`:254-255`)、`DELETE`(`:268-275`)、
中継の path 判定(`:295, 302`)。`build.js` と `previewManager.js` を `vi.mock` し、実 CLI も実
ブラウザも起動しない。

```ts
// =============================================================================
// vivliostyle.routes.preview.test.ts — build 成功応答と preview セッションの HTTP 契約
// =============================================================================
// `vivliostyleRoutes.entry.test.ts` は entry の封じ込めだけを見る。ここでは成功経路
// (PDF の content-type・監査の success)と、preview の start / get / stop が previewManager の
// 戻りをどう HTTP に写すか(空振りは 404 に合流、他人のセッションと区別しない)を固定する。
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.AUDIT_DB = 'false';
process.env.LOG_DIR = /* tmp */;

vi.mock('../src/vivliostyle/build.js', () => ({
  withBuildSlot: async (fn: (run: (o: unknown) => Promise<void>) => Promise<unknown>) => fn(async () => {}),
  buildProjectInSlot: async () => Buffer.from('%PDF-1.4 project'),
  buildInlinePdf: async () => Buffer.from('%PDF-1.4 inline'),
  buildMergedPdf: async () => Buffer.from('%PDF-1.4 merged'),
  prepareInlineDoc: async () => ({ dir: '/tmp/x', entry: '/tmp/x/index.html' }),
}));
const sessions = new Map<string, { id: string; mode: string; docBase: string }>();
vi.mock('../src/vivliostyle/previewManager.js', () => ({
  previewManager: {
    start: vi.fn(async (input: { mode: string }) => {
      const meta = { id: '11111111-1111-4111-8111-111111111111', mode: input.mode, docBase: '/base/' };
      sessions.set(meta.id, meta);
      return meta;
    }),
    get: vi.fn((id: string) => sessions.get(id) ?? null),
    stop: vi.fn(async (id: string) => sessions.delete(id)),
    resolveFor: vi.fn((id: string) => (sessions.has(id) ? { upstream: 'http://127.0.0.1:1', docBase: '/base/' } : null)),
  },
}));
```

主張:

```ts
it('POST /build(inline)は application/pdf のバイト列を返す', async () => {
  const res = await app.inject({ method: 'POST', url: '/build', payload: { html: '<p>x</p>', css: '' } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/pdf');
  expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
});
it('POST /build/merge は複数文書を 1 PDF にする', async () => {
  const res = await app.inject({ method: 'POST', url: '/build/merge', payload: { documents: [{ html: '<p>a</p>', css: '' }, { html: '<p>b</p>', css: '' }] } });
  expect(res.statusCode).toBe(200);
  expect(res.rawPayload.toString()).toContain('merged');
});
it('POST /preview(inline)は 201 でセッション meta、不正ボディは 400', async () => {
  expect((await app.inject({ method: 'POST', url: '/preview', payload: { nope: 1 } })).statusCode).toBe(400);
  const res = await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ mode: 'inline' });
});
it('POST /preview(zip)は展開して project モードで起動する', async () => {
  const z = new JSZip(); z.file('index.html', '<p>x</p>');
  const zip = await z.generateAsync({ type: 'nodebuffer' });
  const res = await app.inject({ method: 'POST', url: '/preview', headers: { 'content-type': 'application/zip' }, payload: zip });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ mode: 'project' });
});
it('GET /preview/:id は meta、未知 id は 404。DELETE は 204、二度目は 404(存在オラクルにしない)', async () => {
  const started = (await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } })).json();
  expect((await app.inject({ method: 'GET', url: `/preview/${started.id}` })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/preview/22222222-2222-4222-8222-222222222222' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'DELETE', url: `/preview/${started.id}` })).statusCode).toBe(204);
  expect((await app.inject({ method: 'DELETE', url: `/preview/${started.id}` })).statusCode).toBe(404);
});
it('中継: UUID でない id・許可リスト外のパスは上流へ出ずに 404', async () => {
  const started = (await app.inject({ method: 'POST', url: '/preview', payload: { html: '<p>x</p>', css: '' } })).json();
  expect((await app.inject({ method: 'GET', url: '/preview/not-a-uuid/index.html' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: `/preview/${started.id}/@fs/etc/passwd` })).statusCode).toBe(404);
});
```

`docBase` / `resolveFor` の戻りの形は `previewManager.ts` と `previewProxy.ts` の型を読んで合わせる。
`/preview/:id/*` の中継は hijack するので、許可リスト内のパスを叩くテストは書かない(上流が無い)。

- [ ] **Step 6: 5 ルートの perFile 計測**

Run(include に 5 ファイル、テストは既存 + 新規の該当ファイル):
```bash
pnpm exec vitest run --project server --coverage \
  --coverage.include='editor/server/src/routes/generate.routes.ts' \
  --coverage.include='editor/server/src/routes/history.routes.ts' \
  --coverage.include='editor/server/src/routes/notes.routes.ts' \
  --coverage.include='editor/server/src/routes/reviews.routes.ts' \
  --coverage.include='editor/server/src/routes/vivliostyle.routes.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/server/test/generate.routes.test.ts editor/server/test/generate.routes.local.test.ts \
  editor/server/test/history.routes.test.ts editor/server/test/notes.routes.test.ts \
  editor/server/test/reviews.routes.test.ts editor/server/test/reviews.metaFailure.test.ts \
  editor/server/test/vivliostyleRoutes.entry.test.ts editor/server/test/vivliostyle.routes.preview.test.ts \
  editor/server/test/previewProxy.routes.test.ts
```
Expected: ERROR 行 0。

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write editor/server/test
git add editor/server/test/generate.routes.local.test.ts editor/server/test/history.routes.test.ts editor/server/test/notes.routes.test.ts editor/server/test/reviews.routes.test.ts editor/server/test/vivliostyle.routes.preview.test.ts
git commit -m "test(editor): generate の local 経路・履歴 PDF 記録・コメント投稿・申請の失敗監査・preview セッションの HTTP 契約を固定する"
```

---

### Task 4: server の files / git / generate 層

**Files:**
- Modify: `editor/server/test/atomicWrite.test.ts`(`atomic.ts`)
- Modify: `editor/server/test/pathGuards.test.ts`(`draftFiles.ts`。既存の DRAFTS_DIR 設定を再利用)
- Modify: `editor/server/test/historyFiles.rotation.test.ts`(`historyFiles.ts`)
- Create: `editor/server/test/syncFiles.test.ts`(`syncFiles.ts`)
- Modify: `editor/server/test/pyTemplate.test.ts`(`pyTemplate.ts`)
- Modify: `editor/server/test/gitRepo.test.ts`(`gitRepo.ts`)

**Interfaces:**
- Consumes: `atomicWrite(path, body)`、`draftExists` / `draftMtime` / `readDraft` / `writeDraft` /
  `deleteDraft`(`files/draftFiles.ts`)、`readHistory` / `appendHistory` / `MAX_HISTORY_BYTES` /
  `MAX_HISTORY_TAIL_BYTES`(`files/historyFiles.ts`。export 名は実物を読む)、`readSyncState` /
  `writeSyncState`(`files/syncFiles.ts`)、`generateTemplate`(`generate/pyTemplate.ts`)、
  `gitRepo.ts` の公開関数(既存テストが使っているもの)。
- Produces: なし。

- [ ] **Step 1: `atomic.ts` — rename の共有違反リトライと、失敗時の一時ファイル掃除**

未到達: `:37` の `code ?? ''`(`code` 無しのエラー)、`:80`(rename 失敗後の `rm` 掃除)。

```ts
import fsPromises from 'node:fs/promises';

describe('renameWithRetry', () => {
  it('EPERM(共有違反)は待って再試行し、2 度目で成功すれば内容が残る', async () => {
    const target = path.join(dir, 'busy.json');
    const original = fsPromises.rename;
    let calls = 0;
    const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return original(from, to);
    });
    await atomicWrite(target, 'v');
    spy.mockRestore();
    expect(calls).toBe(2);
    expect(await fs.readFile(target, 'utf8')).toBe('v');
  });
  it('code の無い失敗は再試行せずに投げ、一時ファイルを残さない', async () => {
    const target = path.join(dir, 'x.json');
    const spy = vi.spyOn(fsPromises, 'rename').mockRejectedValue(new Error('no code'));
    await expect(atomicWrite(target, 'v')).rejects.toThrow('no code');
    spy.mockRestore();
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
```

`atomic.ts` が `import fs from 'node:fs/promises'` の default import なら `vi.spyOn(fsPromises,
'rename')` が効く(同じモジュールオブジェクト)。named import(`import { rename }`)なら spy が
効かないので `vi.mock('node:fs/promises', …)` の partial mock に切り替える。

- [ ] **Step 2: `draftFiles.ts` — 存在判定・mtime・読み取りの空振り**

未到達: `:57`(`readDraft` の null / 読取失敗 → `''`)、`:65-69`(`draftExists` の規約外 id と
stat 成否)、`:75-79`(`draftMtime`)。`pathGuards.test.ts` は `DRAFTS_DIR` を設定済みなので追記する。

```ts
describe('draftFiles の存在判定と mtime', () => {
  it('規約外 id は例外ではなく「無い」(false / null)で答え、drafts に触れない', async () => {
    const { draftExists, draftMtime } = await import('../src/files/draftFiles.js');
    expect(await draftExists('../outside/pwned')).toBe(false);
    expect(await draftMtime('../outside/pwned')).toBeNull();
  });
  it('書いた下書きは exists=true・mtime は ISO、消せば false / null', async () => {
    const { draftExists, draftMtime, deleteDraft, writeDraft } = await import('../src/files/draftFiles.js');
    await writeDraft(VALID_ID, '<p>x</p>', '');
    expect(await draftExists(VALID_ID)).toBe(true);
    expect(await draftMtime(VALID_ID)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await deleteDraft(VALID_ID);
    expect(await draftExists(VALID_ID)).toBe(false);
    expect(await draftMtime(VALID_ID)).toBeNull();
  });
  it('readDraft は null 参照と無いファイルを空文字で返す(台帳の値を信じない)', async () => {
    const { readDraft } = await import('../src/files/draftFiles.js');
    expect(await readDraft(null, null)).toEqual({ html: '', css: '' });
    expect(await readDraft(`${VALID_ID}.html`, `${VALID_ID}.css`)).toEqual({ html: '', css: '' });
    expect(await readDraft('../outside/x.html', 'x.css')).toEqual({ html: '', css: '' });
  });
});
```

- [ ] **Step 3: `historyFiles.ts` — 空ファイルの tail、改行の無い tail、close 失敗、rm 失敗**

未到達: `:61`(世代ファイルの `rm` が reject したときの握り潰し)、`:97`(`length === 0`)、
`:106`(tail に改行が無い)、`:110`(`handle.close` の reject)。

```ts
describe('readTail の端', () => {
  it('空ファイルは空配列(0 バイト read を試みない)', async () => {
    const h = await importHistory();
    await fs.mkdir(path.dirname(historyFile('pdf')), { recursive: true });
    await fs.writeFile(historyFile('pdf'), '', 'utf8');
    expect(await h.getPdfHistory()).toEqual([]);
  });
  it('読み窓より大きく改行を 1 つも含まない末尾は「行なし」として空配列', async () => {
    const h = await importHistory();
    await fs.mkdir(path.dirname(historyFile('pdf')), { recursive: true });
    await fs.writeFile(historyFile('pdf'), 'x'.repeat(h.MAX_HISTORY_TAIL_BYTES + 16), 'utf8');
    expect(await h.getPdfHistory()).toEqual([]);
  });
  it('close の失敗は読み取り結果を変えない', async () => {
    const h = await importHistory();
    await fs.mkdir(path.dirname(historyFile('pdf')), { recursive: true });
    await fs.writeFile(historyFile('pdf'), `${JSON.stringify({ id: 'a', templateId: 't', user: 'u', timestamp: 'now' })}\n`, 'utf8');
    const realOpen = fs.open;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen.apply(fs, args as Parameters<typeof fs.open>);
      const close = handle.close.bind(handle);
      return Object.assign(handle, { close: async () => { await close(); throw new Error('close failed'); } });
    });
    const rows = await h.getPdfHistory();
    spy.mockRestore();
    expect(rows).toHaveLength(1);
  });
  it('世代ファイルの削除失敗はローテーションを止めない', async () => {
    const h = await importHistory();
    await fs.mkdir(path.dirname(historyFile('pdf')), { recursive: true });
    await fs.writeFile(historyFile('pdf'), 'x'.repeat(h.MAX_HISTORY_BYTES), 'utf8');
    const spy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('EBUSY'));
    await h.recordPdfExport('AM01_510037_20240710_交付版', 'u');
    spy.mockRestore();
    expect(await fs.stat(historyFile('pdf', 1)).then(() => true, () => false)).toBe(true);
  });
});
```

`MAX_HISTORY_TAIL_BYTES` が export されていなければ export する(定数の公開のみ。既存の
`MAX_HISTORY_BYTES` と同じ扱い)。`fs` は `node:fs/promises` の default import(既存テストと同じ)。

- [ ] **Step 4: `syncFiles.ts` — 既存ファイルの読み戻し**

未到達: `:38-39`(ファイルがあるときの parse)。

```ts
// =============================================================================
// syncFiles.test.ts — ペア同期状態ファイルの往復
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-syncfiles-'));
process.env.DATA_ROOT = root;
process.env.SYNC_DIR = path.join(root, 'sync');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readSyncState', () => {
  it('未作成なら空状態、書けば同じ内容が読み戻る(Zod の形で検証される)', async () => {
    const { readSyncState, writeSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240710';
    const empty = await readSyncState(key);
    expect(empty.parts).toEqual({});
    await writeSyncState({ ...empty, parts: { 'p-1': { lastSynced: 'h1' } }, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(await readSyncState(key)).toMatchObject({ pairKey: key, parts: { 'p-1': { lastSynced: 'h1' } } });
  });
  it('形の壊れたファイルは例外(黙って空状態にしない = 書き込み経路の入力にしない)', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    fs.writeFileSync(path.join(root, 'sync', 'AM01_510037_20240711.json'), '{"pairKey":1}', 'utf8');
    await expect(readSyncState('AM01_510037_20240711')).rejects.toThrow();
  });
});
```

`pairKey` の形は `assertPairKey`(`@editor/shared`)に合わせる(3 トークン)。

- [ ] **Step 5: `pyTemplate.ts` — `basedOnTemplateId` の検査と stderr 無しの失敗文言**

未到達: `:25`(`basedOnTemplateId` あり)、`:40`(stderr 空)。既存テストの `execFile` モックの
形を読んで追記:

```ts
it('basedOnTemplateId は生成器へ渡す前に検査し、規約外なら Python を起動しない', async () => {
  await expect(generateTemplate({ ...attrs, basedOnTemplateId: '../etc/passwd' })).rejects.toThrow();
  expect(execFileMock).not.toHaveBeenCalled();
});
it('基にする id が規約内なら引数として渡る', async () => {
  execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => cb(null, '<html/>', ''));
  await generateTemplate({ ...attrs, basedOnTemplateId: 'AM01_510037_20240710_交付版' });
  expect(execFileMock.mock.calls[0][1]).toContain('AM01_510037_20240710_交付版');
});
it('stderr が空の失敗は message だけで組む(末尾に改行を足さない)', async () => {
  execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => cb(new Error('exit 1'), '', ''));
  await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗: exit 1$/);
});
```

- [ ] **Step 6: `gitRepo.ts` — identity の既定値と index.lock リトライ**

未到達(branches 47/56 → 48 以上が必要): `:155`(`author.name` 空 → `system`)、`:296`(add 対象
ゼロ)、`:133-137`(index.lock の再試行)、`:148`(直列化チェーンの失敗側)。既存テストの一時
リポジトリ helper に乗せて 2 つ:

```ts
it('author.name が空でも system として commit できる(email は system@editor.local)', async () => {
  await commitAll({ message: 'm', author: { name: '' } /* 既存の引数形に合わせる */ });
  const log = await listVersions(ID); // 既存の読み出し関数
  expect(log[0].user).toBe('system');
});
it('index.lock が居る間は待ち、外れれば commit が通る', async () => {
  const lock = path.join(tmp, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  setTimeout(() => fs.rmSync(lock, { force: true }), 150);
  await expect(commitAll({ message: 'm2', author: { name: 'a' } })).resolves.toBeDefined();
});
```

関数名・引数は `gitRepo.ts` の export を読んで合わせる。`GIT_BIN` の `?? 'git'` 側(`:28`)は env
未設定で常に踏むので追加不要。

- [ ] **Step 7: 6 ファイルの perFile 計測**

Run:
```bash
pnpm exec vitest run --project server --coverage \
  --coverage.include='editor/server/src/files/atomic.ts' --coverage.include='editor/server/src/files/draftFiles.ts' \
  --coverage.include='editor/server/src/files/historyFiles.ts' --coverage.include='editor/server/src/files/syncFiles.ts' \
  --coverage.include='editor/server/src/generate/pyTemplate.ts' --coverage.include='editor/server/src/git/gitRepo.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/server/test/atomicWrite.test.ts editor/server/test/pathGuards.test.ts editor/server/test/historyFiles.rotation.test.ts \
  editor/server/test/historyFiles.limits.test.ts editor/server/test/syncFiles.test.ts editor/server/test/pyTemplate.test.ts \
  editor/server/test/gitRepo.test.ts editor/server/test/history.routes.test.ts editor/server/test/confirmedWrite.rollback.test.ts
```
Expected: ERROR 行 0。

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write editor/server/test editor/server/src/files/historyFiles.ts
git add editor/server/test/atomicWrite.test.ts editor/server/test/pathGuards.test.ts editor/server/test/historyFiles.rotation.test.ts editor/server/test/syncFiles.test.ts editor/server/test/pyTemplate.test.ts editor/server/test/gitRepo.test.ts editor/server/src/files/historyFiles.ts
git commit -m "test(editor): ファイル I/O 層の空振り・再試行・close 失敗と git identity の既定値を固定する"
```

---

### Task 5: server の vivliostyle / security 層

**Files:**
- Modify: `editor/server/test/projectConfig.test.ts`
- Modify: `editor/server/src/vivliostyle/previewHost.ts`(`bundleSafeToInline` を export)
- Modify: `editor/server/test/previewHost.test.ts`
- Modify: `editor/server/test/inlineDocScripts.test.ts`
- Modify: `editor/server/test/buildWorkerPool.test.ts`
- Modify: `editor/server/src/vivliostyle/egressGuard.ts`(port probe の注入点を足す)
- Modify: `editor/server/test/egressGuard.test.ts`
- Modify: `editor/server/test/templateScripts.test.ts`

**Interfaces:**
- Consumes: `parseProjectConfig(text, root, isFile?)`、`previewHostRoutes`、`inlineDocScripts(html,
  servedRoot, served)`、`BuildWorkerPool`(`FakeWorker` は既存テスト内)、`reserveBuildOrigin` /
  `startEgressGuard` / `stopEgressGuard`、`collectExecutableUnits` / `expandEncodedChips`。
- Produces(本番コードの変更):
  - `previewHost.ts`: `export function bundleSafeToInline(bundle: string): boolean`(実装不変。
    export を足すだけ)。
  - `egressGuard.ts`: `pickFreePortSpan(probe: PortProbe = listenProbe)` と
    `pickFreePortSpanSerialized(probe?: PortProbe)` を **export** し、`type PortProbe = (port: number)
    => Promise<net.Server>` を export する。`reserveBuildOrigin` は引数無しのまま
    `pickFreePortSpanSerialized()` を呼ぶ(本番経路は不変)。

- [ ] **Step 1: `projectConfig.ts` — entry オブジェクト・cover・toc・copyAsset・上限**

未到達(statements 111/146、branches 80/116): `:142, 158, 213-214`(`MAX_LIST_ITEMS` 超過)、
`:160-179`(entry オブジェクトの `title` / `theme` / `encodingFormat` / `rel`(文字列・配列)、
文字列でもオブジェクトでもない要素)、`:219-225`(`defaultIsFile`)、`:236-237`(`MAX_CONFIG_BYTES`
超過)、`:254-255`(オブジェクトでない JSON)、`:283-299`(cover オブジェクト: 未知キー・`name`・
`htmlPath`・型不正)、`:303-325`(toc 文字列 / オブジェクト: `title`・`htmlPath`・`sectionDepth`
の正常・不正 / 型不正)、`:331-343`(copyAsset 型不正・`excludes`)。

```ts
describe('entry のオブジェクト形', () => {
  it('title / theme / encodingFormat / rel(文字列・配列)を検証して写す', () => {
    const out = parse({ entry: [{ path: 'a.md', title: 'T', theme: 'theme.css', encodingFormat: 'text/markdown', rel: 'contents' }, { path: 'b.md', rel: ['a', 'b'] }] });
    expect(out.entry).toEqual([
      { path: path.resolve(ROOT, 'a.md'), title: 'T', theme: path.resolve(ROOT, 'theme.css'), encodingFormat: 'text/markdown', rel: 'contents' },
      { path: path.resolve(ROOT, 'b.md'), rel: ['a', 'b'] },
    ]);
  });
  it('文字列でもオブジェクトでもない要素・ルート外 theme・非文字列 title は 400', () => {
    expect(() => parse({ entry: [1] })).toThrow();
    expect(() => parse({ entry: [{ path: 'a.md', theme: '../x.css' }] })).toThrow();
    expect(() => parse({ entry: [{ path: 'a.md', title: 7 }] })).toThrow();
    expect(() => parse({ entry: [{ path: 'a.md', rel: [1] }] })).toThrow();
  });
  it('要素数の上限を超える theme / entry / copyAsset.includes は 400', () => {
    const many = Array.from({ length: 1000 }, () => 'theme.css');
    expect(() => parse({ entry: 'a.md', theme: many })).toThrow(/多すぎ/);
    expect(() => parse({ entry: many.map(() => 'a.md') })).toThrow(/多すぎ/);
    expect(() => parse({ entry: 'a.md', copyAsset: { includes: many } })).toThrow(/多すぎ/);
  });
});
describe('cover / toc / copyAsset', () => {
  it('cover オブジェクトは src 必須で name / htmlPath を写し、未知キー・非文字列は 400', () => {
    expect(parse({ entry: 'a.md', cover: { src: 'c.png', name: 'Cover', htmlPath: 'cover.html' } }).cover).toEqual({ src: path.resolve(ROOT, 'c.png'), name: 'Cover', htmlPath: path.resolve(ROOT, 'cover.html') });
    expect(() => parse({ entry: 'a.md', cover: { src: 'c.png', evil: 1 } })).toThrow();
    expect(() => parse({ entry: 'a.md', cover: 7 })).toThrow(/cover/);
  });
  it('toc は文字列パス・オブジェクト(title / htmlPath / sectionDepth 0〜10)を受け、他は 400', () => {
    expect(parse({ entry: 'a.md', toc: 'toc.html' }).toc).toBe(path.resolve(ROOT, 'toc.html'));
    expect(parse({ entry: 'a.md', toc: { title: 'Contents', htmlPath: 'toc.html', sectionDepth: 3 } }).toc).toEqual({ title: 'Contents', htmlPath: path.resolve(ROOT, 'toc.html'), sectionDepth: 3 });
    expect(() => parse({ entry: 'a.md', toc: { sectionDepth: 11 } })).toThrow(/sectionDepth/);
    expect(() => parse({ entry: 'a.md', toc: { sectionDepth: 1.5 } })).toThrow(/sectionDepth/);
    expect(() => parse({ entry: 'a.md', toc: 7 })).toThrow(/toc/);
  });
  it('copyAsset は includes / excludes の glob 配列だけを受ける', () => {
    expect(parse({ entry: 'a.md', copyAsset: { excludes: ['**/*.psd'] } }).copyAsset).toEqual({ excludes: ['**/*.psd'] });
    expect(() => parse({ entry: 'a.md', copyAsset: 'x' })).toThrow(/copyAsset/);
    expect(() => parse({ entry: 'a.md', copyAsset: { includes: 'x' } })).toThrow(/配列/);
  });
});
describe('入力の大きさと形', () => {
  it('MAX_CONFIG_BYTES を超える本文・オブジェクトでない JSON は 400', () => {
    expect(() => parseText(`{"entry":"a.md","title":"${'x'.repeat(2 * 1024 * 1024)}"}`)).toThrow(/大きすぎ/);
    expect(() => parseText('"str"')).toThrow(/オブジェクト/);
    expect(() => parseText('123')).toThrow(/オブジェクト/);
  });
  it('isFile 省略時は lstat で実在を見る(symlink 越しは実体扱いしない)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projcfg-'));
    fs.writeFileSync(path.join(dir, 'theme.css'), '', 'utf8');
    expect(parseProjectConfig(JSON.stringify({ entry: 'a.md', theme: 'theme.css' }), dir).theme).toBe(path.resolve(dir, 'theme.css'));
    expect(() => parseProjectConfig(JSON.stringify({ entry: 'a.md', theme: 'missing.css' }), dir)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

`MAX_LIST_ITEMS` / `MAX_CONFIG_BYTES` の実値は `projectConfig.ts` を読んで、超える長さに合わせる。
`theme` が「実在ファイルのみ」でない仕様(URL やパッケージ名を拒む等)は既存テストを読んで、
上の期待値を実装に合わせる。

- [ ] **Step 2: `previewHost.ts` — `bundleSafeToInline` の export と 4 入力、bundle 配信の経路**

未到達(branches 14/23 → 20 以上が必要): `:136`(`</script` を含む)、`:140`(コメント内の
`<script`: 3 分岐)、`:154`(bundle キャッシュ命中)、`:413-417`(`vivliostyle.js` の配信)。

`previewHost.ts` の `function bundleSafeToInline` に `export` を付け、doc comment に「テストから
直接検証するために公開する。呼び出しは本モジュール内のみ」を 1 行足す。

```ts
import { bundleSafeToInline } from '../src/vivliostyle/previewHost.js';

describe('bundleSafeToInline', () => {
  it('</script を含む bundle は inline にしない(要素の早期終端)', () => {
    expect(bundleSafeToInline('var s="</script>";')).toBe(false);
  });
  it('<!-- の後に <script が来る形は inline にしない(script data の二重エスケープ)', () => {
    expect(bundleSafeToInline('/*<!-- x */ var a="<script>";')).toBe(false);
    expect(bundleSafeToInline('/*<!-- x --> */ var a="<script>";')).toBe(false); // 閉じた後の <script
  });
  it('<!-- が閉じられて <script を含まない・そもそも無い bundle は inline できる', () => {
    expect(bundleSafeToInline('/*<!-- x -->*/ var a=1;')).toBe(true);
    expect(bundleSafeToInline('var a=1;')).toBe(true);
  });
});
describe('GET /api/preview-host/vivliostyle.js', () => {
  it('ビューア bundle を text/javascript・no-store で配る(2 回目はキャッシュから同一内容)', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/preview-host/vivliostyle.js' });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('text/javascript');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toContain('window.Vivliostyle=module.exports');
    const b = await app.inject({ method: 'GET', url: '/api/preview-host/vivliostyle.js' });
    expect(b.body).toBe(a.body);
  });
});
```

2 つ目の `it` の 2 番目の入力(閉じた後に `<script`)は `open < close` が偽で次のコメントも無い
→ `true` になる。期待値を実装の意味(「コメントが閉じる前に `<script` が現れる」だけを拒む)に
合わせて直す: `expect(bundleSafeToInline('/*<!-- x --> */ var a="<script>";')).toBe(true)`。

- [ ] **Step 3: `inlineDocScripts.ts` — type 属性・ディレクトリ・サイズ超過・読取失敗**

未到達: `:90-93, 97-99`(`type` 属性: `module` / `text/javascript` / 許可外)、`:154`(ファイルで
ない・サイズ超過)、`:157`(読み取り失敗)。

```ts
it('type が module / text/javascript / application/javascript なら展開し、他の type は原文のまま', async () => {
  const served = new Set(['js/app.js']);
  expect(await inlineDocScripts('<script type="module" src="js/app.js"></script>', root, served)).toContain('<script type="module">window.MARK');
  expect(await inlineDocScripts('<script type="text/javascript" src="js/app.js"></script>', root, served)).toContain('<script>window.MARK');
  const ld = '<script type="application/ld+json" src="js/app.js"></script>';
  expect(await inlineDocScripts(ld, root, served)).toBe(ld);
});
it('served に載っていても実体が無い・ディレクトリ・上限超過なら原文のまま', async () => {
  await fs.mkdir(path.join(root, 'js', 'dir.js'), { recursive: true });
  await fs.writeFile(path.join(root, 'js', 'big.js'), 'x'.repeat(MAX_INLINE_SCRIPT_BYTES + 1), 'utf8');
  const served = new Set(['js/missing.js', 'js/dir.js', 'js/big.js']);
  for (const rel of served) {
    const html = `<script src="${rel}"></script>`;
    expect(await inlineDocScripts(html, root, served)).toBe(html);
  }
});
```

`MAX_INLINE_SCRIPT_BYTES` は export されていなければ export する(定数公開のみ)。

- [ ] **Step 4: `buildWorkerPool.ts` — 枠の二重使用・クラッシュ時の待機者・idle 中のクラッシュ**

未到達(branches 27/34 → 29 以上): `:112`(同じ枠で 2 度 build)、`:226`(除去済み slot の
discard)、`:233`(除去済み slot の exit 通知)、`:240`(idle 中の除去)、`:243`(除去時に待機者へ
新ワーカー)、`:262`(TTL 失効時に既に非 idle)。

```ts
it('1 枠で build を 2 度呼ぶと 2 度目は拒否される(返却済みの枠へ投げない)', async () => {
  const { pool, created } = makePool();
  const p = pool.withSlot(async (build) => {
    const first = build({});
    created[0].finish();
    await first;
    await expect(build({})).rejects.toThrow(/枠の二重使用/);
    return 'done';
  });
  await expect(p).resolves.toBe('done');
});
it('満員で待つ要求は、稼働中ワーカーのクラッシュで空いた容量へ新ワーカーで割り当てられる', async () => {
  const { pool, created } = makePool({ poolSize: 1 });
  const first = pool.run({});
  const second = pool.run({});
  expect(created).toHaveLength(1);
  created[0].crash();
  await expect(first).rejects.toThrow();
  await vi.waitFor(() => expect(created).toHaveLength(2));
  created[1].finish();
  await expect(second).resolves.toBeUndefined();
});
it('idle 中のワーカーがクラッシュしても idle 一覧から外れ、次の要求は新ワーカーで走る', async () => {
  const { pool, created } = makePool({ poolSize: 1 });
  const p = pool.run({});
  created[0].finish();
  await p;
  created[0].crash();
  created[0].crash(); // 2 度目の exit 通知は無視される
  const q = pool.run({});
  await vi.waitFor(() => expect(created).toHaveLength(2));
  created[1].finish();
  await q;
});
it('idle TTL が切れる前に再取得されたワーカーは停止されない', async () => {
  vi.useFakeTimers();
  const { pool, created } = makePool({ poolSize: 1, idleTtlMs: 1000 });
  const p = pool.run({});
  created[0].finish();
  await p;
  const q = pool.run({});           // TTL 前に再取得 → idle から外れる
  vi.advanceTimersByTime(1000);     // 失効タイマーは「もう idle でない」で早期 return
  expect(created[0].killed).toBe(false);
  created[0].finish();
  await q;
  vi.useRealTimers();
});
```

`crash()` 後の `discard`(timeout 経路)は既存テストが持つ。`vi.waitFor` は vitest 4 で利用可。

- [ ] **Step 5: `egressGuard.ts` — probe の注入点と、span 確保の失敗経路・中継の端**

未到達(branches 24/32 → 28 以上): `:155`(中継先が API ポート)、`:201`(先頭 probe 失敗)、
`:213-217`(span 途中に先客)、`:224`(全試行失敗)、`:239, 242`(直列化行列の失敗側)、`:290`
(上流エラー時に既にヘッダ送信済み)、`:319`(中継の二重 close)。

`egressGuard.ts` の変更(本番経路は不変):

```ts
/** ポートを実際に押さえる関数。テストが失敗パターンを注入するために差し替えられる。 */
export type PortProbe = (port: number) => Promise<net.Server>;

export async function pickFreePortSpan(probe: PortProbe = listenProbe): Promise<number[]> {
  // 本体は不変。`listenProbe(...)` の 2 箇所を `probe(...)` に置き換える。
}

export function pickFreePortSpanSerialized(probe?: PortProbe): Promise<number[]> {
  const next = pickQueue.then(
    () => pickFreePortSpan(probe),
    () => pickFreePortSpan(probe),
  );
  pickQueue = next.catch(() => undefined);
  return next;
}
```

テスト:

```ts
import net from 'node:net';
import { type PortProbe, pickFreePortSpan, pickFreePortSpanSerialized } from '../src/vivliostyle/egressGuard.js';

const realProbe: PortProbe = (port) => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(port, '127.0.0.1', () => { s.removeListener('error', reject); resolve(s); });
});

describe('pickFreePortSpan の失敗経路', () => {
  it('先頭 probe が失敗し続ければ試行を使い切って例外(枠を予約しない)', async () => {
    const failing: PortProbe = async () => { throw new Error('EADDRINUSE'); };
    await expect(pickFreePortSpan(failing)).rejects.toThrow(/連番ポート/);
  });
  it('span の途中に先客が居れば番地を替えて取り直す', async () => {
    let seen = 0;
    const probe: PortProbe = async (port) => {
      seen += 1;
      if (seen === 2) throw new Error('EADDRINUSE'); // 1 回目の span の 2 番目だけ塞がっている
      return realProbe(port);
    };
    const ports = await pickFreePortSpan(probe);
    expect(ports).toHaveLength(4);
    expect(seen).toBeGreaterThan(4);
  });
  it('直列化の行列は、直前の予約が失敗しても次の予約を止めない', async () => {
    const failing: PortProbe = async () => { throw new Error('EADDRINUSE'); };
    await expect(pickFreePortSpanSerialized(failing)).rejects.toThrow();
    await expect(pickFreePortSpanSerialized(realProbe)).resolves.toHaveLength(4);
  });
});
describe('中継の端', () => {
  it('editor 自身の API ポート宛ては、枠に入っていても中継しない', async () => {
    const { config } = await import('../src/config.js');
    const build = await startFakeBuild('x');
    const res = await viaProxy(build.proxyUrl, `http://127.0.0.1:${config.port}/api/health`);
    expect(res.statusCode).toBe(502);
    await stopFakeBuild(build);
  });
  it('上流がヘッダ送信後に切れても 502 へ書き換えず、応答を閉じる', async () => {
    const build = await startFakeBuild('');
    build.origin.removeAllListeners('request');
    build.origin.on('request', (_req, res) => { res.writeHead(200); res.flushHeaders(); res.socket?.destroy(); });
    const res = await viaProxy(build.proxyUrl, `http://127.0.0.1:${build.originPort}/`).catch((e) => e);
    expect(res.statusCode === 200 || res instanceof Error).toBe(true);
    await stopFakeBuild(build);
  });
  it('release は冪等で、stopEgressGuard の後に呼んでも二重 close にならない', async () => {
    const reservation = await reserveBuildOrigin();
    await stopEgressGuard();
    expect(() => reservation.release()).not.toThrow();
    expect(() => reservation.release()).not.toThrow();
  });
});
```

`viaProxy` は既存テストの「プロキシ経由で GET する」helper 名に合わせる。`startFakeBuild` の
`ports.length` は `BUILD_PORT_SPAN`(4)。`config.port` が枠の中に入ることは無いので 1 つ目は
`isForwardableTarget` の `port === config.port` 分岐(`:155`)を踏み、`relayPorts` 側は既存テストが
踏む。

- [ ] **Step 6: `templateScripts.ts` — 復号属性の端・走査の端・URL scheme・style 属性**

未到達(branches 134/159 → 136 以上): `:88`(空の base64 属性)、`:113, 131`(single quote の
属性値)、`:116, 132`(復号が空)、`:540`(本文が `<` で終わる)、`:562-563`(閉じない doctype)、
`:604-605`(閉じない引用符の属性値)、`:661-662`(`{%` / `{#` トークンを含む URL)、`:681`
(`mailto:` 等の不活性 scheme)、`:682-683`(`data:` の media 判定)、`:759-760`(`<style>` の
非不活性属性)。

```ts
describe('走査の端(壊れた入力で単位列が欠落・混入しない)', () => {
  const units = (html: string) => collectExecutableUnits(html).map((u) => u.unit);
  it('空の data-opaque と single quote の data-opaque は復号対象にならない / なる', () => {
    expect(units(`<span data-opaque="">x</span>`)).toEqual([]);
    expect(units(`<span data-opaque=''>x</span>`)).toEqual([]);
    const enc = Buffer.from('<script>a()</script>').toString('base64');
    expect(units(`<span data-opaque='${enc}'>x</span>`)).toEqual(units(`<span data-opaque="${enc}">x</span>`));
    expect(units(`<span data-opaque="${enc}">x</span>`).length).toBe(1);
  });
  it('本文末尾の `<`・閉じない doctype・閉じない引用符で止まらず、後続の script を落とさない', () => {
    expect(units('<p>x</p><')).toEqual([]);
    expect(units('<!doctype html')).toEqual([]);
    expect(units('<div title="unterminated><script>a()</script>')).toHaveLength(0); // 属性値に飲まれる = 単位にならない
    expect(units('<div title="ok"><script>a()</script>')).toHaveLength(1);
  });
  it('URL の scheme: mailto/tel は不活性、data は画像 media だけ不活性、Jinja トークン混じりは strip して判定', () => {
    expect(units('<a href="mailto:a@b.example">x</a>')).toEqual([]);
    expect(units('<a href="data:image/png;base64,AAAA">x</a>')).toEqual([]);
    expect(units('<a href="data:text/html,<script>a()</script>">x</a>').length).toBe(1);
    expect(units('<a href="{% if x %}javascript:{% endif %}a()">x</a>').length).toBe(1);
    expect(units('<a href="{# c #}#top">x</a>')).toEqual([]);
  });
  it('<style> の非不活性属性は単位に入る(media は不活性)', () => {
    expect(units('<style media="print">a{}</style>').some((u) => u.startsWith('attr:style.'))).toBe(false);
    expect(units('<style onload="x()">a{}</style>').some((u) => u.startsWith('attr:style.onload='))).toBe(true);
  });
});
```

`unit` の文字列形(`attr:style.<name>=…`)と「data: の不活性 media」の正規表現は
`templateScripts.ts` の `INERT_DATA_MEDIA` / `isInertAttrName` を読んで期待値を合わせる。

- [ ] **Step 7: 6 ファイルの perFile 計測**

Run:
```bash
pnpm exec vitest run --project server --coverage \
  --coverage.include='editor/server/src/vivliostyle/projectConfig.ts' --coverage.include='editor/server/src/vivliostyle/previewHost.ts' \
  --coverage.include='editor/server/src/vivliostyle/inlineDocScripts.ts' --coverage.include='editor/server/src/vivliostyle/buildWorkerPool.ts' \
  --coverage.include='editor/server/src/vivliostyle/egressGuard.ts' --coverage.include='editor/server/src/security/templateScripts.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/server/test/projectConfig.test.ts editor/server/test/previewHost.test.ts editor/server/test/inlineDocScripts.test.ts \
  editor/server/test/buildWorkerPool.test.ts editor/server/test/egressGuard.test.ts editor/server/test/templateScripts.test.ts \
  editor/server/test/confirmedWrite.guard.test.ts editor/server/test/reviews.test.ts
```
Expected: ERROR 行 0。`egressGuard.ts` が 85% に届かない場合は `coverage-final.json` の `b` で残りを
特定し、到達可能なものを追加する(到達不能な `?? ''` 系は数えて報告する)。

- [ ] **Step 8: 変更した本番 2 ファイルの既存テストを全部通す**

Run: `pnpm exec vitest run --project server`
Expected: 全緑。

- [ ] **Step 9: Commit**

```bash
pnpm exec biome check --write editor/server/src/vivliostyle/previewHost.ts editor/server/src/vivliostyle/egressGuard.ts editor/server/src/vivliostyle/inlineDocScripts.ts editor/server/test
git add editor/server/src/vivliostyle/previewHost.ts editor/server/src/vivliostyle/egressGuard.ts editor/server/src/vivliostyle/inlineDocScripts.ts editor/server/test/projectConfig.test.ts editor/server/test/previewHost.test.ts editor/server/test/inlineDocScripts.test.ts editor/server/test/buildWorkerPool.test.ts editor/server/test/egressGuard.test.ts editor/server/test/templateScripts.test.ts
git commit -m "test(editor): 組版まわりの許可リスト・プール・egress 遮断・実行コード走査の端を固定し、probe と bundle 判定をテストから注入・参照できるようにする"
```

---

### Task 6: web の `api/local/*` と `lib/*`

**Files:**
- Modify: `editor/web/test/localReposExtra.dom.test.ts`(`local/historyRepo` / `local/partRepo` /
  `local/templateRepo` / `local/userRepo`)
- Modify: `editor/web/test/localReviewRepo.dom.test.ts`(`local/reviewRepo`)
- Modify: `editor/web/test/format.test.ts`(`lib/format`)
- Modify: `editor/web/src/lib/nunjucksRender.ts` + `editor/web/test/nunjucksRender.dom.test.ts`
- Modify: `editor/web/test/fillJinja.dom.test.ts`
- Modify: `editor/web/test/useCascadingSelect.dom.test.ts`
- Modify: `editor/web/test/editorSession.dom.test.ts`
- Modify: `editor/web/test/geom.test.ts`
- Modify: `editor/web/test/partKey.dom.test.ts`

**Interfaces:**
- Consumes: 各 local リポジトリ(`localHistoryRepo` / `localPartRepo` / `localTemplateRepo` /
  `localUserRepo` / `localReviewRepo` / `localAuthRepo`)、`K`(`@/api/local/store`)、`versionLabel`
  (`@/lib/format`)、`renderJinja`、`toFilled`、`useCascadingSelect`、`useEditorSessionStore`、
  `geomToStyle` / `geomFromStyle` / `geomChangeLabel`、`partPathKeyFor` / `canvasRawKey`。
- Produces(本番コードの変更): `nunjucksRender.ts:44` の `e instanceof Error ? e.message :
  String(e)` を `(e as Error).message` に置き換える(nunjucks は同期描画の失敗を必ず
  `TemplateError`(Error 派生)に包んで投げるので、非 Error 側は型の上で到達不能。コメントに
  その根拠を 1 行残す)。

- [ ] **Step 1: local リポジトリの未到達分岐**

```ts
describe('localHistoryRepo.getSnapshot', () => {
  it('templateId を渡したとき、別テンプレの snapshot は not_found', async () => {
    // confirmSaveLocal で t1 の snapshot を 1 件積み、その historyId を別 id で引く。
    const saved = await confirmSaveLocal({ templateId: ID, html: '<p>a</p>', css: '', fundCode: FUND }, '誰か');
    const versions = await localHistoryRepo.listVersions(ID);
    const hid = isOk(versions) ? versions.value[0].historyId : '';
    const r = await localHistoryRepo.getSnapshot(hid, 'AM01_999999_20240710_交付版');
    expect(isErr(r) && r.error.kind).toBe('not_found');
  });
});
describe('localPartRepo の階層絞り', () => {
  it('majorClass / middleClass / minorClass は上位を満たす項目だけへ順に効く', async () => {
    const all = await localPartRepo.listParts({});
    const first = isOk(all) ? all.value[0] : undefined;
    const c = first!.classification;
    for (const q of [
      { category: c.category, majorClass: c.majorClass },
      { category: c.category, majorClass: c.majorClass, middleClass: c.middleClass },
      { category: c.category, majorClass: c.majorClass, middleClass: c.middleClass, minorClass: c.minorClass },
    ]) {
      const r = await localPartRepo.listParts(q);
      expect(isOk(r) && r.value.some((p) => p.id === first!.id)).toBe(true);
    }
    const none = await localPartRepo.listParts({ category: c.category, majorClass: '存在しない大分類' });
    expect(isOk(none) && none.value).toEqual([]);
  });
});
describe('localTemplateRepo の生成と override', () => {
  it('fixture の無いファンドは既定 skeleton から生成し、償還指定はモック置換を通す', async () => {
    const r = await localTemplateRepo.generate({ companyCode: 'ZZ99', fundCode: '000000', editionType: '交付版', isRedemption: true });
    expect(isOk(r) && r.value.template.html.length).toBeGreaterThan(0);
    expect(isOk(r) && r.value.template.css).toBe('');
  });
  it('confirmSaveLocal は filledHtml があれば instance も積み、override 後の getTemplate は filled を空にする', async () => {
    await confirmSaveLocal({ templateId: ID, html: '<p>over</p>', css: '.o{}', fundCode: FUND, filledHtml: '<p>filled</p>' }, '誰か');
    expect(JSON.parse(localStorage.getItem(K.instances) ?? '{}')[ID].html).toBe('<p>filled</p>');
    const t = await localTemplateRepo.getTemplate(ID);
    expect(isOk(t) && t.value.html).toBe('<p>over</p>');
    expect(isOk(t) && t.value.css).toBe('.o{}');
    expect(isOk(t) && t.value.filled).toBe('');
  });
  it('resolveFund はコアラップ系の集合メンバシップ', async () => {
    const a = await localTemplateRepo.resolveFund('AM01', '510037', '交付版');
    expect(isOk(a)).toBe(true);
  });
});
describe('localUserRepo.resetUserPassword', () => {
  it('更新に失敗したときはその失敗を返す(一時パスワードを払い出さない)', async () => {
    await loginAdmin();
    const users = await localUserRepo.listUsers();
    const id = isOk(users) ? users.value[0].id : '';
    const spy = vi.spyOn(localUserRepo, 'updateUser').mockResolvedValueOnce(err(conflict('壊れた')));
    const r = await localUserRepo.resetUserPassword(id);
    spy.mockRestore();
    expect(isErr(r) && r.error.kind).toBe('conflict');
  });
});
```

`ID` / `FUND` は fixtures にある id(`AM01_510037_20240710_交付版` / `510037`)。`confirmSaveLocal` の
引数形は `localRepos.dom.test.ts` の既存呼び出しに合わせる。

- [ ] **Step 2: `local/reviewRepo` の未到達分岐**

```ts
describe('localReviewRepo の拒否と既定値', () => {
  it('規約外 templateId の申請は not_found、未ログインの申請者は「不明」', async () => {
    const bad = await localReviewRepo.submitReview({ templateId: 'not-a-template', fundCode: 'x', origin: 'edit', html: '', css: '' });
    expect(isErr(bad) && bad.error.kind).toBe('not_found');
    const target = await firstTemplate();
    const r = await localReviewRepo.submitReview({ templateId: target!.id, fundCode: target!.attributes.fundCode, origin: 'edit', html: '<p>x</p>', css: '', filledHtml: '<p>f</p>', changedSummary: { count: 1, names: ['a'] } });
    expect(isOk(r) && r.value.submittedBy).toBe('不明');
  });
  it('未知の申請 id は取得・承認・却下とも not_found', async () => {
    await loginAdmin();
    expect(isErr(await localReviewRepo.getReview('rv-none'))).toBe(true);
    expect(isErr(await localReviewRepo.approveReview('rv-none', {}))).toBe(true);
    expect(isErr(await localReviewRepo.rejectReview('rv-none', { comment: 'x' }))).toBe(true);
  });
  it('却下は理由必須(空白だけも不可)、処理済みの申請は承認も却下も conflict', async () => {
    await loginAdmin();
    const target = await firstTemplate();
    const sub = await localReviewRepo.submitReview({ templateId: target!.id, fundCode: target!.attributes.fundCode, origin: 'edit', html: '<p>x</p>', css: '' });
    const id = isOk(sub) ? sub.value.id : '';
    const noReason = await localReviewRepo.rejectReview(id, { comment: '   ' });
    expect(isErr(noReason) && noReason.error.kind).toBe('validation');
    expect(isOk(await localReviewRepo.rejectReview(id, { comment: '理由' }))).toBe(true);
    const again = await localReviewRepo.approveReview(id, {});
    expect(isErr(again) && again.error.kind).toBe('conflict');
    const rejectAgain = await localReviewRepo.rejectReview(id, { comment: '再' });
    expect(isErr(rejectAgain) && rejectAgain.error.kind).toBe('conflict');
  });
  it('一覧は未ログインでも落ちず、自分の申請だけを見せる(誰でもない = 0 件)', async () => {
    const list = await localReviewRepo.listReviews({});
    expect(isOk(list)).toBe(true);
  });
});
```

`decision` の型(`ReviewDecisionRequest`)は `comment?` を持つ。`getTemplate` が失敗して `baseHash`
が null になる分岐(`:59`)は、`vi.spyOn(localTemplateRepo, 'getTemplate').mockResolvedValueOnce(
err(notFound('x')))` で申請 1 件を積んで `baseHash` が `null` であることを主張する。

- [ ] **Step 3: `format.ts` の `versionLabel`、`nunjucksRender.ts` の分岐除去、`fillJinja.ts`**

```ts
describe('versionLabel', () => {
  it('timestamp があれば「日時・編集者」、無ければ user だけ(現行版)', () => {
    expect(versionLabel({ timestamp: '2024-07-10T11:42:00Z', user: '太郎' })).toMatch(/・太郎$/);
    expect(versionLabel({ timestamp: '', user: '現行版' })).toBe('現行版');
  });
});
```

`nunjucksRender.ts` の変更後、`renderJinja` の失敗が `error` に文字列で載ることを主張する
テストが既に無ければ足す:

```ts
it('描画失敗は throw せず error に nunjucks の文言を載せる', () => {
  const r = renderJinja('{{ x.y.z }}', { x: null });
  expect(r.html).toBe('');
  expect(typeof r.error).toBe('string');
});
```

`fillJinja.ts` の未到達: `:93`(`for` の対象が配列でない)、`:120`(`var` でないインライン
トークン、例 `{% set %}`)、`:210`(`else` の有無)、`:214`(if の枝が単一要素でない)。

```ts
describe('toFilled の端', () => {
  it('for の対象が配列でなければ 0 回展開(例外にしない)', () => {
    const out = toFilled('<ul>{% for h in holdings %}<li>{{ h.name }}</li>{% endfor %}</ul>', { holdings: 7 });
    expect(out).not.toContain('<li>');
  });
  it('値でないインライントークン(set)はチップ文言をそのまま見せる', () => {
    expect(toFilled('<p>{% set a = 1 %}x</p>', {})).toContain('{% set a = 1 %}');
  });
  it('if は else の有無どちらでも採用枝を展開し、枝が単一要素でなければ生ブロックを残す', () => {
    expect(toFilled('{% if ok %}<p>A</p>{% else %}<p>B</p>{% endif %}', { ok: false })).toContain('B');
    expect(toFilled('{% if ok %}<p>A</p>{% endif %}', { ok: false })).not.toContain('A');
    const raw = '{% if ok %}<p>A</p><p>A2</p>{% endif %}';
    expect(toFilled(raw, { ok: true })).toContain('{% if ok %}');
  });
});
```

- [ ] **Step 4: `useCascadingSelect.ts`、`editorSession.ts`、`geom.ts`、`partKey.ts`**

```ts
// useCascadingSelect: 遅い旧要求の結果は捨てる(44 / 49)、list の失敗は返す(48)
it('後着の旧世代応答は options / list に反映されない', async () => {
  let release!: () => void;
  const first = new Promise<void>((r) => { release = r; });
  const fetchOptions = vi.fn()
    .mockImplementationOnce(async () => { await first; return ok({ items: ['old'] }); })
    .mockResolvedValueOnce(ok({ items: ['new'] }));
  const cs = useCascadingSelect<Query, Options>({ levels: ['region'], emptyOptions: { items: [] }, fetchOptions, immediate: false });
  const p1 = cs.refresh();
  await cs.refresh();
  release();
  await p1;
  expect(cs.options.value.items).toEqual(['new']);
});
it('fetchList の失敗は refresh の結果として返り、list は変えない', async () => {
  const cs = useCascadingSelect<Query, Options, number>({ levels: ['region'], emptyOptions: { items: [] }, fetchOptions: vi.fn().mockResolvedValue(ok({ items: [] })), fetchList: vi.fn().mockResolvedValue(err(unauthorized('x'))), immediate: false });
  await cs.refresh();
  expect(cs.list.value).toEqual([]);
  expect(cs.error.value?.kind).toBe('unauthorized');
});
```

```ts
// editorSession: 壊れた JSON は空(45)、未知 id の persist は no-op(93)、quota 時の間引き(104-105 / 115)
it('undo ミラーの JSON が壊れていても空として読む', () => {
  localStorage.setItem(undoStacksKey(), '{not json');
  const store = useEditorSessionStore();
  expect(() => store.ensure('t1')).not.toThrow();
});
it('容量超過では他テンプレを古い側から間引き、それでも駄目なら深度を半減して保存を試みる', () => {
  const store = useEditorSessionStore();
  for (const id of ['a', 'b']) { const s = store.ensure(id); s.undoPast.push({ html: 'x', css: '' }); store.persist(id); }
  const real = localStorage.setItem.bind(localStorage);
  let fails = 2;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, v) {
    if (k === undoStacksKey() && fails-- > 0) throw new DOMException('quota', 'QuotaExceededError');
    return real(k, v);
  });
  const c = store.ensure('c'); c.undoPast.push({ html: 'y', css: '' });
  store.persist('c');
  spy.mockRestore();
  const map = readUndoMap();
  expect(map.c).toBeDefined();
  expect(Object.keys(map)).not.toContain('a');
});
```

`persist` の公開名(`store.persist` か `store.ensure` 内で暗黙か)は `editorSession.ts` を読んで
合わせる。

```ts
// geom: pctToNum の既定(54 / 56)、geomToStyle の配置分岐(108-117)、geomChangeLabel の各項目(134-147)
it('width が無い・数値でない style は 100% として読む', () => {
  expect(geomFromStyle({}).widthPct).toBe(100);
  expect(geomFromStyle({ width: 'abc%' }).widthPct).toBe(100);
});
it('geomToStyle: 100% + indent は左マージン、center/right は auto、pageBreakAfter は always', () => {
  expect(geomToStyle({ ...DEFAULT_GEOM, widthPct: 100, indent: 5 })['margin-left']).toBe('5mm');
  expect(geomToStyle({ ...DEFAULT_GEOM, widthPct: 50, align: 'center' })['margin-left']).toBe('auto');
  expect(geomToStyle({ ...DEFAULT_GEOM, widthPct: 50, align: 'right' })['margin-right']).toBe('');
  expect(geomToStyle({ ...DEFAULT_GEOM, widthPct: 50, align: 'left', indent: 3 })['margin-left']).toBe('3mm');
  expect(geomToStyle({ ...DEFAULT_GEOM, pageBreakAfter: true })['page-break-after']).toBe('always');
});
it('geomChangeLabel は最初に違う項目だけを日本語で言う', () => {
  const b = DEFAULT_GEOM;
  expect(geomChangeLabel(b, { ...b, align: 'center' })).toContain('横の配置');
  expect(geomChangeLabel(b, { ...b, indent: 2 })).toContain('左インデント');
  expect(geomChangeLabel(b, { ...b, marginBottom: 2 })).toContain('下の余白');
  expect(geomChangeLabel(b, { ...b, pageBreakBefore: true })).toContain('前で改ページ」を有効化');
  expect(geomChangeLabel({ ...b, pageBreakAfter: true }, b)).toContain('後で改ページ」を解除');
  expect(geomChangeLabel(b, { ...b, keepTogether: true })).toContain('分割しない」を有効化');
  expect(geomChangeLabel(b, b)).toBeNull();
});
```

```ts
// partKey: .page の外の要素(53-54 / 89)、id もクラスも無い要素の canvasRawKey(134 / 139)
it('.page を持つ文書で .page の外にある要素は part を解決できない(null)', () => {
  const r = root('<div class="page"><p>in</p></div><p id="out">out</p>');
  expect(partPathKeyFor(q(r, '#out'), r)).toBeNull();
});
it('canvasRawKey は id もクラスも無い要素をタグ名で表し、GrapesJS の自動 id を引かない', () => {
  const ed = { Components: { getById: vi.fn(() => undefined) } } as unknown as Editor;
  const r = root('<div class="page"><section>x</section></div>');
  expect(canvasRawKey(ed)(q(r, 'section'))).toBe('section');
  expect(ed.Components.getById).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: perFile 計測(12 ファイル)**

Run(include は 12 ファイル、テストは上で触った 9 ファイル + `localRepos.dom.test.ts`):
```bash
pnpm exec vitest run --project web-dom --project web-node --coverage \
  --coverage.include='editor/web/src/api/local/{historyRepo,partRepo,reviewRepo,templateRepo,userRepo}.ts' \
  --coverage.include='editor/web/src/lib/{format,nunjucksRender,fillJinja,useCascadingSelect}.ts' \
  --coverage.include='editor/web/src/stores/editorSession.ts' --coverage.include='editor/web/src/features/editor/{geom,partKey}.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/web/test/localRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts editor/web/test/localReviewRepo.dom.test.ts \
  editor/web/test/reviewRepo.local.dom.test.ts editor/web/test/format.test.ts editor/web/test/nunjucksRender.dom.test.ts \
  editor/web/test/fillJinja.dom.test.ts editor/web/test/useCascadingSelect.dom.test.ts editor/web/test/editorSession.dom.test.ts \
  editor/web/test/geom.test.ts editor/web/test/partKey.dom.test.ts editor/web/test/partKey.pageIndex.dom.test.ts
```
Expected: ERROR 行 0。

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write editor/web/src/lib/nunjucksRender.ts editor/web/test
git add editor/web/src/lib/nunjucksRender.ts editor/web/test/localReposExtra.dom.test.ts editor/web/test/localReviewRepo.dom.test.ts editor/web/test/format.test.ts editor/web/test/nunjucksRender.dom.test.ts editor/web/test/fillJinja.dom.test.ts editor/web/test/useCascadingSelect.dom.test.ts editor/web/test/editorSession.dom.test.ts editor/web/test/geom.test.ts editor/web/test/partKey.dom.test.ts
git commit -m "test(editor): local リポジトリの拒否経路と lib の端(世代ガード・容量超過・幾何ラベル・構造キー)を固定する"
```

---

### Task 7: web の features / services と `use*Service`

**Files:**
- Modify: `editor/web/test/templateEditorService.test.ts`
- Modify: `editor/web/test/useAutosave.dom.test.ts`
- Modify: `editor/web/test/mergePdfService.dom.test.ts`
- Modify: `editor/web/test/previewPanel.dom.test.ts`
- Modify: `editor/web/test/templatePreviewService.dom.test.ts`
- Modify: `editor/web/test/changedSummary.test.ts`
- Modify: `editor/web/test/partNames.test.ts`
- Modify: `editor/web/test/reviewDiffService.dom.test.ts`
- Modify: `editor/web/test/templateCreationService.test.ts`
- Modify: `editor/web/test/previewSelfContain.dom.test.ts`
- Create: `editor/web/test/useServices.dom.test.ts`(`use*Service` 5 本を 1 箇所で)

**Interfaces:**
- Consumes: 各 `create*Service` と `use*Service`(`useTemplateEditorService` /
  `useMergePdfService` / `useTemplatePreviewService` / `useChangedSummaryService` /
  `useReviewDiffService` / `useTemplateCreationService`)、`REPOS_KEY` / `localRepositories`、
  `PreviewPanel`、`selfContainPreviewDoc` / `resetSelfContainCache`。
- Produces: なし。

- [ ] **Step 1: `useServices.dom.test.ts` — `use*Service` は inject した repo で組み立てる**

Task 1 の `inSetup` と同じ形(provide は `localRepositories`)。`compareService` は
`useCompareService` が内部で持つので、`useChangedSummaryService` / `useReviewDiffService` は
「例外なく組み立てられ、関数を持つ」ことだけを主張する。

```ts
it('use*Service は provide 済みの repo から service を組み立てる', () => {
  expect(typeof inSetup(useTemplateEditorService).loadForEdit).toBe('function');
  expect(typeof inSetup(useMergePdfService).buildMergedPdf).toBe('function');
  expect(typeof inSetup(useTemplatePreviewService).loadForPreview).toBe('function');
  expect(typeof inSetup(useChangedSummaryService).computeChangedSummary).toBe('function');
  expect(typeof inSetup(useReviewDiffService).loadDiff).toBe('function');
  expect(typeof inSetup(useTemplateCreationService).generate).toBe('function');
});
```

メソッド名は各 service の interface を読んで実物に合わせる。

- [ ] **Step 2: `templateEditorService` / `templateCreationService` / `mergePdfService` /
  `templatePreviewService` の失敗経路と委譲**

```ts
// templateEditorService: listParts / getDraft の失敗はそのまま返す(65 / 68)、sample 失敗は空(90)、
// discard 失敗なら所属を解放しない(147)、recordPartChange は委譲(154)
it('listParts / getDraft の失敗は loadForEdit の結果として返る', async () => { /* repos() を err にして isErr を主張 */ });
it('getSampleData の失敗でも本文は開ける(sample は空)', async () => { /* getSampleData: err → isOk(load) */ });
it('discardDraft が失敗したら下書きの所属は解放しない', async () => {
  const owner: DraftOwner = { claim: vi.fn(), release: vi.fn(), belongsToSession: vi.fn(() => true) };
  const svc = createTemplateEditorService({ ...repos({}), discardDraft: vi.fn(async () => err(network('x'))) } as never, parts, owner);
  await svc.discardDraft('t1');
  expect(owner.release).not.toHaveBeenCalled();
});
it('recordPartChange は parts へそのまま委譲する', async () => {
  const parts = { recordPartChange: vi.fn(async () => ok(undefined)) } as unknown as PartRepository;
  await createTemplateEditorService(repos({}), parts).recordPartChange('t1', 'k#1', 'c');
  expect(parts.recordPartChange).toHaveBeenCalledWith('t1', 'k#1', 'c');
});
// templateCreationService: resolveFund の委譲(44)
it('resolveFund は repo へそのまま委譲する', async () => {
  const repo = { resolveFund: vi.fn(async () => ok({ isSeriesFund: true })) } as unknown as TemplateRepository;
  expect(isOk(await createTemplateCreationService(repo).resolveFund('A', 'F', 'E'))).toBe(true);
  expect(repo.resolveFund).toHaveBeenCalledWith('A', 'F', 'E');
});
// mergePdfService: sample 失敗(92-93)、PDF 生成の例外(72)
it('サンプルデータの取得失敗は何番目の文書かを含む conflict', async () => {
  const templates = { ...templatesOf(), getSampleData: vi.fn(async () => err(notFound('x'))) } as unknown as TemplateRepository;
  const r = await createMergePdfService(templates, history).buildMergedPdf(['t1']);
  expect(isErr(r) && r.error.message).toMatch(/サンプルデータ.*1.*取得に失敗/);
});
it('PDF 生成が例外を投げても Result で返る', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const r = await createMergePdfService(templatesOf(), history).buildMergedPdf(['t1']);
  expect(isErr(r) && r.error.kind).toBe('conflict');
  vi.unstubAllGlobals();
});
// templatePreviewService: sample / draft 失敗(81 / 86)、PDF fetch の例外(152)
it('getSampleData / getDraft の失敗は loadForPreview の結果として返る', async () => { /* 2 件 */ });
it('PDF 出力の fetch が例外を投げても conflict(PDF_ERROR_MSG)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const r = await createTemplatePreviewService(draftRepos('<p>x</p>'), history, ownerOf(true)).exportPdf(/* 既存テストの引数 */);
  expect(isErr(r) && r.error.message).toBe(PDF_ERROR_MSG);
  vi.unstubAllGlobals();
});
```

`mergePdfService` の PDF 生成が `fetch` でなく `renderPdfDocument` 経由なら、`vi.mock('@/lib/pdfDocument')`
で `renderPdfDocument` を throw させる。

- [ ] **Step 3: `changedSummary` / `partNames` / `reviewDiffService`**

```ts
// changedSummary: renderAfter 失敗(64)、origin=create は before を描画しない(67)、renderBefore 失敗(69)、
// パーツ id の無いキー(54)、createChangedSummaryService の配線(98-105)
it('renderAfter の失敗は null、origin=create は renderBefore を呼ばない、renderBefore の失敗は空の before で続行', async () => {
  expect(await computeChangedSummaryWith(input('edit'), { ...deps, renderAfter: vi.fn(async () => err(notFound('x'))) })).toBeNull();
  const before = vi.fn(async () => ok({ html: '', css: '' }));
  await computeChangedSummaryWith(input('create'), { ...deps, renderBefore: before });
  expect(before).not.toHaveBeenCalled();
  const s = await computeChangedSummaryWith(input('edit'), { ...deps, renderBefore: vi.fn(async () => err(notFound('x'))) });
  expect(s?.count).toBe(2);
});
it('createChangedSummaryService は compare の描画 2 本と parts の名前表を配線する', async () => {
  const compare = { renderTemplateBody: vi.fn(async () => ok({ html: '<p>a</p>', css: '' })), renderVersionHtml: vi.fn(async () => ok({ html: '<p>b</p>', css: '' })) } as unknown as CompareService;
  const parts = { listParts: vi.fn(async () => ok([{ id: 'note-a', name: '運用実績の表' }])) } as unknown as PartRepository;
  const svc = createChangedSummaryService(compare, parts);
  await svc.computeChangedSummary({ templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' });
  expect(compare.renderVersionHtml).toHaveBeenCalledWith('baseline:t');
  expect(parts.listParts).toHaveBeenCalled();
});
// partNames: ページ番号の無い fallback(52)、loadPartNameMap の成否(61-62)
it('fallback にページ番号が無ければ業務名だけ', () => {
  expect(businessLabel('note-fund-status#1', 'パーツ1', names)).toBe('当ファンドの状況');
});
it('loadPartNameMap は listParts の失敗で空 Map、成功で id→name', async () => {
  expect((await loadPartNameMap({ listParts: async () => err(notFound('x')) } as never)).size).toBe(0);
  const m = await loadPartNameMap({ listParts: async () => ok([{ id: 'a', name: 'A' }]) } as never);
  expect(m.get('a')).toBe('A');
});
// reviewDiffService: 空 html の text(118)、fund css 空・style 空(140 / 144-145)
it('申請者の style に隠し文言があっても本文テキストに現れ、空の style / fund CSS は無視される', async () => { /* 既存の loadDiff 経路で css:'' と <style></style> を通す */ });
```

`@/workers` の `htmlWorker.buildHtmlDiff` は `changedSummary.test.ts` 側でも `vi.mock('@/workers', …)`
で差し替える(`createChangedSummaryService` が import するため)。

- [ ] **Step 4: `useAutosave` / `PreviewPanel.vue` / `previewSelfContain`**

```ts
// useAutosave: 待機中の flush(40)、待機中の cancel(68)、待機中の unmount(89)
it('タイマー待機中の flush は待たずに保存し、タイマーは 1 度しか発火しない', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => ok(undefined));
  const { api } = host(save, 800);
  api.trigger();
  await api.flush();
  await vi.advanceTimersByTimeAsync(800);
  expect(save).toHaveBeenCalledTimes(1);
});
it('タイマー待機中の cancel と unmount は予約を捨てる', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => ok(undefined));
  const a = host(save, 800); a.api.trigger(); a.api.cancel();
  const b = host(save, 800); b.api.trigger(); b.wrapper.unmount();
  await vi.advanceTimersByTimeAsync(800);
  expect(save).not.toHaveBeenCalled();
});
```

```ts
// PreviewPanel: fallback の二重呼び出し(102)、fallback 後の srcdoc 更新(108 / 238)、selfContain 失敗(139)、
// ローダー保険(146-151)、type の無いメッセージ(163)、state 無し(172)、ready(181-183)、
// ERROR の非文字列 message(189)、READY 後の load(196)、boot 期限(199)、fallback 中の send/gotoAnchor(204 / 230)
it('ERROR は簡易表示へ倒し、2 度目の ERROR も props 更新も簡易 iframe の srcdoc に写す', async () => {
  const wrapper = mount(PreviewPanel, { props: { html: '<p>a</p>' }, attachTo: document.body });
  const win = frameWindow(wrapper);
  deliver({ type: 'editor:preview-ready' }, win);
  deliver({ type: 'editor:preview-error', message: 7 }, win);   // 非文字列 → 「不明なエラー」
  deliver({ type: 'editor:preview-error', message: 'again' }, win);
  await flushPromises();
  const fb = wrapper.get('iframe[title="簡易プレビュー"]').element as HTMLIFrameElement;
  expect(fb.srcdoc).toBe('<p>a</p>');
  await wrapper.setProps({ html: '<p>b</p>' });
  expect(fb.srcdoc).toBe('<p>b</p>');
  const post = vi.spyOn(win, 'postMessage');
  (wrapper.vm as unknown as { gotoAnchor(id: string): void }).gotoAnchor('review-anchor-1');
  expect(post).not.toHaveBeenCalled();
});
it('type の無いメッセージ・state の無い STATE は無視し、ready な STATE でローダーを消す', async () => { /* deliver 3 件、rendering の DOM 表示で主張 */ });
it('COMPLETE が来ないままの失敗はローダーだけ解除する(簡易表示へは倒さない)', async () => {
  const wrapper = mount(PreviewPanel, { props: { html: '<p>a</p>' }, attachTo: document.body });
  deliver({ type: 'editor:preview-ready' }, frameWindow(wrapper));
  await flushPromises();
  vi.advanceTimersByTime(RENDER_LOADER_FAILSAFE_MS);
  await flushPromises();
  expect(wrapper.find('iframe[title="簡易プレビュー"]').exists()).toBe(false);
  expect(wrapper.find('[role="status"]').exists()).toBe(false); // ローダーが消えている(実際のマークアップに合わせる)
});
it('自己完結化に失敗しても原文を送る', async () => {
  const { selfContainPreviewDoc } = await import('../src/lib/previewSelfContain');
  (selfContainPreviewDoc as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('x'));
  /* READY 後に props.html がそのまま postMessage される */
});
```

メッセージ種別の定数名(`PREVIEW_MSG_*`)と簡易 iframe の `title` は `PreviewPanel.vue` /
`shared/src/preview/hostProtocol.ts` を読んで合わせる。

```ts
// previewSelfContain: サイズ超過(79)、fetcher 例外(85 / 117)、font キャッシュ(105)、未知拡張子(109)、
// 404 / サイズ超過の font(112 / 114)、type 属性(135-138)、src 無し(143)、空 style(162-163)、
// 解決できない font(172)、既定 fetcher(189)
it('上限を超える script / font と fetcher の例外は展開しない', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const out = await selfContainPreviewDoc(DOC('<script src="js/big.js"></script>'), fetcherFor({ 'js/big.js': big }));
  expect(out).toContain('src="js/big.js"');
  const throwing = vi.fn(async () => { throw new Error('net'); });
  expect(await selfContainPreviewDoc(DOC('<script src="js/a.js"></script>'), throwing)).toContain('src="js/a.js"');
  expect(await selfContainPreviewDoc(DOC('', '<style>@font-face{src:url(fonts/a.woff2)}</style>'), throwing)).toContain('url(fonts/a.woff2)');
});
it('font は拡張子の許可リスト・404・上限で展開を諦め、同じ rel は 1 度しか取得しない', async () => {
  const fetcher = fetcherFor({ 'fonts/a.woff2': new Uint8Array([1, 2, 3]) });
  const css = '<style>@font-face{src:url(fonts/a.woff2)} .x{src:url(fonts/a.woff2)}</style>';
  const out = await selfContainPreviewDoc(DOC('', css), fetcher);
  expect(out.match(/data:font\/woff2;base64,/g)).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await selfContainPreviewDoc(DOC('', '<style>@font-face{src:url(fonts/a.xyz)}</style>'), fetcher)).toContain('url(fonts/a.xyz)');
  expect(await selfContainPreviewDoc(DOC('', '<style>@font-face{src:url(fonts/missing.woff2)}</style>'), fetcher)).toContain('url(fonts/missing.woff2)');
});
it('type=module は展開し、許可外 type と src 無しの script、空の style は触らない', async () => {
  const fetcher = fetcherFor({ 'js/m.js': 'm()' });
  expect(await selfContainPreviewDoc(DOC('<script type="module" src="js/m.js"></script>'), fetcher)).toContain('<script type="module">m()');
  const ld = DOC('<script type="application/ld+json" src="js/m.js"></script><script>inline()</script><style></style>');
  expect(await selfContainPreviewDoc(ld, fetcher)).toContain('src="js/m.js"');
});
it('fetcher を省略すると window.fetch を使う', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('g()', { status: 200 })));
  expect(await selfContainPreviewDoc(DOC('<script src="js/g.js"></script>'))).toContain('g()');
  vi.unstubAllGlobals();
});
```

- [ ] **Step 5: perFile 計測(10 ファイル)**

Run(include は 10 ファイル、テストは上で触った 11 ファイル):
```bash
pnpm exec vitest run --project web-dom --project web-node --coverage \
  --coverage.include='editor/web/src/features/editor/services/templateEditorService.ts' --coverage.include='editor/web/src/features/editor/useAutosave.ts' \
  --coverage.include='editor/web/src/features/merge/services/mergePdfService.ts' --coverage.include='editor/web/src/features/preview/PreviewPanel.vue' \
  --coverage.include='editor/web/src/features/preview/services/templatePreviewService.ts' \
  --coverage.include='editor/web/src/features/reviews/services/{changedSummary,partNames,reviewDiffService}.ts' \
  --coverage.include='editor/web/src/features/templates/services/templateCreationService.ts' --coverage.include='editor/web/src/lib/previewSelfContain.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  editor/web/test/templateEditorService.test.ts editor/web/test/useAutosave.dom.test.ts editor/web/test/mergePdfService.dom.test.ts \
  editor/web/test/previewPanel.dom.test.ts editor/web/test/templatePreviewService.dom.test.ts editor/web/test/changedSummary.test.ts \
  editor/web/test/partNames.test.ts editor/web/test/reviewDiffService.dom.test.ts editor/web/test/templateCreationService.test.ts \
  editor/web/test/previewSelfContain.dom.test.ts editor/web/test/useServices.dom.test.ts
```
Expected: ERROR 行 0。

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write editor/web/test
git add editor/web/test/templateEditorService.test.ts editor/web/test/useAutosave.dom.test.ts editor/web/test/mergePdfService.dom.test.ts editor/web/test/previewPanel.dom.test.ts editor/web/test/templatePreviewService.dom.test.ts editor/web/test/changedSummary.test.ts editor/web/test/partNames.test.ts editor/web/test/reviewDiffService.dom.test.ts editor/web/test/templateCreationService.test.ts editor/web/test/previewSelfContain.dom.test.ts editor/web/test/useServices.dom.test.ts
git commit -m "test(editor): service 層の失敗経路と委譲、プレビューの簡易表示・自己完結化の端、use*Service の配線を固定する"
```

---

### Task 8: pie-chart `seaRuntime.ts` の SEA 側経路

**Files:**
- Modify: `pie-chart/test/sea_runtime.test.ts`
- Test target: `pie-chart/src/runtime/seaRuntime.ts`

**Interfaces:**
- Consumes: `isSea` / `readSeaAsset` / `installSeaGuards` / `installModuleResolutionBlock` /
  `resolveSeaRequest` / `HB_WASM_SPECIFIER` / `HB_WASM_SENTINEL`。
- Produces: なし。

未到達: `:70`(`require('node:sea')` が throw → 非 SEA)、`:108`(`getAsset` の実行)、`:137`
(`Module._resolveFilename` 欠落)、`:163-173`(SEA でのガード導入)。`typeof require` はグローバル
参照なので `vi.stubGlobal('require', …)` で SEA の ambient `require` を装える。ガード導入は
モジュールのフラグ(`guardsInstalled`)とプロセス全体の `Module._resolveFilename` を書き換えるため、
**`vi.resetModules()` で読み直したモジュールに対して行い、`afterEach` で `_resolveFilename` を
元に戻す**。

- [ ] **Step 1: SEA を装うテストを追記する**

```ts
import Module from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Runtime = typeof import('../src/runtime/seaRuntime.js');
const internals = Module as unknown as { _resolveFilename?: unknown };
const originalResolve = internals._resolveFilename;

/** SEA の ambient require を装う。`node:sea` だけを `api` で答える。 */
function stubSeaRequire(api: unknown): void {
  vi.stubGlobal('require', (id: string) => {
    if (id === 'node:sea') { if (api instanceof Error) throw api; return api; }
    throw new Error(`unexpected require: ${id}`);
  });
}
async function freshRuntime(): Promise<Runtime> {
  vi.resetModules();
  return import('../src/runtime/seaRuntime.js');
}
afterEach(() => {
  vi.unstubAllGlobals();
  internals._resolveFilename = originalResolve;
});

describe('SEA 実行時の経路', () => {
  it('require が node:sea を投げれば非 SEA(dev と同じ振る舞い)', async () => {
    stubSeaRequire(new Error('no sea'));
    const rt = await freshRuntime();
    expect(rt.isSea()).toBe(false);
  });
  it('SEA では許可キーのアセットを getAsset のコピーで返す', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    stubSeaRequire({ isSea: () => true, getAsset: () => bytes.buffer.slice(0) });
    const rt = await freshRuntime();
    expect(rt.isSea()).toBe(true);
    expect([...rt.readSeaAsset('hb-subset.wasm')]).toEqual([1, 2, 3]);
    expect(() => rt.readSeaAsset('..\\evil.woff2')).toThrow(/not in the allowlist/);
  });
  it('SEA では installSeaGuards が require.resolve の許可リスト shim と解決封鎖を張り、2 度目は何もしない', async () => {
    const req = Object.assign((id: string) => { if (id === 'node:sea') return { isSea: () => true, getAsset: () => new ArrayBuffer(0) }; throw new Error(id); }, {} as { resolve?: unknown });
    vi.stubGlobal('require', req);
    const rt = await freshRuntime();
    rt.installSeaGuards();
    expect(req.resolve).toBe(rt.resolveSeaRequest);
    expect(() => (internals._resolveFilename as (r: string) => string)('lodash')).toThrow(/external module resolution is disabled/);
    expect((internals._resolveFilename as (r: string) => string)('node:path')).toBeTruthy();
    const before = internals._resolveFilename;
    rt.installSeaGuards();
    expect(internals._resolveFilename).toBe(before);
  });
  it('Module._resolveFilename が無ければ封鎖を張れない事実を投げる(黙って素通しにしない)', async () => {
    const rt = await freshRuntime();
    internals._resolveFilename = undefined;
    expect(() => rt.installModuleResolutionBlock()).toThrow(/_resolveFilename is missing/);
  });
});
```

`node:path` の解決は `original.call(this, 'node:path', …)` が親モジュール等の残りの引数を要求する
場合があるので、失敗するなら `expect(() => resolve('node:path')).not.toThrow(/disabled/)` に
弱める(builtin が「封鎖」で落ちないことだけを主張する)。

- [ ] **Step 2: perFile 計測**

Run:
```bash
pnpm exec vitest run --project pie-chart --coverage \
  --coverage.include='pie-chart/src/runtime/seaRuntime.ts' \
  --coverage.reporter=text --coverage.thresholds.perFile=true \
  pie-chart/test/sea_runtime.test.ts pie-chart/test/subset_font_fs.test.ts pie-chart/test/build_pins.test.ts
```
Expected: ERROR 行 0。statements ≥ 90、branches ≥ 85。

- [ ] **Step 3: pie-chart のバイト不変を確認して Commit**

Run: `pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`(テストのみの
変更だが、規約どおり回す)。Expected: 83 件一致。

```bash
git add pie-chart/test/sea_runtime.test.ts
git commit -m "test(pie-chart): SEA 実行時のアセット読み出しとガード導入を ambient require のスタブで固定する"
```

---

### Task 9: include の追加・`perFile: true`・全体の通し・ドキュメント

**Files:**
- Modify: `vitest.config.ts`(root)
- Modify: `editor/README.md`(カバレッジ方針の節)
- Modify: `docs/editor/src/設計正典.md`(「触る前のチェックリスト」3 項)
- Modify: `docs/superpowers/specs/2026-09-06-ci-optimization-design.md`(10 章に B2 の実測を追記)

**Interfaces:**
- Consumes: Task 1〜8 の成果。
- Produces: perFile 閾値で緑の `pnpm run test:coverage`。

- [ ] **Step 1: include を広げ、perFile を有効にする**

`vitest.config.ts` の `coverage.include` へ次を足す(既存の `rest/reviewRepo.ts` / `rest/http.ts`
の 2 行は `rest/*.ts` に置き換える):

```ts
        // ルート層。ハンドラ本体は inject テストで通す(templates / parts / users を含む)。
        'editor/server/src/routes/*.ts',
        // rest トランスポートと 7 リポジトリ、DI 合成ルート。local と同じ契約で差し替わることを
        // 直接テストで固定する(rest e2e は挙動の一部しか通らない)。
        'editor/web/src/api/rest/*.ts',
        'editor/web/src/api/repositories.ts',
```

`thresholds` に `perFile: true` を足し、コメントを 1 行添える:

```ts
      thresholds: {
        // ファイル単位で 4 指標とも 85%。全体平均だと薄いファイルが厚いファイルに隠れる。
        perFile: true,
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
```

- [ ] **Step 2: 全体を通す**

Run: `pnpm run test:coverage`(約 2.5〜3 分)
Expected: exit 0、`ERROR: Coverage …` 行 0。赤いファイルが残ったら、その行/分岐を計測結果から
特定して該当タスクのテストファイルへ追記する(このタスク内で閉じる。閾値・include は触らない)。

- [ ] **Step 3: `pnpm run ci` の前半(typecheck まで)と lint を通す**

Run: `pnpm run check:comments && pnpm run check:ci && pnpm run typecheck && pnpm exec biome check editor`
Expected: 全部 exit 0(新規テストのコメント規約・型・整形)。

- [ ] **Step 4: ドキュメント**

- `editor/README.md` のカバレッジの節: 「include 列挙 = テスト済みのみ・全指標 85%」に
  「**閾値はファイル単位**(`perFile: true`)。新規ファイルを include へ足すときは、そのファイル
  単体で 4 指標 85% を満たすテストを同時に入れる。単体の計測コマンドは
  `pnpm exec vitest run --project <p> --coverage --coverage.include='<file>' --coverage.reporter=text
  --coverage.thresholds.perFile=true <tests>`」を追記する。
- `docs/editor/src/設計正典.md` 「触る前のチェックリスト」3 項を「カバレッジは **include 列挙 =
  テスト済みのみ・ファイル単位で全指標 85% 閾値**。新規ファイルをテストしたら include へ追加し、
  そのファイル単体で 85% を満たすこと(正典は `editor/README.md`)」へ更新する。
- 設計書 10 章「計画 B2 の完了条件」の直後に実測(全体 `test:coverage` の所要秒数、include に
  足したファイル、本番コードに入れた変更 4 点: `previewHost.bundleSafeToInline` の export、
  `egressGuard` の probe 注入、`historyFiles` / `inlineDocScripts` の定数 export、`nunjucksRender`
  の到達不能分岐の除去)を 5 行以内で追記する。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write vitest.config.ts
git add vitest.config.ts editor/README.md docs/editor/src/設計正典.md docs/superpowers/specs/2026-09-06-ci-optimization-design.md
git commit -m "ci: カバレッジ閾値をファイル単位(perFile)に切り替え、routes と rest リポジトリを include へ加える"
```

---

## Self-Review

- **Spec coverage**: 8 章 1(rest 直接テスト)= Task 1。8 章 2(38 ファイルの底上げ、閾値も include
  も触らない)= Task 4〜8 + 再計測で増えた分(routes・rest・repositories)を Task 1〜3 で吸収。
  8 章 3(routes の include と 3 ルートの inject テスト)= Task 2・3・9。8 章 4(`perFile: true`)=
  Task 9。10 章の完了条件(perFile で `test:coverage` 緑・`routes/*.ts` が include)= Task 9 Step 2。
- **Placeholder scan**: 各 `it` は主張とコードを持つ。実装依存で期待値を「実物に合わせる」と書いた
  箇所(sync-status の応答、一時パスワードの文字集合、`persist` の公開名、`PREVIEW_MSG_*` の名前、
  `templateScripts` の unit 文字列、gitRepo の関数名)は、そのファイルを読めば一意に決まる値で、
  実装者の裁量ではない。
- **Type consistency**: `inSetup`(Task 1・7)は同じ形。`PortProbe` / `pickFreePortSpan(probe)` /
  `pickFreePortSpanSerialized(probe?)`(Task 5)は定義と利用が一致。`bundleSafeToInline` は
  export 名 = 既存関数名。`MAX_HISTORY_TAIL_BYTES` / `MAX_INLINE_SCRIPT_BYTES` は「未 export なら
  export」で統一。
- **本番コード変更の一覧**(Global Constraints の 2 種類に収まる): `previewHost.ts`(export)、
  `egressGuard.ts`(DI 引数の追加 + export)、`historyFiles.ts` / `inlineDocScripts.ts`(定数
  export)、`nunjucksRender.ts`(型で到達不能な分岐の除去)、`vitest.config.ts`(include / perFile)。
