# editor: DB 既定化の残タスク解消 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR #67（DB モード既定化 + `filled/`）のレビューで park / defer した残件を解消し、Vite 8.2.2 の e2e ネイティブ即死の原因を掴む。

**Architecture:** 3 群に分ける。A = 正しさ・防御（作成経路の query 落ち、契約の機械検証、正典追記）、B = Vite 即死の原因調査（Vite をランチャで包んでクラッシュ情報を残し、対策を決める）、C = 整理（識別子・dead export・被覆・重複・表記）。A と C は小さな独立コミットに束ね、B は調査 → 判断 → 対策の 3 段。

**Tech Stack:** TypeScript / Vue 3 / Fastify / Vitest / Playwright / tsx

**Spec:** 前計画の設計書 `docs/superpowers/specs/2026-09-11-editor-db-default-design.md`（不変則の正典）と、本計画冒頭の「残件一覧」。

## Global Constraints

- 不変則は前計画と同じ: 関所は `confirmedWrite.ts` のみ / 経路判定は `created` query と `origin` のみ / `Boolean(tpl.filled)` の文書は nunjucks・`toTemplate` を通さない / local 資源は削除しない。
- コメント規約 `docs/コメント規約.md`（なぜを書く・経緯や日付を書かない・100 桁）。
- `editor/**` 変更コミット前に `pnpm exec biome check --write <対象>`。`.bat` は CRLF、日本語 `.ps1` は BOM。
- 新規スクリプトは TypeScript（`tsx` 実行）。新規 `.mjs` / `.ps1` は作らない（チーム方針）。
- コミットメッセージは通常の日本語、末尾に `Claude-Session: https://claude.ai/code/session_01MqQNqj2QCN24jXTC7XSUmR`。1 タスク 1 コミット。コミット後は `git log --oneline -3` で実在確認。
- テスト: `pnpm exec vitest run --project server|web-dom|web-node <file>`、型は `pnpm typecheck:editor`。e2e はポート 24680/24681 が空いているとき（`node scripts/check-ports.mjs 24680 24681`）だけ、1 度に 1 プロセス。
- 実 DB・実 dataRoot に触れない。

## 残件一覧（出所 = 前計画の ledger / 最終レビュー）

| # | 群 | 内容 | 対応タスク |
|---|---|---|---|
| A1 | A | `ReviewTabView.vue:196`「編集へ」と `PreviewView.vue:169` の BackButton fallback が `?created=1` を落とす | Task 1 |
| A2 | A | 設計正典に「編集経路の申請は `filled/` の存在を要求する」が未記載 | Task 5 |
| A3 | A | `reviews.test.ts:288` のコメント「申請の作成前に拒否」を assert が検証していない | Task 2 |
| A4 | A | `routeGuards.ts:146` が 100 桁超 | Task 2 |
| A5 | A | rest と local の `status==='draft'` ⇔「filled 無し」の一致に機械検証が無い（local は `fixtureTemplates` の有無で判定） | Task 3 |
| A6 | A | local に「edit 申請は filled 必須」の門が無い | Task 3 |
| B1 | B | Vite 8.2.2 が e2e 中に exit 0xC0000409 で即死（16 回中 7 回、地点は移動、warmup 無効） | Task 6, 7 |
| C1 | C | `historyRepo.ts` の `TEMPLATES_PATHSPEC` / `templateRel` / `templateFilesOf` が `filled` を指す | Task 8 |
| C2 | C | `listTemplateFiles` が dead export | Task 8 |
| C3 | C | `server/src/repositories/templateRepo.ts` が coverage include 外 | Task 8 |
| C4 | C | `playwright.config.ts` の API ポート 24680 が 3 箇所ハードコード（`E2E_REST_PORT` 未配線） | Task 9 |
| C5 | C | `generate.routes.test.ts:154` の `templatesDir` 書込が一覧には無効（残置） | Task 8 |
| C6 | C | `readFilledHtml` の非 ENOENT throw が `ioFailurePolicy.test.ts` に無い | Task 8 |
| C7 | C | `auth.ts` の `reset()`（401）で sample キャッシュを消さない | Task 10 |
| C8 | C | `readSampleCache` に形状検査が無い | Task 10 |
| C9 | C | `ReviewDetail.vue:302` の `filledHtml !== undefined` と `Boolean()` の不一致 | Task 10 |
| C10 | C | `mergePdfService.ts` の `conflict` ラップ重複（108 / 126） | Task 10 |
| C11 | C | `putContentOverrides` の read/write 重複 | Task 10 |
| C12 | C | 旧「フェーズ 1 / フェーズ 2 / Phase2」表記（`editor/README.md:23`、`CONTRIBUTING.md:71`、`設計書.md:21,53,85,181,205,739`） | Task 11 |
| C13 | C | e2e の `rm -rf` がサーバ書込と競合しうる（実測無し） | Task 9（再試行を足す） |
| D1 | 見送り | ペア同期の状態ファイルを target で分けない | Task 5（理由を正典へ） |
| D2 | 見送り | 編集タブバナーが `templates/` 側の競合を出さない | Task 5（理由を正典へ） |

