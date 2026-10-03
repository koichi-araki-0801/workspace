# editor: 作成タブをファンド属性テーブル起点の一覧へ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 作成タブの候補を DB の台帳から `Rep1` のファンド属性テーブル（sproc 経由）へ移し、会社と版種で検索したファンドの表から作成・系列から作成できるようにし、使われなくなる台帳一式を削除する。

**Architecture:** DB は `usp_テンプレート` に `委託会社一覧` / `ファンド一覧`、新ゲートウェイ `usp_シリーズ` に `一覧` を足し、いずれも `Rep1.dbo.…` を 3 部名で読む（列名は仮で sproc 内に閉じる）。サーバは `GET /templates/companies` と `GET /templates/funds` で、ファンドごとに「作成済み」と「系列のコピー元候補（テンプレの有無付き）」を組み立てる。web の作成タブは編集タブと同じ「上段のプルダウン＋下段の表」に作り直し、系列から作成ではコピー元のファンドコード（`sourceFundCode`）を生成器へ渡す。

**Tech Stack:** TypeScript（Fastify / Vue 3 / Zod）、vitest、Playwright、SQL Server 2012 の sproc、Python 3.13（テスト用の偽の生成器・パッチ生成）。

**Spec:** `docs/superpowers/specs/2026-10-03-editor-create-tab-fund-attributes-design.md`

## Global Constraints

- DB へは必ず sproc ゲートウェイ経由（却下済み設計 #12）。`Rep1` は usrap の sproc の中で 3 部名（`Rep1.dbo.<テーブル>`）で読む。
- 仮の名前（sproc 内だけに書く）: テーブル `Rep1.dbo.Rep1_投委託会社`・`Rep1.dbo.Rep1_投信ファンド属性`、列 `委託会社コード`・`委託会社名`・`ファンドコード`・`ファンド名`・`シリーズコード`。sproc が返す列名はこの 5 つで固定し、Node 側はこれだけを見る。
- sproc は 8 本（`usp_シリーズ` を追加）。`usp_テンプレート` の `@操作` は `委託会社一覧` / `ファンド一覧` だけになる（`候補`・`生成登録` は削除）。
- 全 SQL ファイルは UTF-8 BOM。SQL Server 2012 互換（`CREATE OR ALTER` 不可、DROP + CREATE）。
- 版種は `交付版` / `全体版` の 2 択（プルダウンで 1 つ）。
- `created` と `hasTemplate` の照合は大文字小文字を区別しない。`created` は `filled/`・`templates/`・`pending/` のどれか、`hasTemplate` は `templates/` だけを見る。基準日は問わない。
- `GenerateRequest.basedOnTemplateId` は `sourceFundCode` に置き換える。生成器へ渡す JSON の `sourceFundCode` は系列から作成のときだけ、`isRedemption` は true のときだけ付ける。
- `GET /templates/options` の `scope` は `edit` / `published` だけ。省略時は `edit`。
- 削除するもの: `GET /templates/series`、`TemplateRepository.resolveFund` / `listSeriesFunds`、`FundResolution`、テンプレート台帳テーブルと関連 DDL、`registerGenerated`。
- 各コミットの時点で `pnpm typecheck` と `pnpm run test:editor` が通ること（commit ごとに自動 push の pre-push CI が走るため）。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write <対象>` を実行する。vitest はリポジトリ直下から実行する。
- コメントに経緯（変更日・移植元・所見番号）を書かない。
- 差分パッチ: `--base e82a5c27677376f4db8ba55de12c7e855c60e9e9`（別環境に適用済み）。

## Review Focus

1. 会社に属するファンドが 0 件のとき、表が空の案内を出し、エラーにしない（Task 1 のリポジトリテスト、Task 3 の画面で固定）。
2. `usp_シリーズ` が返すシリーズコードが NULL のファンドは `seriesFunds` が空で、自分自身はコピー元候補に入らない（Task 1 で固定）。
3. ファンド一覧にあってシリーズ一覧に無いファンド（行の欠け）でも落ちない（Task 1 で固定）。
4. コピー元テンプレートが無いのに API を直接叩いて `sourceFundCode` を送った場合、生成器を呼ばずに 400（Task 2 で固定）。
5. 会社コードの大文字小文字がファイル名と DB で違う（`smtam` と `SMTAM`）場合でも `created` / `hasTemplate` が正しく立つ（Task 1 で固定）。

---

### Task 1: DB とサーバ — 委託会社・ファンド・シリーズの取得 API を追加する

既存の台帳の処理には触らない（削除は Task 4）。

**Files:**
- Modify: `editor/server/db/sproc/template.sql`（`候補` の前に 2 操作を追加）
- Create: `editor/server/db/sproc/series.sql`
- Create: `editor/server/db/dev/Rep1_検証用.sql`
- Modify: `editor/server/src/db/sprocNames.ts`（`series: gw('シリーズ')`）
- Modify: `editor/server/test/fakes/sprocFake.ts`（`FakeFundSeed.seriesCode?`、`委託会社一覧` / `ファンド一覧`、`usp_シリーズ` の `一覧`）
- Modify: `editor/server/test/sprocFake.test.ts`
- Modify: `editor/shared/src/schemas.ts`、`editor/shared/src/index.ts`、`editor/shared/src/api-paths.ts`
- Modify: `editor/server/src/repositories/templateRepo.ts`
- Modify: `editor/server/src/routes/templates.routes.ts`、`editor/server/src/openapi/document.ts`
- Create: `editor/server/test/templateRepo.creatable.test.ts`
- Modify: `editor/server/test/templates.routes.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Produces（shared schemas, `editor/shared/src/schemas.ts`）:
  - `CompanyOption = z.object({ companyCode: z.string(), companyName: z.string() }).meta({ id: 'CompanyOption' })`
  - `SeriesFundOption = z.object({ fundCode: z.string(), fundName: z.string(), hasTemplate: z.boolean() }).meta({ id: 'SeriesFundOption' })`
  - `CreatableFund = z.object({ fundCode: z.string(), fundName: z.string(), created: z.boolean(), seriesFunds: z.array(SeriesFundOption) }).meta({ id: 'CreatableFund' })`
  - `CreatableFundsQuery = z.object({ companyCode: z.string(), editionType: z.string() })`
  - 型 export: `CompanyOption` / `SeriesFundOption` / `CreatableFund`（index.ts で `z.infer`）
- Produces（api-paths）: `templatesCompanies: '/templates/companies'`、`templatesFunds: '/templates/funds'`
- Produces（server `TemplateRepo`）: `listCompanies(): Promise<CompanyOption[]>`、`listCreatableFunds(companyCode: string, editionType: string): Promise<CreatableFund[]>`
- Produces（`templateRepo.ts` 内 export、Task 2 が使う）: `hasTemplateFor(companyCode: string, fundCode: string, editionType: string): Promise<boolean>`（`templates/` に同じ会社・ファンド・版種が 1 件以上あるか、大文字小文字を区別しない）
- Produces（sprocNames）: `SP.series`

- [ ] **Step 1: sproc を書く**

`editor/server/db/sproc/template.sql` の `/* ---- 候補:` の直前に追加する（UTF-8 BOM を保つ）:

```sql
  /* ---- 委託会社一覧: 作成タブの会社プルダウン(Rep1 のファンド属性系テーブル) ---- */
  /* テーブル名・列名は仮。実際の名前が違うときは FROM と列に AS を付けて、返す列名を   */
  /* [委託会社コード] [委託会社名] に合わせる(Node 側はこの列名だけを見る)。              */
  IF @操作 = N'委託会社一覧'
  BEGIN
    SELECT [委託会社コード] AS [委託会社コード], [委託会社名] AS [委託会社名]
      FROM [Rep1].[dbo].[Rep1_投委託会社]
      ORDER BY [委託会社コード];
    RETURN;
  END

  /* ---- ファンド一覧: 会社を選んだときに 1 回で引く(返す列名は固定) ------------- */
  IF @操作 = N'ファンド一覧'
  BEGIN
    IF @委託会社コード IS NULL
      THROW 50000, N'委託会社コードが必要です', 1;
    SELECT [ファンドコード] AS [ファンドコード], [ファンド名] AS [ファンド名]
      FROM [Rep1].[dbo].[Rep1_投信ファンド属性]
      WHERE [委託会社コード] = @委託会社コード
      ORDER BY [ファンドコード];
    RETURN;
  END

```

