# editor: DB 既定化の残タスク解消 実装計画（v3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR #67（DB モード既定化 + `filled/`）のレビューで park / defer した残件を解消し、Vite 8.2.2 の e2e ネイティブ即死の原因を掴む。

**Architecture:** 3 群。B = Vite 即死の観測（ランチャで終了コード・出力・任意のダンプを残す）→ 再現の計数 → 判断ゲート。A = 正しさ・防御（pending だけの id を作成経路で開く規則を**データ（`status`）側**で 1 か所に置く、local の filled 意味論を明文化して契約を揃える、正典追記）。C = 整理。B の観測機構を先に入れ、以後のすべての e2e 実行を再現試行として数える。

**Tech Stack:** TypeScript / Vue 3 / Fastify / Vitest / Playwright / Node 24（型ストリップ既定有効）

**Spec:** 前計画の設計書 `docs/superpowers/specs/2026-09-11-editor-db-default-design.md`（不変則の正典）と本計画の「残件一覧」。反対目線レビュー（v1 → v2 → v3）の反映点は末尾「v1 からの変更」「v2 からの変更」。

## Global Constraints

- 不変則は前計画と同じ: 関所は `confirmedWrite.ts` のみ / 経路判定は `created` query と `origin` のみ / `Boolean(tpl.filled)` の文書は nunjucks・`toTemplate` を通さない / local 資源は削除しない。
- コメント規約 `docs/コメント規約.md`（なぜを書く・経緯や日付を書かない・100 桁。幅は全角 = 2 で数える。`check:comments` は幅を検査しないので自分で数える）。
- `editor/**` 変更コミット前に `pnpm exec biome check --write <対象>`。`.bat` は CRLF、日本語 `.ps1` は BOM。
- 新規スクリプトは TypeScript。実行は Node 24 の型ストリップ（`node <file>.ts`、erasable な構文のみ: enum / namespace / parameter property を使わない）か、server の `tsx`。新規 `.mjs` / `.ps1` は作らない。**devDependency を増やさない**（lockfile 変更 = オフラインバンドル再 publish）。
- コミットメッセージは通常の日本語、末尾に `Claude-Session: https://claude.ai/code/session_01MqQNqj2QCN24jXTC7XSUmR`。1 タスク 1 コミット。コミット後は `git log --oneline -3` で実在確認。
- テスト: `pnpm exec vitest run --project server|web-dom|web-node <file>`、型は `pnpm typecheck:editor`。e2e はポート 24680/24681 が空いているとき（`node scripts/check-ports.mjs 24680 24681`）だけ、1 度に 1 プロセス。**e2e を走らせたら毎回、結果（緑 / Vite 死亡）を `.tmp/vite-e2e/RUNS.md` に 1 行追記する**（Task 7 の計数）。
- 実 DB・実 dataRoot に触れない。

## 残件一覧（出所 = 前計画の ledger / 最終レビュー）