---

## Stage A: 正しさ・防御

### Task 1: 作成経路の query を落とす 2 導線を直す

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue:196`
- Modify: `editor/web/src/features/preview/PreviewView.vue:169`
- Test: `editor/web/test/twoSystems.guard.test.ts`（ソース走査を 1 件追加）

**Interfaces:**
- Produces: 編集画面へ遷移する導線はすべて `route.query.created` を引き継ぐ（`EditorView.vue:220-223` と同じ形）。

- [ ] **Step 1: 失敗するテストを書く**

`twoSystems.guard.test.ts` の describe `'editor 2系統の原則: rest 経路の値入り HTML'` に足す:

```ts
  it('編集画面へ戻る導線は created query を引き継ぐ(承認タブ・プレビュー)', () => {
    const review = read('features/reviews/ReviewTabView.vue');
    expect(review).toMatch(/name: 'editor', params: \{ id: targetId\.value \}, query: createdQuery/);
    const preview = read('features/preview/PreviewView.vue');
    expect(preview).toMatch(/:fallback="\{ name: 'editor', params: \{ id \}, query: createdQuery \}"/);
  });
```

- [ ] **Step 2: 失敗を確認する** — `pnpm exec vitest run --project web-node editor/web/test/twoSystems.guard.test.ts` → FAIL

- [ ] **Step 3: 実装する**

`ReviewTabView.vue`: `targetId` の近くに次を足し、196 行を `router.push({ name: 'editor', params: { id: targetId.value }, query: createdQuery.value })` にする。

```ts
// 承認タブが対象にしているテンプレートが作成経路(`?created=1`)で開かれたものなら、編集へ
// 戻る導線もその query を引き継ぐ。落とすと編集経路として開き直され、値入り HTML の無い
// pending 実体を編集経路で申請する形になる(サーバは拒否するが、画面が先に迷わせない)。
const createdQuery = computed(() => (route.query.created === '1' ? { created: '1' } : {}));
```

（`route` が未 import なら `useRoute()` を足す。承認タブは `?template=<id>` で来るので、`created` は編集タブの直前画面（`tabMemory`）から取れないことがある。その場合は `resolveReviewTarget.ts` が返す対象に `created` を含めるよう拡張し、同じ値を使う。どちらにしたかを報告に書く。）

`PreviewView.vue:169`: `:fallback="{ name: 'editor', params: { id }, query: createdQuery }"`。`createdQuery` は既存の `origin` 算出（`route.query.created === '1'`）の隣に `const createdQuery = computed(() => (origin.value === 'create' ? { created: '1' } : {}));` を置く。

- [ ] **Step 4: 通ることを確認する** — 同テスト PASS、`pnpm typecheck:editor`、`pnpm exec playwright test -c editor/playwright.config.ts --project=chromium review_tab.spec.ts create.spec.ts`（ポート空き時）

- [ ] **Step 5: コミット** — `fix(web): 承認タブとプレビューから編集へ戻る導線が created query を引き継ぐ`

---

### Task 2: テストの主張とコメント長の是正

**Files:**
- Modify: `editor/server/test/reviews.test.ts:288-289`
- Modify: `editor/server/src/routes/routeGuards.ts:146`

- [ ] **Step 1: `reviews.test.ts`**

288〜289 行を次にする（`countPendingReviews` は `reviewFiles.ts` の export。無ければ `fs.readdirSync(path.join(tmp, 'reviews'))` の件数を前後で比べる）:

```ts
    // 拒否は申請の作成前に起きる(未処理の申請が増えない)。
    expect(fs.existsSync(path.join(tmp, 'reviews'))
      ? fs.readdirSync(path.join(tmp, 'reviews')).filter((d) => d.includes(tplId)).length
      : 0).toBe(0);
