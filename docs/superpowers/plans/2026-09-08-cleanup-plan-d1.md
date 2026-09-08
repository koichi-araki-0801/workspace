# 後始末 計画 D1(守りを実際に効かせる)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計画 A〜C2 が繰り越した軽微項目のうち、「守りがあるように見えて実際には効いていない」4 件を
実効化する。差分採点の申告漏れを機械で捕まえる自己検査モード、負荷下で落ちる e2e のログイン待ち、
実時間に依存した git lock の検証、そして中継の応答終端が直った今なら書けるハング検出。

**Architecture:** どれも既存の仕組みへ小さく足す。自己検査は開発時フラグで差分と全走査を突き合わせて
throw する(本番経路には分岐を増やさない)。e2e は待ち条件を状態待ちへ寄せる。git lock は実時間の窓を
観測に置き換える。中継は専用センチネルで client timeout を他のエラーと区別する。

**Tech Stack:** TypeScript 6 / vitest 4.1.11 / @playwright/test 1.62 / Node 24

**Spec:** なし(繰り越し項目の消化)。出典は各計画の台帳と最終レビュー。関連する設計は
`docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md`(§6 等価性の検証)と
`docs/pie-chart/src/設計正典.md`(採点の節)。

## Global Constraints

- **pie-chart の SVG 出力はバイト不変**: `pnpm --filter pie-chart run batch` →
  `pnpm --filter pie-chart run batch:diff` で 83 件が byte 一致。ゴールデン
  (`renderHashExpected.ts` 26 行、`final_score.snap`、`mark_flags.snap`)も不変。
- **本番の既定経路に分岐を増やさない**: Task 1 の自己検査は環境変数で有効化する形にし、
  既定(未設定)では 1 度の真偽判定だけで抜ける。対判定ループの内側に分岐を足さない。
- **e2e は `retries: 0` のまま**。固定待ち(`waitForTimeout`)を新たに足さない。
- **コメント規約**(`docs/コメント規約.md`): 日本語散文で「なぜ」を書く。日付・所見番号・
  経緯・計画名やコミット ID は書かない。識別子はバッククォート。
- **コミット**: 日本語のメッセージ、末尾に
  `Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF`。`git add` は明示
  ファイルのみ(同一 checkout で別セッションが作業していることがある)。post-commit フックが
  push と pre-push CI(8〜10 分)を走らせる。amend / rebase はしない。
- **重いジョブを重ねない**: `batch` / vitest / e2e の前に
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vitest|playwright|ci-affected' }`
  で他ジョブが無いことを確かめる。

---

### Task 1: 差分採点の自己検査モード

**Files:**
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(`measureRepairVecDelta`)
- Test: `pie-chart/test/diff_scoring.test.ts`(自己検査が食い違いを捕まえることの固定)

**Interfaces:**
- Consumes: `measureRepairVecDelta(base, placements, cfg, coord, changed)`、
  `measureRepairVecFrom(placements, cfg, coord, geo)`、`collectLeaderGeometry(placements, cfg, coord)`
  (すべて既存)。
- Produces: 環境変数 `PIE_CHART_VERIFY_DELTA=1` のとき、差分の戻り値と全走査の戻り値が
  食い違えば `Error` を投げる。既定では何もしない。

差分採点の正しさは「`changed` に動いた index が漏れなく載っていること」に懸かっている。今これを
守っているのは実サンプル 83 件のバイト比較だけで、**サンプルに出ない配置**で申告が漏れても気づけない。
`verify/consistency.ts` が scorer と emit の一致を独立に確かめているのと同じ形の網を足す。

- [ ] **Step 1: 失敗するテストを書く**

`pie-chart/test/diff_scoring.test.ts` の末尾へ:

```ts
describe('自己検査モード', () => {
  it('PIE_CHART_VERIFY_DELTA=1 のとき、changed の申告漏れを検出して投げる', () => {
    const cfg = createPieLayoutConfig({});
    const { placements, coord } = makePlacements(syntheticCases().gen_long_12_other, cfg);
    const base = buildScoreBase(placements, cfg, coord);
    // 2 件動かしたのに 1 件しか申告しない = 申告漏れそのもの。
    placements[0].leaderBend = { x: 8, y: 8 };
    placements[1].leaderBend = { x: -8, y: -8 };
    vi.stubEnv('PIE_CHART_VERIFY_DELTA', '1');
    expect(() => measureRepairVecDelta(base, placements, cfg, coord, [0])).toThrow(
      /差分採点が全走査と一致しません/,
    );
    vi.unstubAllEnvs();
  });

  it('既定(環境変数なし)では申告漏れでも投げない(本番経路の費用を増やさない)', () => {
    const cfg = createPieLayoutConfig({});
    const { placements, coord } = makePlacements(syntheticCases().gen_long_12_other, cfg);
    const base = buildScoreBase(placements, cfg, coord);
    placements[0].leaderBend = { x: 8, y: 8 };
    placements[1].leaderBend = { x: -8, y: -8 };
    expect(() => measureRepairVecDelta(base, placements, cfg, coord, [0])).not.toThrow();
  });
});
```

`vi` / `createPieLayoutConfig` / `buildScoreBase` / `makePlacements` / `syntheticCases` は同ファイルの
既存 import と helper を使う(`vi` が未 import なら足す)。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/diff_scoring.test.ts`
Expected: 1 件目が FAIL(投げない)、2 件目は PASS。

- [ ] **Step 3: 自己検査を足す**

`measureRepairVecDelta` の戻り値を組み立てた後、返す直前へ:

```ts
  const out = { /* 既存の 9 フィールド */ };
  // 差分の正しさは「`changed` に動いた index が漏れなく載っていること」に懸かっており、
  // 漏れは出力バイトを静かに変える。実サンプルのバイト比較では、サンプルに出ない配置の
  // 漏れを捕まえられない。開発時にだけ全走査と突き合わせ、食い違いを即座に落とす。
  if (process.env.PIE_CHART_VERIFY_DELTA === '1') {
    const full = measureRepairVecFrom(placements, cfg, coord, collectLeaderGeometry(placements, cfg, coord));
    for (const k of Object.keys(out) as (keyof RepairVec)[]) {
      if (out[k] !== full[k]) {
        throw new Error(
          `差分採点が全走査と一致しません: ${k} が ${String(out[k])} と ${String(full[k])} で食い違います`,
        );
      }
    }
  }
  return out;
```

`out` を先に組み立てる形へ書き換える(現在は `return { … }` で直接返している)。**フィールドの
式と順序は変えない**(FP の値が変わる)。全走査へ落ちる分岐(`!base.usable ||
changed.length >= placements.length`)はこの検査より前でそのまま返してよい(そちらは定義上一致する)。

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/diff_scoring.test.ts`
Expected: 全件 PASS。

- [ ] **Step 5: 自己検査を有効にして実サンプルを 1 周する**

Run(PowerShell):
```powershell
$env:PIE_CHART_VERIFY_DELTA='1'; pnpm --filter pie-chart run batch; Remove-Item Env:PIE_CHART_VERIFY_DELTA
```
Expected: 83 件が例外なく生成される。**ここで投げたら本物の申告漏れ**なので、どのサンプル・
どのフィールドかを報告して止める(直すのは別タスク)。時間は通常の 2 倍強かかる。

- [ ] **Step 6: バイト不変と全テスト**

Run: `pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff && pnpm exec vitest run --project pie-chart`
Expected: 83 件 byte 一致、全テスト緑(環境変数なしの通常経路で走ることを確認)。

- [ ] **Step 7: 設計正典へ 1 行**

`docs/pie-chart/src/設計正典.md` の採点の節、差分採点の項の末尾へ:

```markdown
  申告漏れは出力を静かに変えるため、`PIE_CHART_VERIFY_DELTA=1` で差分と全走査を突き合わせて
  食い違いを投げる自己検査を持つ(既定は無効。`batch` をこのフラグ付きで 1 周させると
  実サンプル全件で申告を検査できる)。
```

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write pie-chart/src/svg_export/emit_repair.ts pie-chart/test/diff_scoring.test.ts
git add pie-chart/src/svg_export/emit_repair.ts pie-chart/test/diff_scoring.test.ts docs/pie-chart/src/設計正典.md
git commit -m "test(pie-chart): 差分採点の申告漏れを開発時に検出する自己検査モードを足す"
```

---

### Task 2: 承認 e2e のログイン待ちを状態待ちにする

**Files:**
- Modify: `editor/e2e/helpers.ts`(`login`)

**Interfaces:**
- Consumes: `login(page, user)`(既存。`/login` へ遷移し `#u` の可視化を待つ)。
- Produces: 変更なし(待ち方だけ変わる)。