| # | 群 | 内容 | 対応タスク |
|---|---|---|---|
| A1 | A | `ReviewTabView.vue:196`「編集へ」と `PreviewView.vue:169` の BackButton fallback が作成経路の id を編集経路で開く | Task 2 |
| A2 | A | 設計正典に「編集経路の申請は `filled/` の存在を要求する」「pending だけの id は作成経路で開く」が未記載 | Task 5 |
| A3 | A | `reviews.test.ts:288` のコメント「申請の作成前に拒否」を assert が検証していない | Task 4 |
| A4 | A | `routeGuards.ts:146` が 100 幅超（全角 2 幅で 118。機械検査対象外） | Task 4 |
| A5 | A | local の `status` が `fixtureTemplates` の有無で決まり、rest の「`filled/` の有無」と一致しない。機械検証も無い | Task 3 |
| A6 | A | local に「edit 申請は filled 必須」の門が無い | Task 3 |
| B1 | B | Vite 8.2.2 が e2e 中に exit 0xC0000409 で即死（16 回中 7 回、地点は移動、warmup 無効、死ぬ前に Vite は 1 行も出さない） | Task 1, 6, 7 |
| C1 | C | `historyRepo.ts` の `TEMPLATES_PATHSPEC` / `templateRel` / `templateFilesOf` が `filled` を指す | Task 8 |
| C2 | C | `listTemplateFiles` が dead export | Task 8 |
| C3 | C | `server/src/repositories/templateRepo.ts` が coverage include 外 | Task 8 |
| C4 | C | `playwright.config.ts` の API ポート 24680 が 3 箇所ハードコード | Task 1 |
| C6 | C | `readFilledHtml` の非 ENOENT throw が `ioFailurePolicy.test.ts` に無い | Task 8 |
| C7 | C | `auth.ts` の `reset()`（401）で sample キャッシュを消さない | Task 9 |
| C8 | C | `readSampleCache` に形状検査が無い | Task 9 |
| C9 | C | `ReviewDetail.vue:302` の `filledHtml !== undefined` と `Boolean()` の不一致（`filledHtml: ''` は描画中・描画失敗の申請で到達する） | Task 9 |
| C10 | C | `mergePdfService.ts` の `conflict` ラップ重複（108 / 126） | Task 9 |
| C11 | C | `putContentOverrides` の read/write 重複 | Task 9 |
| C12 | C | 旧「フェーズ 1 / フェーズ 2 / Phase2」表記 | Task 10 |
| C13 | C | e2e の `rm -rf` が閉じかけのハンドルと競合しうる（実測無し） | Task 1（`fs.rm` の再試行オプション） |
| D1 | 見送り | ペア同期の状態ファイルを target で分けない | Task 5（理由を正典へ） |
| D2 | 見送り | 編集タブバナーが `templates/` 側の競合を出さない | Task 5（理由を正典へ） |
| — | 落とした | `generate.routes.test.ts:154` の `templatesDir` 書込削除（主張に無関係な churn） | なし |
| — | 落とした | rest↔local 契約一致テスト（v1 Task 4。rest 側は fetch スタブで検証不能） | Task 3 に吸収 |

---

## Stage B-1: Vite 即死の観測機構（最初に入れる）

### Task 1: Vite ランチャ + API ポート配線 + `fs.rm` の再試行

**Files:**
- Create: `editor/e2e/tools/e2e-vite.ts`（Node 24 の型ストリップで直接実行。`tsconfig.e2e.json` の `include` に `e2e/**/*.ts` が入っているので型検査対象になる）
- Modify: `editor/playwright.config.ts`（webServer 2 本、`E2E_REST_PORT` の配線）
- Modify: `editor/server/scripts/e2e-rest-seed.ts:22`
- Modify: `editor/README.md`（e2e 節に 2 行）
- Verify: `knip.json`（ランチャが未使用扱いにならないか。`pnpm knip` が `ci` に無いなら確認のみ）

**Interfaces:**
- Produces: `node editor/e2e/tools/e2e-vite.ts --port <n>` が Vite を**Node 直接**（`process.execPath` + `vite/bin/vite.js`）で子プロセス起動し、stdout/stderr を素通ししつつ `<repoRoot>/.tmp/vite-e2e/vite-<stamp>.log` にも写す。終了コードが 0 以外なら `exit-<stamp>.txt` に `code / hex / 直前 200 行` を残す。環境変数 `RUST_BACKTRACE=full` と `NODE_OPTIONS` に `--report-on-fatalerror --report-directory=<dir>` を足す。`E2E_VITE_PROCDUMP=<procdump.exe のパス>` が設定されているときは `procdump -accepteula -e -ma -x <dir> node.exe vite.js …` の形で起動する（クラッシュダンプ採取。未設定なら従来どおり）。
- `E2E_REST_PORT` を `playwright.config.ts` で import し `apiUrl` として `url` / `API_PROXY_TARGET` / コメントに使う。root `package.json:18` の `check-ports.mjs 24680 24681` と `capture_docs.spec.ts:6` のコメントは据え置き（`check-ports` は既定値の事前検査で、env で変えた場合は呼び出し側が引数も変える。コメントに 1 行書く）。

- [ ] **Step 1: ランチャを書く**