```

（申請ディレクトリ名が reqId(UUID)で templateId を含まない場合は、`listReviews({}, approver)` に `templateId === tplId` の行が無いことを主張する形にする。）

- [ ] **Step 2: `routeGuards.ts:146`** を 100 桁以内に折り返す（意味は変えない）。

- [ ] **Step 3: 確認** — `pnpm exec vitest run --project server editor/server/test/reviews.test.ts`、`pnpm run check:comments`

- [ ] **Step 4: コミット** — `test(server): 編集経路の申請拒否で申請が作られないことを主張し、コメント長を規約に揃える`

---

### Task 3: local 実装の契約一致（draft 判定・filled 必須門）

**Files:**
- Modify: `editor/web/src/api/local/store.ts:239`
- Modify: `editor/web/src/api/local/reviewRepo.ts`（`submitReview` / 承認）
- Test: `editor/web/test/localReviewRepo.dom.test.ts`、`editor/web/test/twoSystems.guard.test.ts`

**Interfaces:**
- Produces: local の `status` は `fixtureFilled[fileName] || filledOverride[id]` があれば `published`、無ければ `draft`（rest の「`filled/` にあるものが published」と同じ意味）。local の `submitReview` は `origin==='edit'` かつ filled が無い id を `validation` で拒否する。

- [ ] **Step 1: 失敗するテストを書く**

`localReviewRepo.dom.test.ts` に:

```ts
  it("origin='edit' の申請は filled が無い id を validation で拒否する(server と同じ契約)", async () => {
    const id = 'AM01_510037_20991231_交付版'; // fixture に無い id
    const res = await localReviewRepo.submitReview({ templateId: id, html: '<p>x</p>', css: '', fundCode: '510037', origin: 'edit' });
    expect(isErr(res) && res.error.kind).toBe('validation');
  });
```

`twoSystems.guard.test.ts` に「fixtures/templates と fixtures/filled のファイル名集合が一致する」を足す（一致しないと local の draft 判定が rest とずれる）:

```ts
  it('fixtures/templates と fixtures/filled は同じファイル名集合(local の draft 判定を rest と揃える前提)', () => {
    const dir = (p: string) => fs.readdirSync(path.resolve(__dirname, '../src/api/fixtures', p)).filter((f) => f.endsWith('.html')).sort();
    expect(dir('filled')).toEqual(dir('templates'));
  });