`pnpm run ci` の中でカバレッジ段の直後に e2e が走ると、`approve.spec` の `login` が
`#u` の可視化を 30 秒待って落ちることがある。単独実行とフル e2e 単独では 2 回連続で全件緑なので、
負荷で SPA の初期化が遅れているだけ。待ち条件を「入力欄が現れる」から「ログイン画面として
操作できる」へ寄せ、明示 timeout を与える。

- [ ] **Step 1: 待ち条件を変える**

`editor/e2e/helpers.ts` の `login` の `await page.locator('#u').waitFor();` を:

```ts
  // 全体 CI ではカバレッジ段の直後に走るため、SPA の初期化が既定の 30 秒に収まらないことがある。
  // 待つのは「入力欄が DOM に出た」ではなく「ログイン画面として操作できる」状態にする。
  await page.locator('#u').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'ログイン' })).toBeEnabled({ timeout: 60_000 });
```

`expect` が未 import なら `@playwright/test` から足す。

- [ ] **Step 2: 単独で確認する**

Run: `node scripts/check-ports.mjs 24680 24681 && pnpm exec playwright test -c editor/playwright.config.ts --project=chromium editor/e2e/approve.spec.ts`
Expected: 1 passed。

- [ ] **Step 3: 全体 e2e で確認する**

Run: `pnpm run test:e2e`
Expected: 36 passed。

- [ ] **Step 4: 負荷下で確認する**

Run: `pnpm run ci`
Expected: exit 0(この計画の主目的。もし別の spec が落ちたらその spec 名と失敗内容を報告する。
`ci` は 6 分前後かかる)。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write editor/e2e/helpers.ts
git add editor/e2e/helpers.ts
git commit -m "test(e2e): ログイン待ちを操作可能状態まで広げ、全体 CI の負荷で落ちないようにする"
```

---

### Task 3: git lock の検証から実時間の窓を外す

**Files:**
- Modify: `editor/server/test/gitRepo.test.ts`(index.lock のリトライ検証)

**Interfaces:**
- Consumes: `git.commitAll(message, author)`、`INDEX_LOCK_RETRY_DELAYS_MS = [200, 400, 800, 1600]`
  (`src/git/gitRepo.ts`)。
- Produces: 変更なし。

現在は「250 ミリ秒待って `settled === false` を確かめてから lock を外す」形。遅いマシンほど
観測しやすい方向なので退行はしないが、待ちの長さが実装のリトライ間隔に依存している。lock ファイルが
**実際に開かれた回数**を観測する形へ寄せる。

- [ ] **Step 1: 観測に置き換える**

lock ファイルの mtime やアクセスは移植性が低いので、「commit が完了していないこと」を短い間隔で
複数回確かめる形にする(1 回の長い待ちを、短い確認の繰り返しに変える)。

```ts
  it('index.lock が居る間は待ち、外れれば commit が通る(共有違反リトライ)', async () => {
    const rel = 'templates/AM01_999999_20250110_交付版.html';
    fs.writeFileSync(path.join(tmp, rel), '<p>lock retry</p>', 'utf8');
    const lockFile = path.join(tmp, '.git', 'index.lock');
    fs.writeFileSync(lockFile, '');
    let settled = false;
    const commit = git.commitAll('確定保存: lock retry', { name: 'tester' });
    void commit.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    // lock が居るあいだは完了しないことを、短い間隔で繰り返し確かめる。1 回の長い待ちだと
    // 「たまたまその瞬間だけ未完了だった」と区別できない。
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);
    }
    fs.rmSync(lockFile, { force: true });
    const hash = await commit;
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.commitFiles(hash)).toContain(rel);
  }, 10_000);