先頭コメントの `@操作 で分岐:` の行に `委託会社一覧 / ファンド一覧` を足し、「`Rep1` は 3 部名で読む。editor の実行アカウントに Rep1 の 2 テーブルの SELECT 権限が要る（DB をまたぐ参照は所有権の連鎖が効かない）」を 1 行足す。

`editor/server/db/sproc/series.sql`（UTF-8 BOM で新規作成）:

```sql
/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_シリーズ
 *  @操作 で分岐: 一覧
 *  作成タブの「系列から作成」で、同じシリーズのファンド(コピー元の候補)を求める素。
 *  Rep1 のファンド属性テーブルを 3 部名で読む。テーブル名・列名は仮で、返す列名
 *  [ファンドコード] [シリーズコード] は固定(違うときは AS で合わせる)。シリーズに
 *  属さないファンドは [シリーズコード] を NULL で返す。
 *  SQL Server 2012 互換: CREATE OR ALTER 不可 → DROP+CREATE。UTF-8 BOM。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_シリーズ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_シリーズ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_シリーズ]
  @操作              NVARCHAR(32),
  @委託会社コード    NVARCHAR(32)  = NULL
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'一覧'
  BEGIN
    IF @委託会社コード IS NULL
      THROW 50000, N'委託会社コードが必要です', 1;
    SELECT [ファンドコード] AS [ファンドコード], [シリーズコード] AS [シリーズコード]
      FROM [Rep1].[dbo].[Rep1_投信ファンド属性]
      WHERE [委託会社コード] = @委託会社コード
      ORDER BY [ファンドコード];
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(シリーズ)', 1;
END
GO
```

`editor/server/db/dev/Rep1_検証用.sql`（UTF-8 BOM。`apply.ps1` は `ddl` / `sproc` / `seed` しか読まないので対象外）:

```sql
/* 検証用: LocalDB に Rep1 と仮の 2 テーブルを作る(本番では流さない)。
   sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -f 65001 -i server\db\dev\Rep1_検証用.sql */
IF DB_ID(N'Rep1') IS NULL CREATE DATABASE [Rep1];
GO
USE [Rep1];
GO
IF OBJECT_ID(N'[dbo].[Rep1_投委託会社]', N'U') IS NULL
  CREATE TABLE [dbo].[Rep1_投委託会社] (
    [委託会社コード] NVARCHAR(32) NOT NULL PRIMARY KEY,
    [委託会社名]     NVARCHAR(128) NOT NULL
  );
IF OBJECT_ID(N'[dbo].[Rep1_投信ファンド属性]', N'U') IS NULL
  CREATE TABLE [dbo].[Rep1_投信ファンド属性] (
    [ファンドコード]   NVARCHAR(32) NOT NULL PRIMARY KEY,
    [委託会社コード]   NVARCHAR(32) NOT NULL,
    [ファンド名]       NVARCHAR(256) NOT NULL,
    [シリーズコード]   NVARCHAR(32) NULL
  );
GO
DELETE FROM [dbo].[Rep1_投信ファンド属性];
DELETE FROM [dbo].[Rep1_投委託会社];
INSERT INTO [dbo].[Rep1_投委託会社] VALUES
  (N'AM01', N'三井住友トラスト・アセットマネジメント株式会社'),
  (N'AM02', N'検証用アセット');
INSERT INTO [dbo].[Rep1_投信ファンド属性] VALUES
  (N'110024', N'AM01', N'高金利ソブリンオープン', NULL),
  (N'510003', N'AM01', N'コア投資戦略ファンド（安定型）', N'CORE'),
  (N'510037', N'AM01', N'コア投資戦略ファンド（切替型）', N'CORE'),
  (N'510124', N'AM01', N'コア投資戦略ファンド（成長型）', NULL),
  (N'510155', N'AM01', N'コア投資戦略ファンド（切替型ワイド）', N'CORE'),
  (N'900001', N'AM02', N'検証用ファンド', NULL);
GO
```

`editor/server/src/db/sprocNames.ts` の `SP` に `series: gw('シリーズ'),` を足す（`noteMaster` の後）。

- [ ] **Step 2: sprocFake に操作を足し、フェイクのテストを書く（RED → GREEN）**

`editor/server/test/sprocFake.test.ts` に追加:

```ts
  it('委託会社一覧 returns every company once, ordered by code', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.template, '委託会社一覧');
    expect(rows).toEqual([
      { 委託会社コード: 'AM01', 委託会社名: '三井住友トラスト・アセットマネジメント株式会社' },
    ]);
  });

  it('ファンド一覧 returns the funds of one company and needs the company', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.template, 'ファンド一覧', [p('委託会社コード', 'AM01')]);
    expect(rows.map((r) => r.ファンドコード)).toEqual(['110024', '510003', '510037', '510124', '510155']);
    expect(rows[0]).toMatchObject({ ファンド名: '高金利ソブリンオープン' });
    await expect(sproc.callSproc(SP.template, 'ファンド一覧', [])).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('シリーズ 一覧 returns fund and series code (null when not in a series)', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.series, '一覧', [p('委託会社コード', 'AM01')]);
    expect(rows).toContainEqual({ ファンドコード: '510037', シリーズコード: 'CORE' });
    expect(rows).toContainEqual({ ファンドコード: '110024', シリーズコード: null });
  });
```

（会社名の期待値は `DEFAULT_FUNDS` の `companyName` の値に合わせる。`TRUST_AM` 定数の文字列を確認すること。）

実行して失敗を確かめる: `pnpm exec vitest run --project server editor/server/test/sprocFake.test.ts` → FAIL（未知の @操作）。

`editor/server/test/fakes/sprocFake.ts`:
- `FakeFundSeed` に `seriesCode?: string | null;` を足し、`DEFAULT_FUNDS` の `510003` / `510037` / `510155` に `seriesCode: 'CORE'` を付ける（local の `SERIES_FUND_CODES` と同じ 3 件）。
- テンプレート sproc の分岐（`if (op === '候補')` の前）に:

```ts
    if (op === '委託会社一覧') {
      const byCode = new Map<string, string>();
      for (const f of funds.values()) if (!byCode.has(f.companyCode)) byCode.set(f.companyCode, f.companyName);
      return [...byCode.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([委託会社コード, 委託会社名]) => ({ 委託会社コード, 委託会社名 }));
    }

    if (op === 'ファンド一覧') {
      const company = text(a, '委託会社コード');
      if (!company) throw sqlError(50000, '委託会社コードが必要です');
      return [...funds.values()]
        .filter((f) => f.companyCode === company)
        .sort((x, y) => x.code.localeCompare(y.code))
        .map((f) => ({ ファンドコード: f.code, ファンド名: f.name }));
    }
```

- `SP.series` 用の分岐を、他のゲートウェイ（`SP.part` など）の分岐と同じ形で足す（`proc === SP.series` の判定の書き方は既存に合わせる）:

```ts
    if (op === '一覧') {
      const company = text(a, '委託会社コード');
      if (!company) throw sqlError(50000, '委託会社コードが必要です');
      return [...funds.values()]
        .filter((f) => f.companyCode === company)
        .sort((x, y) => x.code.localeCompare(y.code))
        .map((f) => ({ ファンドコード: f.code, シリーズコード: f.seriesCode ?? null }));
    }
    throw sqlError(50000, '未知の @操作 です(シリーズ)');
```

再実行して PASS を確かめる。

- [ ] **Step 3: shared に型とパスを足す**

`editor/shared/src/schemas.ts` の `GenerateRequest` の直前に Interfaces の 4 スキーマを追加する（説明は `.meta({ description })` で付ける: companyName「委託会社名(Rep1 の属性テーブル)」、created「選んだ版種のテンプレートが filled/・templates/・pending/ のどこかにあるか」、seriesFunds「同じシリーズの他のファンド(系列から作成のコピー元候補)」、hasTemplate「コピー元のテンプレートが templates/ に同じ会社・版種で 1 件以上あるか」）。

`editor/shared/src/index.ts` に `export type CompanyOption = z.infer<typeof sch.CompanyOption>;`・`SeriesFundOption`・`CreatableFund` を足す。

`editor/shared/src/api-paths.ts` の `templates` の近くに `templatesCompanies: '/templates/companies',` と `templatesFunds: '/templates/funds',` を足す。

- [ ] **Step 4: リポジトリのテストを書く（RED）**

`editor/server/test/templateRepo.creatable.test.ts`:

```ts
// =============================================================================
// templateRepo.creatable.test.ts — 作成タブの会社・ファンド一覧(Rep1 の属性 + ファイル)
// =============================================================================
// 会社とファンドは sproc(Rep1 の属性テーブル)から、作成済みとコピー元の有無はファイルから決める。
// 照合は大文字小文字を区別しない(ファイル名と DB で会社コードの綴りが揺れる)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-creatable-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const put = (dir: string, id: string) =>
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), '<p>x</p>', 'utf8');

describe('templateRepo の作成タブ用一覧', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'pending']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    put('filled', 'am01_110024_20250101_交付版'); // 小文字の会社コード(filled/)
    put('templates', 'AM01_510037_20240710_交付版'); // 510037 はコピー元になれる
    put('templates', 'AM01_510003_20240710_全体版'); // 版種違い(交付版のコピー元にはならない)
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM01_510124_20261001_交付版', '<p>未確定</p>', '');
    const { createFakeSproc } = await import('./fakes/sprocFake.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(await createFakeSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('委託会社は sproc から会社コードと会社名で返す', async () => {
    expect(await repo.listCompanies()).toEqual([
      { companyCode: 'AM01', companyName: '三井住友トラスト・アセットマネジメント株式会社' },
    ]);
  });

  it('作成済みは filled/・templates/・pending/ のどれかにあれば立つ(大文字小文字を区別しない)', async () => {
    const rows = await repo.listCreatableFunds('AM01', '交付版');
    const created = Object.fromEntries(rows.map((r) => [r.fundCode, r.created]));
    expect(created).toEqual({
      '110024': true, // filled/(小文字の会社コード)
      '510003': false, // templates/ にあるのは全体版だけ
      '510037': true, // templates/
      '510124': true, // pending/
      '510155': false,
    });
  });

  it('シリーズの他ファンドをコピー元候補にし、自分は含めず、テンプレの有無を付ける', async () => {
    const rows = await repo.listCreatableFunds('AM01', '交付版');
    const of = (code: string) => rows.find((r) => r.fundCode === code);
    expect(of('510155')?.seriesFunds).toEqual([
      { fundCode: '510003', fundName: 'コア投資戦略ファンド（安定型）', hasTemplate: false },
      { fundCode: '510037', fundName: 'コア投資戦略ファンド（切替型）', hasTemplate: true },
    ]);
    expect(of('110024')?.seriesFunds).toEqual([]); // シリーズに属さない
  });

  it('ファンドが 0 件の会社は空配列', async () => {
    expect(await repo.listCreatableFunds('ZZ99', '交付版')).toEqual([]);
  });

  it('hasTemplateFor は templates/ を大文字小文字を区別せずに見る', async () => {
    const { hasTemplateFor } = await import('../src/repositories/templateRepo.js');
    expect(await hasTemplateFor('am01', '510037', '交付版')).toBe(true);
    expect(await hasTemplateFor('AM01', '510003', '交付版')).toBe(false);
  });
});
```

（ファンド名の期待値は `DEFAULT_FUNDS` に合わせる。）

続けて、シリーズ一覧に行が無いファンド（Review Focus 3）のケースを足す。`createFakeSproc` の seed に、シリーズ sproc の結果から外すファンドを作る手段が無いので、`createSprocClient` で包んだ手書きの QueryFn を使う:

```ts
  it('シリーズ一覧に行が無いファンドも落ちず、seriesFunds は空', async () => {
    const { createSprocClient } = await import('../src/db/sproc.js');
    const { SP } = await import('../src/db/sprocNames.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    // 既存の QueryFn の引数の形(proc 名と @操作の取り出し方)は sprocFake.ts の parseCall に合わせる。
    const sproc = createSprocClient(async (sql) => {
      if (sql.includes(SP.series)) return [];
      if (sql.includes('ファンド一覧')) return [{ ファンドコード: '777777', ファンド名: '行なし' }];
      return [];
    });
    const rows = await createTemplateRepo(sproc).listCreatableFunds('AM01', '交付版');
    expect(rows).toEqual([{ fundCode: '777777', fundName: '行なし', created: false, seriesFunds: [] }]);
  });
```

`pnpm exec vitest run --project server editor/server/test/templateRepo.creatable.test.ts` → FAIL（`listCompanies` が無い）。

- [ ] **Step 5: リポジトリを実装する（GREEN）**

`editor/server/src/repositories/templateRepo.ts`（`sameCi` / `isMeta` / `parseTemplateFileName` を使う）:

```ts
/** 会社・ファンド・版種のキー(大文字小文字を区別しない照合用)。 */
const attrKey = (companyCode: string, fundCode: string, editionType: string): string =>
  `${companyCode}\u0000${fundCode}\u0000${editionType}`.toLowerCase();

/** ファイル名一覧から、会社・ファンド・版種のキー集合を作る(基準日は問わない)。 */
function keysOf(fileNames: string[]): Set<string> {
  const keys = new Set<string>();
  for (const f of fileNames) {
    const a = parseTemplateFileName(f);
    if (a) keys.add(attrKey(a.companyCode, a.fundCode, a.editionType));
  }
  return keys;
}

/** templates/ に、同じ会社・ファンド・版種のテンプレートが 1 件以上あるか(系列のコピー元判定)。 */
export async function hasTemplateFor(
  companyCode: string,
  fundCode: string,
  editionType: string,
): Promise<boolean> {
  return keysOf(await listTemplateFiles()).has(attrKey(companyCode, fundCode, editionType));
}
```

`TemplateRepo` に `listCompanies(): Promise<CompanyOption[]>;` と `listCreatableFunds(companyCode: string, editionType: string): Promise<CreatableFund[]>;` を足し、実装:

```ts
    async listCompanies() {
      const rows = await sproc.callSproc(SP.template, '委託会社一覧');
      return rows.map((r) => ({
        companyCode: asString(r.委託会社コード),
        companyName: asString(r.委託会社名),
      }));
    },

    /**
     * 作成タブのファンド表。ファンドと名称は Rep1 の属性(sproc)、作成済みとコピー元の有無は
     * ファイルから決める。作成済みは filled/・templates/・pending/ のどれか、コピー元は生成器が
     * 読む templates/ だけを見る。
     */
    async listCreatableFunds(companyCode, editionType) {
      const fundRows = await sproc.callSproc(SP.template, 'ファンド一覧', [
        p('委託会社コード', companyCode),
      ]);
      if (fundRows.length === 0) return [];
      const seriesRows = await sproc.callSproc(SP.series, '一覧', [p('委託会社コード', companyCode)]);
      const seriesOf = new Map(
        seriesRows.map((r) => [asString(r.ファンドコード), asStringOrNull(r.シリーズコード)]),
      );
      const funds = fundRows.map((r) => ({
        fundCode: asString(r.ファンドコード),
        fundName: asString(r.ファンド名),
      }));
      const templateKeys = keysOf(await listTemplateFiles());
      const createdKeys = new Set([
        ...templateKeys,
        ...keysOf(await listFilledFiles()),
        ...keysOf((await listPendingIds()).map((id) => `${id}.html`)),
      ]);
      return funds.map((f) => {
        const series = seriesOf.get(f.fundCode) ?? null;
        const seriesFunds = series
          ? funds
              .filter((o) => o.fundCode !== f.fundCode && seriesOf.get(o.fundCode) === series)
              .map((o) => ({
                ...o,
                hasTemplate: templateKeys.has(attrKey(companyCode, o.fundCode, editionType)),
              }))
          : [];
        return {
          ...f,
          created: createdKeys.has(attrKey(companyCode, f.fundCode, editionType)),
          seriesFunds,
        };
      });
    },
```

import に `type CompanyOption`・`type CreatableFund`・`parseTemplateFileName` を足す。テストを再実行して PASS を確かめる。

- [ ] **Step 6: ルートとテスト（RED → GREEN）**

`editor/server/test/templates.routes.test.ts` に追加:

```ts
  it('GET /templates/companies: 会社コードと会社名(未ログインは 401)', async () => {
    expect((await app.inject({ method: 'GET', url: '/templates/companies' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/templates/companies', headers: as('editor') });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ companyCode: 'AM01' });
  });

  it('GET /templates/funds: companyCode と editionType が無ければ 400、あれば作成済み付きのファンド', async () => {
    for (const url of ['/templates/funds?companyCode=AM01', `/templates/funds?editionType=${encodeURIComponent('交付版')}`]) {
      expect((await app.inject({ method: 'GET', url, headers: as('editor') })).statusCode).toBe(400);
    }
    const res = await app.inject({
      method: 'GET',
      url: `/templates/funds?companyCode=AM01&editionType=${encodeURIComponent('交付版')}`,
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json() as Array<{ fundCode: string; created: boolean }>).find((r) => r.fundCode === '510037');
    expect(row?.created).toBe(true); // beforeAll が filled/ に置いた ID
  });
```