```ts
// =============================================================================
// e2e-vite.ts — e2e 用 Vite dev サーバのランチャ(即死時の観測)
// =============================================================================
// Vite 8 が e2e の途中で exit 0xC0000409(ネイティブ側の即死)で落ちる事象があり、Playwright の
// webServer からは終了コードしか見えない。pnpm を挟むと reporter の出力が混ざり終了コードの
// 出所も曖昧になるため、Node で `vite/bin/vite.js` を直接起動する。出力はファイルにも写し、
// 異常終了のときだけ終了コードと直前の出力を残す。Rust 製ネイティブ部品の panic hook を
// 通る失敗は `RUST_BACKTRACE` で stderr に出る。hook を通らない即死はクラッシュダンプでしか
// 追えないので、`E2E_VITE_PROCDUMP` が指すときは procdump 経由で起動する。
// Playwright は Windows で `taskkill /T /F` により終了させるため、シグナル転送は持たない。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const webDir = path.join(repoRoot, 'editor', 'web');
const outDir = path.join(repoRoot, '.tmp', 'vite-e2e');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(outDir, `vite-${stamp}.log`);
const log = fs.createWriteStream(logPath);
const recent: string[] = [];
const keep = (chunk: Buffer): void => {
  const text = chunk.toString('utf8');
  log.write(text);
  for (const line of text.split(/\r?\n/)) {
    recent.push(line);
    if (recent.length > 200) recent.shift();
  }
};

const viteBin = createRequire(path.join(webDir, 'package.json')).resolve('vite/bin/vite.js');
const nodeOptions = [process.env.NODE_OPTIONS, '--report-on-fatalerror', `--report-directory=${outDir}`]
  .filter(Boolean)
  .join(' ');
const env = { ...process.env, RUST_BACKTRACE: 'full', NODE_OPTIONS: nodeOptions };
const viteArgs = [viteBin, ...process.argv.slice(2)];
const procdump = process.env.E2E_VITE_PROCDUMP;
// 配列リテラルの分割代入は tuple に推論されないので型を明示する(`tsc -p tsconfig.e2e.json`)。
const [cmd, args]: [string, string[]] = procdump
  ? [procdump, ['-accepteula', '-e', '-ma', '-x', outDir, process.execPath, ...viteArgs]]
  : [process.execPath, viteArgs];

const child = spawn(cmd, args, { cwd: webDir, env, stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (c: Buffer) => {
  process.stdout.write(c);
  keep(c);
});
child.stderr.on('data', (c: Buffer) => {
  process.stderr.write(c);
  keep(c);
});
child.on('exit', (code, signal) => {
  const hex = code === null ? '-' : `0x${(code >>> 0).toString(16).toUpperCase()}`;
  // procdump 経由のときの `code` は procdump 自身のもので、Vite の即死は伝播しない。実体は
  // `.dmp` の有無と procdump の出力(`Exception: C0000409` / `Dump 1 complete`)で判定するため、
  // procdump 使用時は終了コードに関わらず記録を残す。直前の出力は chunk 境界で行が割れる
  // ことがあり、末尾 200 行は目安。procdump のバナー行も混ざる。
  const head = `[e2e-vite] exit code=${code} (${hex}) signal=${signal} procdump=${Boolean(procdump)} log=${logPath}`;
  process.stderr.write(`${head}\n`);
  if (code !== 0 || procdump) {
    fs.writeFileSync(
      path.join(outDir, `exit-${stamp}.txt`),
      `${head}\n--- last output (目安。chunk 境界で行が割れうる) ---\n${recent.join('\n')}\n`,
      'utf8',
    );
  }
  log.end(() => process.exit(code ?? 1));
});
```

- [ ] **Step 2: `playwright.config.ts`**

`import { E2E_REST_PORT, E2E_REST_WEB_PORT } from './server/scripts/e2e-rest-paths';`、`const apiUrl = \`http://127.0.0.1:${E2E_REST_PORT}\`;`。webServer の `url: \`${apiUrl}/api/health\``、`API_PROXY_TARGET: apiUrl`、Vite の `command: \`node e2e/tools/e2e-vite.ts --port ${E2E_REST_WEB_PORT}\``（`cwd` は既存どおり `editor/`）。コメントに「ランチャ経由で即死時の情報を `.tmp/vite-e2e/` に残す」「`check-ports.mjs` の引数は既定値のまま」を書く。

- [ ] **Step 3: `e2e-rest-seed.ts:22`**

`await fs.rm(E2E_REST_DATA_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });` + コメント「Windows では閉じかけのハンドルで EBUSY/EPERM/ENOTEMPTY になるので一過性のロックだけ待つ（テスト終了後にサーバが書き終える順序は解かない）」。