```

- [ ] **Step 2: 失敗を確認する** — web-dom / web-node の該当ファイル

- [ ] **Step 3: 実装する**

`store.ts:239`: `status: saved?.status ?? (fixtureFilled[fileName] || filledOverride[id] ? 'published' : 'draft')`（`filledOverride` は `read<Record<string,string>>(K.filledOverride, {})` で取る。コメントを「rest と同じく値入り HTML の有無で決める」に直す）。

`reviewRepo.ts` `submitReview`: 先頭で `if (req.origin === 'edit' && !hasFilled(req.templateId)) throw validation('編集タブの申請には値入り HTML(filled)が必要です: ' + req.templateId)`。`hasFilled` は `fixtureFilled[fileName] || filledOverride[id]`（`templateRepo.ts` に既にある判定を export して使う。重複させない）。

- [ ] **Step 4: 通ることを確認する** — `pnpm exec vitest run --project web-dom --project web-node`、`pnpm typecheck:editor`

- [ ] **Step 5: コミット** — `feat(web): local 実装の draft 判定と編集経路の申請拒否を server の契約に揃える`

---

### Task 4: rest↔local の契約一致の機械検証

**Files:**
- Test: `editor/web/test/repositoryContract.dom.test.ts`（新規）

- [ ] **Step 1: テストを書く** — 同じ入力に対し local と rest（`fetch` スタブ）が同じ `status` / 同じ拒否を返すことを 2 ケースで固定する:
  1. `listTemplates` の `status`: local の fixture 一覧で `published` になる id 集合 = `fixtures/filled` のファイル名集合。
  2. `submitReview(origin:'edit', filled 無し)`: local は `validation`、rest は `apiFetch` へ届く前に… ではなく server が 400 を返す形なので、rest 側は `server/test/reviews.routes.test.ts` の既存ケース（Task 2 で確認）に委ね、ここでは local の拒否だけを主張しつつコメントで rest 側テストの場所を指す。

- [ ] **Step 2: 通す・コミット** — `test(web): local と rest の status と申請拒否の契約が一致することを固定する`

---

### Task 5: 設計正典の追記（A2, D1, D2）

**Files:**
- Modify: `docs/editor/src/設計正典.md`（中核原則「編集 2 系統」の箇条書き `:61-66`、「してはならないこと・却下済み設計」）

- [ ] **Step 1: 追記**（通常の日本語・簡潔）

中核原則に 1 文: 「編集経路（`origin='edit'`）の申請と承認は `filled/<id>.html` の存在を要求する（無ければ `validation`）。pending だけの id は作成経路（`?created=1`）で開く。導線（一覧・承認タブ・プレビューの戻る）はすべて `created` query を引き継ぐ。」

却下済み設計に 2 項:
- 「ペア同期の状態ファイル（`sync/<pairKey>.json`）を `filled/` と `templates/` で分ける」: しない。同じペアが両方にあるのは作成タブ承認直後の短期間だけで、混在しても両側変更→競合→スキップの fail-safe に倒れる。分けると JSON 形式の変更と移行が要る。
- 「編集タブのバナーに `templates/` 側の同期競合を出す」: しない。バナーは値入り HTML のペアの有無を見る。`templates/` 側の競合はその版種自身の承認時に扱う。

- [ ] **Step 2: ビルド・コミット** — `py -3.13 docs/_build/build_all.py --project editor`、`pnpm run test:docs`。`docs(editor): 編集経路の filled 必須と、ペア同期状態・バナーの見送り理由を設計正典に書く`

---

## Stage B: Vite 即死の原因調査

### Task 6: Vite をランチャで包み、クラッシュ情報を残す

**Files:**
- Create: `editor/web/scripts/e2e-vite.ts`
- Modify: `editor/playwright.config.ts:75`（`command`）
- Modify: `editor/web/package.json`（`"e2e:vite": "tsx scripts/e2e-vite.ts"` を追加。`tsx` は server と同じ devDependency を使う）

**Interfaces:**
- Produces: `pnpm --filter web run e2e:vite -- --port <n>` が `vite --port <n>` を子プロセスで起動し、stdout/stderr を素通ししつつ `<repoRoot>/.tmp/vite-e2e/vite-<timestamp>.log` にも書き、終了時に `exit code / signal / 直前 200 行` を `crash-<timestamp>.txt` に残す。環境変数 `RUST_BACKTRACE=full`、`NODE_OPTIONS=--report-on-fatalerror --report-on-signal --report-directory=<repoRoot>/.tmp/vite-e2e`（既存の `NODE_OPTIONS` があれば連結）を子に渡す。

- [ ] **Step 1: 実装する**

```ts
// =============================================================================
// e2e-vite.ts — e2e 用 Vite dev サーバのランチャ(クラッシュ情報の採取)
// =============================================================================
// Vite 8 が e2e の途中で exit 0xC0000409(ネイティブ即死)で落ちる事象があり、Playwright の
// webServer からは終了コードしか見えない。子プロセスとして起動し、出力をファイルにも写し、
// 終了時に終了コード・シグナル・直前の出力を残す。Rust 製ネイティブ部品の panic を stderr へ
// 出させるため RUST_BACKTRACE を立て、Node 側の致命エラーは診断レポートに残す。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webDir, '..', '..');
const outDir = path.join(repoRoot, '.tmp', 'vite-e2e');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(outDir, `vite-${stamp}.log`);
const log = fs.createWriteStream(logPath);
const recent: string[] = [];
const keep = (chunk: Buffer) => {
  const text = chunk.toString('utf8');
  log.write(text);
  for (const line of text.split(/\r?\n/)) {
    recent.push(line);
    if (recent.length > 200) recent.shift();
  }
};
const nodeOptions = [process.env.NODE_OPTIONS, '--report-on-fatalerror', '--report-on-signal', `--report-directory=${outDir}`]
  .filter(Boolean)
  .join(' ');
