# editor: DB 既定化の残置 7 件 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DB 既定化（PR #67）の最終レビューで「記録のみ」とした残置項目のうち、実害のある 6 件を直し、誤指摘 1 件を閉じる。

**Architecture:** 既存の設計を変えない小修正の集まり。各タスクは 1〜3 ファイルで閉じ、テストは既存のテストファイルへ追記する（新規テストファイルは Task 4 の認証ストアだけ）。ドキュメント修正は原稿（`docs/editor/src/`）と生成 HTML をセットでコミットする。

**Tech Stack:** TypeScript（Vue 3 / Pinia / Vitest web-dom）、Node ランチャ（`editor/e2e/tools/e2e-vite.ts`）、docs ビルド（`py -3.13 docs/_build/build_all.py`）。

**Spec:** 単独の仕様書は無い。根拠は `docs/superpowers/specs/2026-09-11-editor-db-default-design.md`（DB 既定化の設計）と、PR #67 最終レビューで残置とした所見一覧（本計画の各タスク冒頭に転記）。ユーザーの判断（2026-09-12）: goEdit は「承認待ちの申請だけを見る」、認証ストアは「テスト追加 + include 登録」、フェーズ文言は「local / rest のモード名へ置換」。

## Global Constraints

- 編集 2 系統の原則（`docs/editor/src/設計正典.md`「中核原則」）を崩さない。経路判定は `route.query.created === '1'` のみ。`created` query を出すのは `features/templates/editorRoute.ts` の `editorRoute` だけ。
- コメント規約 `docs/コメント規約.md`（なぜを書く / 経緯・日付・所見番号を書かない / 100 桁）。
- `editor/**` を変更したコミット前に `pnpm exec biome check --write editor/<対象>` を実行する（lint-staged のステージ入れ替わり事故の回避）。
- カバレッジは include 列挙 = テスト済みのみ、ファイル単位で 4 指標 85%（`vitest.config.ts`）。
- コミットメッセージは通常の日本語。末尾に `Claude-Session: https://claude.ai/code/session_01MqQNqj2QCN24jXTC7XSUmR` を付ける。
- push はしない（ユーザーが `! git push` で行う。pre-push CI が重いため）。
- `.md` の原稿は通常の日本語で書く（genshijin 圧縮を適用しない）。

---

### Task 1: e2e Vite ランチャの 3 点（procdump 出力の文字化け / `error` 未捕捉 / `--report-directory` の空白）

所見: (a) procdump は stdout に UTF-16LE を吐くが、ランチャは全 chunk を UTF-8 として `vite-*.log` と `exit-*.txt` へ書くため NUL 混じりで化ける。同じパイプに Vite（UTF-8）も流れるため、ストリーム全体を UTF-16 で読むこともできない。(b) `spawn` した子に `error` ハンドラが無く、`E2E_VITE_PROCDUMP` のパス誤り（ENOENT）は未捕捉例外で落ちてログが残らない。(c) `--report-directory=${outDir}` は `outDir` に空白があると切れる。

**Files:**
- Modify: `editor/e2e/tools/e2e-vite.ts:25-33`（`keep`）、`:43-49`（`nodeOptions`）、`:58`（`spawn` 直後）

**Interfaces:**
- Consumes: なし
- Produces: なし（ランチャは Playwright の `webServer` からしか起動されない）

このディレクトリは Vitest のどの project にも属さないため、単体テストは書けない。検証は型検査と実行で行う。

- [ ] **Step 1: chunk ごとに UTF-16LE を見分けて復号する**

`keep` を次に置き換える。

