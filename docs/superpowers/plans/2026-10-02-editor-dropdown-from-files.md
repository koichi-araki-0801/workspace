# editor: 候補ドロップダウンと系列をファイル起点へ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 候補（`GET /api/templates/options`）を画面ごとの出所（`filled/`・`pending/`・台帳）から作り、系列（`GET /api/templates/series`）を `templates/` のファイル走査へ移し、別環境向けの差分パッチを出す。

**Architecture:** サーバの `templateRepo` に「`filled/` + `pending/` を走査して `TemplateMeta` を作る」関数を切り出し、一覧と候補で共用する。候補 API はクエリ `scope`（`edit` / `published` / `create`）で出所を切り替え、`create` だけが従来の sproc `候補` を呼ぶ。web の `SearchFilters` は必須 prop `scope` を各画面から受け取って API へ渡す。

**Tech Stack:** TypeScript（Fastify / Vue 3 / Zod）、vitest、SQL Server 2012 の sproc、Python 3.13（パッチ生成）。

**Spec:** `docs/superpowers/specs/2026-10-02-editor-dropdown-from-files-design.md`

## Global Constraints

- 候補の出所: `edit` = `filled/` + `pending/`（`filled/` にある id は `pending/` 側を除く）、`published` = `filled/` だけ、`create` = sproc `template` の `候補`。
- `scope` 省略（および空文字）は `create`。それ以外の未知の値は 400（`validation`）。
- 候補は「自分より上位の選択だけで絞る」（会社は絞らない／ファンドは会社で／基準日は会社・ファンドで／版種は会社・ファンド・基準日で）。
- 候補・一覧・系列の照合は大文字小文字を区別しない。候補で大文字小文字だけが違う値は 1 つにまとめ、最初に見つかった表記を残す。並びは `localeCompare`。
- 系列は `templates/` のファイル名から作り、会社・版種で絞り、ファンド → 基準日の順に並べる。sproc `template` の `系列` 分岐は削除する。
- 画面の scope: 編集タブ `edit`、比較・結合 `published`、作成タブ `create`。`SearchFilters` の `scope` は必須 prop。
- local モード: `published` のときだけ承認済みに絞る。`metaMatches` は大文字小文字を区別しない。系列はモックのまま。
- コメントに経緯（変更日・移植元・所見番号）を書かない。既存コードのコメント密度に合わせる。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write <対象>` を実行する。
- 型検査は `pnpm typecheck`（`@editor/shared` の先行ビルド込み）。
- 差分パッチの対象は `SOURCE-COMMIT` の先頭が `2f88a2efcd821237ae6c65c150ca45b9c108f686` の環境だけ。

## Review Focus

1. `scope=edit` で `pending/` と `filled/` に同じ id があるとき、候補が二重にならず `filled/` 側で数える（Task 1 のテストで固定）。
2. `filled/` と `pending/` が存在しない環境で `scope=edit` / `published` を呼んでも 500 にならず空の候補を返す（Task 1 の `templateRepo.options.empty.test.ts` で固定）。
3. `scope=edit` / `published` は DB に一切触れない（DB 不在でも候補が返る。Task 1 は `createOfflineSproc` で固定）。
4. 系列で `templates/` に規約外の名前（`readme.html` など）があっても黙って除く（Task 2 のテストで固定）。
5. 作成タブの候補が従来どおり台帳から出る（`scope=create` で sproc を呼ぶ。Task 1 のルートテストで固定）。

---

### Task 1: サーバ — 候補の scope 切り替えと大文字小文字を区別しない照合

**Files:**
- Modify: `editor/shared/src/schemas.ts`（`DropdownQuery` の直後）
- Modify: `editor/shared/src/index.ts`（`DropdownQuery` の型 export の近く、`MAX_NOTE_*` の値 export の近く）
- Modify: `editor/server/src/repositories/templateRepo.ts`
- Modify: `editor/server/src/routes/templates.routes.ts`
- Modify: `editor/server/src/openapi/document.ts:252-258`
- Create: `editor/server/test/templateRepo.options.test.ts`
- Create: `editor/server/test/templateRepo.options.empty.test.ts`
- Modify: `editor/server/test/templates.routes.test.ts:112-138`

**Interfaces:**
- Produces（shared）:
  - `export const DROPDOWN_SCOPES = ['edit', 'published', 'create'] as const;`
  - `export const DropdownScope = z.enum(DROPDOWN_SCOPES);`
  - `export const DropdownOptionsQuery = DropdownQuery.extend({ scope: DropdownScope.optional() });`
  - `export type DropdownScope = z.infer<typeof sch.DropdownScope>;`（index.ts）と `DROPDOWN_SCOPES` の値 export
- Produces（server）: `TemplateRepo.getDropdownOptions(q: DropdownQuery, scope: DropdownScope): Promise<DropdownOptions>`
- Produces（server、Task 2 が使う）: `templateRepo.ts` 内の `sameCi(a: string, b: string): boolean` と `isMeta(m: TemplateMeta | null): m is TemplateMeta`

- [ ] **Step 1: shared に scope の型を足す**

`editor/shared/src/schemas.ts` の `DropdownQuery` 定義の直後に追加する:

```ts
/** 候補の出所。edit = filled/ + pending/、published = filled/ のみ、create = 台帳(sproc `候補`)。 */
export const DROPDOWN_SCOPES = ['edit', 'published', 'create'] as const;
export const DropdownScope = z.enum(DROPDOWN_SCOPES);