const child = spawn('pnpm', ['exec', 'vite', ...process.argv.slice(2)], {
  cwd: webDir,
  env: { ...process.env, RUST_BACKTRACE: 'full', NODE_OPTIONS: nodeOptions },
  shell: process.platform === 'win32',
  stdio: ['inherit', 'pipe', 'pipe'],
});
child.stdout.on('data', (c: Buffer) => { process.stdout.write(c); keep(c); });
child.stderr.on('data', (c: Buffer) => { process.stderr.write(c); keep(c); });
child.on('exit', (code, signal) => {
  const summary = `exit code=${code} signal=${signal} hex=${code === null ? '-' : `0x${(code >>> 0).toString(16).toUpperCase()}`}\n--- last output ---\n${recent.join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, `crash-${stamp}.txt`), summary, 'utf8');
  process.stderr.write(`[e2e-vite] ${summary.split('\n')[0]} (log: ${logPath})\n`);
  log.end(() => process.exit(code ?? 1));
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
```

`playwright.config.ts:75` の `command` を `` `pnpm --filter web run e2e:vite -- --port ${E2E_REST_WEB_PORT}` `` にし、コメントで「ランチャ経由でクラッシュ情報を `.tmp/vite-e2e/` に残す」と書く。`.tmp/` は既に gitignore 済みか確認する。

- [ ] **Step 2: 動作確認** — `pnpm run test:e2e` を 1 回。`[e2e-vite] exit code=…` が出ること、`.tmp/vite-e2e/` にログが出ること。

- [ ] **Step 3: コミット** — `test(e2e): Vite をランチャで包み、即死時の終了コード・出力・診断レポートを残す`

---

### Task 7: 再現と原因の切り分け（判断ゲート）

- [ ] **Step 1: 再現** — `pnpm run test:e2e` を最大 6 回（緑でも続ける）。落ちた回の `crash-*.txt` / `report*.json` / `vite-*.log` 末尾を集める。
- [ ] **Step 2: 切り分け（落ちた回の情報で分岐）**
  - stderr に Rust panic（`thread '...' panicked` / rolldown / oxc）が出た → rolldown/oxc のバグ。パニック位置（対象ファイル）を特定し、そのファイルの構文を回避できるか（例: 特定の正規表現リテラルや TS 構文）を試す。回避不能なら Vite 7 系固定案へ。
  - Node 診断レポートが出た（V8 側の致命エラー）→ `javascriptStack` / `nativeStack` から原因モジュールを特定。
  - どちらも無く即死だけ → 外部要因（メモリ / AV）を疑い、`Get-Counter '\Memory\Available MBytes'` を並走記録して相関を見る。
- [ ] **Step 3: 判断（ユーザー確認）** — 結果を `docs/superpowers/specs/2026-09-12-vite-crash-findings.md` に書き、対策を 3 択で提示する: (a) Vite 7 系へ固定（依存変更 → `local-only/offline-publish` でバンドル再 publish）、(b) 回避策（設定・構文）、(c) `test:e2e` ラッパで Vite 死亡時だけ 1 回再実行。**ユーザーの選択を待って** Stage B を閉じる（選択後のタスクは別途起こす）。

---

## Stage C: 整理

### Task 8: server の整理（C1, C2, C3, C5, C6）

**Files:**
- Modify: `editor/server/src/repositories/historyRepo.ts:29-43`（`TEMPLATES_PATHSPEC`→`FILLED_PATHSPEC`、`templateRel`→`filledRel`、`templateFilesOf`→`filledFilesOf`。呼び出し 5 箇所も追随）
- Modify: `editor/server/src/files/templateFiles.ts:63`（`listTemplateFiles` を削除）
- Modify: `vitest.config.ts`（include に `editor/server/src/repositories/templateRepo.ts` を追加。`templateMeta.ts` の隣）
- Modify: `editor/server/test/generate.routes.test.ts:154`（`templatesDir` への書込を削除し、コメントを「一覧の確定判定は filled/ 走査」だけにする）
- Modify: `editor/server/test/ioFailurePolicy.test.ts`（`readFilledHtml` 版の 2 ケース: 規約外は空文字 / EISDIR は throw）

- [ ] **Step 1: 実装・テスト** — `pnpm exec vitest run --project server --coverage --coverage.include='**/repositories/templateRepo.ts'` で `templateRepo.ts` の 4 指標が 85% 以上であることを確認（不足なら `templateRepo.filled.test.ts` に `getDropdownOptions` / `listSeriesFunds` / `saveDraft` 系のケースを足す）。`pnpm typecheck:editor`。
- [ ] **Step 2: コミット** — `refactor(server): 版履歴の識別子を filled に合わせ、未使用 export を消し、templateRepo を被覆ゲートに入れる`

---

### Task 9: e2e の整理（C4, C13）

**Files:**
- Modify: `editor/playwright.config.ts:62-79`（`E2E_REST_PORT` を import し `apiUrl = \`http://127.0.0.1:${E2E_REST_PORT}\`` を `url` / `API_PROXY_TARGET` / コメントに使う）
- Modify: `editor/server/scripts/e2e-rest-seed.ts:22`（`fs.rm` を最大 5 回・200ms 間隔で再試行。`EBUSY` / `EPERM` / `ENOTEMPTY` のときだけ）

```ts
async function rmWithRetry(target: string): Promise<void> {
  // Windows では直前テストの autosave など、まだ閉じていないハンドルがあると rm が
  // EBUSY/EPERM/ENOTEMPTY で失敗する。数百 ms 待てば閉じるので、その種類だけ再試行する。
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
```

- [ ] **Step 1: 実装・確認** — `pnpm typecheck:editor`、`pnpm run test:e2e` 1 回（ポート空き時）
- [ ] **Step 2: コミット** — `test(e2e): API ポートを共有定数から引き、dataRoot 削除を一過性のロックで再試行する`

---

### Task 10: web の整理（C7, C8, C9, C10, C11）

**Files:**
- Modify: `editor/web/src/stores/auth.ts` `reset()`（`clearSampleDataCache()` を呼ぶ。コメント: 401 の後に別利用者がログインしうる）
- Modify: `editor/web/src/api/rest/templateRepo.ts` `readSampleCache`（`typeof parsed === 'object' && parsed !== null` を確認、違えば null）
- Modify: `editor/web/src/features/reviews/ReviewDetail.vue:301-302`（`const html = filledHtml || afterBodyHtml.value; … renderPdf(html, cssAfter.value, {}, false, Boolean(filledHtml))` — 空文字の `filledHtml` は「描画失敗の申請」なので差分由来へ倒す）
- Modify: `editor/web/src/features/merge/services/mergePdfService.ts`（`renderOne` の 2 分岐で共通の `const fail = (cause: unknown) => err(conflict(\`テンプレート${nth}のレンダリングに失敗しました。\`, { cause }))` を使う）
- Modify: `editor/web/src/api/local/templateRepo.ts` `putContentOverrides`（`const key = req.origin === 'edit' ? K.filledOverride : K.htmlOverride;` で 1 本化）
- Test: `restRepos.dom.test.ts`（壊れた JSON は無視して再取得する 1 ケース）、`auth` ストアのテスト（reset で `editor:sample:*` が消える）

- [ ] **Step 1: 実装・テスト** — `pnpm exec vitest run --project web-dom --project web-node`、`pnpm typecheck:editor`
- [ ] **Step 2: コミット** — `refactor(web): 401 リセットでもサンプル名を捨て、キャッシュの形状検査と重複した分岐を整理する`

---

### Task 11: 表記の整理（C12）

**Files:**
- Modify: `editor/README.md:23`、`editor/CONTRIBUTING.md:71`、`docs/editor/src/設計書.md:21,53,85,181,205,739`

- [ ] **Step 1: 書き換え** — 「フェーズ 1 / フェーズ 2 / Phase2」を「local（開発用）/ rest（既定。SQL Server）」の語へ。設計書 205 行の「同じ Repository 契約」の説明は残す。ビルド `py -3.13 docs/_build/build_all.py --project editor`、`pnpm run test:docs`、`pnpm run check:comments`。
- [ ] **Step 2: コミット** — `docs(editor): フェーズ番号での呼び分けを rest / local の語に揃える`

---

### Task 12: CI とレビュー

- [ ] `pnpm run ci`（前半後半を分けてよい。e2e は Vite 死亡なら 1 回再実行し、結果を報告に書く）
- [ ] PR #67 へ積む（ブランチは同じ）。GH の `verify` が緑になることを確認。

## 自己点検

- 残件一覧の全行に対応タスクがある（D1/D2 は正典への記録）。Task 7 だけはユーザー判断で終わる（設計上の分岐点）。
- 新規スクリプトは TypeScript（`e2e-vite.ts`）。`.mjs` / `.ps1` は増やさない。
- 型・シグネチャ: `E2E_REST_PORT` / `E2E_REST_WEB_PORT` は `e2e-rest-paths.ts` の既存 export。`clearSampleDataCache` は前計画で export 済み。`K.filledOverride` は前計画で追加済み。