RED を確かめてから、`templates.routes.ts` に追加（`templatesSeries` の前）:

```ts
  app.get(apiPaths.templatesCompanies, { preHandler: requireAuth }, async () =>
    templates.listCompanies(),
  );

  app.get<QueryRec>(apiPaths.templatesFunds, { preHandler: requireAuth }, async (request) => {
    const q = request.query;
    const companyCode = typeof q.companyCode === 'string' ? q.companyCode : '';
    const editionType = typeof q.editionType === 'string' ? q.editionType : '';
    if (!companyCode || !editionType) throw validation('companyCode と editionType が必要です');
    return templates.listCreatableFunds(companyCode, editionType);
  });
```

`openapi/document.ts` の `/templates/series` の前に 2 パスを足す（`getDropdownOptions` と同じ書式。companies は `responses: { '200': json('委託会社の一覧', z.array(s.CompanyOption)), ...ERR_401 }`、funds は `requestParams: { query: s.CreatableFundsQuery }`、`'200': json('作成タブのファンド一覧', z.array(s.CreatableFund))`、`...ERR_400`（既存の 400 定数名に合わせる）、`...ERR_401`）。

`pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen` で `openapi.json` を再生成する。

- [ ] **Step 7: 検証とコミット**

Run: `pnpm typecheck` → exit 0。`pnpm exec vitest run --project server` → 全件 PASS（`openapiArtifact.guard` を含む）。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test
git add editor/server/db/sproc/template.sql editor/server/db/sproc/series.sql editor/server/db/dev/Rep1_検証用.sql editor/server/src/db/sprocNames.ts editor/server/test/fakes/sprocFake.ts editor/server/test/sprocFake.test.ts editor/shared/src/schemas.ts editor/shared/src/index.ts editor/shared/src/api-paths.ts editor/server/src/repositories/templateRepo.ts editor/server/src/routes/templates.routes.ts editor/server/src/openapi/document.ts editor/server/openapi/openapi.json editor/server/test/templateRepo.creatable.test.ts editor/server/test/templates.routes.test.ts
git commit -m "feat(server): 作成タブ用に委託会社とファンド(Rep1 の属性)・シリーズの取得 API を追加する"
```

---

### Task 2: 生成 — コピー元ファンドコードと償還を生成器へ渡す

`basedOnTemplateId` はまだ消さない（web が使っているため。削除は Task 4）。

**Files:**
- Modify: `editor/shared/src/schemas.ts`（`GenerateRequest` に `sourceFundCode`、`CreateHistoryEntry` に `sourceFundCode`）
- Modify: `editor/server/src/generate/pyTemplate.ts`（`GenerateAttributes` と `toGeneratorPayload`）
- Modify: `editor/server/src/routes/generate.routes.ts`
- Modify: `editor/server/src/repositories/historyRepo.ts`（`recordCreate` の引数）
- Modify: `editor/server/scripts/fake_generate_template.py`
- Modify: `editor/server/test/pyTemplate.test.ts`、`editor/server/test/generate.routes.test.ts`、`editor/server/test/fakeGenerator.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Consumes: Task 1 の `hasTemplateFor(companyCode, fundCode, editionType)`
- Produces: `GenerateRequest.sourceFundCode?: string`（コピー元のファンドコード）、`CreateHistoryEntry.sourceFundCode?: string`、`GenerateAttributes.sourceFundCode?` / `isRedemption?`、`recordCreate(attributes, source: { basedOnTemplateId?: string; sourceFundCode?: string }, loginId)`（Task 4 で `basedOnTemplateId` を外す）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/pyTemplate.test.ts` の `toGeneratorPayload`（または `generateTemplate` の引数 JSON を確かめている既存ケース）に倣って追加:

```ts
  it('sourceFundCode と isRedemption は指定したときだけ生成器の JSON に入る', async () => {
    // 既存ケースと同じ方法で、生成器に渡った argv[1] の JSON を取り出す。
    const withAll = await capturedPayload({
      companyCode: 'AM01', fundCode: '510155', editionType: '交付版', baseDate: '20261003',
      sourceFundCode: '510037', isRedemption: true,
    });
    expect(withAll).toEqual({
      companyCode: 'AM01', fundCode: '510155', editionType: '交付版', baseDate: '20261003',
      sourceFundCode: '510037', isRedemption: true,
    });
    const plain = await capturedPayload({
      companyCode: 'AM01', fundCode: '510155', editionType: '交付版', baseDate: '20261003',
      isRedemption: false,
    });
    expect(plain).not.toHaveProperty('sourceFundCode');
    expect(plain).not.toHaveProperty('isRedemption');
  });
```

（`capturedPayload` は既存テストが argv を取り出している方法に合わせたヘルパ。無ければ `toGeneratorPayload` を export して直接検査する。）

`editor/server/test/generate.routes.test.ts` に追加:

```ts
  it('sourceFundCode のコピー元テンプレートが templates/ に無ければ生成器を呼ばずに 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/generate', headers: as('editor'),
      payload: { companyCode: 'AM01', fundCode: '510155', editionType: '交付版', sourceFundCode: '999999' },
    });
    expect(res.statusCode).toBe(400);
    expect(generatorCalls).toHaveLength(0); // 既存テストの生成器スパイ名に合わせる
  });

  it('sourceFundCode が規約外(パス区切りなど)なら 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/generate', headers: as('editor'),
      payload: { companyCode: 'AM01', fundCode: '510155', editionType: '交付版', sourceFundCode: '../x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('コピー元があれば sourceFundCode を生成器へ渡し、作成履歴に残す', async () => {
    // templates/ に AM01_510037_20240710_交付版.html を置いてから呼ぶ(既存の beforeAll の置き方に合わせる)
    const res = await app.inject({
      method: 'POST', url: '/generate', headers: as('editor'),
      payload: { companyCode: 'AM01', fundCode: '510155', editionType: '交付版', sourceFundCode: '510037' },
    });
    expect(res.statusCode).toBe(200);
    expect(lastGeneratorPayload()).toMatchObject({ sourceFundCode: '510037' });
    // 作成履歴に sourceFundCode が入ることは既存の作成履歴の検査方法で確かめる。
  });
```

`editor/server/test/fakeGenerator.test.ts` に追加（既存の起動方法に合わせる）: `TEMPLATES_DIR` に `AM01_510037_20240101_交付版.html`（本文 `<p>old</p>`）と `AM01_510037_20250101_交付版.html`（`<p>new</p>`）を置き、`{ companyCode: 'AM01', fundCode: '510155', editionType: '交付版', sourceFundCode: '510037' }` で起動すると stdout が `<p>new</p>` になること。会社コードを `am01` で渡しても同じになること。

Run: `pnpm exec vitest run --project server editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts editor/server/test/fakeGenerator.test.ts` → FAIL。

- [ ] **Step 2: 実装する**

`schemas.ts` の `GenerateRequest` に:

```ts
    sourceFundCode: z
      .string()
      .optional()
      .meta({ description: '系列から作成するときのコピー元ファンドコード(会社と版種は作成先と同じ)' }),
```

`isRedemption` の説明を「償還ファンドとして作成(生成器へパラメータとして渡す)」に直す。`CreateHistoryEntry`（265 行付近）に `sourceFundCode: z.string().optional().meta({ description: '系列から作成したときのコピー元ファンドコード' })` を足す。

`pyTemplate.ts`: `GenerateAttributes` に `sourceFundCode?: string; isRedemption?: boolean;` を足し、`toGeneratorPayload` の返り値に:

```ts
    ...(attrs.sourceFundCode ? { sourceFundCode: attrs.sourceFundCode } : {}),
    ...(attrs.isRedemption ? { isRedemption: true } : {}),
```

`generate.routes.ts`: `basedOnTemplateId` の検査の後に:

```ts
          const sourceFundCode = body.sourceFundCode
            ? assertTemplateAttributeToken('コピー元ファンドコード', body.sourceFundCode)
            : undefined;
          // 画面は「コピー元テンプレートが無い候補」で作成を止めるが、API を直接呼ばれても同じ結果にする。
          if (
            sourceFundCode &&
            !(await hasTemplateFor(attributes.companyCode, sourceFundCode, attributes.editionType))
          ) {
            throw validation(`コピー元のテンプレートがありません: ${sourceFundCode}`);
          }
