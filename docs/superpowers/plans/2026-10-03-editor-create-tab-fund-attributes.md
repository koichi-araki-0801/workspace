# editor: 作成タブの候補をファンド属性テーブル起点へ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 作成タブの連動プルダウン（会社 → ファンド → 版種）の候補を DB の台帳から `Rep1` のファンド属性テーブル（sproc 経由）へ移し、シリーズから作成ではコピー元のファンドコードを生成器へ渡し、使われなくなる台帳一式を削除する。

**Architecture:** DB は `usp_テンプレート` に `委託会社一覧`（略称付き）/ `ファンド一覧`、新ゲートウェイ `usp_シリーズ` に `一覧` を足し、いずれも `Rep1.dbo.…` を 3 部名で読む（列名は仮で sproc 内に閉じ、`RTRIM(CAST(…))` で返す）。サーバは `companies` / `funds` / `creatable` の 3 ルートを持ち、`creatable` が「作成済み」と「シリーズのコピー元候補（テンプレの有無付き）」を返す。web の作成タブは見た目を保ったまま、Step 1 を専用の連動プルダウンへ差し替え、Step 2 にコピー元候補の表を置く。

**Tech Stack:** TypeScript（Fastify / Vue 3 / Zod / reka-ui）、vitest、Playwright、SQL Server 2012 の sproc、Python 3.13。

**Spec:** `docs/superpowers/specs/2026-10-03-editor-create-tab-fund-attributes-design.md`

**Reviews:** 初版を /dig と Fable でレビューし、指摘（テスト用 QueryFn の操作名の取り出し、既存テスト 2 件の書き換え、台帳削除で壊れるテスト、e2e のボタン名の部分一致、Select のテスト方法、カバレッジ、列の型、会社コードの書式、権限、パッチ README の順序）を反映した版。

## Global Constraints

- DB へは必ず sproc ゲートウェイ経由（却下済み設計 #12）。`Rep1` は usrap の sproc の中で 3 部名で読む。Rep1 は同じサーバで、実行アカウントは既に読める（権限付与の作業は無い）。
- 仮の名前（sproc 内だけに書く）: テーブル `Rep1.dbo.Rep1_投委託会社`・`Rep1.dbo.Rep1_投信ファンド属性`。sproc が返す列名は `委託会社コード`・`委託会社名`・`委託会社略称`・`ファンドコード`・`ファンド名`・`シリーズコード` で固定。各列は `RTRIM(CAST(<列> AS NVARCHAR(n)))`（コード 32、名称 256）で返す。
- 会社コードの使い分け: editor 内の `companyCode`（ファイル名・`TemplateAttributes`・`GenerateRequest`）は **略称**。Rep1 を引くときだけ `rep1CompanyCode`（Rep1 の `委託会社コード`）を使う。
- sproc は 8 本（`usp_シリーズ` 追加）。最終的に `usp_テンプレート` の `@操作` は `委託会社一覧` / `ファンド一覧` だけ。
- 全 SQL ファイルは UTF-8 BOM。SQL Server 2012 互換（DROP + CREATE）。
- 版種は `交付版` / `全体版` の 2 択。
- `created` は `filled/`・`templates/`・`pending/` のどれか、`hasTemplate` は `templates/` だけを見る。基準日は問わず、照合は大文字小文字を区別しない。
- 生成器へ渡す JSON の `sourceFundCode` はシリーズから作成のときだけ、`isRedemption` は true のときだけ付ける（false や未指定ではキー自体を付けない）。
- `GET /templates/options` の `scope` は `edit` / `published` だけ。省略時は `edit`。
- 各コミットで pre-push（`ci-affected` → editor を触ると typecheck + `test:editor` + build + `e2e:editor`）が通ること。フルの pre-push は 10 分を超えうるので、push が終わったかは `git ls-remote` で確かめ、止まっていたらユーザーに `! git push` を頼む。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write <対象>`。vitest はリポジトリ直下から実行する。
- コメントに経緯（変更日・移植元・所見番号）を書かない。
- 見える文言で、仕様書に無いものは変えない（作成履歴の列見出しなど）。

## Review Focus

1. Rep1 の会社コード（`R-AM01` など）と略称（`AM01`）が違っても、作成済み・コピー元の判定とファイル名は略称で行われる（Task 1 のリポジトリテスト、Task 3 の e2e で固定）。
2. シリーズ一覧に行が無いファンド、シリーズコードが NULL のファンドは `seriesFunds` が空（Task 1 で固定）。
3. コピー元テンプレートが無いのに API を直接叩いて `sourceFundCode` を送ると、生成器を呼ばずに 400（Task 2 で固定）。
4. 会社コードの大文字小文字がファイル名と違っても（`am01_…` のファイル）`created` / `hasTemplate` が立つ（Task 1 で固定）。
5. 3 つの選択を素早く変えたとき、古い `creatable` の応答で Step 2 が上書きされない（Task 3 で `useLatest` を使う）。

---

### Task 1: DB とサーバ — 委託会社・ファンド・作成可否の取得 API を追加する

既存の台帳の処理には触らない（削除は Task 4）。

**Files:**
- Modify: `editor/server/db/sproc/template.sql`（`候補` の前に 2 操作を追加、先頭コメント）
- Create: `editor/server/db/sproc/series.sql`、`editor/server/db/dev/Rep1_検証用.sql`
- Modify: `editor/server/src/db/sprocNames.ts`（`series: gw('シリーズ')`、ヘッダの本数）
- Modify: `editor/server/src/files/templateFiles.ts`（`attrKey`・`templateAttrKeys`・`hasTemplateFor`）
- Modify: `editor/server/test/fakes/sprocFake.ts`（`FakeFundSeed.rep1CompanyCode?` / `seriesCode?`、3 操作、ヘッダの本数）、`editor/server/test/sprocFake.test.ts`
- Modify: `editor/shared/src/schemas.ts`、`editor/shared/src/index.ts`、`editor/shared/src/api-paths.ts`
- Modify: `editor/server/src/repositories/templateRepo.ts`、`editor/server/src/routes/templates.routes.ts`、`editor/server/src/openapi/document.ts`
- Create: `editor/server/test/templateRepo.creatable.test.ts`
- Modify: `editor/server/test/templates.routes.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Produces（shared schemas）:
  - `CompanyOption = z.object({ companyCode: z.string(), companyName: z.string(), rep1CompanyCode: z.string() })`
  - `FundOption = z.object({ fundCode: z.string(), fundName: z.string() })`
  - `SeriesFundOption = FundOption.extend({ hasTemplate: z.boolean() })`
  - `CreatableInfo = z.object({ created: z.boolean(), seriesFunds: z.array(SeriesFundOption) })`
  - `FundsQuery = z.object({ rep1CompanyCode: z.string().min(1) })`
  - `CreatableQuery = z.object({ companyCode: z.string().min(1), rep1CompanyCode: z.string().min(1), fundCode: z.string().min(1), editionType: z.string().min(1) })`
  - 型 export（index.ts）: `CompanyOption` / `FundOption` / `SeriesFundOption` / `CreatableInfo`
- Produces（api-paths）: `templatesCompanies: '/templates/companies'`、`templatesFunds: '/templates/funds'`、`templatesCreatable: '/templates/creatable'`
- Produces（`files/templateFiles.ts`、Task 2 も使う）: `attrKey(companyCode, fundCode, editionType): string`、`templateAttrKeys(fileNames: string[]): Set<string>`、`hasTemplateFor(companyCode: string, fundCode: string, editionType: string): Promise<boolean>`
- Produces（server `TemplateRepo`）: `listCompanies(): Promise<CompanyOption[]>`、`listFunds(rep1CompanyCode: string): Promise<FundOption[]>`、`getCreatableInfo(q: { companyCode: string; rep1CompanyCode: string; fundCode: string; editionType: string }): Promise<CreatableInfo>`
- Produces（sprocNames）: `SP.series`

- [ ] **Step 1: sproc と検証用 SQL を書く**

`template.sql` の `/* ---- 候補:` の直前に追加（UTF-8 BOM を保つ。保存後に先頭 3 バイトが `EF BB BF` か確かめる）:

```sql
  /* ---- 委託会社一覧: 作成タブの会社プルダウン(Rep1 のファンド属性系テーブル) ------- */
  /* テーブル名・列名は仮。返す列名は固定で、実際の名前が違うときは FROM と AS を直す。  */
  /* CHAR 型でも末尾空白で照合がずれないよう、文字列化して右の空白を落として返す。       */
  IF @操作 = N'委託会社一覧'
  BEGIN
    SELECT RTRIM(CAST([委託会社コード] AS NVARCHAR(32)))  AS [委託会社コード],
           RTRIM(CAST([委託会社名]     AS NVARCHAR(256))) AS [委託会社名],
           RTRIM(CAST([委託会社略称]   AS NVARCHAR(32)))  AS [委託会社略称]
      FROM [Rep1].[dbo].[Rep1_投委託会社]
      ORDER BY [委託会社コード];
    RETURN;
  END

  /* ---- ファンド一覧: 会社を選んだときに 1 回で引く -------------------------------- */
  IF @操作 = N'ファンド一覧'
  BEGIN
    IF @委託会社コード IS NULL
      THROW 50000, N'委託会社コードが必要です', 1;
    SELECT RTRIM(CAST([ファンドコード] AS NVARCHAR(32)))  AS [ファンドコード],
           RTRIM(CAST([ファンド名]     AS NVARCHAR(256))) AS [ファンド名]
      FROM [Rep1].[dbo].[Rep1_投信ファンド属性]
      WHERE [委託会社コード] = @委託会社コード
      ORDER BY [ファンドコード];
    RETURN;
  END

```