/** `GET /templates/options` のクエリ。`scope` 省略時は `create`。 */
export const DropdownOptionsQuery = DropdownQuery.extend({
  scope: DropdownScope.optional(),
});
```

`editor/shared/src/index.ts` の `export type DropdownQuery = …` の直後に:

```ts
export type DropdownScope = z.infer<typeof sch.DropdownScope>;
```

同ファイルの `export { MAX_NOTE_CONTENT_CHARS, … } from './schemas.js';` ブロックの直後に:

```ts
export { DROPDOWN_SCOPES } from './schemas.js';
```

- [ ] **Step 2: 失敗するテストを書く（リポジトリ）**

`editor/server/test/templateRepo.options.test.ts` を作る:

```ts
// =============================================================================
// templateRepo.options.test.ts — 候補の出所を scope で切り替えること
// =============================================================================
// edit は filled/ + pending/、published は filled/ だけ、create は台帳 sproc。ファイル起点の
// scope は DB に触れない(DB 不在の sproc を渡しても候補が返る)。照合は大文字小文字を区別しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-options-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const put = (dir: string, id: string, body = '<p>x</p>') =>
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), body, 'utf8');

type Repo = import('../src/repositories/templateRepo.js').TemplateRepo;

describe('templateRepo.getDropdownOptions の scope', () => {
  let repo: Repo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'pending']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    put('filled', 'smtam_110024_2024-05-17_交付版');
    put('filled', 'SMTAM_510037_2024-05-17_全体版');
    put('filled', 'AM01_510155_20240710_交付版');
    put('filled', 'not-a-template'); // 規約外は黙って除く
    // pending/ のメタは pending/<id>.html と同名の JSON 等の形式に合わせる(下の注記)。
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM02_999999_20261001_交付版', '<p>未確定</p>', '');
    // filled/ と同じ id の pending は filled/ 側で数える(二重にしない)。
    await writePending('AM01_510155_20240710_交付版', '<p>消し残り</p>', '');
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('edit は filled/ と pending/ から作り、DB に触れない', async () => {
    const o = await repo.getDropdownOptions({}, 'edit');
    // smtam / SMTAM のどちらが残るかは readdir の順に依る。1 つにまとまることだけを見る。
    expect(o.companyCodes.map((c) => c.toLowerCase())).toEqual(['am01', 'am02', 'smtam']);
  });

  it('published は pending/ を含めない', async () => {
    const o = await repo.getDropdownOptions({}, 'published');
    expect(o.companyCodes.map((c) => c.toLowerCase())).toEqual(['am01', 'smtam']);
  });

  it('大文字小文字だけが違う値は 1 つにまとめ、絞り込みも区別しない', async () => {
    const o = await repo.getDropdownOptions({ companyCode: 'SMTAM' }, 'edit');
    expect(o.fundCodes).toEqual(['110024', '510037']);
  });

  it('各候補は自分より上位の選択だけで絞る', async () => {
    const o = await repo.getDropdownOptions(
      { companyCode: 'smtam', fundCode: '110024', baseDate: '2024-05-17', editionType: '交付版' },
      'edit',
    );
    expect(o.companyCodes.map((c) => c.toLowerCase())).toEqual(['am01', 'am02', 'smtam']);
    expect(o.fundCodes).toEqual(['110024', '510037']);
    expect(o.baseDates).toEqual(['2024-05-17']);
    expect(o.editionTypes).toEqual(['交付版']);
  });

  it('pending/ と filled/ に同じ id があっても二重にならない', async () => {
    const o = await repo.getDropdownOptions({ companyCode: 'AM01' }, 'edit');
    expect(o.fundCodes).toEqual(['510155']);
  });

  it('create は台帳 sproc を呼ぶ(DB 不在なら失敗する)', async () => {
    await expect(repo.getDropdownOptions({}, 'create')).rejects.toBeTruthy();
  });

  it('一覧の絞り込みも大文字小文字を区別しない', async () => {
    const ids = (await repo.listTemplates({ companyCode: 'Smtam' })).map((m) => m.id);
    expect(ids).toEqual(['smtam_110024_2024-05-17_交付版', 'SMTAM_510037_2024-05-17_全体版']);
  });
});

```

続けて `editor/server/test/templateRepo.options.empty.test.ts` を作る（`config` は import 時に env から決まるので、置き場が無い環境は別ファイルで再現する）:

```ts
// =============================================================================
// templateRepo.options.empty.test.ts — filled/ と pending/ が無い環境でも候補は空で返る
// =============================================================================
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const missing = path.join(os.tmpdir(), `editor-template-repo-options-missing-${process.pid}`);
process.env.DATA_ROOT = missing;
process.env.TEMPLATES_DIR = path.join(missing, 'templates');
process.env.FILLED_DIR = path.join(missing, 'filled');
process.env.CSS_DIR = path.join(missing, 'css');
process.env.PENDING_DIR = path.join(missing, 'pending');
process.env.DRAFTS_DIR = path.join(missing, 'drafts');