```

生成器の呼び出しに `...(sourceFundCode === undefined ? {} : { sourceFundCode })` と `isRedemption: body.isRedemption === true` を足し、`recordCreate(attributes, { basedOnTemplateId, sourceFundCode }, loginId)` にする。`historyRepo.ts` の `recordCreate` の第 2 引数を `source: { basedOnTemplateId?: string; sourceFundCode?: string }` にして、両方をエントリへ書く（`undefined` は書かない）。既存の呼び出し元とテストを合わせる。

`fake_generate_template.py`: `based_on` の処理の前に:

```python
    source_fund = attrs.get("sourceFundCode")
    if source_fund:
        templates_dir = os.environ.get("TEMPLATES_DIR")
        if not templates_dir:
            print("TEMPLATES_DIR is required when sourceFundCode is given", file=sys.stderr)
            return 2
        # 会社・版種は作成先と同じ。基準日が最新のコピー元テンプレートを写す(大文字小文字は区別しない)。
        prefix = f"{company}_{source_fund}_".lower()
        suffix = f"_{edition}.html".lower()
        candidates = sorted(
            f for f in os.listdir(templates_dir)
            if f.lower().startswith(prefix) and f.lower().endswith(suffix)
        )
        if not candidates:
            print(f"source template not found: {source_fund}", file=sys.stderr)
            return 2
        with open(os.path.join(templates_dir, candidates[-1]), encoding="utf-8") as f:
            sys.stdout.write(f.read())
            return 0
```

（`os.listdir` が返すのは名前だけなので、ディレクトリの外へは出ない。docstring の引数説明に `sourceFundCode?` と `isRedemption?` を足す。）

- [ ] **Step 3: 検証とコミット**

`pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen`。`pnpm typecheck` → exit 0。`pnpm exec vitest run --project server` → 全件 PASS。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test
git add editor/shared/src/schemas.ts editor/server/src/generate/pyTemplate.ts editor/server/src/routes/generate.routes.ts editor/server/src/repositories/historyRepo.ts editor/server/scripts/fake_generate_template.py editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts editor/server/test/fakeGenerator.test.ts editor/server/openapi/openapi.json
git commit -m "feat(server): 系列から作成のコピー元ファンドコードと償還を生成器へ渡す"
```

---

### Task 3: web — 作成タブを「会社・版種で検索 → ファンドの表」へ作り直す

**Files:**
- Modify: `editor/shared/src/repositories/TemplateRepository.ts`（`listCompanies` / `listCreatableFunds` を追加）
- Modify: `editor/web/src/api/rest/templateRepo.ts`、`editor/web/src/api/local/templateRepo.ts`
- Modify: `editor/web/src/features/templates/services/templateCreationService.ts`
- Create: `editor/web/src/features/templates/components/FundTable.vue`
- Modify: `editor/web/src/features/templates/CreateTabView.vue`（全面）
- Modify: `editor/web/src/features/templates/HistoryTabView.vue:81`（元の列）
- Modify: `editor/web/test/restRepos.dom.test.ts`、`editor/web/test/localReposExtra.dom.test.ts`、`editor/web/test/templateCreationService.test.ts`、`editor/web/test/dropdownScope.guard.test.ts`（作成タブの行を外す）
- Create: `editor/web/test/FundTable.dom.test.ts`
- Modify: `editor/e2e/create.spec.ts`、`editor/e2e/capture_docs.spec.ts`（作成タブの撮影手順）
- Modify: `vitest.config.ts`（カバレッジ include に `FundTable.vue` を足すかは、既存の `TemplateTable.vue` が入っているかに合わせる）

**Interfaces:**
- Consumes: Task 1 の `CompanyOption` / `CreatableFund` / `apiPaths.templatesCompanies` / `apiPaths.templatesFunds`、Task 2 の `GenerateRequest.sourceFundCode`
- Produces: `TemplateRepository.listCompanies(): Promise<Result<CompanyOption[]>>`、`listCreatableFunds(companyCode: string, editionType: string): Promise<Result<CreatableFund[]>>`。`FundTable.vue`: props `rows: CreatableFund[]`、`disabled?: boolean`、emits `create: [CreatableFund]`、`createFromSeries: [CreatableFund, string]`（第 2 引数はコピー元ファンドコード）

- [ ] **Step 1: 失敗するテストを書く**

`restRepos.dom.test.ts` に:

```ts
  it('作成タブの会社・ファンド一覧の URL', async () => {
    const calls = stubFetch(() => json([]));
    await restTemplateRepo.listCompanies();
    expect(calls[0].url).toBe('/api/templates/companies');
    await restTemplateRepo.listCreatableFunds('AM01', '交付版');
    expect(calls[1].url).toBe(`/api/templates/funds?companyCode=AM01&editionType=${encodeURIComponent('交付版')}`);
  });
```

`localReposExtra.dom.test.ts` に:

```ts
  it('listCompanies / listCreatableFunds は fixtures の会社とファンドを返し、作成済みとシリーズを付ける', async () => {
    const companies = await localTemplateRepo.listCompanies();
    expect(isOk(companies) && companies.value[0]).toMatchObject({ companyCode: 'AM01' });
    const funds = await localTemplateRepo.listCreatableFunds('AM01', '交付版');
    if (!isOk(funds)) throw new Error('listCreatableFunds に失敗');
    const f510037 = funds.value.find((f) => f.fundCode === '510037');
    expect(f510037?.created).toBe(true); // fixtures に AM01_510037_…_交付版 がある
    expect(f510037?.seriesFunds.map((s) => s.fundCode)).toEqual(['510003', '510155']);
    expect(funds.value.find((f) => f.fundCode === '110024')?.seriesFunds).toEqual([]);
  });

  it('generate(sourceFundCode) はコピー元ファンドの最新テンプレートの HTML を写す', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const r = await localTemplateRepo.generate({
      companyCode: 'AM01', fundCode: '510155', editionType: '全体版', sourceFundCode: '510037',
    });
    const base = await localTemplateRepo.getTemplate('AM01_510037_20240710_全体版');
    if (!isOk(r) || !isOk(base)) throw new Error('generate か getTemplate に失敗');
    expect(r.value.template.html).toBe(base.value.html);
  });
```

`editor/web/test/FundTable.dom.test.ts`（既存の `*.dom.test.ts` の mount の仕方に合わせる）:

```ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import FundTable from '@/features/templates/components/FundTable.vue';

const row = (over = {}) => ({
  fundCode: '510155', fundName: '切替型ワイド', created: false,
  seriesFunds: [
    { fundCode: '510003', fundName: '安定型', hasTemplate: false },
    { fundCode: '510037', fundName: '切替型', hasTemplate: true },
  ],
  ...over,
});

describe('FundTable', () => {
  it('作成済みの行に「作成済み」を出す', () => {
    const w = mount(FundTable, { props: { rows: [row({ created: true })] } });
    expect(w.text()).toContain('作成済み');
  });

  it('コピー元テンプレートが無いファンドを選ぶと警告を出し、系列から作成を押せない', async () => {
    const w = mount(FundTable, { props: { rows: [row()] } });
    await w.get('[data-testid="series-source-510155"]').setValue('510003');
    expect(w.text()).toContain('コピー元のテンプレートがありません');
    expect(w.get('[data-testid="series-create-510155"]').attributes('disabled')).toBeDefined();
    await w.get('[data-testid="series-source-510155"]').setValue('510037');
    expect(w.get('[data-testid="series-create-510155"]').attributes('disabled')).toBeUndefined();
    await w.get('[data-testid="series-create-510155"]').trigger('click');
    expect(w.emitted('createFromSeries')?.[0]?.[1]).toBe('510037');
  });

  it('シリーズに属さない行には系列から作成を出さない', () => {
    const w = mount(FundTable, { props: { rows: [row({ seriesFunds: [] })] } });
    expect(w.find('[data-testid="series-create-510155"]').exists()).toBe(false);
  });
});
```

Run: `pnpm exec vitest run --project "web-*" editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts editor/web/test/FundTable.dom.test.ts` → FAIL。

- [ ] **Step 2: 契約と repo を実装する**

`TemplateRepository.ts` に:

```ts
  /** 作成タブの委託会社(Rep1 の属性テーブル)。 */
  listCompanies(): Promise<Result<CompanyOption[]>>;
  /** 作成タブのファンド表。作成済みと、系列から作成のコピー元候補を含む。 */
  listCreatableFunds(companyCode: string, editionType: string): Promise<Result<CreatableFund[]>>;
```

rest:

```ts
  listCompanies: () => attemptRest(() => apiFetch<CompanyOption[]>(apiPaths.templatesCompanies)),
  listCreatableFunds: (companyCode: string, editionType: string) =>
    attemptRest(() =>
      apiFetch<CreatableFund[]>(apiPaths.templatesFunds, { query: { companyCode, editionType } }),
    ),
```

local（`fundMaster` は `store.ts` が読む `funds.json`。キーがファンドコード、値に `name` と `company.{code,name}`）:

```ts
  listCompanies: () =>
    attempt(() => {
      const byCode = new Map<string, string>();
      for (const f of Object.values(fundMaster)) byCode.set(f.company.code, f.company.name);
      return delay(
        [...byCode.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([companyCode, companyName]) => ({ companyCode, companyName })),
      );
    }),

  listCreatableFunds: (companyCode: string, editionType: string) =>
    attempt(() => {
      const funds = Object.entries(fundMaster)
        .filter(([, f]) => f.company.code.toLowerCase() === companyCode.toLowerCase())
        .map(([fundCode, f]) => ({ fundCode, fundName: f.name }))
        .sort((a, b) => a.fundCode.localeCompare(b.fundCode));
      const has = (fundCode: string) =>
        allMetas().some(
          (m) =>
            m.attributes.companyCode.toLowerCase() === companyCode.toLowerCase() &&
            m.attributes.fundCode === fundCode &&
            m.attributes.editionType === editionType,
        );
      return delay(
        funds.map((f) => ({
          ...f,
          created: has(f.fundCode),
          seriesFunds: SERIES_FUND_CODES.has(f.fundCode)
            ? funds
                .filter((o) => o.fundCode !== f.fundCode && SERIES_FUND_CODES.has(o.fundCode))
                .map((o) => ({ ...o, hasTemplate: has(o.fundCode) }))
            : [],
        })),
      );
    }),
```

（`fundMaster` の実際の型と名前は `store.ts` を確認して合わせる。local の `hasTemplate` は「local で開けるテンプレがある」で代用する。）

local の `generate` に、`basedOnTemplateId` の分岐の前に:

```ts
      if (req.sourceFundCode) {
        const source = allMetas()
          .filter(
            (m) =>
              m.attributes.companyCode.toLowerCase() === req.companyCode.toLowerCase() &&
              m.attributes.fundCode === req.sourceFundCode &&
              m.attributes.editionType === req.editionType,
          )
          .sort((a, b) => a.attributes.baseDate.localeCompare(b.attributes.baseDate))
          .at(-1);
        if (!source) throw validation(`コピー元のテンプレートがありません: ${req.sourceFundCode}`);
        const baseRes = await localTemplateRepo.getTemplate(source.id);
        if (isErr(baseRes)) throw baseRes.error;
        baseHtml = baseRes.value.html;
      } else if (req.basedOnTemplateId) {
```

作成履歴のエントリに `sourceFundCode: req.sourceFundCode` を（あるときだけ）入れる。

`templateCreationService.ts`: `listCompanies` / `listCreatableFunds` を素通しで足す（`resolveFund` / `listSeriesFunds` は Task 4 で消すまで残す）。`templateCreationService.test.ts` に素通しの 1 ケースを足す。

- [ ] **Step 3: FundTable.vue を作る**

`TemplateTable.vue` と同じ表の部品（`Table` / `TableHeader` / `TableRow` / `TableCell` / `Badge` / `Button` / `Select`）とクラスを使う。列は「ファンドコード」「ファンド名」「状態」「操作」。

```vue
<script setup lang="ts">
// =============================================================================
// FundTable.vue — 作成タブのファンド表(作成済みの印・作成・系列から作成)
// =============================================================================
import type { CreatableFund } from '@editor/shared';
import { FilePlus2, Files, TriangleAlert } from '@lucide/vue';
import { reactive } from 'vue';
// 表の部品は TemplateTable.vue と同じものを import する。

const props = defineProps<{ rows: CreatableFund[]; disabled?: boolean }>();
const emit = defineEmits<{ create: [CreatableFund]; createFromSeries: [CreatableFund, string] }>();

/** 行ごとに選んだコピー元ファンドコード。 */
const source = reactive<Record<string, string>>({});

function selected(row: CreatableFund) {
  return row.seriesFunds.find((s) => s.fundCode === source[row.fundCode]);
}
/** コピー元を選び、そのテンプレートがあるときだけ系列から作成を押せる。 */
function canCreateFromSeries(row: CreatableFund): boolean {
  return !props.disabled && selected(row)?.hasTemplate === true;
}
</script>
```

テンプレート部の要点（クラスは TemplateTable に合わせる）:
- 状態セル: `row.created` なら `<Badge variant="secondary">作成済み</Badge>`、そうでなければ「—」。
- 操作セル: `<Button variant="outline" :disabled="props.disabled" @click="emit('create', row)"><FilePlus2 /> 作成</Button>`。
- `row.seriesFunds.length > 0` のとき、同じセルに
  - コピー元の Select（`data-testid="series-source-<fundCode>"`、`v-model="source[row.fundCode]"`、選択肢は `` `${s.fundCode} ${s.fundName}` ``、テンプレの無いものはラベル末尾に「（テンプレートなし）」）
  - `<Button data-testid="series-create-<fundCode>" :disabled="!canCreateFromSeries(row)" @click="emit('createFromSeries', row, source[row.fundCode])"><Files /> 系列から作成</Button>`
  - 選んだコピー元の `hasTemplate` が false なら `<p class="text-xs text-destructive"><TriangleAlert /> コピー元のテンプレートがありません</p>`
- 行が 0 件の表示は呼び出し側（CreateTabView）が持つ。

（Select が `setValue` で動かない部品なら、テストは部品の `update:modelValue` を emit させる形に合わせる。`data-testid` は残す。）

- [ ] **Step 4: CreateTabView.vue を作り直す**

構成（編集タブと同じ `FilterBar` / `FormField` / `Label` / `Combobox` / `Select` を使う）:

```vue
<script setup lang="ts">
// =============================================================================
// CreateTabView.vue — テンプレ作成タブ(委託会社・版種で検索 → ファンドの表から作成)
// =============================================================================
// 会社とファンドは Rep1 の属性テーブル(サーバの sproc 経由)から取る。会社はタブを開いたとき、
// ファンドは検索したときに会社コードで一括取得する。版種は 1 つだけ選ぶ。
import { type CompanyOption, type CreatableFund, type GenerateRequest, isErr } from '@editor/shared';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
// FilterBar / FormField / Label / Combobox / Select / Button / Checkbox / Search アイコン / toast は
// SearchFilters.vue と同じ場所から import する。
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';
import FundTable from './components/FundTable.vue';
import { editorRoute } from './editorRoute';
import { useTemplateCreationService } from './services/templateCreationService';

const EDITION_TYPES = ['交付版', '全体版'] as const;

const router = useRouter();
const templates = useTemplateCreationService();
const { loading: creating, run } = useAsyncResult();
const query = reactive<{ companyCode?: string; editionType?: string }>({});
const companies = ref<CompanyOption[]>([]);
const rows = ref<CreatableFund[]>([]);
const searched = ref(false);
const isRedemption = ref(false);
const latest = useLatest();

const companyOptions = computed(() =>
  companies.value.map((c) => ({ label: c.companyName, value: c.companyCode })),
);
const canSearch = computed(() => !!query.companyCode && !!query.editionType);

const { hydrated } = useUrlQuerySync(query, { keys: ['companyCode', 'editionType'] });

onMounted(async () => {
  const res = await templates.listCompanies();
  if (isErr(res)) {
    toastError(res.error.message);
    return;
  }
  companies.value = res.value;
  if (hydrated && canSearch.value) search();
});

async function search() {
  const { companyCode, editionType } = query;
  if (!companyCode || !editionType) return;
  const isLatest = latest.begin();
  const res = await run(() => templates.listCreatableFunds(companyCode, editionType));
  if (isErr(res) || !isLatest()) return;
  rows.value = res.value;
  searched.value = true;
}

async function create(req: GenerateRequest, successMsg: string) {
  const res = await run(() => templates.create(req));
  if (isErr(res)) return;
  toastSuccess(successMsg);
  router.push(editorRoute(res.value.id, { created: true }));
}

function createNew(f: CreatableFund) {
  const { companyCode, editionType } = query;
  if (!companyCode || !editionType || creating.value) return;
  create(
    { companyCode, fundCode: f.fundCode, editionType, isRedemption: isRedemption.value },
    'テンプレートを作成しました',
  );
}

function createFromSeries(f: CreatableFund, sourceFundCode: string) {
  const { companyCode, editionType } = query;
  if (!companyCode || !editionType || creating.value) return;
  create(
    { companyCode, fundCode: f.fundCode, editionType, sourceFundCode, isRedemption: isRedemption.value },
    'シリーズを基にテンプレートを作成しました',
  );
}
</script>
```