```

`git.commitFiles` は既存 export(`gitRepo.ts`)。

- [ ] **Step 2: 単独で確認する**

Run: `pnpm exec vitest run --project server editor/server/test/gitRepo.test.ts`
Expected: 全件 PASS(18 件前後)。

- [ ] **Step 3: 繰り返して安定を見る**

Run: `pnpm exec vitest run --project server editor/server/test/gitRepo.test.ts --repeat 3`
Expected: 3 周とも PASS。`--repeat` が使えない版なら 3 回続けて実行する。

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write editor/server/test/gitRepo.test.ts
git add editor/server/test/gitRepo.test.ts
git commit -m "test(editor): index.lock のリトライ検証を短い確認の繰り返しへ変えて実時間依存を薄くする"
```

---

### Task 4: 中継のハング検出を戻す

**Files:**
- Modify: `editor/server/test/egressGuard.test.ts`(上流切断のテスト)

**Interfaces:**
- Consumes: `startFakeBuild` / `stopFakeBuild`(同ファイルの既存 helper)、
  `egressGuard.ts` の中継(上流の `aborted` / `error` を購読して応答を終端する。修正済み)。
- Produces: 変更なし。

中継が上流の途中切断で応答を終端しなかった欠陥は修正済み。当時は「ハングしない」を主張できず
テスト名を「502 へ書き換えない」に留めたが、今は client 側 timeout を専用センチネルにすれば
**ハングを実際に落とせる**。引き継ぎ資料
(`C:\Users\caads\AppData\Local\Temp\claude\C--Users-caads-workspace\42727383-4438-4f5b-b104-b021d61ae72d\scratchpad\planC1-task5-egressGuard-handover.md`)に
当時のコード片がある。

- [ ] **Step 1: センチネルを入れ、名前を戻す**

```ts
  it('上流がヘッダ送信後に切れても 502 へ書き換えず、応答を閉じる(ハングしない)', async () => {
    // client 側 timeout はハングの唯一の観測手段なので、他の失敗と型で区別する。
    // 中継が上流の途中切断を購読していなかった頃は、ここが必ず timeout になっていた。
    const CLIENT_TIMEOUT = Symbol('client timeout');
    // …既存の request 組み立て…
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(CLIENT_TIMEOUT);
      });
    // …
    expect(outcome).not.toBe(CLIENT_TIMEOUT);
    expect(outcome instanceof Error || (outcome as { status: number }).status === 200).toBe(true);
```

`Promise` の型引数へ `| typeof CLIENT_TIMEOUT` を足す。既存のコメント(なぜ client timeout が
起きうるかの説明)は、原因が解消されたので**書き換える**(上の 2 行に置き換える)。

- [ ] **Step 2: 単独で確認する**

Run: `pnpm exec vitest run --project server editor/server/test/egressGuard.test.ts`
Expected: 全件 PASS。**FAIL したら中継の修正が効いていない**ので、どのフィールドで落ちたかを
報告して止める(テストを弱めない)。

- [ ] **Step 3: 被覆を確認する**

Run: `pnpm exec vitest run --project server --coverage --coverage.include='editor/server/src/vivliostyle/egressGuard.ts' --coverage.reporter=text --coverage.thresholds.perFile=true editor/server/test/egressGuard.test.ts`
Expected: `ERROR: Coverage` 行なし。

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write editor/server/test/egressGuard.test.ts
git add editor/server/test/egressGuard.test.ts
git commit -m "test(editor): 中継のハング検出をセンチネルで戻し、応答終端の修正を実際に固定する"
```

---

### Task 5: 全体の通し

**Files:** なし(検証のみ)。

- [ ] **Step 1: 空きマシンで `pnpm run ci`**

Run: `pnpm run ci`
Expected: exit 0。所要秒数を報告に書く。Task 2 の効果で、カバレッジ直後の e2e が落ちないこと。

- [ ] **Step 2: 作業ツリーが clean**

Run: `git status --short`
Expected: 空(撮影の再実行で PNG が変わらないこと)。

---

## Self-Review

- **項目の消化**: 自己検査モード = Task 1、e2e の flake = Task 2、index.lock の実時間依存 =
  Task 3、中継のセンチネル = Task 4。4 件すべて。
- **Placeholder scan**: 各 Step にコードと期待結果がある。Task 4 のコード片は既存テストの
  構造へ差し込む形なので、行番号でなく変更内容で示した。
- **Type consistency**: `PIE_CHART_VERIFY_DELTA` は Task 1 内で定義と利用が閉じる。
  `CLIENT_TIMEOUT` は Task 4 内で閉じる。`git.commitFiles` は既存 export。