```ts
/**
 * procdump は stdout に UTF-16LE を吐き、同じパイプに Vite(UTF-8)も流れる。chunk 単位で
 * 書き手が分かれるので、奇数バイトの半分以上が NUL なら UTF-16LE として復号する
 * (ASCII 主体の UTF-16LE は 1 文字おきに NUL が並ぶ。UTF-8 の出力に NUL は現れない)。
 */
const looksUtf16le = (chunk: Buffer): boolean => {
  if (chunk.length < 2 || chunk.length % 2 !== 0) return false;
  let zeros = 0;
  for (let i = 1; i < chunk.length; i += 2) if (chunk[i] === 0) zeros += 1;
  return zeros * 2 > chunk.length / 2;
};
const keep = (chunk: Buffer): void => {
  const text = chunk.toString(looksUtf16le(chunk) ? 'utf16le' : 'utf8');
  log.write(text);
  for (const line of text.split(/\r?\n/)) {
    recent.push(line);
    if (recent.length > 200) recent.shift();
  }
};
```

- [ ] **Step 2: `--report-directory` の値を引用符で囲む**

```ts
const nodeOptions = [
  process.env.NODE_OPTIONS,
  '--report-on-fatalerror',
  // Node は NODE_OPTIONS 内の引用符を解釈する。パスに空白があっても 1 引数に保つ。
  `--report-directory="${outDir}"`,
]
  .filter(Boolean)
  .join(' ');
```

- [ ] **Step 3: `error` ハンドラを足す**

`const child = spawn(...)` の直後に追加する。

```ts
// 起動そのものの失敗(`E2E_VITE_PROCDUMP` のパス誤り = ENOENT 等)。`exit` は来ないので、
// ここで記録して終える(未捕捉のままだと例外で落ちてログが残らない)。
child.on('error', (e) => {
  const head = `[e2e-vite] spawn failed cmd=${cmd}: ${e.message}`;
  process.stderr.write(`${head}\n`);
  fs.writeFileSync(path.join(outDir, `exit-${stamp}.txt`), `${head}\n`, 'utf8');
  log.end(() => process.exit(1));
});
```

- [ ] **Step 4: 型検査**

Run: `pnpm exec tsc -p editor/tsconfig.e2e.json --noEmit`
Expected: エラー 0。

- [ ] **Step 5: 起動失敗の記録を実行で確かめる**

PowerShell:

```powershell
$env:E2E_VITE_PROCDUMP = 'C:\no\such\procdump64.exe'
node editor/e2e/tools/e2e-vite.ts --port 24699
Remove-Item Env:E2E_VITE_PROCDUMP
Get-Content (Get-ChildItem .tmp/vite-e2e/exit-*.txt | Sort-Object LastWriteTime | Select-Object -Last 1)
```

Expected: 終了コード 1、`exit-*.txt` の 1 行目が `[e2e-vite] spawn failed cmd=C:\no\such\procdump64.exe: spawn ... ENOENT`。

- [ ] **Step 6: procdump 経由の 1 回で文字化けが消えたことを確かめる**

PowerShell（2 spec だけの部分実行。3〜4 分）:

```powershell
$env:E2E_VITE_PROCDUMP = 'C:\Users\caads\workspace\.tmp\tools\procdump\procdump64.exe'
pnpm exec playwright test --config editor/playwright.config.ts --project chromium editor/e2e/smoke.spec.ts
Remove-Item Env:E2E_VITE_PROCDUMP
$log = Get-ChildItem .tmp/vite-e2e/vite-*.log | Sort-Object LastWriteTime | Select-Object -Last 1
(Get-Content $log -Raw).Contains([char]0)
Select-String -Path $log -Pattern 'ProcDump v' | Select-Object -First 1
```

Expected: `False`（NUL 無し）、`ProcDump v12.x` のバナー行が読める形で出る。Vite の `VITE v` 行も同じログに読める形で残る。

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/e2e/tools/e2e-vite.ts
git add editor/e2e/tools/e2e-vite.ts
git commit -m "fix(e2e): Vite ランチャで procdump の UTF-16 出力を復号し、起動失敗も記録し、report-directory の空白に耐える"
```

---

### Task 2: local の `resolveFilled` が `allMetas` で localStorage を毎件読む

所見: `resolveFilled` は 1 回の呼び出しで `htmlOverride` と `filledOverride` の 2 キーを `getItem` + `JSON.parse` する。`allMetas` はテンプレ N 件のループで毎回呼ぶうえ、同関数の先頭でも `htmlOverride` を読んでいるため、同じ 2 キーを 2N 回 parse する。

**Files:**
- Modify: `editor/web/src/api/local/store.ts:224-257`
- Test: `editor/web/test/localRepos.dom.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `resolveFilled(id, fileName)` の公開シグネチャは不変（`templateRepo.ts:218`・`reviewRepo.ts:73` は無改修）