先頭コメントの `@操作 で分岐:` に `委託会社一覧 / ファンド一覧` を足し、「Rep1 は 3 部名で読む（同じサーバ）。返す委託会社略称がファイル名の会社コード」を 1 行足す。

`series.sql`（UTF-8 BOM で新規）:

```sql
/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_シリーズ
 *  @操作 で分岐: 一覧
 *  作成タブの「シリーズから作成」で、同じシリーズのファンド(コピー元の候補)を求める素。
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
    SELECT RTRIM(CAST([ファンドコード] AS NVARCHAR(32))) AS [ファンドコード],
           NULLIF(RTRIM(CAST([シリーズコード] AS NVARCHAR(32))), N'') AS [シリーズコード]
      FROM [Rep1].[dbo].[Rep1_投信ファンド属性]
      WHERE [委託会社コード] = @委託会社コード
      ORDER BY [ファンドコード];
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(シリーズ)', 1;
END
GO
```

`server/db/dev/Rep1_検証用.sql`（UTF-8 BOM。`apply.ps1` は `ddl` / `sproc` / `seed` だけを読むので対象外）:

```sql
/* 検証用: LocalDB に Rep1 と仮の 2 テーブルを作る(本番では流さない)。
   sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -f 65001 -i server\db\dev\Rep1_検証用.sql */
IF DB_ID(N'Rep1') IS NULL CREATE DATABASE [Rep1];
GO
USE [Rep1];
GO
IF OBJECT_ID(N'[dbo].[Rep1_投委託会社]', N'U') IS NULL
  CREATE TABLE [dbo].[Rep1_投委託会社] (
    [委託会社コード] CHAR(4)       NOT NULL PRIMARY KEY,  -- 末尾空白の除去を確かめるため CHAR
    [委託会社名]     NVARCHAR(128) NOT NULL,
    [委託会社略称]   NVARCHAR(32)  NOT NULL
  );
IF OBJECT_ID(N'[dbo].[Rep1_投信ファンド属性]', N'U') IS NULL
  CREATE TABLE [dbo].[Rep1_投信ファンド属性] (
    [ファンドコード]   CHAR(8)       NOT NULL PRIMARY KEY,
    [委託会社コード]   CHAR(4)       NOT NULL,
    [ファンド名]       NVARCHAR(256) NOT NULL,
    [シリーズコード]   NVARCHAR(32)  NULL
  );
GO
DELETE FROM [dbo].[Rep1_投信ファンド属性];
DELETE FROM [dbo].[Rep1_投委託会社];
INSERT INTO [dbo].[Rep1_投委託会社] VALUES
  ('0001', N'三井住友トラスト・アセットマネジメント株式会社', N'AM01'),
  ('0002', N'検証用アセット', N'AM02');
INSERT INTO [dbo].[Rep1_投信ファンド属性] VALUES
  ('110024', '0001', N'高金利ソブリンオープン', NULL),
  ('510003', '0001', N'コア投資戦略ファンド（安定型）', N'CORE'),
  ('510037', '0001', N'コア投資戦略ファンド（切替型）', N'CORE'),
  ('510124', '0001', N'ＳＭＴ ＪＰＸ日経中小型株インデックス・オープン', NULL),
  ('510155', '0001', N'コア投資戦略ファンド（切替型ワイド）', N'CORE'),
  ('900001', '0002', N'検証用ファンド', NULL);
GO
```

（ファンド名は `sprocFake.ts` の `DEFAULT_FUNDS` に合わせる。違えば DEFAULT_FUNDS 側の値をそのまま写す。）

`sprocNames.ts` の `SP` に `series: gw('シリーズ'),` を足し、ファイル先頭の「7 本」の記述を「8 本」にする。

- [ ] **Step 2: sprocFake に操作を足す（RED → GREEN）**

`sprocFake.test.ts` に追加（`TRUST_AM_NAME` は `sprocFake.ts` の会社名定数。export されていなければ export を付けるか、文字列をそのまま書く）:

```ts
  it('委託会社一覧 returns the Rep1 code, name and abbreviation (abbreviation = file company code)', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.template, '委託会社一覧');
    expect(rows).toEqual([
      { 委託会社コード: 'R-AM01', 委託会社名: TRUST_AM_NAME, 委託会社略称: 'AM01' },
    ]);
  });

  it('ファンド一覧 returns the funds of one Rep1 company (case-insensitive) and needs the company', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.template, 'ファンド一覧', [p('委託会社コード', 'r-am01')]);
    expect(rows.map((r) => r.ファンドコード)).toEqual(['110024', '510003', '510037', '510124', '510155']);
    await expect(sproc.callSproc(SP.template, 'ファンド一覧', [])).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('シリーズ 一覧 returns fund and series code (null when not in a series)', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.series, '一覧', [p('委託会社コード', 'R-AM01')]);
    expect(rows).toContainEqual({ ファンドコード: '510037', シリーズコード: 'CORE' });
    expect(rows).toContainEqual({ ファンドコード: '110024', シリーズコード: null });
  });
```

Run: `pnpm exec vitest run --project server editor/server/test/sprocFake.test.ts` → FAIL（未知の @操作）。

`sprocFake.ts`:
- `FakeFundSeed` に `rep1CompanyCode?: string; seriesCode?: string | null;` を足す。`DEFAULT_FUNDS` の `510003` / `510037` / `510155` に `seriesCode: 'CORE'`（local の `SERIES_FUND_CODES` と同じ 3 件）。Rep1 コードの既定は `R-<companyCode>`:

```ts
const rep1Of = (f: FakeFundSeed): string => f.rep1CompanyCode ?? `R-${f.companyCode}`;
```

- テンプレート sproc の分岐（`if (op === '候補')` の前）に:

```ts
    if (op === '委託会社一覧') {
      const byCode = new Map<string, { 名: string; 略: string }>();
      for (const f of funds.values()) {
        if (!byCode.has(rep1Of(f))) byCode.set(rep1Of(f), { 名: f.companyName, 略: f.companyCode });
      }
      return [...byCode.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([委託会社コード, v]) => ({ 委託会社コード, 委託会社名: v.名, 委託会社略称: v.略 }));
    }

    if (op === 'ファンド一覧') {
      const company = text(a, '委託会社コード');
      if (!company) throw sqlError(50000, '委託会社コードが必要です');
      // 実 DB は Japanese_CI_AS 前提なので大文字小文字を区別しない。
      return [...funds.values()]
        .filter((f) => rep1Of(f).toLowerCase() === company.toLowerCase())
        .sort((x, y) => x.code.localeCompare(y.code))
        .map((f) => ({ ファンドコード: f.code, ファンド名: f.name }));
    }
```

- `switch (proc)` に `SP.series` の case を、他のゲートウェイと同じ形で足す:

```ts
    if (op === '一覧') {
      const company = text(a, '委託会社コード');
      if (!company) throw sqlError(50000, '委託会社コードが必要です');
      return [...funds.values()]
        .filter((f) => rep1Of(f).toLowerCase() === company.toLowerCase())
        .sort((x, y) => x.code.localeCompare(y.code))
        .map((f) => ({ ファンドコード: f.code, シリーズコード: f.seriesCode ?? null }));
    }
    throw sqlError(50000, '未知の @操作 です(シリーズ)');
```

- ファイル先頭のゲートウェイの本数の記述を 8 本にする。

再実行して PASS。

- [ ] **Step 3: shared に型とパスを足す**

`schemas.ts` の `GenerateRequest` の直前に Interfaces の 6 スキーマを追加（`CompanyOption` / `FundOption` / `SeriesFundOption` / `CreatableInfo` は `.meta({ id })` 付き。説明: `companyCode`「ファイル名の会社コード(Rep1 の委託会社略称)」、`rep1CompanyCode`「Rep1 の委託会社コード(ファンドを引くときに使う)」、`created`「選んだ会社・ファンド・版種のテンプレートが filled/・templates/・pending/ のどこかにあるか」、`seriesFunds`「同じシリーズの他のファンド(シリーズから作成のコピー元候補)」、`hasTemplate`「コピー元のテンプレートが templates/ に同じ会社・版種で 1 件以上あるか」）。index.ts に 4 型、api-paths.ts に 3 パスを足す。

- [ ] **Step 4: リポジトリとファイル判定のテストを書く（RED）**

`templateRepo.creatable.test.ts`:

```ts
// =============================================================================
// templateRepo.creatable.test.ts — 作成タブの会社・ファンド・作成可否(Rep1 の属性 + ファイル)
// =============================================================================
// 会社・ファンド・シリーズは sproc(Rep1)から、作成済みとコピー元の有無はファイルから決める。
// ファイル名の会社コードは Rep1 の略称で、Rep1 のコードとは書式が違う。
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
const q = (fundCode: string) => ({
  companyCode: 'AM01', rep1CompanyCode: 'R-AM01', fundCode, editionType: '交付版',
});

describe('templateRepo の作成タブ用の問い合わせ', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'pending']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    put('filled', 'am01_110024_20250101_交付版'); // 小文字の会社コード(filled/)
    put('templates', 'AM01_510037_20240710_交付版');
    put('templates', 'AM01_510003_20240710_全体版');
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM01_510124_20261001_交付版', '<p>未確定</p>', '');
    const { createFakeSproc } = await import('./fakes/sprocFake.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(await createFakeSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('hasTemplateFor は templates/ だけを、大文字小文字を区別せずに見る', async () => {
    const { hasTemplateFor } = await import('../src/files/templateFiles.js');
    expect(await hasTemplateFor('am01', '510037', '交付版')).toBe(true);
    expect(await hasTemplateFor('AM01', '510003', '交付版')).toBe(false); // 全体版だけ
    expect(await hasTemplateFor('AM01', '110024', '交付版')).toBe(false); // filled/ にしか無い
  });

  it('委託会社は略称をファイル名の会社コード、Rep1 のコードを rep1CompanyCode で返す', async () => {
    expect(await repo.listCompanies()).toEqual([
      { companyCode: 'AM01', companyName: TRUST_AM_NAME, rep1CompanyCode: 'R-AM01' },
    ]);
  });

  it('ファンドは Rep1 の会社コードで引く', async () => {
    const funds = await repo.listFunds('R-AM01');
    expect(funds.map((f) => f.fundCode)).toEqual(['110024', '510003', '510037', '510124', '510155']);
    expect(await repo.listFunds('R-ZZ99')).toEqual([]);
  });

  it('作成済みは filled/・templates/・pending/ のどれかにあれば立つ(大文字小文字を区別しない)', async () => {
    const created = async (f: string) => (await repo.getCreatableInfo(q(f))).created;
    expect(await created('110024')).toBe(true); // filled/(小文字)
    expect(await created('510037')).toBe(true); // templates/
    expect(await created('510124')).toBe(true); // pending/
    expect(await created('510003')).toBe(false); // 全体版だけ
    expect(await created('510155')).toBe(false);
  });

  it('シリーズの他ファンドをコピー元候補にし、自分は含めず、テンプレの有無を付ける', async () => {
    expect((await repo.getCreatableInfo(q('510155'))).seriesFunds).toEqual([
      { fundCode: '510003', fundName: 'コア投資戦略ファンド（安定型）', hasTemplate: false },
      { fundCode: '510037', fundName: 'コア投資戦略ファンド（切替型）', hasTemplate: true },
    ]);
    expect((await repo.getCreatableInfo(q('110024'))).seriesFunds).toEqual([]);
  });

  it('シリーズ一覧に行が無いファンドも落ちず、seriesFunds は空', async () => {
    const { createSprocClient } = await import('../src/db/sproc.js');
    const { SP } = await import('../src/db/sprocNames.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    // createSprocClient が組む SQL は `EXEC <proc> @操作=?, …` で、@操作 の値は values[0]。
    const sproc = createSprocClient(async (sql, values) => {
      if (sql.includes(SP.series)) return [];
      if (values[0] === 'ファンド一覧') return [{ ファンドコード: '777777', ファンド名: '行なし' }];
      return [];
    });
    const info = await createTemplateRepo(sproc).getCreatableInfo(q('777777'));
    expect(info).toEqual({ created: false, seriesFunds: [] });
  });
});
```

（`TRUST_AM_NAME` は Step 2 と同じ。ファンド名の期待値は `DEFAULT_FUNDS` に合わせる。）

Run: `pnpm exec vitest run --project server editor/server/test/templateRepo.creatable.test.ts` → FAIL。

- [ ] **Step 5: 実装する（GREEN）**

`templateFiles.ts` に追加（`parseTemplateFileName` を import）:

```ts
/** 会社・ファンド・版種のキー(基準日を問わず、大文字小文字を区別しない照合用)。 */
export const attrKey = (companyCode: string, fundCode: string, editionType: string): string =>
  `${companyCode}\u0000${fundCode}\u0000${editionType}`.toLowerCase();

/** ファイル名一覧から、会社・ファンド・版種のキー集合を作る(規約外の名前は捨てる)。 */
export function templateAttrKeys(fileNames: string[]): Set<string> {
  const keys = new Set<string>();
  for (const f of fileNames) {
    const a = parseTemplateFileName(f);
    if (a) keys.add(attrKey(a.companyCode, a.fundCode, a.editionType));
  }
  return keys;
}

/** templates/ に同じ会社・ファンド・版種が 1 件以上あるか(シリーズから作成のコピー元判定)。 */
export async function hasTemplateFor(
  companyCode: string,
  fundCode: string,
  editionType: string,
): Promise<boolean> {
  return templateAttrKeys(await listTemplateFiles()).has(attrKey(companyCode, fundCode, editionType));
}
```

`templateRepo.ts`（import に `type CompanyOption`・`type FundOption`・`type CreatableInfo`、`attrKey`・`templateAttrKeys`・`listTemplateFiles`）。`TemplateRepo` に 3 メソッドを足し、`createTemplateRepo` の中で:

```ts
  async function listFunds(rep1CompanyCode: string): Promise<FundOption[]> {
    const rows = await sproc.callSproc(SP.template, 'ファンド一覧', [
      p('委託会社コード', rep1CompanyCode),
    ]);
    return rows.map((r) => ({ fundCode: asString(r.ファンドコード), fundName: asString(r.ファンド名) }));
  }
```

を置き、返すオブジェクトに:

```ts
    async listCompanies() {
      const rows = await sproc.callSproc(SP.template, '委託会社一覧');
      return rows.map((r) => ({
        companyCode: asString(r.委託会社略称),
        companyName: asString(r.委託会社名),
        rep1CompanyCode: asString(r.委託会社コード),
      }));
    },

    listFunds,

    /**
     * 作成タブ Step 2 の素。作成済みは filled/・templates/・pending/ のどれか、コピー元の有無は
     * 生成器が読む templates/ だけを見る。シリーズは Rep1 の会社コードで引き、名称はファンド一覧から付ける。
     */
    async getCreatableInfo({ companyCode, rep1CompanyCode, fundCode, editionType }) {
      const templateKeys = templateAttrKeys(await listTemplateFiles());
      const createdKeys = new Set([
        ...templateKeys,
        ...templateAttrKeys(await listFilledFiles()),
        ...templateAttrKeys((await listPendingIds()).map((id) => `${id}.html`)),
      ]);
      const created = createdKeys.has(attrKey(companyCode, fundCode, editionType));
      const seriesRows = await sproc.callSproc(SP.series, '一覧', [p('委託会社コード', rep1CompanyCode)]);
      const seriesOf = new Map(
        seriesRows.map((r) => [asString(r.ファンドコード), asStringOrNull(r.シリーズコード)]),
      );
      const series = seriesOf.get(fundCode) ?? null;
      if (!series) return { created, seriesFunds: [] };
      const names = new Map((await listFunds(rep1CompanyCode)).map((f) => [f.fundCode, f.fundName]));
      const seriesFunds = [...seriesOf.entries()]
        .filter(([code, s]) => code !== fundCode && s === series)
        .map(([code]) => ({
          fundCode: code,
          fundName: names.get(code) ?? '',
          hasTemplate: templateKeys.has(attrKey(companyCode, code, editionType)),
        }))
        .sort((a, b) => a.fundCode.localeCompare(b.fundCode));
      return { created, seriesFunds };
    },
```

PASS を確かめる。

- [ ] **Step 6: ルート（RED → GREEN）**

`templates.routes.test.ts` に追加（認証ヘッダは既存の `as('editor')`）:

```ts
  it('GET /templates/companies: 略称と Rep1 コード付きの会社(未ログインは 401)', async () => {
    expect((await app.inject({ method: 'GET', url: '/templates/companies' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/templates/companies', headers: as('editor') });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ companyCode: 'AM01', rep1CompanyCode: 'R-AM01' });
  });

  it('GET /templates/funds: rep1CompanyCode が無ければ 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/templates/funds', headers: as('editor') })).statusCode).toBe(400);
    const res = await app.inject({ method: 'GET', url: '/templates/funds?rep1CompanyCode=R-AM01', headers: as('editor') });
    expect(res.json().map((f: { fundCode: string }) => f.fundCode)).toContain('510037');
  });

  it('GET /templates/creatable: 4 つのどれかが欠けたら 400、そろえば作成済みを返す', async () => {
    const base = `companyCode=AM01&rep1CompanyCode=R-AM01&fundCode=510037&editionType=${encodeURIComponent('交付版')}`;
    for (const drop of ['companyCode', 'rep1CompanyCode', 'fundCode', 'editionType']) {
      const url = `/templates/creatable?${base.split('&').filter((kv) => !kv.startsWith(`${drop}=`)).join('&')}`;
      expect((await app.inject({ method: 'GET', url, headers: as('editor') })).statusCode).toBe(400);
    }
    const res = await app.inject({ method: 'GET', url: `/templates/creatable?${base}`, headers: as('editor') });
    expect(res.json()).toMatchObject({ created: true }); // beforeAll が filled/ に置いた ID
  });
```

FAIL を確かめてから、`templates.routes.ts` に追加（既存の `validateQuery` があればそれに `FundsQuery` / `CreatableQuery` を渡す。無ければこのファイル内に `parseQuery` を置く）:

```ts
function parseQuery<T>(schema: z.ZodType<T>, q: unknown): T {
  const r = schema.safeParse(q);
  if (!r.success) throw validation('クエリが不正です');
  return r.data;
}
```

```ts
  app.get(apiPaths.templatesCompanies, { preHandler: requireAuth }, async () => templates.listCompanies());

  app.get<QueryRec>(apiPaths.templatesFunds, { preHandler: requireAuth }, async (request) => {
    const q = parseQuery(FundsQuery, request.query);
    return templates.listFunds(assertTemplateAttributeToken('委託会社コード', q.rep1CompanyCode));
  });

  app.get<QueryRec>(apiPaths.templatesCreatable, { preHandler: requireAuth }, async (request) => {
    const q = parseQuery(CreatableQuery, request.query);
    return templates.getCreatableInfo({
      companyCode: assertTemplateAttributeToken('会社コード', q.companyCode),
      rep1CompanyCode: assertTemplateAttributeToken('委託会社コード', q.rep1CompanyCode),
      fundCode: assertTemplateAttributeToken('ファンドコード', q.fundCode),
      editionType: assertTemplateAttributeToken('版種', q.editionType),
    });
  });
```

