# 後始末 計画 D2(テストの主張を実態へ揃える)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計画 A〜C2 が繰り越した軽微項目のうち、「テストの名前が主張していることを、実際には
検査していない」6 件を直す。加えて、到達しない分岐 3 件を「到達させる」か「到達不能と判る形にする」
かで決着させる。

**Architecture:** どれも既存テストへの追記か置き換えで、本番コードは触らない。ただし到達しない分岐の
うち死んだコードは、テストで到達させるのではなく**本番から削る**(残すと「いつか通る」と読まれる)。

**Tech Stack:** vitest 4.1.11 / TypeScript 6 / jsdom

**Spec:** なし(繰り越し項目の消化)。出典は計画 B2 / C1 / C2 の台帳とレビュー。

## Global Constraints

- **カバレッジはファイル単位 4 指標 85%**(`vitest.config.ts` の `perFile: true`)。閾値も include も
  触らない。主張の強化で被覆が下がることは無いが、Task 3 で本番から分岐を削る場合は該当ファイルを
  `--coverage.include` で確認する。
- **本番コードの変更は Task 3 の 1 種類だけ**: 型で到達不能が確定している防御分岐の除去。挙動を
  変える変更は入れない。他のタスクはテストのみ。
- **主張は強くする方向にしか変えない**。ある Step の想定が実装と食い違ったら、テストを弱めずに
  報告する。
- **pie-chart を触る Task では SVG バイト不変**: `pnpm --filter pie-chart run batch` →
  `batch:diff` で 83 件一致。
- **コメント規約**(`docs/コメント規約.md`): 日本語散文で「なぜ」。日付・所見番号・経緯は書かない。
- **コミット**: 日本語のメッセージ、末尾に
  `Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF`。`git add` は明示
  ファイルのみ。post-commit フックが push と pre-push CI(8〜10 分)を走らせる。amend / rebase しない。
- **重いジョブを重ねない**: 実行前に
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vitest|playwright|ci-affected' }`。

---

### Task 1: REST トランスポートの未主張な経路

**Files:**
- Modify: `editor/web/test/restHttp.dom.test.ts`
- Modify: `editor/web/test/restRepos.dom.test.ts`

**Interfaces:**
- Consumes: `apiFetch(path, opts)`(`@/api/rest/http`)、`restReviewRepo`(`@/api/rest/reviewRepo`)、
  同ファイルの `stubFetch` helper。
- Produces: なし。

2 件。① サーバの構造化エラー本文にある `code` が**文字列のとき**にそのまま載ることが未主張
(現在は非文字列で落ちる側だけ)。② 承認と却下の要求本文が未主張(URL とメソッドのみ)。

- [ ] **Step 1: `code` の正常系を足す**

`editor/web/test/restHttp.dom.test.ts` の「写像表に無いステータス」の `it` の後へ:

```ts
  it('構造化ボディの code が文字列ならそのまま載る(呼び出し側が分岐に使える)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ kind: 'conflict', message: '重複', code: 'DUP_KEY' }), {
            status: 409,
          }),
      ),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ kind: 'conflict', code: 'DUP_KEY' });
  });
```

- [ ] **Step 2: 承認・却下のボディを主張する**

`editor/web/test/restRepos.dom.test.ts` の reviews の `it` で、URL とメソッドの配列比較の後へ:

```ts
    expect(calls[4].body).toEqual({ comment: 'ok' });
    expect(calls[5].body).toEqual({ comment: 'ng' });
```

`calls` の添字は同 `it` 内の呼び出し順に合わせる(承認が 5 番目、却下が 6 番目なら 4 / 5)。
ずれていたら実際の順序に合わせる。

- [ ] **Step 3: 確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/restHttp.dom.test.ts editor/web/test/restRepos.dom.test.ts`
Expected: 全件 PASS。

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write editor/web/test/restHttp.dom.test.ts editor/web/test/restRepos.dom.test.ts
git add editor/web/test/restHttp.dom.test.ts editor/web/test/restRepos.dom.test.ts
git commit -m "test(editor): rest トランスポートの code 正常系と承認・却下のボディを主張する"
```

---

### Task 2: 名前どおりに検査していないテスト 3 件

**Files:**
- Modify: `editor/web/test/useAutosave.dom.test.ts`
- Modify: `editor/server/test/gitRepo.test.ts`(`withGitLock` の直列化)
- Modify: `editor/server/test/pyTemplate.test.ts`