- [ ] **Step 1: 失敗するテストを書く**

`localRepos.dom.test.ts` の末尾（既存の `describe` の外側）に追加する。`localTemplateRepo` は既存 import を使う。

```ts
describe('allMetas の localStorage 読み取り回数', () => {
  it('テンプレ件数に関わらず filledOverride / htmlOverride は 1 回ずつしか読まない', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    const res = await localTemplateRepo.listTemplates({});
    expect(isOk(res)).toBe(true);
    const keys = spy.mock.calls.map(([k]) => k);
    expect(keys.filter((k) => k === K.filledOverride)).toHaveLength(1); // 'editor:filled'
    expect(keys.filter((k) => k === K.htmlOverride)).toHaveLength(1); // 'editor:html'
    spy.mockRestore();
  });
});
```

`K` は `@/lib/storageKeys` から import する（`K.filledOverride` = `'editor:filled'`、`K.htmlOverride` = `'editor:html'`）。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/localRepos.dom.test.ts -t "読み取り回数"`
Expected: FAIL（件数が 1 より大きい）。

- [ ] **Step 3: オーバレイを引数で渡す内部版を作り、`allMetas` はループ外で 1 回だけ読む**

```ts
type Overlay = Record<string, string>;

/** `resolveFilled` の本体。読み込み済みのオーバレイを受け取り、ストレージを触らない。 */
function resolveFilledWith(
  id: string,
  fileName: string,
  htmlOverride: Overlay,
  filledOverride: Overlay,
): string {
  return filledOverride[id] ?? (htmlOverride[id] ? '' : (fixtureFilled[fileName] ?? ''));
}

export function resolveFilled(id: string, fileName: string): string {
  return resolveFilledWith(
    id,
    fileName,
    read<Overlay>(K.htmlOverride, {}),
    read<Overlay>(K.filledOverride, {}),
  );
}
```

`allMetas` では先頭で `filledOverride` も読み、ループ内を
`status: resolveFilledWith(id, fileName, htmlOverride, filledOverride) !== '' ? 'published' : 'draft'`
に置き換える。`resolveFilled` の doc comment（「local の『値入り HTML が在る』を決める唯一の規則」）は `resolveFilledWith` へ移し、`resolveFilled` 側は「ストレージから読んで委譲する」1 行にする。

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/localRepos.dom.test.ts editor/web/test/localReviewRepo.dom.test.ts`
Expected: PASS（既存の `status` のテストも含めて全件）。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/api/local/store.ts editor/web/test/localRepos.dom.test.ts
git add editor/web/src/api/local/store.ts editor/web/test/localRepos.dom.test.ts
git commit -m "perf(web): local の一覧が値入り HTML の有無をテンプレ件数分だけ localStorage から読み直すのをやめる"
```

---

### Task 3: rest の sample cache が配列を通す

所見: `readSampleCache` は `typeof parsed === 'object' && parsed !== null` で判定するため `"[]"` が `SampleData` として返り、作成タブが `fund.name` 等で undefined を掴む。

**Files:**
- Modify: `editor/web/src/api/rest/templateRepo.ts:30-41`
- Test: `editor/web/test/restRepos.dom.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`restRepos.dom.test.ts` の「getSampleData は同じファンドの 2 回目を sessionStorage から返し、clear で捨てる」の直後に追加する。fetch のモックと `restTemplateRepo` は同ファイルの既存の形に合わせる（既存テストがどう fetch 呼び出し回数を数えているかを読んで同じ手段を使う）。