（`assertTemplateAttributeToken` が `R-AM01` の `-` を通すかを `isValidTemplateToken` で確かめる。通らなければ `rep1CompanyCode` の検査は長さと区切り文字（`/` `\` `_`）だけにし、その判断を台帳に Ruling で残す。）

`openapi/document.ts` に 3 パスを、既存の `getDropdownOptions` と同じ書式で足す（`requestParams: { query: s.FundsQuery }` / `s.CreatableQuery`、`'200': json(…, z.array(s.CompanyOption))` / `z.array(s.FundOption)` / `s.CreatableInfo`、`...ERR_400`、`...ERR_401`）。`pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen`。

- [ ] **Step 7: 検証とコミット**

Run: `pnpm typecheck` → exit 0。`pnpm exec vitest run --project server` → 全件 PASS（`openapiArtifact.guard` を含む）。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test
git add editor/server/db/sproc/template.sql editor/server/db/sproc/series.sql editor/server/db/dev/Rep1_検証用.sql editor/server/src/db/sprocNames.ts editor/server/src/files/templateFiles.ts editor/server/test/fakes/sprocFake.ts editor/server/test/sprocFake.test.ts editor/shared/src/schemas.ts editor/shared/src/index.ts editor/shared/src/api-paths.ts editor/server/src/repositories/templateRepo.ts editor/server/src/routes/templates.routes.ts editor/server/src/openapi/document.ts editor/server/openapi/openapi.json editor/server/test/templateRepo.creatable.test.ts editor/server/test/templates.routes.test.ts
git commit -m "feat(server): 作成タブ用に委託会社・ファンド(Rep1 の属性)と作成可否の取得 API を追加する"
```

---

### Task 2: 生成 — コピー元ファンドコードと償還を生成器へ渡す

`basedOnTemplateId` はまだ消さない（web が使っているため。削除は Task 4）。

**Files:**
- Modify: `editor/shared/src/schemas.ts`（`GenerateRequest.sourceFundCode`、`CreateHistoryEntry.sourceFundCode`、`isRedemption` の説明）
- Modify: `editor/server/src/generate/pyTemplate.ts`、`editor/server/src/routes/generate.routes.ts`、`editor/server/src/repositories/historyRepo.ts`
- Modify: `editor/server/scripts/fake_generate_template.py`
- Modify: `editor/server/test/pyTemplate.test.ts`、`editor/server/test/generate.routes.test.ts`、`editor/server/test/fakeGenerator.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Consumes: Task 1 の `hasTemplateFor`（`files/templateFiles.ts`）
- Produces: `GenerateRequest.sourceFundCode?: string`、`CreateHistoryEntry.sourceFundCode?: string`、`GenerateAttributes.sourceFundCode?` / `isRedemption?`、`recordCreate(attributes, source: { basedOnTemplateId?: string; sourceFundCode?: string }, loginId)`

- [ ] **Step 1: テストを書き換え・追加する（RED）**

`pyTemplate.test.ts`（生成器は `execFileMock`、属性は `attrs`、応答は `answerOk()`）:
- 既存「属性 JSON は明示したキーだけで組み…」（`{ ...attrs, isRedemption: true, evil: '<x>' }` を渡して 4 キーを `toEqual`）は、渡す余計なキーを `evil` だけにする（`isRedemption` を外す。期待値は 4 キーのまま）。
- 追加:

```ts
  it('sourceFundCode と isRedemption は指定したときだけ生成器の JSON に入る', async () => {
    answerOk();
    await generateTemplate({ ...attrs, sourceFundCode: '510037', isRedemption: true });
    let args = execFileMock.mock.calls[0][1] as string[];
    expect(JSON.parse(args[args.length - 1])).toEqual({
      companyCode: 'C1', fundCode: 'F1', editionType: 'monthly', baseDate: '20261001',
      sourceFundCode: '510037', isRedemption: true,
    });
    execFileMock.mockClear();
    answerOk();
    await generateTemplate({ ...attrs, isRedemption: false });
    args = execFileMock.mock.calls[0][1] as string[];
    const payload = JSON.parse(args[args.length - 1]);
    expect(payload).not.toHaveProperty('sourceFundCode');
    expect(payload).not.toHaveProperty('isRedemption');
  });

  it('規約外の sourceFundCode は生成器を呼ばずに拒否する(呼び出し元とは独立の防御)', async () => {
    await expect(generateTemplate({ ...attrs, sourceFundCode: '../x' })).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });
```

`generate.routes.test.ts`（生成器は `generateMock`、呼び出しは `generate(body)`、本文の基本は `validBody`、`beforeEach` が `templatesDir` を毎回空にする）:
- 既存「生成器へは検証済みの属性とサーバの基準日だけを渡す(本文の他のキーは渡らない)」は、本文から `isRedemption: true` を外し、残りの余計なキーで「渡らない」ことを確かめる形にする。
- 追加:

```ts
  it('sourceFundCode のコピー元テンプレートが templates/ に無ければ生成器を呼ばずに 400', async () => {
    generateMock.mockClear();
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '999999' });
    expect(res.statusCode).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('規約外の sourceFundCode は 400', async () => {
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '../x' });
    expect(res.statusCode).toBe(400);
  });

  it('コピー元があれば sourceFundCode と isRedemption を生成器へ渡し、作成履歴に残す', async () => {
    fs.writeFileSync(path.join(templatesDir, 'AM01_510037_20240710_交付版.html'), '<p>元</p>', 'utf8');
    generateMock.mockClear();
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037', isRedemption: true });
    expect(res.statusCode).toBe(200);
    expect(generateMock.mock.calls[0][0]).toMatchObject({ sourceFundCode: '510037', isRedemption: true });
    const lines = fs.readFileSync(path.join(root, 'logs', 'history', 'create.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ sourceFundCode: '510037' });
  });

  it('isRedemption が false なら生成器へ渡さない', async () => {
    generateMock.mockClear();
    await generate({ ...validBody, isRedemption: false });
    expect(generateMock.mock.calls[0][0]).not.toHaveProperty('isRedemption');
  });
```

（作成履歴のパスは、このファイル冒頭のコメント（`<LOG_DIR>/history/create.jsonl`）と `LOG_DIR` の設定に合わせる。）

`fakeGenerator.test.ts`（既存の起動方法に合わせる）: `TEMPLATES_DIR` に `AM01_510037_20240101_交付版.html`（`<p>old</p>`）と `am01_510037_20250101_交付版.html`（`<p>new</p>`）を置き、`{ companyCode: 'AM01', fundCode: '510155', editionType: '交付版', baseDate: '20261003', sourceFundCode: '510037' }` で起動すると stdout が `<p>new</p>`（大文字小文字が混在しても基準日で最新を選ぶ）。コピー元が無ければ終了コード 2。`sourceFundCode` が `../x` なら終了コード 2。

Run: `pnpm exec vitest run --project server editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts editor/server/test/fakeGenerator.test.ts` → 新ケースが FAIL。

- [ ] **Step 2: 実装する**

`schemas.ts`:
- `GenerateRequest` に `sourceFundCode: z.string().optional().meta({ description: 'シリーズから作成するときのコピー元ファンドコード(会社と版種は作成先と同じ)' })`。`isRedemption` の説明を「償還ファンドとして作成(生成器へパラメータとして渡す)」に。
- `CreateHistoryEntry` に `sourceFundCode: z.string().optional().meta({ description: 'シリーズから作成したときのコピー元ファンドコード' })`。

`pyTemplate.ts`: `GenerateAttributes` に `sourceFundCode?: string; isRedemption?: boolean;`。`generateTemplate` の先頭（`basedOnTemplateId` の検査と同じ場所）で `if (attrs.sourceFundCode) assertTemplateAttributeToken('コピー元ファンドコード', attrs.sourceFundCode);`。`toGeneratorPayload` に:

```ts
    ...(attrs.sourceFundCode ? { sourceFundCode: attrs.sourceFundCode } : {}),
    ...(attrs.isRedemption ? { isRedemption: true } : {}),
```

`generate.routes.ts`（`basedOnTemplateId` の検査の後）:

```ts
          const sourceFundCode = body.sourceFundCode
            ? assertTemplateAttributeToken('コピー元ファンドコード', body.sourceFundCode)
            : undefined;
          // 画面はコピー元テンプレートが無い候補で作成を止めるが、API を直接呼ばれても同じ結果にする。
          if (
            sourceFundCode &&
            !(await hasTemplateFor(attributes.companyCode, sourceFundCode, attributes.editionType))
          ) {
            throw validation(`コピー元のテンプレートがありません: ${sourceFundCode}`);
          }
```

生成器の呼び出しの引数に `...(sourceFundCode === undefined ? {} : { sourceFundCode })` と `...(body.isRedemption === true ? { isRedemption: true } : {})` を足す。`recordCreate(attributes, { basedOnTemplateId, sourceFundCode }, loginId)`。

`historyRepo.ts` の `recordCreate` の第 2 引数を `source: { basedOnTemplateId?: string; sourceFundCode?: string }` にし、`undefined` でない方だけエントリへ書く。

`fake_generate_template.py`（`based_on` の処理の前。docstring の引数説明に `sourceFundCode?` / `isRedemption?` を足す）:

```python
    source_fund = attrs.get("sourceFundCode")
    if source_fund:
        templates_dir = os.environ.get("TEMPLATES_DIR")
        if not templates_dir:
            print("TEMPLATES_DIR is required when sourceFundCode is given", file=sys.stderr)
            return 2
        if source_fund != os.path.basename(source_fund) or ".." in source_fund or "_" in source_fund:
            print("invalid sourceFundCode", file=sys.stderr)
            return 2
        # 会社・版種は作成先と同じ。基準日(ファイル名の 3 番目のトークン)が最新のものを写す。
        best = None
        for name in os.listdir(templates_dir):
            parts = name[: -len(".html")].split("_") if name.lower().endswith(".html") else []
            if len(parts) != 4:
                continue
            c, f, d, e = parts
            if c.lower() == company.lower() and f == source_fund and e == edition:
                if best is None or d > best[0]:
                    best = (d, name)
        if best is None:
            print(f"source template not found: {source_fund}", file=sys.stderr)
            return 2
        with open(os.path.join(templates_dir, best[1]), encoding="utf-8") as fh:
            sys.stdout.write(fh.read())
            return 0
```

- [ ] **Step 3: 検証とコミット**

`pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen`。`pnpm typecheck` → exit 0。`pnpm exec vitest run --project server` → 全件 PASS。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test
git add editor/shared/src/schemas.ts editor/server/src/generate/pyTemplate.ts editor/server/src/routes/generate.routes.ts editor/server/src/repositories/historyRepo.ts editor/server/scripts/fake_generate_template.py editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts editor/server/test/fakeGenerator.test.ts editor/server/openapi/openapi.json
git commit -m "feat(server): シリーズから作成のコピー元ファンドコードと償還を生成器へ渡す"
```

---

### Task 3: web — 作成タブの候補を Rep1 起点へ差し替え、名称でも絞れるようにする

**Files:**
- Modify: `editor/shared/src/repositories/TemplateRepository.ts`（3 メソッドを追加）
- Modify: `editor/web/src/api/rest/templateRepo.ts`、`editor/web/src/api/local/templateRepo.ts`
- Modify: `editor/web/src/features/templates/services/templateCreationService.ts`
- Create: `editor/web/src/components/ui/comboboxFilter.ts`
- Modify: `editor/web/src/components/ui/Combobox.vue`
- Create: `editor/web/src/features/templates/components/CreateFundSelect.vue`、`editor/web/src/features/templates/components/SeriesSourceTable.vue`
- Modify: `editor/web/src/features/templates/CreateTabView.vue`
- Modify: `editor/web/test/restRepos.dom.test.ts`、`editor/web/test/localReposExtra.dom.test.ts`、`editor/web/test/templateCreationService.test.ts`、`editor/web/test/dropdownScope.guard.test.ts`
- Create: `editor/web/test/comboboxFilter.test.ts`、`editor/web/test/SeriesSourceTable.dom.test.ts`
- Modify: `editor/e2e/create.spec.ts`、`editor/e2e/capture_docs.spec.ts`、`vitest.config.ts`（カバレッジ include に `comboboxFilter.ts`）

**Interfaces:**
- Consumes: Task 1 の `CompanyOption` / `FundOption` / `SeriesFundOption` / `CreatableInfo` / `apiPaths.templatesCompanies|templatesFunds|templatesCreatable`、Task 2 の `GenerateRequest.sourceFundCode`
- Produces:
  - `TemplateRepository.listCompanies(): Promise<Result<CompanyOption[]>>`、`listFunds(rep1CompanyCode: string): Promise<Result<FundOption[]>>`、`getCreatableInfo(q: { companyCode: string; rep1CompanyCode: string; fundCode: string; editionType: string }): Promise<Result<CreatableInfo>>`
  - `filterComboboxOptions(options: { label: string; value: string }[], query: string): { label: string; value: string }[]`
  - `CreateFundSelect.vue`: emits `update: [{ companyCode?: string; rep1CompanyCode?: string; fundCode?: string; editionType?: string }]`
  - `SeriesSourceTable.vue`: props `rows: SeriesFundOption[]`、`disabled?: boolean`、emits `create: [string]`（コピー元ファンドコード）

- [ ] **Step 1: 失敗するテストを書く**

`comboboxFilter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterComboboxOptions } from '@/components/ui/comboboxFilter';

const opts = [
  { label: '三井住友トラスト', value: 'AM01' },
  { label: '510037 コア投資戦略ファンド（切替型）', value: '510037' },
];

describe('filterComboboxOptions', () => {
  it('空の入力は全件', () => expect(filterComboboxOptions(opts, ' ')).toEqual(opts));
  it('値(コード)の前方一致で絞る(大文字小文字を区別しない)', () =>
    expect(filterComboboxOptions(opts, 'am0')).toEqual([opts[0]]));
  it('表示名の部分一致でも絞る', () => {
    expect(filterComboboxOptions(opts, 'トラスト')).toEqual([opts[0]]);
    expect(filterComboboxOptions(opts, '切替')).toEqual([opts[1]]);
  });
  it('どれにも当たらなければ空', () => expect(filterComboboxOptions(opts, 'zzz')).toEqual([]));
});
```

`SeriesSourceTable.dom.test.ts`（`Button` はネイティブの `<button>` を描くので、`data-testid` は Button に付ける。mount の仕方は既存の `*.dom.test.ts` に合わせる）:

```ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SeriesSourceTable from '@/features/templates/components/SeriesSourceTable.vue';

const rows = [
  { fundCode: '510003', fundName: '安定型', hasTemplate: false },
  { fundCode: '510037', fundName: '切替型', hasTemplate: true },
];

describe('SeriesSourceTable', () => {
  it('コピー元テンプレートが無い行は警告を出し、作成ボタンを押せない', () => {
    const w = mount(SeriesSourceTable, { props: { rows } });
    expect(w.text()).toContain('コピー元のテンプレートがありません');
    expect(w.get('[data-testid="series-create-510003"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="series-create-510037"]').attributes('disabled')).toBeUndefined();
  });

  it('作成ボタンでコピー元のファンドコードを emit する', async () => {
    const w = mount(SeriesSourceTable, { props: { rows } });
    await w.get('[data-testid="series-create-510037"]').trigger('click');
    expect(w.emitted('create')?.[0]).toEqual(['510037']);
  });

  it('disabled のときは全行の作成ボタンを押せない', () => {
    const w = mount(SeriesSourceTable, { props: { rows, disabled: true } });
    expect(w.get('[data-testid="series-create-510037"]').attributes('disabled')).toBeDefined();
  });
});
```

`restRepos.dom.test.ts`:

```ts
  it('作成タブの 3 つの問い合わせの URL', async () => {
    const calls = stubFetch(() => json([]));
    await restTemplateRepo.listCompanies();
    expect(calls[0].url).toBe('/api/templates/companies');
    await restTemplateRepo.listFunds('R-AM01');
    expect(calls[1].url).toBe('/api/templates/funds?rep1CompanyCode=R-AM01');
    await restTemplateRepo.getCreatableInfo({ companyCode: 'AM01', rep1CompanyCode: 'R-AM01', fundCode: '510037', editionType: '交付版' });
    expect(calls[2].url).toBe(
      `/api/templates/creatable?companyCode=AM01&rep1CompanyCode=R-AM01&fundCode=510037&editionType=${encodeURIComponent('交付版')}`,
    );
  });
```

`localReposExtra.dom.test.ts`:

```ts
  it('listCompanies / listFunds / getCreatableInfo は fixtures から作る', async () => {
    const companies = await localTemplateRepo.listCompanies();
    expect(isOk(companies) && companies.value[0]).toMatchObject({ companyCode: 'AM01', rep1CompanyCode: 'AM01' });
    const funds = await localTemplateRepo.listFunds('AM01');
    expect(isOk(funds) && funds.value.map((f) => f.fundCode)).toContain('510037');
    const info = await localTemplateRepo.getCreatableInfo({ companyCode: 'AM01', rep1CompanyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
    if (!isOk(info)) throw new Error('getCreatableInfo に失敗');
    expect(info.value.created).toBe(true);
    expect(info.value.seriesFunds.map((s) => s.fundCode)).toEqual(['510003', '510155']);
  });

  it('generate(sourceFundCode) はコピー元ファンドの最新テンプレートの HTML を写す', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const r = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510155', editionType: '全体版', sourceFundCode: '510037' });
    const base = await localTemplateRepo.getTemplate('AM01_510037_20240710_全体版');
    if (!isOk(r) || !isOk(base)) throw new Error('generate か getTemplate に失敗');
    expect(r.value.template.html).toBe(base.value.html);
  });

  it('generate(sourceFundCode) はコピー元テンプレートが無ければ失敗する', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const r = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510155', editionType: '交付版', sourceFundCode: '999999' });
    expect(isOk(r)).toBe(false);
  });
```

`templateCreationService.test.ts`: `listCompanies` / `listFunds` / `getCreatableInfo` の 3 つとも repo へそのまま委譲することを 1 ケースずつ書く（このファイルはカバレッジ対象で、関数単位の閾値がある）。

Run: `pnpm exec vitest run --project "web-*" editor/web/test/comboboxFilter.test.ts editor/web/test/SeriesSourceTable.dom.test.ts editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts editor/web/test/templateCreationService.test.ts` → FAIL。

- [ ] **Step 2: 契約・repo・サービス・絞り込みを実装する**

`TemplateRepository.ts` に 3 メソッドを足す（説明コメント付き）。

rest:

```ts
  listCompanies: () => attemptRest(() => apiFetch<CompanyOption[]>(apiPaths.templatesCompanies)),
  listFunds: (rep1CompanyCode: string) =>
    attemptRest(() => apiFetch<FundOption[]>(apiPaths.templatesFunds, { query: { rep1CompanyCode } })),
  getCreatableInfo: (q) =>
    attemptRest(() => apiFetch<CreatableInfo>(apiPaths.templatesCreatable, { query: { ...q } })),
```

local（`fundMaster` は `store.ts` の `Record<string, FundMaster>`。`name` と `company.{code,name}`。local では Rep1 コードと略称を同じにする）:

```ts
  listCompanies: () =>
    attempt(() => {
      const byCode = new Map<string, string>();
      for (const f of Object.values(fundMaster)) byCode.set(f.company.code, f.company.name);
      return delay(
        [...byCode.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, name]) => ({ companyCode: code, companyName: name, rep1CompanyCode: code })),
      );
    }),

  listFunds: (rep1CompanyCode: string) =>
    attempt(() =>
      delay(
        Object.entries(fundMaster)
          .filter(([, f]) => f.company.code.toLowerCase() === rep1CompanyCode.toLowerCase())
          .map(([fundCode, f]) => ({ fundCode, fundName: f.name }))
          .sort((a, b) => a.fundCode.localeCompare(b.fundCode)),
      ),
    ),

  getCreatableInfo: ({ companyCode, fundCode, editionType }) =>
    attempt(() => {
      const has = (code: string) =>
        allMetas().some(
          (m) =>
            m.attributes.companyCode.toLowerCase() === companyCode.toLowerCase() &&
            m.attributes.fundCode === code &&
            m.attributes.editionType === editionType,
        );
      const seriesFunds = SERIES_FUND_CODES.has(fundCode)
        ? [...SERIES_FUND_CODES]
            .filter((c) => c !== fundCode)
            .sort()
            .map((c) => ({ fundCode: c, fundName: fundMaster[c]?.name ?? '', hasTemplate: has(c) }))
        : [];
      return delay({ created: has(fundCode), seriesFunds });
    }),
```

local の `generate` の `basedOnTemplateId` の分岐の前に:

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

作成履歴のエントリに `...(req.sourceFundCode ? { sourceFundCode: req.sourceFundCode } : {})` を入れる。

`templateCreationService.ts` に 3 メソッドを素通しで足す（`resolveFund` / `listSeriesFunds` は Task 4 まで残す）。

`comboboxFilter.ts`:

```ts
// =============================================================================
// comboboxFilter.ts — Combobox の絞り込み(コードの前方一致 + 表示名の部分一致)
// =============================================================================

type Option = { label: string; value: string };

/** 値(コード)の前方一致、または表示名の部分一致で絞る。大文字小文字は区別しない。空入力は全件。 */
export function filterComboboxOptions(options: Option[], query: string): Option[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) => o.value.toLowerCase().startsWith(q) || o.label.toLowerCase().includes(q),
  );
}
```

`Combobox.vue` の `filtered` を `filterComboboxOptions(normalized.value, search.value)` にし、6〜8 行目と 42 行目のコメントを「値の前方一致または表示名の部分一致」に直す。`vitest.config.ts` のカバレッジ include に `editor/web/src/components/ui/comboboxFilter.ts` を足す（テスト済みの新規ファイルは include に足す規約）。

- [ ] **Step 3: SeriesSourceTable.vue を作る**

`TemplateTable.vue` と同じ表の部品とクラスで、列は「ファンドコード」「ファンド名」「状態」「操作」。

```vue
<script setup lang="ts">
// =============================================================================
// SeriesSourceTable.vue — シリーズから作成のコピー元候補(テンプレが無い行は作成できない)
// =============================================================================
import type { SeriesFundOption } from '@editor/shared';
import { FilePlus2, TriangleAlert } from '@lucide/vue';
// Table / TableHeader / TableRow / TableHead / TableBody / TableCell / Button は TemplateTable.vue と同じ所から import する。

const props = defineProps<{ rows: SeriesFundOption[]; disabled?: boolean }>();
const emit = defineEmits<{ create: [string] }>();
</script>
```

テンプレート部の要点:
- 状態セル: `row.hasTemplate` が false なら `<span class="inline-flex items-center gap-1 text-xs text-destructive"><TriangleAlert class="h-3.5 w-3.5" /> コピー元のテンプレートがありません</span>`、true なら「—」。
- 操作セル: `` <Button :data-testid="`series-create-${row.fundCode}`" variant="outline" size="sm" :disabled="props.disabled || !row.hasTemplate" @click="emit('create', row.fundCode)"><FilePlus2 /> 作成</Button> ``。

- [ ] **Step 4: CreateFundSelect.vue を作る**

`SearchFilters.vue` と同じ `FilterBar` / `FormField` / `Label` / `Combobox` / `Select` で、`bare` 指定（Step の中に埋め込む）・検索ボタン無し・クリアボタンあり。

```vue
<script setup lang="ts">
// =============================================================================
// CreateFundSelect.vue — 作成タブ Step 1 の連動プルダウン(委託会社 → ファンド → 版種)
// =============================================================================
// 候補は Rep1 のファンド属性(サーバの sproc 経由)から取る。会社は開いたとき、ファンドは会社を
// 選んだときに一括取得する。会社の値はファイル名の会社コード(略称)で、ファンドを引くときだけ
// Rep1 の会社コードを使う。
import { type CompanyOption, type FundOption, isErr } from '@editor/shared';
import { computed, onMounted, reactive, ref } from 'vue';
// FilterBar / FormField / Label / Combobox / Select / Button / RotateCcw / toastError は SearchFilters.vue と同じ所から。
import { useLatest } from '@/lib/useLatest';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';
import { useTemplateCreationService } from '../services/templateCreationService';

const EDITION_TYPES = ['交付版', '全体版'];

const emit = defineEmits<{
  update: [{ companyCode?: string; rep1CompanyCode?: string; fundCode?: string; editionType?: string }];
}>();

const service = useTemplateCreationService();
const query = reactive<{ companyCode?: string; fundCode?: string; editionType?: string }>({});
const companies = ref<CompanyOption[]>([]);
const funds = ref<FundOption[]>([]);
const loading = ref(false);
const latestFunds = useLatest();

useUrlQuerySync(query, { keys: ['companyCode', 'fundCode', 'editionType'] });

const rep1Of = (companyCode?: string) =>
  companies.value.find((c) => c.companyCode === companyCode)?.rep1CompanyCode;
const companyOptions = computed(() =>
  companies.value.map((c) => ({ label: c.companyName, value: c.companyCode })),
);
const fundOptions = computed(() =>
  funds.value.map((f) => ({ label: `${f.fundCode} ${f.fundName}`, value: f.fundCode })),
);

function notify() {
  emit('update', { ...query, rep1CompanyCode: rep1Of(query.companyCode) });
}

async function loadFunds(keepFund: boolean) {
  const rep1 = rep1Of(query.companyCode);
  funds.value = [];
  if (!keepFund) {
    query.fundCode = undefined;
    query.editionType = undefined;
  }
  if (!rep1) return notify();
  const isLatest = latestFunds.begin();
  loading.value = true;
  const res = await service.listFunds(rep1);
  loading.value = false;
  if (!isLatest()) return;
  if (isErr(res)) {
    toastError(res.error.message);
    return;
  }
  funds.value = res.value;
  notify();
}

onMounted(async () => {
  loading.value = true;
  const res = await service.listCompanies();
  loading.value = false;
  if (isErr(res)) {
    toastError(res.error.message);
    return;
  }
  companies.value = res.value;
  // URL から復元した選択は保ったままファンドを引く。
  await loadFunds(true);
});

function onCompany() {
  void loadFunds(false);
}
function onFund() {
  query.editionType = undefined;
  notify();
}
function reset() {
  query.companyCode = undefined;
  query.fundCode = undefined;
  query.editionType = undefined;
  funds.value = [];
  notify();
}
</script>
```

テンプレート部: 委託会社（`Combobox`、`:options="companyOptions"`、placeholder「委託会社を入力/選択」、`@update:model-value="onCompany"`）、ファンド（`Combobox`、`:options="fundOptions"`、placeholder「ファンドを入力/選択」、`:disabled="loading || !query.companyCode"`、`@update:model-value="onFund"`）、版種（`Select`、`:options="EDITION_TYPES"`、placeholder「版種を選択」、`:disabled="!query.fundCode"`、`@update:model-value="notify"`）、ラベルに必須の `*`、クリアボタン（`@click="reset"`）。

- [ ] **Step 5: CreateTabView.vue を差し替える**

変える箇所だけ:
- `SearchFilters` を `<CreateFundSelect @update="onUpdate" />` に置き換える（`dropdown-scope` などの属性は消す）。`liveQuery` の型に `rep1CompanyCode` を足す。
- `resolveFund` の watch を `getCreatableInfo` に替える:

```ts
const info = ref<CreatableInfo | null>(null);

watch(
  () => [liveQuery.companyCode, liveQuery.rep1CompanyCode, liveQuery.fundCode, liveQuery.editionType],
  async () => {
    method.value = null;
    info.value = null;
    const { companyCode, rep1CompanyCode, fundCode, editionType } = liveQuery;
    if (!companyCode || !rep1CompanyCode || !fundCode || !editionType) return;
    const isLatest = latestResolve.begin();
    const res = await templates.getCreatableInfo({ companyCode, rep1CompanyCode, fundCode, editionType });
    if (!isLatest()) return;
    if (isErr(res)) {
      toastError(res.error.message);
      return;
    }
    info.value = res.value;
  },
);

const isSeriesFund = computed(() => (info.value?.seriesFunds.length ?? 0) > 0);
```

- `isSeriesFund` の ref、`seriesRows` / `loadSeries` / `latestSeries` と、`method` が `series` のときの watch を消す。
- Step 2 の先頭に、`info?.created` のときの注意（既存の注意枠と同じクラス。文言「この会社・ファンド・版種のテンプレートは作成済みです。作成すると新しい版ができます。」）。
- series の候補表を `<SeriesSourceTable :rows="info?.seriesFunds ?? []" :disabled="creating" @create="createFromSeries" />` にし、案内文を「元にするファンドの「作成」を押すと、そのテンプレートを基にした編集画面に進みます。コピー元のテンプレートが無いファンドは選べません。」にする。
- `createFromSeries(sourceFundCode: string)` は `{ companyCode, fundCode, editionType, sourceFundCode, isRedemption }` で作成する。
- import から `SearchFilters`・`TemplateTable`・`TemplateMeta`（使わなくなれば）を外し、`CreateFundSelect`・`SeriesSourceTable`・`type CreatableInfo` を足す。

`dropdownScope.guard.test.ts` から `CreateTabView.vue` の行を外す。

- [ ] **Step 6: e2e と撮影**

`create.spec.ts` の Step 1 の操作を次にする（以降の検証はそのまま）:

```ts
  await page.getByPlaceholder('委託会社を入力/選択').click();
  await page.getByRole('option', { name: '三井住友トラスト・アセットマネジメント株式会社' }).click();
  await page.getByPlaceholder('ファンドを入力/選択').click();
  await page.getByRole('option', { name: /^510037/ }).click();
  await page.getByRole('combobox').filter({ hasText: '版種を選択' }).click();
  await page.getByRole('option', { name: '交付版', exact: true }).click();
  await page.getByRole('button', { name: '属性から新規作成' }).click();
```

（e2e の既定 project は rest + sprocFake。フェイクの略称は `AM01` なので、生成される ID は従来どおり `AM01_510037_<日付>_交付版`。Rep1 コード `R-AM01` とファイル名の `AM01` が違っても通ることがここで確かめられる。）

`capture_docs.spec.ts` の作成タブ（95〜98 行付近）は `page.goto('/create?companyCode=AM01&fundCode=510037&editionType=' + encodeURIComponent('交付版'))` で開き、「属性から新規作成」ボタンが見えるまで待ってから `create-tab.png` を撮る。

- [ ] **Step 7: 検証とコミット**

Run: `pnpm typecheck` → exit 0。`pnpm run test:editor` → 全件 PASS。`pnpm exec playwright test -c editor/playwright.config.ts --project chromium editor/e2e/create.spec.ts` → PASS。

```bash
pnpm exec biome check --write editor/shared/src editor/web/src editor/web/test editor/e2e
git status --short   # docs/editor/images の再撮影差分は含めない
git add editor/shared/src/repositories/TemplateRepository.ts editor/web/src/api/rest/templateRepo.ts editor/web/src/api/local/templateRepo.ts editor/web/src/features/templates/services/templateCreationService.ts editor/web/src/components/ui/comboboxFilter.ts editor/web/src/components/ui/Combobox.vue editor/web/src/features/templates/components/CreateFundSelect.vue editor/web/src/features/templates/components/SeriesSourceTable.vue editor/web/src/features/templates/CreateTabView.vue editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts editor/web/test/templateCreationService.test.ts editor/web/test/dropdownScope.guard.test.ts editor/web/test/comboboxFilter.test.ts editor/web/test/SeriesSourceTable.dom.test.ts editor/e2e/create.spec.ts editor/e2e/capture_docs.spec.ts vitest.config.ts
git commit -m "feat(web): 作成タブの候補を Rep1 起点にし、シリーズのコピー元を選べるようにする"
```

---

### Task 4: 使われなくなった台帳・系列・候補の処理を削除する

**Files:**
- Modify: `editor/server/db/sproc/template.sql`（`候補`・`生成登録` を削除、先頭コメント）
- Modify: `editor/server/db/ddl/01_テーブル.sql`・`02_索引.sql`・`03_制約.sql`（台帳の節を削除、節番号を詰める）
- Create: `editor/server/db/dev/台帳_削除.sql`
- Modify: `editor/server/test/fakes/sprocFake.ts`、`editor/server/test/sprocFake.test.ts`
- Modify: `editor/server/src/repositories/templateRepo.ts`、`editor/server/src/routes/generate.routes.ts`、`editor/server/src/routes/templates.routes.ts`
- Modify: `editor/server/src/generate/pyTemplate.ts`、`editor/server/scripts/fake_generate_template.py`、`editor/server/src/repositories/historyRepo.ts`
- Modify: `editor/server/src/openapi/document.ts`、`editor/shared/src/schemas.ts`、`editor/shared/src/api-paths.ts`、`editor/shared/src/index.ts`、`editor/shared/src/repositories/TemplateRepository.ts`
- Modify: `editor/web/src/api/rest/templateRepo.ts`、`editor/web/src/api/local/templateRepo.ts`、`editor/web/src/features/templates/services/templateCreationService.ts`、`editor/web/src/features/templates/HistoryTabView.vue`、`editor/web/src/features/templates/components/SearchFilters.vue`、`editor/web/src/api/local/fundRules.ts`（先頭コメントが台帳前提なら）
- Delete: `editor/server/test/templateRepo.series.test.ts`
- Modify: `editor/server/test/templateRepo.options.test.ts`、`templates.routes.test.ts`、`generate.routes.test.ts`、`generate.routes.local.test.ts`、`pyTemplate.test.ts`、`fakeGenerator.test.ts`、`editor/web/test/restRepos.dom.test.ts`、`localReposExtra.dom.test.ts`、`templateCreationService.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Consumes: Task 1〜3 の新しい API と画面
- Produces: `DROPDOWN_SCOPES = ['edit', 'published']`、`toScope` の既定 `edit`。`recordCreate(attributes, sourceFundCode: string | undefined, loginId)`。`CreateHistoryEntry.basedOnTemplateId` は既存の作成履歴ファイルを読むために optional で残す（書かない）。

- [ ] **Step 1: 削除後の振る舞いを固定するテストを先に書き換える（RED）**

- `templates.routes.test.ts`: 「scope 省略は台帳 sproc の候補(create)」を「scope 省略は edit(filled/ から作る)」に書き換え（期待値は `scope=edit` のケースと同じ）。`scope=create` が 400 のケース、`GET /templates/series` が 404 のケースを足す。「クエリが配列…」のケースのコメントから台帳の記述を消す。
- `templateRepo.options.test.ts`: 「create は台帳 sproc を呼ぶ」のケースを削除。
- `generate.routes.test.ts`: 「台帳登録に失敗したら pending も残さない(孤児を作らない)」を削除し、代わりに「生成で `SP.template` を呼ばない」を足す（このファイルの sproc の QueryFn に `if (sql.includes(SP.template)) templateCalls += 1;` を足し、生成後に `templateCalls === 0`）。ファイル冒頭と途中の台帳前提のコメントを直す。`basedOnTemplateId` の 400 のケースは削除。
- `generate.routes.local.test.ts`: 「台帳(sproc)も pending も触らない」を「sproc の `SP.template` を呼ばない、pending も触らない」と言い換える（`ledgerCalls` の名前を `templateCalls` へ）。
- `sprocFake.test.ts`: `候補` と `生成登録` が「未知の @操作」で失敗するケースに書き換え、既存の `候補` / `生成登録` のケースを削除。ファイル先頭の操作数のコメントを直す。
- `pyTemplate.test.ts` / `fakeGenerator.test.ts`: `basedOnTemplateId` のケースを削除。
- web の 3 テスト: `resolveFund` / `listSeriesFunds` / `basedOnTemplateId` のケースを削除。

Run: `pnpm exec vitest run --project server editor/server/test/templates.routes.test.ts editor/server/test/generate.routes.test.ts editor/server/test/sprocFake.test.ts` → 書き換えたケースが FAIL。

- [ ] **Step 2: 削除する**

- `template.sql`: `委託会社一覧` / `ファンド一覧` だけ残し、先頭コメントの分岐一覧と「台帳は…」の説明を直す。
- DDL: `01` の「1. テンプレート台帳」、`02` の「テンプレート台帳」の索引 3 本、`03` の `CK_台帳_状態` を削除し、節番号を詰める。`01` 冒頭の「本テーブル群は台帳・カタログ・認証等のメタのみ」を「カタログ・認証等のメタのみ」へ。
- `server/db/dev/台帳_削除.sql`（UTF-8 BOM）:

```sql
/* 既存環境で不要になったテンプレート台帳を消す(任意。editor は読まない)。
   sqlcmd -S <host\instance> -d usrap -E -b -f 65001 -i server\db\dev\台帳_削除.sql */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]', N'U') IS NOT NULL
  DROP TABLE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳];