**Interfaces:**
- Consumes: `useAutosave(save, debounceMs)` と同ファイルの `host` helper、
  `git.withGitLock(fn)`(`src/git/gitRepo.ts`)、`generateTemplate(attrs)`
  (`src/generate/pyTemplate.ts`)と同ファイルの `execFileMock`。
- Produces: なし。

- [ ] **Step 1: `useAutosave` の no-op テストを観測可能にする**

現在は「例外を投げない」だけ。予約が無いことを**保存が呼ばれないこと**で主張する:

```ts
  it('trigger() 前の cancel() / unmount は保存を起こさない', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ok(undefined));
    const a = host(save, 800);
    a.api.cancel();
    const b = host(save, 800);
    b.wrapper.unmount();
    // 予約が無い状態で cancel / unmount しても、待ち時間を進めて保存が起きないことまで見る
    // (例外が出ないことだけでは、誤って保存を走らせる実装を捕まえられない)。
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
```

- [ ] **Step 2: `withGitLock` の直列化を並行で試す**

現在は 3 つの予約を 1 つずつ待っているので、直列化そのものを検査していない。同時に投げて
**実行順**を見る:

```ts
  it('withGitLock は同時に来た予約を投入順へ直列化し、失敗しても次を詰まらせない', async () => {
    const order: number[] = [];
    const gate: Array<() => void> = [];
    const hold = (n: number) =>
      git.withGitLock(async () => {
        order.push(n);
        await new Promise<void>((r) => gate.push(r));
        if (n === 2) throw new Error('boom');
        return n;
      });
    // 3 つを待たずに投げる。直列化されていれば、1 つ目が解ける前に 2 つ目は始まらない。
    const p1 = hold(1);
    const p2 = hold(2);
    const p3 = hold(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1]);
    gate.shift()?.();
    await expect(p1).resolves.toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2]);
    gate.shift()?.();
    await expect(p2).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2, 3]);
    gate.shift()?.();
    await expect(p3).resolves.toBe(3);
  });
```

`gate` の要素数と `shift` の回数がずれるとハングするので、各段で `expect(order)` を確かめてから
解放する形を保つ。

- [ ] **Step 3: `pyTemplate` の実プロセス経路を 1 件足す**

現在は実行部分を全面的に差し替えているので、引数の組み立てが実際に通るかは未検査。差し替えを
外した実行を 1 件だけ足す(生成器そのものは呼ばず、存在しない実行ファイルで**失敗の形**を見る):

```ts
  it('実行ファイルが無ければ Python 生成器の失敗として包んで投げる(実 execFile 経路)', async () => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    vi.stubEnv('PYTHON_BIN', 'このコマンドは存在しません');
    const { generateTemplate } = await import('../src/generate/pyTemplate.js');
    await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗/);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
```

`PYTHON_BIN` が `config.python.bin` を決める env 名かどうかは `src/config.ts` を読んで合わせる。
`doUnmock` + `resetModules` の組でこのテストだけ実 `child_process` を使い、他のテストへ漏らさない
(漏れると同ファイルの他ケースが実プロセスを起動する)。**このやり方が同ファイルの mock 構成と
両立しない場合は、実プロセス経路のテストを別ファイル(`pyTemplate.exec.test.ts`)へ切り出す。**

- [ ] **Step 4: 3 ファイルを確認する**