```ts
it('getSampleData は sessionStorage に配列が入っていてもそれを返さず API から取り直す', async () => {
  sessionStorage.clear();
  sessionStorage.setItem('editor:sample:510037', '[]');
  const calls = stubFetch(() => json({ fund: { code: '510037', name: 'F' } }));
  const res = await restTemplateRepo.getSampleData('510037');
  expect(calls).toHaveLength(1);
  expect(isOk(res) && res.value).toEqual({ fund: { code: '510037', name: 'F' } });
  // 取り直した値で上書きされている(配列は残らない)。
  expect(JSON.parse(sessionStorage.getItem('editor:sample:510037') ?? 'null')).toEqual({
    fund: { code: '510037', name: 'F' },
  });
});
```

`stubFetch` / `json` は同ファイルの既存ヘルパ（直前のテストが使っている）。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/restRepos.dom.test.ts -t "配列"`
Expected: FAIL（`[]` が返る）。

- [ ] **Step 3: 述語に配列除外を足す**

```ts
    // sessionStorage は他スクリプト・拡張機能からも書き換えられうる外部入力。オブジェクトで
    // ない値(壊れた JSON・配列)を SampleData として扱うと呼び出し側が形の合わない値を掴む。
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SampleData)
      : null;
```

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/restRepos.dom.test.ts`
Expected: PASS。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/api/rest/templateRepo.ts editor/web/test/restRepos.dom.test.ts
git add editor/web/src/api/rest/templateRepo.ts editor/web/test/restRepos.dom.test.ts
git commit -m "fix(web): ファンド名キャッシュの読み取りで配列を SampleData として返さない"
```

---

### Task 4: 認証ストアのテスト追加とカバレッジ include 登録

所見: `stores/auth.ts` のテストは `reset()` の 1 本だけで、`vitest.config.ts` の include にも無い（85% ゲートの対象外）。`bootstrap` / `login` / `logout` と computed 4 つが未検証。

**Files:**
- Modify: `editor/web/test/auth.store.dom.test.ts`
- Modify: `vitest.config.ts:176`（`'editor/web/src/stores/pendingReviews.ts',` の次行に追加）

**Interfaces:**
- Consumes: `localRepositories`（fixture ユーザーは `editor/web/src/api/fixtures/users.json`。`admin/admin` は admin、`approver/approver` は approver、`editor` は `mustChangePassword: true`。password は同ファイルを読む）、`currentAppEpoch()` は `<meta name="x-app-epoch">` の `content`（未注入なら空文字）。
- Produces: なし

- [ ] **Step 1: テストを追加する**

既存の `setupStore` / `beforeEach` はそのまま使う。`beforeEach` に `document.head.querySelector('meta[name="x-app-epoch"]')?.remove();` を足し、ファイル冒頭コメントを「認証ストアの状態遷移と端末に残す痕跡」へ書き直す。追加するテスト:

```ts
function setEpoch(value: string) {
  document.head.querySelector('meta[name="x-app-epoch"]')?.remove();
  const m = document.createElement('meta');
  m.setAttribute('name', 'x-app-epoch');
  m.setAttribute('content', value);
  document.head.appendChild(m);
}

describe('useAuthStore.login()', () => {
  it('成功で user と権限 computed が立ち、authEpoch マーカーを現 epoch で書く', async () => {
    setEpoch('e1');
    const store = setupStore();
    const res = await store.login('admin', 'admin');
    expect(isOk(res) && res.value).toBe(false); // mustChangePassword
    expect(store.isAuthenticated).toBe(true);
    expect(store.isAdmin).toBe(true);
    expect(store.isApprover).toBe(true);
    expect(store.mustChangePassword).toBe(false);
    expect(localStorage.getItem('editor:authEpoch')).toBe('e1');
    expect(store.sessionEndedReason).toBeNull();
  });

  it('approver は isApprover のみ真、editor は mustChangePassword が真', async () => {
    const a = setupStore();
    await a.login('approver', 'approver');
    expect(a.isAdmin).toBe(false);
    expect(a.isApprover).toBe(true);
    await a.logout();
    const res = await a.login('editor', EDITOR_PASSWORD); // users.json の値
    expect(isOk(res) && res.value).toBe(true);
    expect(a.mustChangePassword).toBe(true);
    expect(a.isApprover).toBe(false);
  });

  it('失敗では user が null のまま err を返す', async () => {
    const store = setupStore();
    const res = await store.login('admin', 'wrong');
    expect(isOk(res)).toBe(false);
    expect(store.isAuthenticated).toBe(false);
  });
});