describe('置き場が無い環境', () => {
  it('edit / published とも空の候補を返す(500 にしない)', async () => {
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    const repo = createTemplateRepo(createOfflineSproc());
    const none = { companyCodes: [], fundCodes: [], baseDates: [], editionTypes: [] };
    expect(await repo.getDropdownOptions({}, 'edit')).toEqual(none);
    expect(await repo.getDropdownOptions({}, 'published')).toEqual(none);
  });
});
```

`listPendingIds` が置き場の無いときに例外を投げる実装なら、このテストで落ちる。その場合は `scanEditableMetas` 側で空配列へ倒すのではなく、`listPendingIds` の実装（`pendingFiles.ts`）を `listFilledFiles` と同じく `readdir(...).catch(() => [])` に揃える。

- [ ] **Step 3: テストが失敗することを確かめる**

Run: `pnpm vitest run --project server editor/server/test/templateRepo.options.test.ts editor/server/test/templateRepo.options.empty.test.ts`
Expected: FAIL（`getDropdownOptions` が scope を受けず sproc を呼ぶため、DB 不在で失敗する）

- [ ] **Step 4: リポジトリを実装する**

`editor/server/src/repositories/templateRepo.ts`:

import に `type DropdownScope` を足す。`metaMatches` を置き換え、補助関数を足す:

```ts
const ATTR_KEYS = ['companyCode', 'fundCode', 'baseDate', 'editionType'] as const;

/** 大文字小文字を区別しない一致。ファイル名由来の属性と利用者の選択を照合する。 */
export const sameCi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const isMeta = (m: TemplateMeta | null): m is TemplateMeta => m !== null;

/** dropdown query の先頭 `depth` 個の設定済みフィールドにメタが一致するか。 */
function matchesUpTo(m: TemplateMeta, q: DropdownQuery, depth: number): boolean {
  return ATTR_KEYS.slice(0, depth).every((k) => !q[k] || sameCi(m.attributes[k], q[k]));
}

/** dropdown query の設定済み全フィールドにメタが一致するか。 */
function metaMatches(m: TemplateMeta, q: DropdownQuery): boolean {
  return matchesUpTo(m, q, ATTR_KEYS.length);
}

/** 大文字小文字だけが違う値は最初の表記へまとめ、`localeCompare` で並べる。 */
function uniqCi(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** 各候補は自分より上位の選択だけで絞る(sproc `候補` と同じ規則)。 */
function optionsFromMetas(metas: TemplateMeta[], q: DropdownQuery): DropdownOptions {
  const at = (depth: number, key: (typeof ATTR_KEYS)[number]) =>
    uniqCi(metas.filter((m) => matchesUpTo(m, q, depth)).map((m) => m.attributes[key]));
  return {
    companyCodes: at(0, 'companyCode'),
    fundCodes: at(1, 'fundCode'),
    baseDates: at(2, 'baseDate'),
    editionTypes: at(3, 'editionType'),
  };
}

/**
 * 編集タブが扱うテンプレ。`filled/`(確定)に、`includePending` なら `pending/`(生成直後の
 * 未確定)を足す。同じ id が両方に在るときは確定を採る(承認後の pending 削除はベストエフォート)。
 */
async function scanEditableMetas(includePending: boolean): Promise<TemplateMeta[]> {
  const files = await listFilledFiles();
  const confirmed = (await Promise.all(files.map((f) => fileToMeta(f, 'filled')))).filter(isMeta);
  if (!includePending) return confirmed;
  const confirmedIds = new Set(confirmed.map((m) => m.id));
  const pendingIds = (await listPendingIds()).filter((id) => !confirmedIds.has(id));
  const pending = (
    await Promise.all(
      pendingIds.map(async (id): Promise<TemplateMeta | null> => {
        const meta = await fileToMeta(`${id}.html`);
        return meta && { ...meta, status: 'draft', updatedAt: await pendingMtime(id) };
      }),
    )
  ).filter(isMeta);
  return [...confirmed, ...pending];
}
```

`TemplateRepo` インタフェースの `getDropdownOptions` を `getDropdownOptions(q: DropdownQuery, scope: DropdownScope): Promise<DropdownOptions>;` に変える。

`getDropdownOptions` の実装の先頭に分岐を足す:

```ts
    /**
     * 候補の出所は画面ごとに違う。編集タブ(edit)は一覧と同じ filled/ + pending/、比較・結合
     * (published)は承認済みの filled/ だけ、作成タブ(create)は作成可能カタログである台帳。
     */
    async getDropdownOptions(q, scope) {
      if (scope !== 'create') return optionsFromMetas(await scanEditableMetas(scope === 'edit'), q);
      const rows = await sproc.callSproc(SP.template, '候補', queryParams(q));
      // (以下は既存のまま)
```

`listTemplates` の本体を次に置き換える（既存の doc コメントは残す）:

```ts
    async listTemplates(q) {
      return (await scanEditableMetas(true))
        .filter((m) => metaMatches(m, q))
        .sort((a, b) => a.fileName.localeCompare(b.fileName));
    },
```

- [ ] **Step 5: ルートを実装する**

`editor/server/src/routes/templates.routes.ts`:

import を `import { apiPaths, DROPDOWN_SCOPES, type DropdownQuery, type DropdownScope, validation } from '@editor/shared';` にする。`toQuery` の直後に:

```ts
/** `scope` の検査。省略・空文字は作成タブと同じ `create`(変更前の挙動)。 */
function toScope(v: unknown): DropdownScope {
  if (v === undefined || v === '') return 'create';
  if (typeof v === 'string' && (DROPDOWN_SCOPES as readonly string[]).includes(v)) {
    return v as DropdownScope;
  }
  throw validation(`scope は ${DROPDOWN_SCOPES.join(' / ')} のいずれかです`);
}
```

options ルートを次にする:

```ts
  app.get<QueryRec>(apiPaths.templatesOptions, { preHandler: requireAuth }, async (request) => {
    return templates.getDropdownOptions(toQuery(request.query), toScope(request.query.scope));
  });
```

ファイル先頭のコメント「メタデータは台帳 sproc 経由」を「候補(作成タブ)と生成登録は台帳 sproc、一覧・候補(編集/比較/結合)・系列はファイル走査、本体(html/css)はファイル」に直す。

- [ ] **Step 6: OpenAPI 文書を直す**

`editor/server/src/openapi/document.ts` の `getDropdownOptions` の `requestParams: { query: s.DropdownQuery }` を `requestParams: { query: s.DropdownOptionsQuery }` にする。

- [ ] **Step 7: ルートテストを直す・足す**

`editor/server/test/templates.routes.test.ts` の「`GET /templates/options: 台帳 sproc の候補を 4 配列へ束ねる`」は scope 省略 = create の固定として残し、テスト名を「`GET /templates/options: scope 省略は台帳 sproc の候補(create)`」に変える。その直後に足す:

```ts
  it('GET /templates/options: scope=edit は filled/ から作る', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/templates/options?scope=edit',
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      companyCodes: ['AM01'],
      fundCodes: ['510037'],
      baseDates: ['20240710'],
      editionTypes: ['交付版'],
    });
  });

  it('GET /templates/options: 未知の scope は 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/templates/options?scope=all',
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(400);
  });