Run:
```bash
pnpm exec vitest run --project web-dom editor/web/test/useAutosave.dom.test.ts
pnpm exec vitest run --project server editor/server/test/gitRepo.test.ts editor/server/test/pyTemplate.test.ts
```
Expected: 全件 PASS。`gitRepo` は 3 周繰り返して安定を見る。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write editor/web/test/useAutosave.dom.test.ts editor/server/test/gitRepo.test.ts editor/server/test/pyTemplate.test.ts
git add editor/web/test/useAutosave.dom.test.ts editor/server/test/gitRepo.test.ts editor/server/test/pyTemplate.test.ts
git commit -m "test: 自動保存の no-op・git ロックの直列化・生成器の実行失敗を実際に検査する形へ直す"
```

---

### Task 3: 到達しない分岐の決着

**Files:**
- Modify: `editor/web/src/features/editor/geom.ts`(死コードの除去)
- Modify: `editor/web/test/useCascadingSelect.dom.test.ts`(2 回目の世代ガードを踏む)
- Modify: `editor/server/test/gitRepo.test.ts`(対象ゼロの分岐)

**Interfaces:**
- Consumes: `geomFromStyle(style)`(`@/features/editor/geom`)、`useCascadingSelect(config)`、
  `git.commitAll(message, author)`。
- Produces: `geom.ts` から到達しない 1 分岐が消える。

3 件それぞれ扱いが違う。**死んでいるものは消す**、**踏めるものは踏む**、**構造的に到達しないものは
その事実をコメントで残す**。

- [ ] **Step 1: `geom.ts` の死コードを確かめる**

`pctToNum` の `if (!v) return 100;` と `Number.isNaN(n) ? 100 : …` のどちらが到達しないかを、
呼び出し元(`geomFromStyle`)から辿って判定する。`style.width` が常に文字列で来るなら前者が死に、
`undefined` があり得るなら生きている。**判定できたら**、死んでいる側だけを消し、残る側に
「なぜもう一方が要らないか」を 1 行で書く。両方生きていた場合は消さず、テストで踏む。

Run(判定の材料): `pnpm exec vitest run --project web-dom --coverage --coverage.include='editor/web/src/features/editor/geom.ts' --coverage.reporter=text editor/web/test/geom.test.ts`
Expected: 未到達行が表示される。

- [ ] **Step 2: `useCascadingSelect` の 2 回目の世代ガードを踏む**

`fetchList` の後にもう一度「自分が最新か」を見る分岐が未到達。`fetchOptions` は解決済み、
`fetchList` の解決中に次の `refresh()` が始まる形を作る:

```ts
  it('list の取得中に次の refresh が始まったら、後から返った list は捨てる', async () => {
    let releaseList!: () => void;
    const firstList = new Promise<void>((r) => { releaseList = r; });
    const fetchOptions = vi.fn().mockResolvedValue(ok({ items: [] }));
    const fetchList = vi
      .fn()
      .mockImplementationOnce(async () => { await firstList; return ok([1, 1, 1]); })
      .mockResolvedValueOnce(ok([2, 2]));
    const cs = useCascadingSelect<Query, Options, number>({
      levels: ['region'],
      emptyOptions: { items: [] },
      fetchOptions,
      fetchList,
      immediate: false,
    });
    const p1 = cs.refresh();
    await cs.refresh();
    releaseList();
    await p1;
    // 後から返った旧世代の list は捨てられ、新世代の値が残る。
    expect(cs.list.value).toEqual([2, 2]);
  });
```

- [ ] **Step 3: `gitRepo` の対象ゼロを踏む**

`commitAll` が「追跡対象のパスが 1 つも存在しない」ときに `git add` を呼ばない分岐。一時リポジトリを
**空のまま**(`ensureRepo` が作るファイルも消して)コミットする形を作る。既存の一時リポジトリ
helper を使い、`COMMITTED_PATHSPECS` に該当するファイルを全部消してから `commitAll` を呼び、
例外にならないことと、コミットが増えないことを主張する。`COMMITTED_PATHSPECS` の中身は
`src/git/gitRepo.ts` を読んで合わせる。**この形が作れない**(`ensureRepo` が毎回作り直す等)なら
踏まず、`gitRepo.ts` の該当分岐へ「公開 API からは到達しない(`ensureRepo` が必ず対象を作る)」旨の
コメントを 1 行足して終える。

- [ ] **Step 4: 3 件を確認する**

Run:
```bash
pnpm exec vitest run --project web-dom editor/web/test/geom.test.ts editor/web/test/useCascadingSelect.dom.test.ts
pnpm exec vitest run --project server editor/server/test/gitRepo.test.ts
```
Expected: 全件 PASS。`geom.ts` を変更した場合は
`pnpm exec vitest run --project web-dom --coverage --coverage.include='editor/web/src/features/editor/geom.ts' --coverage.reporter=text --coverage.thresholds.perFile=true editor/web/test/geom.test.ts` で
`ERROR: Coverage` 行が無いこと。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write editor/web/src/features/editor/geom.ts editor/web/test/useCascadingSelect.dom.test.ts editor/server/test/gitRepo.test.ts
git add editor/web/src/features/editor/geom.ts editor/web/test/useCascadingSelect.dom.test.ts editor/server/test/gitRepo.test.ts
git commit -m "test(editor): 到達しない分岐を踏むか死コードを消して、被覆の空白の理由を明示する"
```

---

### Task 4: pie-chart のテスト構成 2 件

**Files:**
- Modify: `pie-chart/test/sea_runtime.test.ts`(`afterEach` のスコープ、1 つの `it` の分割)
- Modify: `pie-chart/test/diff_scoring.test.ts`(全件変化のフォールバック、null 経路)