describe('useAuthStore.logout()', () => {
  it('Undo ミラー(現行/旧 2 種)・下書き所属・authEpoch・sample cache を消す', async () => {
    const store = setupStore();
    await store.login('admin', 'admin');
    localStorage.setItem(undoStacksKey(), '{}');
    localStorage.setItem(LEGACY_UNDO_STACKS_KEY, '{}');
    localStorage.setItem(legacyUndoStacksKeyV1(), '{}');
    localStorage.setItem(draftOwnerKey(), '{}');
    sessionStorage.setItem('editor:sample:510037', '{}');
    await store.logout();
    expect(store.user).toBeNull();
    expect(localStorage.getItem(LEGACY_UNDO_STACKS_KEY)).toBeNull();
    expect(localStorage.getItem(legacyUndoStacksKeyV1())).toBeNull();
    expect(localStorage.getItem(draftOwnerKey())).toBeNull();
    expect(localStorage.getItem('editor:authEpoch')).toBeNull();
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
  });
});

describe('useAuthStore.bootstrap()', () => {
  it('セッションがあれば user を復元し authEpoch を現 epoch へ更新する', async () => {
    setEpoch('e1');
    const first = setupStore();
    await first.login('admin', 'admin');
    const store = setupStore();
    await store.bootstrap();
    expect(store.ready).toBe(true);
    expect(store.user?.username).toBe('admin');
    expect(localStorage.getItem('editor:authEpoch')).toBe('e1');
  });

  it('未認証で前回 epoch と食い違えば sessionEndedReason を restart にしてマーカーを消す', async () => {
    setEpoch('e2');
    localStorage.setItem('editor:authEpoch', 'e1');
    const store = setupStore();
    await store.bootstrap();
    expect(store.user).toBeNull();
    expect(store.sessionEndedReason).toBe('restart');
    expect(localStorage.getItem('editor:authEpoch')).toBeNull();
  });

  it('未認証でも前回 epoch が無ければ理由は付かない', async () => {
    setEpoch('e2');
    const store = setupStore();
    await store.bootstrap();
    expect(store.sessionEndedReason).toBeNull();
  });
});
```

`undoStacksKey` は `setUndoUserScope` の現 scope を使うので、ログイン後（scope が `admin`）に値を置き、`logout()` が同じキーを消すことを確かめる（`undoStacksKey()` を logout 前に変数へ取っておき、その値を確認する）。import は `@/lib/storageKeys` と `@editor/shared`（`isOk`）。

- [ ] **Step 2: 通過を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/auth.store.dom.test.ts`
Expected: PASS（8 件）。

- [ ] **Step 3: include に登録する**

`vitest.config.ts` の `'editor/web/src/stores/pendingReviews.ts',` の次に追加する。

```ts
        // 認証セッション。退行は「前の利用者の痕跡が次の利用者へ残る / 再起動の切断理由が
        // 出ない」という共有端末での無言の形で出るため被覆に入れる。
        'editor/web/src/stores/auth.ts',
```

- [ ] **Step 4: カバレッジ閾値を確認**