- [ ] **Step 4: README**

`editor/README.md` の e2e 節に: 「Vite はランチャ `editor/e2e/tools/e2e-vite.ts` 経由で起動し、異常終了時は `.tmp/vite-e2e/exit-*.txt` に終了コードと直前の出力が残る。`E2E_VITE_PROCDUMP=<procdump.exe>` を設定するとクラッシュダンプも採る。」

- [ ] **Step 5: 確認** — `pnpm typecheck:editor`（`tsconfig.e2e.json` がランチャを型検査する）、`pnpm exec biome check --write editor/e2e editor/playwright.config.ts editor/server/scripts`、`pnpm run test:e2e` 1 回（`[e2e-vite] exit code=…` が出る。`RUNS.md` に記録）。`pnpm knip` があれば実行して未使用警告が無いこと。

- [ ] **Step 6: コミット** — `test(e2e): Vite を Node 直起動のランチャで包み、異常終了時の情報を残す。API ポートを共有定数から引く`

---

### Task 1b: ダンプ採取と読解の道具（ユーザー承認済み: procdump / WinDbg とも導入可）

- [ ] procdump: `https://download.sysinternals.com/files/Procdump.zip` を `<repoRoot>/.tmp/tools/procdump/` に展開（git 管理外）。`procdump64.exe -accepteula -?` が動くことを確認。以後の e2e は `E2E_VITE_PROCDUMP=<repoRoot>/.tmp/tools/procdump/procdump64.exe` を呼び出し元シェルで設定して走らせる（`RUNS.md` に「procdump あり」と記す）。
- [ ] WinDbg: `winget install Microsoft.WinDbg`（Store 版）。入らなければ `cdb` を含む Windows SDK Debugging Tools を候補にし、どちらも無理なら「`.dmp` のヘッダから faulting module 名だけ読む」に留めて報告する。
- [ ] 読み方の手順を `docs/superpowers/specs/2026-09-12-vite-crash-findings.md` の冒頭に書く: `windbg -z <dmp>` → `!analyze -v` → `FAULTING_MODULE` / `STACK_TEXT` を控える。
- [ ] コミット対象なし（道具は git 管理外）。README の e2e 節に「ダンプ採取は procdump、読解は WinDbg」の 1 行を Task 1 の追記へ足す。

---

## Stage A: 正しさ・防御

### Task 2: pending だけの id を作成経路で開く規則を 1 か所にする（A1）