**Interfaces:**
- Consumes: 同ファイルの `stubSeaRequire` / `freshRuntime` / `makePlacements` / `buildScoreBase` /
  `measureRepairVecDelta` / `measureRepairVec`。
- Produces: なし。

- [ ] **Step 1: `sea_runtime` の `afterEach` を必要な範囲へ寄せる**

プロセス全体の状態(`Module._load` / `Module._resolveFilename`)を戻す `afterEach` がファイル全体に
掛かっている。SEA を装う `describe` の中へ移す(他の `describe` は自前で `try/finally` 復元するか、
そもそも触らない)。移した後、他の `describe` が復元に依存していないことを、その `describe` だけを
`-t` で走らせて確かめる。

- [ ] **Step 2: 3 主張の `it` を分ける**

「解決封鎖を張り、builtin は通り、2 度目は何もしない」の 1 件を 3 件へ分ける。各 `it` は自前で
`stubSeaRequire` + `freshRuntime` からやり直す(状態を共有しない)。

- [ ] **Step 3: 差分採点の未検査経路 2 つ**

`diff_scoring.test.ts` へ 2 件足す:

```ts
  it('changed が全件なら全走査へ落ちる(同じ値を返す)', () => {
    const cfg = createPieLayoutConfig({});
    const { placements, coord } = makePlacements(syntheticCases().gen_long_12_other, cfg);
    const base = buildScoreBase(placements, cfg, coord);
    for (const p of placements) p.leaderBend = { x: 5, y: -5 };
    const all = placements.map((_, i) => i);
    expect(measureRepairVecDelta(base, placements, cfg, coord, all)).toEqual(
      measureRepairVec(placements, cfg, coord),
    );
  });

  it('leader を描かない placement が混ざっても全走査と一致する', () => {
    const cfg = createPieLayoutConfig({});
    const { placements, coord } = makePlacements(syntheticCases().gen_long_12_other, cfg);
    // 基準側で leader を持たない要素を作る。差分は「基準では null、候補では非 null」の
    // 組み合わせを踏み、行列を読んではならない側に落ちる。
    placements[2].skipLeader = true;
    const base = buildScoreBase(placements, cfg, coord);
    placements[2].skipLeader = false;
    placements[2].leaderBend = { x: 6, y: 6 };
    expect(measureRepairVecDelta(base, placements, cfg, coord, [2])).toEqual(
      measureRepairVec(placements, cfg, coord),
    );
  });
```

`skipLeader` が `Placement` の可変フィールドでない場合は、`makePlacements` の入力側で leader を
持たない配置になるケース(内側配置など)を作る。フィールド名は `src/types.ts` を読んで合わせる。

- [ ] **Step 4: 確認とバイト不変**

Run: `pnpm exec vitest run --project pie-chart && pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`
Expected: 全テスト緑、83 件 byte 一致。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write pie-chart/test/sea_runtime.test.ts pie-chart/test/diff_scoring.test.ts
git add pie-chart/test/sea_runtime.test.ts pie-chart/test/diff_scoring.test.ts
git commit -m "test(pie-chart): 状態復元のスコープを絞り、差分採点の全件変化と leader 無しの経路を足す"
```

---

### Task 5: 全体の通し

**Files:** なし(検証のみ)。

- [ ] **Step 1: 空きマシンで `pnpm run test:coverage`**

Run: `pnpm run test:coverage`
Expected: exit 0、`ERROR: Coverage` 行 0。テスト件数と所要秒数を報告に書く。

- [ ] **Step 2: `pnpm run ci`**

Run: `pnpm run ci`
Expected: exit 0。

---

## Self-Review

- **項目の消化**: `code` 正常系と承認・却下ボディ = Task 1。`useAutosave` / `withGitLock` /
  `pyTemplate` = Task 2。`geom.ts` / `useCascadingSelect` / `gitRepo` の対象ゼロ = Task 3。
  `sea_runtime` の 2 件と差分採点の 2 経路 = Task 4。
- **Placeholder scan**: 各 Step にコードと期待結果がある。Task 3 Step 1 と Step 3、Task 4 Step 3 は
  「実装を読んで判定する」形だが、判定の基準と、判定できなかった場合の代替手段を明記した。
- **Type consistency**: helper 名(`host` / `stubFetch` / `makePlacements` / `stubSeaRequire` /
  `freshRuntime`)は各ファイルの既存のものを使う。新しい共通 helper は作らない。