Run: `pnpm run test:coverage 2>&1 | grep -E "auth\.ts|ERROR|Coverage"`
Expected: `auth.ts` の 4 指標がすべて 85 以上、閾値エラー無し。他のファイルが並行実行で下振れした場合は単独再実行で判定する（`coverage/.tmp` の衝突は既知）。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/test/auth.store.dom.test.ts
git add editor/web/test/auth.store.dom.test.ts vitest.config.ts
git commit -m "test(web): 認証ストアの login / logout / bootstrap と権限判定を検証し、カバレッジのゲートに載せる"
```

---

### Task 5: 承認タブ「編集画面へ」の第 2 根拠を承認待ちの申請に絞る

所見: `goEdit` はメタ未取得のとき `mine.some(m => m.origin === 'create')` を根拠にするが、`mine` は全状態を含むため、過去に 1 度でも作成申請があったテンプレートは `getTemplate` 失敗時に永久に作成経路（`?created=1`）で開く。決定: `status === 'pending'` に絞る。

**Files:**
- Modify: `editor/web/src/features/reviews/ReviewTabView.vue:205-214`
- Test: `editor/web/test/reviewTabView.dom.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

「対象が `status:"draft"`(pending だけ)なら…」の直後に追加する。

```ts
  it('メタが取れないとき、承認済みの作成申請しか無ければ編集経路で開く', async () => {
    editPath.value = `/edit/${encodeURIComponent(TPL)}`;
    getTemplateFn.mockResolvedValue(err(unexpected('読み取り失敗')));
    const w = await mountTab([meta({ origin: 'create', status: 'approved' })]);
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === '編集画面へ')?.trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'editor', params: { id: TPL } });
  });

  it('メタが取れないとき、承認待ちの作成申請があれば作成経路で開く', async () => {
    editPath.value = `/edit/${encodeURIComponent(TPL)}`;
    getTemplateFn.mockResolvedValue(err(unexpected('読み取り失敗')));
    const w = await mountTab([meta({ origin: 'create', status: 'pending' })]);
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === '編集画面へ')?.trigger('click');
    expect(push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: TPL },
      query: { created: '1' },
    });
  });
```