**Files:**
- Create: `editor/web/src/features/templates/editorRoute.ts`
- Modify: `editor/web/src/features/templates/EditTabView.vue:46-51`（既存の inline 規則を `editorRouteFor` に置換）
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue:164-170, 196`（`loadParts` で取った `tpl.meta` を ref に保持し `goEdit` で使う）
- Modify: `editor/web/src/features/preview/PreviewView.vue:169`（`origin` から `created` を復元して fallback に渡す）
- Test: `editor/web/test/editorRoute.test.ts`（新規・web-node）、`editor/web/test/reviewTabView.dom.test.ts`（draft メタの push を主張する 1 ケース追加。既存の完全一致主張は `query` を付けないので無傷）
- Modify: `vitest.config.ts`（coverage include に `editor/web/src/features/templates/editorRoute.ts` を追加。単体で 4 指標 85% 以上）

**Interfaces:**
- Produces（2 関数。`status` と `origin` を混ぜない）:
  - `editorRoute(id: string, opts: { created: boolean }): RouteLocationRaw` = `{ name: 'editor', params: { id }, ...(opts.created ? { query: { created: '1' } } : {}) }` — 編集画面への遷移で `created` query を出す**唯一の場所**。
  - `opensAsCreate(meta: Pick<TemplateMeta, 'status'>): boolean` = `meta.status === 'draft'` — 「pending だけの id（作成経路の産物）は作成経路で開く」の判定。doc: 「編集経路で開くと値入り HTML が無いまま申請へ進み server の `assertFilledPresentForEdit` で拒否される。経路判定は `created` query のみ、という原則は変えず、その query を出す規則をここに集める。」
  - 呼び出し: EditTabView / ReviewTabView は `editorRoute(m.id, { created: opensAsCreate(m) })`、PreviewView は `editorRoute(id, { created: origin === 'create' })`（プレビューは route query に `origin` を持つので `status` を経由しない）。

- [ ] **Step 1: テスト** — `editorRoute.test.ts`: `editorRoute('x', { created: false })` → query なし / `{ created: true }` → `created:'1'`、`opensAsCreate({ status: 'draft' })` → true / `'published'` → false。`reviewTabView.dom.test.ts`: 既存の `template()` ヘルパは `Partial<Template>` を受けるので `getTemplateFn.mockResolvedValue(ok(template({ meta: { ...template().meta, status: 'draft' } })))` の形で draft を返し、`loadParts` は非同期（`watch(targetId, loadParts, { immediate: true })`）なので click 前に `await flushPromises()`（同ファイル 172-181 行の流儀）。主張: 「編集へ」の push が `{ name:'editor', params:{id}, query:{created:'1'} }`。
- [ ] **Step 2: 実装** — `ReviewTabView.vue`: `const targetMeta = ref<TemplateMeta | null>(null)` を `loadParts` で設定。`goEdit` は `router.push(editorRoute(targetId.value, { created: targetMeta.value ? opensAsCreate(targetMeta.value) : mine.value.some((m) => m.origin === 'create') }))` — メタ未取得（`loadParts` 前のクリック）でも申請一覧の `origin` を第 2 の根拠にし、pending だけの id を編集経路で開かない。`PreviewView.vue:169`: `:fallback="editorRoute(id, { created: origin === 'create' })"`。
- [ ] **Step 3: 確認** — web-dom / web-node、`pnpm typecheck:editor`、`pnpm exec playwright test -c editor/playwright.config.ts --project=chromium review_tab.spec.ts create.spec.ts`（RUNS.md に記録）
- [ ] **Step 4: コミット** — `fix(web): pending だけのテンプレートを開く導線を作成経路へ送る規則を 1 か所にまとめる`

---

### Task 3: local の filled 意味論を決めて契約を揃える（A5, A6）

**Step 0（設計判断。実装前に確定）**: local の「値入り HTML がある」は `resolveFilled(id, fileName) = filledOverride[id] ?? (htmlOverride[id] ? '' : (fixtureFilled[fileName] ?? ''))`（現行 `getTemplate` の式）で定義する。作成承認（`htmlOverride`）後に `filledOverride` が無い id は「filled 無し = `draft`」。rest では `filled/` の旧ファイルが残れば `published` のままなので、この点は**意図的に違う**（local は別ツールが `filled/` を置く運用を持たないため）。Task 5 で正典に記録する。

**Files:**
- Modify: `editor/web/src/api/local/store.ts`（`resolveFilled` を export、`allMetas` の `status` を **`resolveFilled(id, fileName) !== '' ? 'published' : 'draft'` だけから導く**。META（`saved`）の `status` は読まない（`updatedAt` / `updatedBy` のみ使う）。現行は `saved?.status ?? (…)` で保存済み status が優先され、`publishMeta` が origin を問わず `published` を書くため、作成承認後も `published` のままになる）
- Modify: `editor/web/src/api/local/templateRepo.ts:70-74` `publishMeta`（`status` を書かない。`updatedAt` / `updatedBy` だけにする）
- Modify: `editor/web/test/localRepos.dom.test.ts:114` 付近（confirm 後 `status === 'published'` を主張するケースの origin を確認し、`create` origin なら期待値を `draft` に直す。`edit` origin なら `published` のまま）
- Modify: `editor/web/src/api/local/templateRepo.ts:223-224`（inline 式を `resolveFilled` に置換）
- Modify: `editor/web/src/api/local/reviewRepo.ts` `submitReview`（`origin==='edit' && resolveFilled(...) === ''` なら `validation`。**store を直接読む**（`getTemplate` 経由にしない — `localReviewRepo.dom.test.ts:85-104` は `getTemplate` を notFound にモックして申請が通ることを主張している））
- Test: `editor/web/test/localReviewRepo.dom.test.ts`（edit + filled 無し → `validation`）、`editor/web/test/localRepos.dom.test.ts`（create 承認後の id が `draft` になる / edit 承認後は `published` のまま）、`editor/web/test/twoSystems.guard.test.ts`（`fixtures/templates` と `fixtures/filled` のファイル名集合が一致する — local の既定 fixture が rest の「filled があるものだけ一覧」と同じ集合を出す前提を固定）

- [ ] **Step 1: 失敗するテスト → Step 2: 実装 → Step 3: `pnpm exec vitest run --project web-dom --project web-node`、`pnpm typecheck:editor`**
- [ ] **Step 4: コミット** — `feat(web): local 実装の値入り HTML の有無を 1 つの規則にし、draft 判定と編集経路の申請拒否を server に揃える`

---

### Task 4: テストの主張とコメント幅の是正（A3, A4。Task 5 と同じコミットでもよい）

- [ ] `editor/server/test/reviews.test.ts:288-289`: 「申請が作られない」は `reviews.listReviews({}, approver)` の結果に `templateId === tplId` の行が無いことで主張する（申請ディレクトリ名は reqId で templateId を含まない）。
- [ ] `editor/server/src/routes/routeGuards.ts:146`: 全角 2 幅で 100 以内に折り返す（意味は変えない。`biome check` はコメントを再整形しないので手で折り、実行後に戻っていないことを確認）。
- [ ] 確認: `pnpm exec vitest run --project server editor/server/test/reviews.test.ts`
- [ ] コミット: `test(server): 編集経路の申請拒否で申請が作られないことを主張し、コメント幅を規約に揃える`

---

### Task 5: 設計正典の追記（A2, D1, D2, Task 3 Step 0）

**Files:** `docs/editor/src/設計正典.md`（中核原則「編集 2 系統」`:61-66`、「してはならないこと・却下済み設計」）

- [ ] 中核原則に追記（通常の日本語）:
  - 「`status:'draft'`（pending だけの id）は作成経路（`?created=1`）で開く。`created` query を出す規則は `features/templates/editorRoute.ts` の `editorRoute`、pending の判定は同ファイルの `opensAsCreate` で、一覧・承認タブ・プレビューの戻る導線が共用する。」
  - 「編集経路（`origin='edit'`）の申請・承認は `filled/<id>.html` の存在を要求する（server `assertFilledPresentForEdit`、local は `resolveFilled`）。」
  - 「local の値入り HTML の有無は `resolveFilled`（`filledOverride` → 作成承認済みなら無し → fixture）で決める。作成承認後に旧 `filled/` が残る rest とは意図的に違う（local は別ツールの配置運用を持たない）。」
- [ ] 却下済み設計に 2 項: ペア同期の状態ファイルを `filled/` と `templates/` で分けない（両方にあるのは作成承認直後の短期間で、混在は競合→スキップの fail-safe。分けると JSON 形式変更と移行が要る）/ 編集タブのバナーに `templates/` 側の競合を出さない（バナーは値入り HTML のペアの有無を見る。`templates/` 側はその版種自身の承認時に扱う）。
- [ ] `py -3.13 docs/_build/build_all.py --project editor`、`pnpm run test:docs`。コミット: `docs(editor): pending の開き方・編集経路の filled 必須・local の filled 意味論と見送り理由を設計正典に書く`

---

## Stage C: 整理

### Task 8: server の整理（C1, C2, C3, C6）

- [ ] `historyRepo.ts:29-43`: `TEMPLATES_PATHSPEC`→`FILLED_PATHSPEC`、`templateRel`→`filledRel`、`templateFilesOf`→`filledFilesOf`（呼び出し 5 箇所も。他ファイル・テストからの参照は無い）。
- [ ] `files/templateFiles.ts:63` `listTemplateFiles` を削除（呼び出し無し。`confirmedWrite.guard.test.ts:88` の検査には影響しない）。
- [ ] `vitest.config.ts` include に `editor/server/src/repositories/templateRepo.ts` を追加し、`pnpm exec vitest run --project server --coverage --coverage.include='**/repositories/templateRepo.ts'` で 4 指標 ≥ 85% を確認（route テストの sproc フェイク経由も数えられる。不足なら `templateRepo.filled.test.ts` に不足分岐のケースを足す）。
- [ ] `ioFailurePolicy.test.ts`: `readFilledHtml` 版の 2 ケース（規約外は空文字 / EISDIR は throw）。
- [ ] `pnpm typecheck:editor`。コミット: `refactor(server): 版履歴の識別子を filled に合わせ、未使用 export を消し、templateRepo を被覆ゲートに入れる`

---

### Task 9: web の整理（C7〜C11）

- [ ] `stores/auth.ts` `reset()` に `clearSampleDataCache()`（コメント: 401 の後に別利用者がログインしうる）。既存の auth ストアテストに「reset で `editor:sample:*` が消える」を足す。
- [ ] `api/rest/templateRepo.ts` `readSampleCache`: `typeof parsed === 'object' && parsed !== null` でなければ null。`restRepos.dom.test.ts` に壊れた JSON → 再取得の 1 ケース。
- [ ] `ReviewDetail.vue:301-302`: `const html = filledHtml || afterBodyHtml.value; … renderPdf(html, cssAfter.value, {}, false, Boolean(filledHtml))`。コメント: 「`filledHtml` が空文字の申請（描画中・描画失敗のまま申請）は差分由来の本文を隔離描画する」。
- [ ] `mergePdfService.ts` `renderOne`: `const fail = (cause: unknown) => err(conflict(\`テンプレート${nth}のレンダリングに失敗しました。\`, { cause }))` で 2 分岐を共用。
- [ ] `api/local/templateRepo.ts` `putContentOverrides`: `const key = req.origin === 'edit' ? K.filledOverride : K.htmlOverride;` で 1 本化（コメントは残す）。
- [ ] `pnpm exec vitest run --project web-dom --project web-node`、`pnpm typecheck:editor`。コミット: `refactor(web): 401 リセットでもサンプル名を捨て、キャッシュの形状検査と重複した分岐を整理する`

---

### Task 10: 表記の整理（C12）

- [ ] `editor/README.md:23`、`editor/CONTRIBUTING.md:71`、`docs/editor/src/設計書.md:21,53,85,181,205,739` の「フェーズ 1 / フェーズ 2 / Phase2」を「local（開発用）/ rest（既定。SQL Server）」の語へ（205 行の「同じ Repository 契約」の説明は残す）。`py -3.13 docs/_build/build_all.py --project editor`、`pnpm run test:docs`、`pnpm run check:comments`。
- [ ] コミット: `docs(editor): フェーズ番号での呼び分けを rest / local の語に揃える`

---

## Stage B-2: 再現の計数と判断

### Task 6: 再現の計数

- [ ] Task 1 以降のすべての e2e 実行（Task 2・3 の spec 実行、Task 11 の CI）を `.tmp/vite-e2e/RUNS.md` に記録。合計が 6 回未満なら `pnpm run test:e2e` を追加実行して 6 回にする（緑でも続ける）。
- [ ] 各実行で `Start-Job { Get-Counter '\Memory\Available MBytes','\Memory\Committed Bytes','\Memory\% Committed Bytes In Use' -SampleInterval 5 -MaxSamples 120 | Export-Counter -Path <csv> -FileFormat CSV }` を**並走**させ（前景で回すと 10 分ブロックする）CSV に残す。値の整形は `[long]`（Committed Bytes は `[int]` で溢れる）（割当失敗はコミット枯渇で起きる。物理 7.67 GB・空き 1.8 GB の端末で、node.exe の `RADAR_PRE_LEAK_64` が WER に記録された実績あり）。
- [ ] 落ちた回は `exit-*.txt` / `report*.json` / procdump の `.dmp`（設定時）/ メモリ CSV を揃える。

### Task 7: 切り分けと判断（ユーザーゲート）

- [ ] 切り分け:
  - stderr に `panicked at`（rolldown / oxc-resolver / lightningcss / tailwind oxide のどれか）→ そのモジュールのバグ。対象ファイルが判れば構文回避を試す。
  - Node 診断レポート（`FATAL ERROR:` が stderr に出る）→ `javascriptStack` / `nativeStack` から特定。
  - 無音死 + ダンプあり → faulting module 名（`.node` のどれか）で判断。
  - 無音死 + ダンプ無し → メモリ CSV の相関（コミット枯渇なら資源起因）。
- [ ] 所見を `docs/superpowers/specs/2026-09-12-vite-crash-findings.md` に書き、対策を提示して**ユーザーの選択を待つ**:
  - (a) Vite 7 系へ固定 — 依存上は可能（`@vitejs/plugin-vue@6.0.8` / `@tailwindcss/vite@4.3.3` / `vitest@4.1.11` の peer 範囲は `^7` を含む）が、vitest は自前の vite を解決するため lockfile に 7 と 8 が併存し、オフラインバンドルの再 publish が要る。**消えるのは rolldown / oxc だけ**で lightningcss・tailwind oxide は残る。faulting module が判るまでは賭け。
  - (b) 回避策（構文・設定）。
  - (c) `test:e2e` を Vite 死亡（ランチャの exit ≠ 0 かつ `ERR_CONNECTION_REFUSED` 連発）に限って 1 回再実行するラッパ（`editor/e2e/tools/` の TS を node で。`playwright.config.ts:31` の `retries: 0` の理由「flake を隠さない」と整合させ、条件を狭く書く）。
- [ ] 選択後のタスクは別途起こす。

---

### Task 11: CI と PR

- [ ] `pnpm run ci`（前半後半を分けてよい。e2e は Vite 死亡なら 1 回再実行し、両方を RUNS.md と報告に書く）。
- [ ] PR #67 へ積む。GH の `verify` が緑であること。

## v1 からの変更（反対目線レビューの反映）

- Task 1（旧）→ Task 2: 承認タブに `created` query は来ない（`resolveReviewTarget` が作成経路を意図的に除く）ため、規則を `status:'draft'` ベースの純関数 `editorRouteFor` に集約。ソース走査テストを捨て、振る舞いテスト（`reviewTabView.dom.test.ts` の draft ケース）へ。
- Task 6（旧）→ Task 1: pnpm を挟まず Node 直起動（`[WebServer] undefined` は pnpm reporter の産物で Vite は無音）。`tsx` 追加を避け Node 24 の型ストリップで実行。シグナル転送と `--report-on-signal` を削除（Playwright は `taskkill /T /F`）。異常終了時のみ記録。procdump の任意経路と、ダンプ道具の有無をユーザー確認事項に。ポート配線と `fs.rm` の再試行を同じコミットへ。
- Task 3: `hasFilled` を `getTemplate` と同じ式（`htmlOverride` を含む）にし、`resolveFilled` として store に 1 つ置く。門は store を直接読む（既存モックテストを壊さない）。rest との意味の違いを Step 0 で決め正典に記録。
- Task 4（旧・契約一致テスト）を削除し Task 3 に吸収。
- Task 2（旧）→ Task 4: 申請の非生成は `listReviews` で主張。A4 は全角 2 幅で 118 と明記。
- Task 9（旧）の自作再試行ループ → `fs.rm` の `maxRetries` / `retryDelay`。C5（templatesDir 書込削除）は落とす。
- Task 7: 3 択に lockfile / 残るネイティブ部品の注記、メモリはコミット系カウンタも記録。
- 実行順: B-1 → ユーザー確認 → A → C → B-2 → CI。

## v2 からの変更（2 回目の反対目線レビューの反映）

- M1: ランチャの `[cmd, args]` に tuple 型注釈（`tsconfig.e2e.json` の型検査で落ちる）。
- M2: local の `status` は `resolveFilled` だけから導き、`publishMeta` は `status` を書かない。`localRepos.dom.test.ts:114` の期待値を origin に合わせて見直す。
- M3: procdump 経由では終了コードが procdump のものになるため、procdump 使用時は常に `exit-*.txt` を書き、判定は `.dmp` と procdump の出力で行う。
- S1: `editorRouteFor(meta)` を `editorRoute(id, { created })` + `opensAsCreate(meta)` の 2 関数に分け、`origin` を偽の `status` に写さない。
- S2: 承認タブでメタ未取得のときは申請一覧の `origin === 'create'` を第 2 の根拠にする。
- S3: `editorRoute.ts` を coverage include へ。
- S4: `reviewTabView.dom.test.ts` の draft ケースの組み方（`template({ meta: {...} })` + `flushPromises`）を明記。
- N1〜N3: メモリ計測は `Start-Job` で並走・`[long]`、直前出力の chunk 境界と procdump バナーを注記。
- ユーザー承認を受け、procdump と WinDbg の導入を Task 1b として計画に入れた。