```

（`beforeAll` が `filled/` に置くのは `AM01_510037_20240710_交付版` の 1 件。フェイク台帳は 8 件なので、edit の結果が 1 件に絞れていればファイル起点であることが分かる。）

- [ ] **Step 8: テストが通ることを確かめる**

Run: `pnpm vitest run --project server editor/server/test/templateRepo.options.test.ts editor/server/test/templateRepo.options.empty.test.ts editor/server/test/templates.routes.test.ts editor/server/test/templateRepo.filled.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: web 側の `TemplateRepository` はまだ変えていないので PASS（server の `TemplateRepo` は server 内の型）。

- [ ] **Step 9: コミット**

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test
git add editor/shared/src/schemas.ts editor/shared/src/index.ts editor/server/src/repositories/templateRepo.ts editor/server/src/routes/templates.routes.ts editor/server/src/openapi/document.ts editor/server/test/templateRepo.options.test.ts editor/server/test/templateRepo.options.empty.test.ts editor/server/test/templates.routes.test.ts
git commit -m "feat(server): 候補の出所を scope で切り替え、編集・比較・結合はファイルから作る"
```

---

### Task 2: サーバ — 系列を templates/ の走査へ移し、sproc の系列分岐を削除する

**Files:**
- Modify: `editor/server/src/files/templateFiles.ts`（`templateMtime` の後）
- Modify: `editor/server/src/repositories/templateRepo.ts`（`listSeriesFunds`、`rowToMeta` の削除）
- Modify: `editor/server/db/sproc/template.sql`
- Modify: `editor/server/db/ddl/01_テーブル.sql:19`
- Modify: `editor/server/test/fakes/sprocFake.ts:112,462-472`
- Modify: `editor/server/test/sprocFake.test.ts:245-315`
- Create: `editor/server/test/templateRepo.series.test.ts`
- Modify: `editor/server/test/templates.routes.test.ts:139-170`

**Interfaces:**
- Consumes: Task 1 の `sameCi` / `isMeta`（`templateRepo.ts` 内）、`fileToMeta(fileName, source = 'template')`（`templateMeta.ts`）
- Produces: `listTemplateFiles(): Promise<string[]>`（`templateFiles.ts`）。`TemplateRepo.listSeriesFunds(companyCode: string, editionType: string): Promise<TemplateMeta[]>`（署名は不変）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/templateRepo.series.test.ts`:

```ts
// =============================================================================
// templateRepo.series.test.ts — 系列は templates/(作成タブの Jinja)のファイル名から作る
// =============================================================================
// 「系列から作る」で生成器が読むのは templates/<ID>.html なので、そこに在るものだけを返す。
// filled/ にしか無いテンプレは出さない。照合は大文字小文字を区別しない。DB に触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-series-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const put = (dir: string, name: string) =>
  fs.writeFileSync(path.join(tmp, dir, name), '<p>{{ x }}</p>', 'utf8');

describe('templateRepo.listSeriesFunds', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    put('templates', 'AM01_510155_20240710_交付版.html');
    put('templates', 'AM01_510037_20250101_交付版.html');
    put('templates', 'AM01_510037_20240710_交付版.html');
    put('templates', 'am01_510124_20251020_交付版.html');
    put('templates', 'AM01_510037_20240710_全体版.html'); // 版種違い
    put('templates', 'AM02_110024_20240710_交付版.html'); // 会社違い
    put('templates', 'readme.html'); // 規約外
    put('filled', 'AM01_999999_20240710_交付版.html'); // filled/ にしか無い
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('会社・版種が一致する templates/ のテンプレをファンド → 基準日の順で返す', async () => {
    const rows = await repo.listSeriesFunds('AM01', '交付版');
    expect(rows.map((m) => m.id)).toEqual([
      'AM01_510037_20240710_交付版',
      'AM01_510037_20250101_交付版',
      'am01_510124_20251020_交付版',
      'AM01_510155_20240710_交付版',
    ]);
    expect(rows[0]).toMatchObject({ status: 'published', fileName: 'AM01_510037_20240710_交付版.html' });
    expect(rows[0].updatedAt).toEqual(expect.any(String));
  });

  it('templates/ が無ければ空', async () => {
    fs.rmSync(path.join(tmp, 'templates'), { recursive: true, force: true });
    expect(await repo.listSeriesFunds('AM01', '交付版')).toEqual([]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `pnpm vitest run --project server editor/server/test/templateRepo.series.test.ts`
Expected: FAIL（`listSeriesFunds` が sproc `系列` を呼び、DB 不在で失敗する）

- [ ] **Step 3: 実装する**

`editor/server/src/files/templateFiles.ts` の `templateMtime` の直後に:

```ts
/** 作成タブの Jinja(`templatesDir`)の `*.html` 一覧(系列の源)。 */
export async function listTemplateFiles(): Promise<string[]> {
  const entries = await fs.readdir(config.templatesDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.html'));
}
```

`editor/server/src/repositories/templateRepo.ts`:
- `listTemplateFiles` を `../files/templateFiles.js` の import に足す。
- `rowToMeta` 関数を削除し、使われなくなった import（`asIso`、`type TemplateStatus` など、型検査と biome が指摘するもの）を外す。
- `listSeriesFunds` を次にする:

```ts
    /**
     * 系列は templates/(作成タブの Jinja)から作る。「系列から作る」で生成器が読むのは
     * `templates/<ID>.html` なので、ここに在るものだけを出す。
     */
    async listSeriesFunds(companyCode, editionType) {
      const metas = (await Promise.all((await listTemplateFiles()).map((f) => fileToMeta(f)))).filter(
        isMeta,
      );
      return metas
        .filter(
          (m) =>
            sameCi(m.attributes.companyCode, companyCode) &&
            sameCi(m.attributes.editionType, editionType),
        )
        .sort(
          (a, b) =>
            a.attributes.fundCode.localeCompare(b.attributes.fundCode) ||
            a.attributes.baseDate.localeCompare(b.attributes.baseDate),
        );
    },
```

`editor/server/db/sproc/template.sql`（UTF-8 BOM を保つ。保存後に先頭 3 バイトが `EF BB BF` であることを確かめる）:
- 先頭コメントを `@操作 で分岐: 候補 / 生成登録` と「台帳は「作成可能カタログ」(作成タブの候補の源)と生成登録のみを担う。既存テンプレの一覧/取得・系列・確定保存・下書き・版/スナップはファイル + git 側(本 sproc 対象外)。」に直す。
- `/* ---- 系列: … */` から、その `IF @操作 = N'系列' … END` ブロックの終わりまでを削除する。

`editor/server/db/ddl/01_テーブル.sql:19` のコメントを「「作成可能カタログ」(作成タブの候補の源)と生成登録のみを担う。テンプレ本体はファイル +」に直す（UTF-8 BOM を保つ）。

`editor/server/test/fakes/sprocFake.ts`:
- 112 行目のコメントを「候補の値がここから出る」にする。
- `if (op === '系列') { … }` ブロックを削除する（未知の操作として `未知の @操作 です(テンプレート)` で失敗するようになり、本物の sproc と揃う）。

`editor/server/test/sprocFake.test.ts`:
- `生成登録` の冪等性テスト（`series.filter((r) => r.基準日 === '20260101')` を見ているもの）は、`系列` の代わりに `候補` で確かめる:

```ts
    const rows = await sproc.callSproc(SP.template, '候補', [
      p('委託会社コード', 'AM01'),
      p('ファンドコード', '510037'),
    ]);
    expect(rows.filter((r) => r.区分 === '基準日' && r.値 === '20260101')).toHaveLength(1);
```

- 「`生成登録 leaves an already registered row untouched`」は削除する。台帳の `状態` / `ファイル名` を読む経路が無くなり、観測できない性質になったため。
- 「`系列 returns the ledger columns …`」と「`系列 needs both …`」は削除し、代わりに足す:

```ts
  it('系列 is no longer an operation (same as the real sproc)', async () => {
    const sproc = await createFakeSproc();
    await expect(
      sproc.callSproc(SP.template, '系列', [p('委託会社コード', 'AM01'), p('版種', '交付版')]),
    ).rejects.toBeTruthy();
  });
```

`editor/server/test/templates.routes.test.ts` の series テスト（139 行目〜）は、400 の 2 ケースを残し、200 のケースを templates/ 起点に直す。`beforeAll` に `templates/` へ 2 件置く処理を足す:

```ts
    fs.writeFileSync(path.join(root, 'data', 'templates', 'AM01_510037_20240710_交付版.html'), '<p>{{ a }}</p>', 'utf8');
    fs.writeFileSync(path.join(root, 'data', 'templates', 'AM01_510037_20240710_全体版.html'), '<p>{{ b }}</p>', 'utf8');
```

200 のケースの期待値:

```ts
    expect((res.json() as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'AM01_510037_20240710_交付版',
    ]);
```

テスト名を「`GET /templates/series: companyCode と editionType が無ければ 400、あれば templates/ を版種で絞る`」に変える。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `pnpm vitest run --project server editor/server/test/templateRepo.series.test.ts editor/server/test/sprocFake.test.ts editor/server/test/templates.routes.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src editor/server/test
git add editor/server/src/files/templateFiles.ts editor/server/src/repositories/templateRepo.ts editor/server/db/sproc/template.sql editor/server/db/ddl/01_テーブル.sql editor/server/test/fakes/sprocFake.ts editor/server/test/sprocFake.test.ts editor/server/test/templateRepo.series.test.ts editor/server/test/templates.routes.test.ts
git commit -m "feat(server): 系列を templates/ の走査から作り、sproc の系列分岐を削除する"
```

---

### Task 3: web — 画面ごとに scope を渡す

**Files:**
- Modify: `editor/shared/src/repositories/TemplateRepository.ts:24`
- Modify: `editor/web/src/api/rest/templateRepo.ts:73-78`
- Modify: `editor/web/src/api/local/templateRepo.ts:181-203`
- Modify: `editor/web/src/api/local/store.ts:200-205`
- Modify: `editor/web/src/features/templates/components/SearchFilters.vue`
- Modify: `editor/web/src/features/templates/EditTabView.vue:60`
- Modify: `editor/web/src/features/merge/MergeTabView.vue:109`
- Modify: `editor/web/src/features/compare/CompareSideSelector.vue:86`
- Modify: `editor/web/src/features/templates/CreateTabView.vue:171`
- Modify: `editor/web/test/restRepos.dom.test.ts:85-86`
- Modify: `editor/web/test/localReposExtra.dom.test.ts:246-280`

**Interfaces:**
- Consumes: Task 1 の `DropdownScope`（`@editor/shared`）
- Produces: `TemplateRepository.getDropdownOptions(query: DropdownQuery, scope: DropdownScope): Promise<Result<DropdownOptions>>`。`SearchFilters` の必須 prop `scope: DropdownScope`

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/restRepos.dom.test.ts` の 85〜86 行を:

```ts
    await restTemplateRepo.getDropdownOptions({}, 'edit');
    expect(calls[1].url).toBe('/api/templates/options?scope=edit');
    await restTemplateRepo.getDropdownOptions({ companyCode: 'AM01' }, 'published');
    expect(calls[2].url).toBe('/api/templates/options?companyCode=AM01&scope=published');
```

`editor/web/test/localReposExtra.dom.test.ts` の既存 2 ケースの `getDropdownOptions(…)` 呼び出しに第 2 引数 `'edit'` を足し、ケースを 2 つ足す:

```ts
  it('getDropdownOptions(published) は承認済みのテンプレだけから作る', async () => {
    const list = await localTemplateRepo.listTemplates({});
    const pub = await localTemplateRepo.getDropdownOptions({}, 'published');
    expect(isOk(list) && isOk(pub)).toBe(true);
    if (!isOk(list) || !isOk(pub)) return;
    const publishedCompanies = new Set(
      list.value.filter((m) => m.status === 'published').map((m) => m.attributes.companyCode),
    );
    expect(new Set(pub.value.companyCodes)).toEqual(publishedCompanies);
  });

  it('listTemplates の絞り込みは大文字小文字を区別しない', async () => {
    const all = await localTemplateRepo.listTemplates({});
    if (!isOk(all) || all.value.length === 0) throw new Error('fixtures が空');
    const company = all.value[0].attributes.companyCode;
    const lower = await localTemplateRepo.listTemplates({ companyCode: company.toLowerCase() });
    const exact = await localTemplateRepo.listTemplates({ companyCode: company });
    expect(isOk(lower) && isOk(exact)).toBe(true);
    if (isOk(lower) && isOk(exact)) expect(lower.value).toEqual(exact.value);
  });
```

（fixtures の会社コード `AM01` は大文字なので、小文字で引いても同じ結果になることを見る。）

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `pnpm vitest run --project "web-*" editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts`
Expected: FAIL（URL に `scope` が付かない、小文字で引くと空）

- [ ] **Step 3: 実装する**

`editor/shared/src/repositories/TemplateRepository.ts`: import に `DropdownScope` を足し、

```ts
  /** 候補。出所は画面ごとに違う(edit / published / create。`DropdownScope` を参照)。 */
  getDropdownOptions(query: DropdownQuery, scope: DropdownScope): Promise<Result<DropdownOptions>>;
```

`editor/web/src/api/rest/templateRepo.ts`:

```ts
  getDropdownOptions: (query: DropdownQuery, scope: DropdownScope) =>
    attemptRest(() =>
      apiFetch<DropdownOptions>(apiPaths.templatesOptions, {
        query: { ...query, scope } as Record<string, string | undefined>,
      }),
    ),
```

`editor/web/src/api/local/store.ts` の `metaMatches`:

```ts
const sameCi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** テンプレートが dropdown query の設定済み全フィールドに一致すれば真(大文字小文字は区別しない)。 */
export const metaMatches = (m: TemplateMeta, q: DropdownQuery): boolean =>
  (!q.companyCode || sameCi(m.attributes.companyCode, q.companyCode)) &&
  (!q.fundCode || sameCi(m.attributes.fundCode, q.fundCode)) &&
  (!q.baseDate || sameCi(m.attributes.baseDate, q.baseDate)) &&
  (!q.editionType || sameCi(m.attributes.editionType, q.editionType));
```

`editor/web/src/api/local/templateRepo.ts` の `getDropdownOptions`:

```ts
  getDropdownOptions: (query: DropdownQuery, scope: DropdownScope) =>
    attempt(() => {
      // 比較・結合(published)は承認済みだけを扱う画面なので、候補も承認済みから作る。
      const metas = allMetas().filter((m) => scope !== 'published' || m.status === 'published');
      // 各候補は「自分より上位の選択」だけで絞る(自分自身・下位は含めない)。そうしないと
      // 最下位の版種を選んだ後にその版種だけへ候補が潰れ、別の版種(例: 全体版)へ戻せない。
      const matchesUpper = (m: TemplateMeta, fields: (keyof TemplateAttributes)[]): boolean =>
        fields.every((f) => {
          const want = query[f];
          return !want || m.attributes[f].toLowerCase() === want.toLowerCase();
        });
      // (以降の return delay({...}) は既存のまま)
```

import に `type DropdownScope` を足す。

`SearchFilters.vue`: `defineProps` の型に必須の `scope` を足す（`withDefaults` の既定値には足さない）:

```ts
    /** 候補の出所(edit = 編集タブ / published = 比較・結合 / create = 作成タブ)。 */
    scope: DropdownScope;
```

import に `type DropdownScope` を足し、`fetchOptions: (q) => repo.getDropdownOptions(q, props.scope),` にする。

各画面:
- `EditTabView.vue:60` → `<SearchFilters scope="edit" @search="search" @restore="search" />`
- `MergeTabView.vue:109` → `<SearchFilters scope="published" @search="search" @restore="search" />`
- `CompareSideSelector.vue:86` の `<SearchFilters` に `scope="published"` を足す
- `CreateTabView.vue:171` の `<SearchFilters` に `scope="create"` を足す

- [ ] **Step 4: テストと型検査が通ることを確かめる**

Run: `pnpm vitest run --project "web-*" editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS（`scope` を渡し忘れた `SearchFilters` があれば vue-tsc が必須 prop の欠落で失敗する）

Run: `pnpm test`
Expected: PASS（`twoSystems.guard.test.ts` を含む）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/shared/src editor/web/src editor/web/test
git add editor/shared/src/repositories/TemplateRepository.ts editor/web/src/api/rest/templateRepo.ts editor/web/src/api/local/templateRepo.ts editor/web/src/api/local/store.ts editor/web/src/features/templates/components/SearchFilters.vue editor/web/src/features/templates/EditTabView.vue editor/web/src/features/merge/MergeTabView.vue editor/web/src/features/compare/CompareSideSelector.vue editor/web/src/features/templates/CreateTabView.vue editor/web/test/restRepos.dom.test.ts editor/web/test/localReposExtra.dom.test.ts
git commit -m "feat(web): 候補の出所を画面ごとの scope で切り替える"
```

---

### Task 4: 文書

**Files:**
- Modify: `docs/editor/src/設計書.md:73-87,183-190,596`
- Modify: `docs/editor/src/デプロイ運用手順書.md`（3.3 節の手順 1 の直後、4 章の適用手順の後）
- 確認: `docs/editor/src/設計正典.md` と `.claude/rules/design-canon-summary.md`（台帳の守備範囲の記述が変わる場合だけ直し、`pnpm run check:canon-summary` を通す）

- [ ] **Step 1: 設計書を直す**

- 73〜79 行の例（`callSproc(SP.template, '候補', ...)`）の前後で、「候補は作成タブだけが台帳 sproc を引く。編集・比較・結合の候補はファイル走査」と分かるように説明文を足す。
- 87 行の「DB の守備範囲」の注記を次の趣旨に直す: 「DB は台帳（作成タブの候補の源）・パーツ・認証・監査のみ。`listTemplates` と、編集・比較・結合の候補（`GET /templates/options?scope=edit|published`）は `filled/` + `pending/` のファイル走査、系列（`GET /templates/series`）は `templates/` のファイル走査で、いずれも sproc を通らない。」
- 190 行の図のノード `S2["sproc<br/>台帳・候補・系列"]` を `S2["sproc<br/>台帳・候補(作成タブ)"]` にする。図に「ファイル」側のノードがあれば、候補(編集/比較/結合)・系列をそちらへ足す。
- 596 行の表の `sproc（候補・系列・生成登録）+ ファイル/git` を `sproc（候補(作成タブ)・生成登録）+ ファイル/git（一覧・候補(編集/比較/結合)・系列）` にする。
- 冒頭の改訂履歴に 1 行足す（既存の書式に合わせる）。

- [ ] **Step 2: デプロイ運用手順書を直す**

3.3 節の手順 1（新版の配置）の直後に手順を足す（以降の番号は送る）:

```markdown
2. sproc `template` を流し直す（`系列` の分岐を削除した版にする）: `sqlcmd -S <host\instance> -d usrap -E -b -f 65001 -i server\db\sproc\template.sql`。流さなくても、使われない分岐が DB に残るだけで動作は変わらない。
```

冒頭の改訂履歴に 1 行足す。

- [ ] **Step 3: 文書のビルド検査**

Run: `pnpm run test:docs`
Expected: PASS

Run: `pnpm run check:canon-summary`
Expected: PASS（設計正典を直した場合は `--update` で SHA を貼り直してから再実行）

- [ ] **Step 4: コミット**

```bash
git add docs/editor/src/設計書.md docs/editor/src/デプロイ運用手順書.md
git commit -m "docs(editor): 候補と系列の出所(ファイル起点)を設計書と手順書へ反映する"
```

---

### Task 5: 差分パッチの生成スクリプトとパッチの公開

**Files:**
- Create: `local-only/make-source-patch/make_source_patch.py`
- Create: `local-only/make-source-patch/templates/apply_patch.py`
- Create: `local-only/make-source-patch/templates/apply_patch.bat`（CRLF・ASCII のみ）
- Create: `local-only/make-source-patch/templates/README.txt`

**Interfaces:**
- Consumes: Task 1〜4 のコミット（target は Task 4 の後の HEAD）
- Produces: `py -3.13 local-only/make-source-patch/make_source_patch.py --base <commit> --target <commit> --out <dir> [--note <追記ファイル>]` → `<dir>/patch-<base7>-to-<target7>/` と同名の `.zip`、`.zip.sha256`

- [ ] **Step 1: 生成スクリプトを書く**

前回の使い捨てスクリプト（37f4c1a → 2f88a2e）を一般化する。仕様:
- `git diff --no-renames --name-status -z <base> <target>` で変更を取り、`D` を `deleted.txt`（UTF-8・1 行 1 パス）、それ以外を `git archive <target> --format=zip -o files.zip -- <paths>` に入れる（`.gitattributes` の改行・BOM が source.zip と同じく反映される）。
- `files.zip` に `MANIFEST`（`git -c core.quotepath=false ls-tree -r --name-only <target>` を UTF-8・BOM 無し・LF で）と `SOURCE-COMMIT`（`<target のフル SHA> <コミット日時 ISO 8601>`、`git show -s --format=%H %cI <target>`）を足す。
- `files.zip` に入った名前が変更ファイルの一覧と一致することを assert する。
- `files.zip.sha256`、`apply_patch.py`（`BASE` / `TARGET` を埋め込む）、`apply_patch.bat`、`README.txt`（base/target/日付、`--note` の内容を差し込む）を出力フォルダへ置き、フォルダごと zip にして `.sha256` も作る。
- `base` が `target` の祖先でなければ中止する（`git merge-base --is-ancestor`）。

`templates/apply_patch.py` は前回のもの（`SOURCE-COMMIT` の照合、適用済みなら何もしない、`files.zip` のハッシュ照合、パスの検査、`bk\patch-backup-<日時>.zip` への退避、削除 → 展開、`--dry-run`）を、`BASE` / `TARGET` をプレースホルダ置換で埋める形にする。

- [ ] **Step 2: 前回分を再現して生成スクリプトを検証する**

Run: `py -3.13 local-only/make-source-patch/make_source_patch.py --base 37f4c1aa8845b98a7b93569578a71b14f05526e1 --target 2f88a2efcd821237ae6c65c150ca45b9c108f686 --out <scratchpad>`
Expected: 変更 255 件・削除 4 件。`37f4c1aa` の `git archive` を展開した所に当てると、Release の `source.zip`（2f88a2e）を展開したものと `diff -rq` で一致する（`bk/` とパッチフォルダは除く）。

- [ ] **Step 3: 今回のパッチを作って検証する**

Run: `py -3.13 local-only/make-source-patch/make_source_patch.py --base 2f88a2efcd821237ae6c65c150ca45b9c108f686 --target HEAD --out <scratchpad> --note <sproc を流し直す手順を書いたファイル>`
検証: `2f88a2e` の `git archive` + その `MANIFEST` / `SOURCE-COMMIT` を展開した所に `--dry-run` → 適用し、`HEAD` の `git archive` + 生成した `MANIFEST` / `SOURCE-COMMIT` と `diff -rq` で一致すること。もう一度実行して「適用済みです」で終わること、`SOURCE-COMMIT` を別の値にした所では中止すること。

`--note` に書く内容（README.txt の手順に差し込む）:

```
6. DB の sproc `template` を流し直す（使われなくなった `系列` の分岐を消す）:
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\template.sql
   流さなくても動作は変わらない。
```

- [ ] **Step 4: push 済みであることを確かめ、Release に上げる**

`git ls-remote origin chore/deps-latest-offline-bundle` が `HEAD` と一致することを確かめる（自動 push が終わっていなければ、ユーザーに `! git push` を頼む）。

```bash
gh release create patch-2f88a2e-to-<target7> --target <target のフル SHA> --title "ソース差分パッチ 2f88a2e → <target7>" --notes-file <notes.md> --prerelease --latest=false <zip> <zip.sha256>
```

notes には、対象（`SOURCE-COMMIT` の先頭が `2f88a2e`）、変更の要点（編集・比較・結合の候補がファイル起点、系列が templates/ 起点）、依存の入れ替え不要、sproc の流し直し（任意）を書く。末尾にセッション URL を付ける。

`local-only/` は git 管理外なので、このタスクのコミットは無い。