`err` / `unexpected` は同ファイルの既存 import（L317 のテストが使っている）に合わせる。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/reviewTabView.dom.test.ts -t "メタが取れないとき"`
Expected: 1 件目が FAIL（`created: '1'` 付きで push される）、2 件目は PASS。

- [ ] **Step 3: 判定を承認待ちに絞る**

```ts
function goEdit() {
  // メタ未取得(`loadParts` の応答前・取得失敗)でも申請の `origin` を第 2 の根拠にする。
  // 見るのは承認待ちだけ — 決着済みの作成申請は「承認で値入り HTML になった」か「却下で
  // 何も無い」かのどちらかで、いま作成経路で開く根拠にならない(取得失敗はテンプレートが
  // 直るまで続くので、決着済みまで見ると誤判定が固定化する)。
  // 根拠がどちらも無いときだけ編集経路へ落とす — pending だけのテンプレートを編集経路で
  // 開くと、値入り HTML が無いまま申請へ進んで server に拒否される。
  const created = targetMeta.value
    ? opensAsCreate(targetMeta.value)
    : mine.value.some((m) => m.origin === 'create' && m.status === 'pending');
  if (targetId.value) router.push(editorRoute(targetId.value, { created }));
  else router.push({ name: 'edit' });
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run --project web-dom editor/web/test/reviewTabView.dom.test.ts`
Expected: PASS（全件）。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/reviews/ReviewTabView.vue editor/web/test/reviewTabView.dom.test.ts
git add editor/web/src/features/reviews/ReviewTabView.vue editor/web/test/reviewTabView.dom.test.ts
git commit -m "fix(reviews): 「編集画面へ」の経路判定で決着済みの作成申請を根拠にしない"
```

---

### Task 6: デプロイ運用手順書・仕様一覧の「フェーズ」を local / rest のモード名へ揃える

所見: 設計書は「local / rest」のモード名で統一済みだが、手順書 5 箇所・仕様一覧 1 箇所に「フェーズ1（ローカル）/ フェーズ2（REST + SQL Server）」が残る。既定が rest になった今、段階の表現は実態と合わない。

**Files:**
- Modify: `docs/editor/src/Editor_仕様一覧.md:10`
- Modify: `docs/editor/src/デプロイ運用手順書.md:3,12,60,112,116`
- Regenerate: `docs/editor/editor_設計.html`（`build_all.py` の出力。手引き HTML は原稿に変更が無ければ byte 不変）

- [ ] **Step 1: 原稿を置き換える**

| 場所 | 置換前 | 置換後 |
|---|---|---|
| 仕様一覧 L10 | `（フェーズ2 REST + SQL Server）` | `（rest モード: REST + SQL Server）` |
| 手順書 L3 | `フェーズ2 REST + SQL Server` | `rest モード（REST + SQL Server）` |
| 手順書 L12 | `フェーズ1（ローカル）/ フェーズ2（REST + SQL Server）の両方を扱う。` | `rest モード（REST + SQL Server。既定）と local モード（fixtures + localStorage。開発用）の両方を扱う。` |
| 手順書 L60 | `# 4. SQL Server セットアップ（フェーズ2）` | `# 4. SQL Server セットアップ（rest モード）` |
| 手順書 L112 | `**REST（フェーズ2 のみ）**` | `**rest モードのみ**` |
| 手順書 L116 | `フェーズ2 では` | `rest モードでは` |

置換後に `grep -n "フェーズ" docs/editor/src/*.md` が 0 件であることを確認する。

- [ ] **Step 2: HTML を再生成し、docs テストを通す**

Run:
```
py -3.13 docs/_build/build_all.py --project editor
pnpm run test:docs
```
Expected: `editor_設計.html` が更新され、`git status` の変更は原稿 2 本 + `editor_設計.html` のみ。pytest が PASS。

- [ ] **Step 3: コミット**

```bash
git add docs/editor/src/Editor_仕様一覧.md docs/editor/src/デプロイ運用手順書.md docs/editor/editor_設計.html
git commit -m "docs(editor): デプロイ運用手順書と仕様一覧の「フェーズ」表記を local / rest のモード名へ揃える"
```

---

### Task 7: 誤指摘の閉鎖（作業なし）

所見「`docs/superpowers/specs/2026-09-12-vite-crash-findings.md:35` が 100 桁超」は誤り。L35 は 74 文字（UTF-8 で 134 バイト。バイト長を桁数と取り違えた指摘）。同ファイルで 100 文字を超えるのは表の 2 行（L74・L75）だけで、折り返すと Markdown の表が壊れる。`check:comments` の対象は `docs/<proj>/src/` に限られ、`docs/superpowers/**` は対象外。

- [ ] **Step 1: 変更しない。**（本タスクは記録のみ。台帳に「Ruling: 修正不要 — 74 文字で規約内、表の行は折り返し不可、機械検査の対象外」と書く）

---

## 最終確認（全タスク後）

- [ ] `pnpm run typecheck` が通る。
- [ ] `pnpm exec vitest run --project web-dom` が通る。
- [ ] `pnpm run test:coverage` で `auth.ts` を含めて閾値エラーが無い。
- [ ] `git log --oneline` に Task 1〜6 のコミットが 6 本並ぶ（push はユーザー）。

## 自己レビュー

- **所見の網羅**: 残置 8 項目（procdump 文字化け / `resolveFilled` / `auth.ts` 被覆 / `readSampleCache` / フェーズ文言 / `error` ハンドラ + NODE_OPTIONS / ReviewTab 判定 / findings.md 行幅）→ Task 1（3 件）・2・4・3・6・5・7 で全件に対応。
- **プレースホルダ**: Task 4 の `EDITOR_PASSWORD` は `users.json` の `editor` の `password` 値に置き換える（実装者が同ファイルを読んで確定する）。
- **型の整合**: `resolveFilledWith` の引数順（id, fileName, htmlOverride, filledOverride）を Step 3 と `allMetas` の呼び出しで一致させる。`goEdit` の戻り経路は `editorRoute` 既存シグネチャのまま。