GO
```

- `templateRepo.ts`: `getDropdownOptions` は `optionsFromMetas(await scanEditableMetas(scope === 'edit'), q)` だけにし、`queryParams` と未使用 import を消す。`registerGenerated` と `listSeriesFunds` を `TemplateRepo` から消す。`listTemplates` の doc コメントの「`UQ_台帳_属性4`」の段落を、今の理由（生成直後にブラウザを閉じても一覧から辿れる）だけに直す。
- `generate.routes.ts`: `registerGenerated` の呼び出しと `basedOnTemplateId` の検査・受け渡しを消す。`recordCreate(attributes, sourceFundCode, loginId)`。台帳前提のコメントを直す。
- `templates.routes.ts`: series ルートを消す。`toScope` の省略・空文字は `edit`。先頭コメントを「一覧・候補はファイル走査、作成タブの会社・ファンドは Rep1(sproc)」へ。
- `pyTemplate.ts` / `fake_generate_template.py` / `historyRepo.ts`: `basedOnTemplateId` を消す（`recordCreate` は `sourceFundCode` だけを書く）。
- shared: `DROPDOWN_SCOPES = ['edit', 'published']`（コメントから create を消す）、`GenerateRequest.basedOnTemplateId` を削除、`templatesSeries` を削除、`FundResolution` を削除、`TemplateRepository` から `resolveFund` / `listSeriesFunds` を削除。`CreateHistoryEntry.basedOnTemplateId` は説明を「過去の履歴(シリーズの元テンプレ ID)。新しい履歴は sourceFundCode」にして残す。
- web: `resolveFund` / `listSeriesFunds` / `seriesFetch` / `basedOnTemplateId` の分岐を消す。`HistoryTabView.vue:81` は値だけ `e.sourceFundCode ?? e.basedOnTemplateId ?? '—'` にする（列見出し「元テンプレート」は変えない）。`SearchFilters.vue` の `dropdownScope` の説明から create を消す。
- `editor/server/test/templateRepo.series.test.ts` を削除する。
- `sprocFake.ts`: `候補` / `生成登録` と台帳用のデータ（`templates` マップ、`DEFAULT_TEMPLATE_IDS`、`FakeSeed.templateIds`）を消す（`e2e-rest-server.ts` は `createFakeQuery()` を引数無しで呼ぶだけなので影響しない）。

`pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen`。

- [ ] **Step 3: 残りを確かめる**

Run: `rg -n "resolveFund\b|listSeriesFunds|templatesSeries|registerGenerated|生成登録|'候補'|FundResolution|basedOnTemplateId|台帳|7 本|create = 台帳|省略時は .create" editor -g '!**/node_modules/**' -g '!**/dist/**'`
Expected: `CreateHistoryEntry.basedOnTemplateId`（読み取り用）、`HistoryTabView.vue` の表示、`server/db/dev/台帳_削除.sql` 以外に残らない。残っていれば直す。

- [ ] **Step 4: 検証とコミット**

Run: `pnpm typecheck` → exit 0。`pnpm run test:editor` → 全件 PASS。

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test editor/web/src editor/web/test
git add -A editor/server/db editor/server/src editor/server/test editor/server/scripts editor/server/openapi/openapi.json editor/shared/src editor/web/src editor/web/test
git commit -m "refactor(editor): 使われなくなったテンプレート台帳・系列 API・作成タブの台帳候補を削除する"
```