テンプレート部:
- 見出し「テンプレート作成」と説明「委託会社と版種を選んで検索し、作成するファンドの行で作成します。」
- `FilterBar` の中に: 委託会社（`Combobox`、`:options="companyOptions"`、placeholder「委託会社を入力/選択」）、版種（`Select`、`:options="EDITION_TYPES"`、placeholder「版種を選択」）、償還（`Checkbox` と「償還ファンドとして作成する」）、検索ボタン（`:disabled="!canSearch"`）。会社や版種を変えたら `searched` を false に戻し、表を消す。
- `searched` かつ `rows.length === 0` なら「この委託会社のファンドが見つかりませんでした。」の枠（既存の空表示と同じクラス）。
- `rows.length > 0` なら `<FundTable :rows="rows" :disabled="creating" @create="createNew" @create-from-series="createFromSeries" />`。

`dropdownScope.guard.test.ts` から `CreateTabView.vue` の行を外す（作成タブは `SearchFilters` を使わなくなる）。`HistoryTabView.vue:81` の列は `{ header: '元', cellClass: MONO, value: (e) => e.sourceFundCode ?? e.basedOnTemplateId ?? '—' }` にする（Task 4 で `basedOnTemplateId` を外す）。

- [ ] **Step 5: e2e と撮影を直す**

`editor/e2e/create.spec.ts` の操作を新しい画面に合わせる:

```ts
  await page.getByText('テンプレート作成').first().waitFor();
  await page.getByPlaceholder('委託会社を入力/選択').click();
  await page.getByRole('option', { name: '三井住友トラスト・アセットマネジメント株式会社' }).click();
  await page.getByRole('combobox').filter({ hasText: '版種を選択' }).click();
  await page.getByRole('option', { name: '交付版', exact: true }).click();
  await page.getByRole('button', { name: '検索' }).click();
  await page.getByRole('row', { name: /510037/ }).getByRole('button', { name: '作成' }).click();
```

以降の検証（`/edit/AM01_510037_\d{8}_交付版?created=1` とハイライト）はそのまま。`capture_docs.spec.ts` の作成タブ（94〜98 行付近）は、会社と版種を選んで検索し、表が出た状態で `create-tab.png` を撮るように直す。

- [ ] **Step 6: 検証とコミット**

Run: `pnpm typecheck` → exit 0。`pnpm run test:editor` → 全件 PASS。`pnpm exec playwright test -c editor/playwright.config.ts --project chromium editor/e2e/create.spec.ts` → PASS。

```bash
pnpm exec biome check --write editor/shared/src editor/web/src editor/web/test editor/e2e
git add editor/shared/src/repositories/TemplateRepository.ts editor/web/src/api/rest/templateRepo.ts editor/web/src/api/local/templateRepo.ts editor/web/src/features/templates/services/templateCreationService.ts editor/web/src/features/templates/components/FundTable.vue editor/web/src/features/templates/CreateTabView.vue editor/web/src/features/templates/HistoryTabView.vue editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts editor/web/test/templateCreationService.test.ts editor/web/test/dropdownScope.guard.test.ts editor/web/test/FundTable.dom.test.ts editor/e2e/create.spec.ts editor/e2e/capture_docs.spec.ts
git commit -m "feat(web): 作成タブを委託会社・版種で検索するファンドの表へ作り直す"
```

---

### Task 4: 使われなくなった台帳・系列・候補の処理を削除する

**Files:**
- Modify: `editor/server/db/sproc/template.sql`（`候補`・`生成登録` を削除）
- Modify: `editor/server/db/ddl/01_テーブル.sql`・`02_索引.sql`・`03_制約.sql`（台帳の節を削除）
- Create: `editor/server/db/dev/台帳_削除.sql`（既存環境で手で流す DROP。`apply.ps1` の対象外）
- Modify: `editor/server/test/fakes/sprocFake.ts`（`候補`・`生成登録`・`templates` マップと `DEFAULT_TEMPLATE_IDS` / `FakeSeed.templateIds` のうち台帳用のもの）、`editor/server/test/sprocFake.test.ts`
- Modify: `editor/server/src/repositories/templateRepo.ts`（`registerGenerated`・`listSeriesFunds`・`queryParams`・`scope=create` の分岐）
- Modify: `editor/server/src/routes/generate.routes.ts`（`registerGenerated` の呼び出し、`basedOnTemplateId`）
- Modify: `editor/server/src/routes/templates.routes.ts`（series ルート、`toScope` の既定）
- Modify: `editor/server/src/generate/pyTemplate.ts`、`editor/server/scripts/fake_generate_template.py`（`basedOnTemplateId`）
- Modify: `editor/server/src/repositories/historyRepo.ts`（`recordCreate` の `basedOnTemplateId`）
- Modify: `editor/server/src/openapi/document.ts`、`editor/shared/src/schemas.ts`（`DROPDOWN_SCOPES` から `create`、`GenerateRequest.basedOnTemplateId`）、`editor/shared/src/api-paths.ts`（`templatesSeries`）、`editor/shared/src/index.ts`（`FundResolution`）、`editor/shared/src/repositories/TemplateRepository.ts`（`resolveFund` / `listSeriesFunds`）
- Modify: `editor/web/src/api/rest/templateRepo.ts`、`editor/web/src/api/local/templateRepo.ts`、`editor/web/src/features/templates/services/templateCreationService.ts`、`editor/web/src/features/templates/HistoryTabView.vue`
- Delete: `editor/server/test/templateRepo.series.test.ts`
- Modify: 関連テスト（`templateRepo.options*.test.ts`・`templates.routes.test.ts`・`generate.routes*.test.ts`・`pyTemplate.test.ts`・`fakeGenerator.test.ts`・`restRepos.dom.test.ts`・`localReposExtra.dom.test.ts`・`templateCreationService.test.ts`）
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Consumes: Task 1〜3 の新しい API と画面（これらが動いていること）
- Produces: `DROPDOWN_SCOPES = ['edit', 'published']`、`toScope` の既定 `edit`。`recordCreate(attributes, sourceFundCode: string | undefined, loginId)`。`CreateHistoryEntry.basedOnTemplateId` は既存の作成履歴ファイルを読むために optional で残す（書かない）。

- [ ] **Step 1: 削除後の振る舞いを固定するテストを先に書き換える（RED）**

- `templates.routes.test.ts`: 「`scope 省略は台帳 sproc の候補(create)`」を「`scope 省略は edit(filled/ から作る)`」に書き換え（期待値は `scope=edit` のケースと同じ）。`scope=create` が 400 になるケースを足す。`GET /templates/series` が 404 になるケースを足す。
- `generate.routes.test.ts`: 生成で sproc の `生成登録` を呼ばないこと（フェイクへの呼び出しを記録している既存の方法で、`SP.template` が呼ばれないこと）。`basedOnTemplateId` を送っても無視される（スキーマから消えるので素通しされない）こと。
- `sprocFake.test.ts`: `候補` と `生成登録` が「未知の @操作」で失敗するケースに書き換え、既存の `候補` / `生成登録` のケースを削除。
- `fakeGenerator.test.ts`: `basedOnTemplateId` のケースを削除（`sourceFundCode` のケースで置き換わっている）。
- `localReposExtra.dom.test.ts` / `restRepos.dom.test.ts` / `templateCreationService.test.ts`: `resolveFund` / `listSeriesFunds` / `basedOnTemplateId` のケースを削除。

Run: `pnpm exec vitest run --project server editor/server/test/templates.routes.test.ts editor/server/test/generate.routes.test.ts editor/server/test/sprocFake.test.ts` → 書き換えたケースが FAIL。

- [ ] **Step 2: 削除する**

上の Files の順に削除する。要点:
- `template.sql` は `委託会社一覧` / `ファンド一覧` だけ残す。先頭コメントの分岐一覧と「台帳は…」の説明を直す。
- DDL の台帳の節（`01` の「1. テンプレート台帳」、`02` の「テンプレート台帳」の索引 3 本、`03` の `CK_台帳_状態`）を削除し、後続の節番号を詰める。
- `server/db/dev/台帳_削除.sql`:

```sql
/* 既存環境で不要になったテンプレート台帳を消す(任意。editor は読まない)。
   sqlcmd -S <host\instance> -d usrap -E -b -f 65001 -i server\db\dev\台帳_削除.sql */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]', N'U') IS NOT NULL
  DROP TABLE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳];
GO
```

- `templateRepo.ts`: `getDropdownOptions` は `optionsFromMetas(await scanEditableMetas(scope === 'edit'), q)` だけにし、`queryParams` と未使用の import を消す。`registerGenerated` と `listSeriesFunds` を `TemplateRepo` から消す。
- `generate.routes.ts`: `if (!(await pendingExists(id))) await templates.registerGenerated(attributes, id);` を消す（`pendingExists` が他で使われていなければ import も消す）。`basedOnTemplateId` の検査と受け渡しを消す。
- `toScope`: 省略・空文字は `edit`。
- `fake_generate_template.py`: `based_on` の分岐を消す。
- web: `resolveFund` / `listSeriesFunds` / `seriesFetch` / `basedOnTemplateId` の分岐を消す。`HistoryTabView.vue` の列は `e.sourceFundCode ?? e.basedOnTemplateId ?? '—'` のまま（過去の履歴ファイルを表示するため）。
- `editor/server/test/templateRepo.series.test.ts` を削除する。

`pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen`。

- [ ] **Step 3: 残りを grep で確かめる**

Run: `grep -rn "resolveFund\b\|listSeriesFunds\|templatesSeries\|registerGenerated\|生成登録\|'候補'\|FundResolution\|basedOnTemplateId" editor --include=*.ts --include=*.vue --include=*.py --include=*.sql | grep -v node_modules | grep -v /dist/`
Expected: `CreateHistoryEntry` の optional な `basedOnTemplateId`（読み取り用）と `HistoryTabView.vue` の表示だけが残る。

- [ ] **Step 4: 検証とコミット**

Run: `pnpm typecheck` → exit 0。`pnpm run test:editor` → 全件 PASS。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test editor/web/src editor/web/test
git add -A editor/server/db editor/server/src editor/server/test editor/server/scripts editor/server/openapi/openapi.json editor/shared/src editor/web/src editor/web/test
git commit -m "refactor(editor): 使われなくなったテンプレート台帳・系列 API・作成タブの候補を削除する"
```

---

### Task 5: 文書

**Files:**
- Modify: `docs/editor/src/設計正典.md`（DB の守備範囲「DB=台帳」、sproc 7 本 → 8 本、作成タブの候補の出所、Rep1 を sproc 経由で読むこと）
- Modify: `.claude/rules/design-canon-summary.md`（`server/src/db/` — sproc ゲートウェイ 8 本）→ `pnpm run check:canon-summary -- --update`
- Modify: `docs/editor/src/設計書.md`（2.1 節の DB の守備範囲、7 節の図、9.2 節の表、作成タブの説明、改訂履歴）
- Modify: `docs/editor/src/Editor_仕様一覧.md`（作成タブの画面項目、API に companies / funds を追加し series を削除、`GenerateRequest.sourceFundCode`、DB テーブル表から台帳を削除、sproc 表の `template` を `委託会社一覧` / `ファンド一覧` に、`シリーズ` / `一覧` を追加、版と改訂履歴）
- Modify: `docs/editor/src/デプロイ運用手順書.md`（4 章: `series.sql` の追加、Rep1 の SELECT 権限の付け方、台帳を消す任意の手順。3.3 節の手順 1 の小項目に sproc の流し直しと権限、改訂履歴）
- Modify: `docs/editor/src/操作手順書.md`（作成タブの操作。作成済み・系列から作成・コピー元が無いときの警告）
- Modify: `editor/server/db/README.md`（sproc の本数と usp_テンプレート / usp_シリーズの役割、dev/ の 2 ファイル）
- Regenerate: `docs/editor/editor_設計.html`・`docs/editor/editor_手引き.html`（`py -3.13 docs/_build/build_all.py`。手引きの画像は Task 3 の撮影で更新される `create-tab.png` を含む）

- [ ] **Step 1: 原稿を直す**（各ファイルの該当節を、上の内容に合わせて書き換える。権限の付け方は次の SQL を手順書に載せる）

```sql
USE [Rep1];
CREATE USER [<ドメイン>\<editor の実行アカウント>] FOR LOGIN [<ドメイン>\<editor の実行アカウント>];
GRANT SELECT ON [dbo].[Rep1_投委託会社] TO [<ドメイン>\<editor の実行アカウント>];
GRANT SELECT ON [dbo].[Rep1_投信ファンド属性] TO [<ドメイン>\<editor の実行アカウント>];
```

- [ ] **Step 2: 生成と検査**

Run: `py -3.13 docs/_build/build_all.py` → exit 0。`pnpm run test:docs` → PASS。`pnpm run check:canon-summary` → OK。`pnpm run check:comments` → OK。

- [ ] **Step 3: コミット**

```bash
git add docs/editor/src .claude/rules/design-canon-summary.md editor/server/db/README.md docs/editor/editor_設計.html docs/editor/editor_手引き.html docs/editor/images/create-tab.png
git commit -m "docs(editor): 作成タブのファンド属性テーブル起点化と台帳の削除を文書へ反映する"
```

（`.claude/` は git 管理外。`git add` で弾かれたら外してよい。要約ファイルの更新はディスク上で行う。）

---

### Task 6: LocalDB での実 DB 検証と差分パッチ

**Files:**
- なし（検証と配布物の作成。リポジトリの変更が出たら別コミット）

- [ ] **Step 1: LocalDB に検証用 Rep1 と sproc を入れる**

```bash
sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -f 65001 -i editor/server/db/dev/Rep1_検証用.sql
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -b -f 65001 -i editor/server/db/sproc/template.sql
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -b -f 65001 -i editor/server/db/sproc/series.sql
```

- [ ] **Step 2: 実 sproc を確かめる**

```bash
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'委託会社一覧'"
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'ファンド一覧', @委託会社コード=N'AM01'"
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_シリーズ] @操作=N'一覧', @委託会社コード=N'AM01'"
```

Expected: 会社 2 件、AM01 のファンド 5 件、シリーズは 510003 / 510037 / 510155 が `CORE`、他は NULL。

- [ ] **Step 3: rest モードで画面を確かめる**

rest モード（`start.bat dev`、LocalDB の検証ユーザーでログイン）で作成タブを開き、会社名が出ること、AM01 と交付版で検索した表に作成済みの印が出ること、510155 の「系列から作成」で 510003（テンプレなし）を選ぶと警告が出て押せないことを確かめる。確認後はサーバを止める。

- [ ] **Step 4: 差分パッチを作り、検証し、Release に上げる**

`--note` の内容:

```
6. DB へ反映する(sqlcmd。<DBサーバ> は DB_SERVER の値):
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\template.sql
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\series.sql
7. editor を動かすアカウントに Rep1 の 2 テーブルの SELECT 権限を付ける(DBA に依頼。SQL は手順書 4 章)。
8. sproc 2 本(template.sql の 委託会社一覧/ファンド一覧、series.sql の 一覧)のテーブル名・列名は仮。
   実際の名前に合わせて FROM と AS を直してから 6 を流す。
9. 任意: 使わなくなったテンプレート台帳を消す
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\dev\台帳_削除.sql
```

```bash
py -3.13 local-only/make-source-patch/make_source_patch.py --base e82a5c27677376f4db8ba55de12c7e855c60e9e9 --target HEAD --out <scratchpad> --note <note.txt>
```

検証: `e82a5c2` の `git archive` を展開し、別環境と同じ MANIFEST（`git -c core.quotepath=false ls-tree -r --name-only e82a5c2`）と SOURCE-COMMIT（`e82a5c2 のフル SHA` ＋ 空白 ＋ `git show -s --format=%cI e82a5c2`、末尾改行なし）を置いた所へ `--dry-run` → 適用し、`HEAD` の `git archive` ＋ 生成した MANIFEST / SOURCE-COMMIT と `diff -rq` で一致すること。2 回目は「適用済み」、別の SOURCE-COMMIT では中止すること。

push 済み（`git ls-remote origin chore/deps-latest-offline-bundle` が `HEAD`）を確かめてから:

```bash
gh release create patch-e82a5c2-to-<target7> --target <target のフル SHA> --title "ソース差分パッチ e82a5c2 → <target7>" --notes-file <notes.md> --prerelease --latest=false <zip> <zip.sha256>
```