---

### Task 5: 文書

**Files:**
- Modify: `docs/editor/src/設計正典.md`（DB の守備範囲「DB=台帳」→「DB はパーツ・認証・監査・注記マスタと、ファンド属性（Rep1）の参照」、sproc 8 本、作成タブの候補の出所、Rep1 を sproc 経由で読むこと、会社コードは Rep1 の略称を使うこと）
- Modify: `.claude/rules/design-canon-summary.md`（`server/src/db/` — sproc ゲートウェイ 8 本）→ `pnpm run check:canon-summary -- --update`（git 管理外。コミットには含めない）
- Modify: `docs/editor/src/設計書.md`、`docs/editor/src/Editor_仕様一覧.md`、`docs/editor/src/デプロイ運用手順書.md`、`docs/editor/src/操作手順書.md`、`editor/server/db/README.md`
- Regenerate: `docs/editor/editor_設計.html`・`docs/editor/editor_手引き.html`

- [ ] **Step 0: 未コミットの撮影差分を片付ける**

`git status --short docs/editor/images` に差分があれば、「再撮影」として先にコミットする（`docs(editor): 手引きのスクリーンショットを再撮影する`）。HTML は作業ツリーの画像を埋め込むので、これを先にしないと HTML と PNG が食い違う。

- [ ] **Step 1: 原稿を直す**

- 設計書: 2.1 節の DB の守備範囲、7 節の図、9.2 節の表、作成タブの説明、改訂履歴。
- 仕様一覧: 作成タブの画面項目、API に companies / funds / creatable を追加し series を削除、`GenerateRequest.sourceFundCode`、DB テーブル表から台帳を削除、sproc 表を `template`（委託会社一覧 / ファンド一覧）と `シリーズ`（一覧）に、版と改訂履歴。
- 手順書: 4 章に `series.sql` の追加、仮のテーブル名・列名を合わせる箇所、Rep1 が読めることの確かめ方、台帳を消す任意の手順、汎用の DB エラーが出たら Rep1 の SELECT 権限を疑うこと。3.3 節の手順 1 の小項目に sproc の流し直し。改訂履歴。確かめ方:

```
sqlcmd -S <DBサーバ> -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'委託会社一覧'"
```

- 操作手順書: 作成タブ（会社名で選べること・名称の一部で絞れること・作成済みの注意・シリーズから作成・コピー元が無いときの警告）。
- `editor/server/db/README.md`: sproc の本数、usp_テンプレート / usp_シリーズの役割、dev/ の 2 ファイル。

- [ ] **Step 2: 生成と検査**

Run: `py -3.13 docs/_build/build_all.py` → exit 0。`pnpm run test:docs` → PASS。`pnpm run check:canon-summary` → OK。`pnpm run check:comments` → OK。

- [ ] **Step 3: コミット**

```bash
git add docs/editor/src editor/server/db/README.md docs/editor/editor_設計.html docs/editor/editor_手引き.html docs/editor/images/create-tab.png
git commit -m "docs(editor): 作成タブの候補の Rep1 起点化と台帳の削除を文書へ反映する"
```

---

### Task 6: LocalDB での実 DB 検証と差分パッチ

- [ ] **Step 1: 3 部名を含む sproc が Rep1 の無い DB でも作れるかを先に確かめる**

LocalDB に `Rep1` が無い状態で `sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -b -f 65001 -i editor/server/db/sproc/series.sql` を流し、作成できるか（遅延名前解決で通るか）を記録する。通らなければ手順書とパッチの README に「Rep1 のある環境で流す」を明記する。

- [ ] **Step 2: 検証用 Rep1 と sproc を入れ、実 sproc を確かめる**

```bash
sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -f 65001 -i editor/server/db/dev/Rep1_検証用.sql
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -b -f 65001 -i editor/server/db/sproc/template.sql
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -b -f 65001 -i editor/server/db/sproc/series.sql
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'委託会社一覧'"
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'ファンド一覧', @委託会社コード=N'0001'"
sqlcmd -S "(localdb)\MSSQLLocalDB" -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_シリーズ] @操作=N'一覧', @委託会社コード=N'0001'"
```

Expected: 会社 2 件（`0001` / `AM01` の組、末尾空白なし）、`0001` のファンド 5 件、シリーズは 510003 / 510037 / 510155 が `CORE`、他は NULL。

（この端末の LocalDB はログイン中の Windows ユーザーが sysadmin なので、DB をまたぐ権限の問題は再現しない。本番は「既に読める」前提で、手順書に確かめ方を載せている。）

- [ ] **Step 3: rest モードで画面を確かめる（実データに書き込まない）**

`DATA_ROOT` を一時フォルダ（`init-data-repo.bat -DataRoot <一時フォルダ>` で初期化）へ向けた新しいコマンドプロンプトで `start.bat dev` を起動し、LocalDB の検証ユーザーでログインして作成タブを開く。会社名で選べること（名称の一部入力で絞れること）、AM01 / 510155 / 交付版でシリーズの候補に 510003（テンプレなし、警告・押せない）と 510037 が出ることを確かめる。確認後はサーバを止める。

- [ ] **Step 4: 差分パッチを作り、検証し、Release に上げる**

`local-only/make-source-patch/templates/README.txt` の `@@NOTE@@` の位置を、手順 4（適用）と 5（start.bat の起動）の間へ動かす（DB の作業は起動の前に要るため。local-only の雛形の変更として台帳に記録する）。

`--note`:

```
※ 次の a〜c を、手順 5 で start.bat を起動する前に済ませる。
a. sproc 2 本(editor\server\db\sproc\template.sql の 委託会社一覧/ファンド一覧、series.sql の 一覧)の
   仮のテーブル名・列名を実際の名前に合わせる(返す列名 AS … は変えない)。
b. DB へ流す(<DBサーバ> は DB_SERVER の値):
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\template.sql
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\series.sql
c. 確かめる(会社と略称が返ること):
     sqlcmd -S <DBサーバ> -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'委託会社一覧'"
任意: 使わなくなったテンプレート台帳を消す
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\dev\台帳_削除.sql
```

```bash
py -3.13 local-only/make-source-patch/make_source_patch.py --base e82a5c27677376f4db8ba55de12c7e855c60e9e9 --target HEAD --out C:/Users/caads/AppData/Local/Temp/claude/C--Users-caads-workspace/a38df4cf-1686-40cd-aa9e-67b1bf36ec57/scratchpad/patch-out --note <note.txt>
```

検証: `e82a5c2` の `git archive` を展開し、別環境と同じ MANIFEST（`git -c core.quotepath=false ls-tree -r --name-only e82a5c2`）と SOURCE-COMMIT（`e82a5c2 のフル SHA` ＋ 空白 ＋ `git show -s --format=%cI e82a5c2`、末尾改行なし）を置いた所へ `--dry-run` → 適用し、`HEAD` の `git archive` ＋ 生成した MANIFEST / SOURCE-COMMIT と `diff -rq` で一致すること。2 回目は「適用済み」、別の SOURCE-COMMIT では中止すること。

push 済み（`git ls-remote origin chore/deps-latest-offline-bundle` が `HEAD`）を確かめてから:

```bash
gh release create patch-e82a5c2-to-<target7> --target <target のフル SHA> --title "ソース差分パッチ e82a5c2 → <target7>" --notes-file <notes.md> --prerelease --latest=false <zip> <zip.sha256>
```
