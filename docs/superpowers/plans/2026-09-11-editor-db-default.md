# editor: DB モード既定化 + `filled/` 新設 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** editor の既定データモードを `rest`（SQL Server + 認証）にし、DB モードの編集タブが dataRoot の `filled/`（値入り HTML）を読み書きできるようにする。local モードは opt-in として温存する。

**Architecture:** server に `filledDir` とその読み取り層を足し、一覧・取得は `filled/` を主、`templates/`（作成タブの Jinja）と `pending/` を従とする。承認は申請の `origin`（`'edit' | 'create'`）で書込先（`filled/` / `templates/`）を選ぶ。web は `tpl.filled` が非空の文書を「完成描画」として nunjucks を通さずに扱い、既定モードを rest に反転する。e2e は chromium/docs project を sproc フェイク + 一時 dataRoot 方式へ移す。

**Tech Stack:** TypeScript / Fastify / Vue 3 / Vitest / Playwright / PowerShell / cmd バッチ

**Spec:** `docs/superpowers/specs/2026-09-11-editor-db-default-design.md`

## Global Constraints

- local モードの資源（`web/src/api/local/**`・`web/src/api/fixtures/**`・`web/scripts/genFilled.ts`・local 系テスト・`appEpoch`）は削除しない。
- 2 系統原則は不変: 編集タブ = `tpl.filled` + ハイライト無し / 作成タブ = `toFilled(tpl.html, 共通sample)` + ハイライト有り。経路判定は `route.query.created === '1'`（申請では `origin`）だけ。
- 確定テンプレへバイト列を書くのは `server/src/repositories/confirmedWrite.ts` だけ（`atomicWrite` と解決子を同時に import するファイルはここ 1 つ。`confirmedWrite.guard.test.ts` が機械検査）。
- 値入り HTML（`filled/`）に Jinja は残らない。web は `tpl.filled` が非空なら nunjucks（`renderJinjaIsolated`）を通さない。
- コメント規約は `docs/コメント規約.md`（なぜを書く / 経緯・日付・所見番号を書かない）。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write editor/<対象>` を先行実行する。
- `.bat` は編集後に CRLF へ戻す（`Edit`/`Write` は LF で保存する。`unix2dos` か PowerShell で変換する）。日本語を含む `.ps1` は UTF-8 BOM を保つ。
- コミットメッセージは通常の日本語で書き、末尾に `Claude-Session: https://claude.ai/code/session_01MqQNqj2QCN24jXTC7XSUmR` を付ける。
- 各タスクの終わりに `pnpm typecheck:editor` と該当 project の `vitest` を通す（`pnpm exec vitest run --project server <file>` / `--project web-dom` / `--project web-node`）。ルート `vitest.config.ts` の project 名は `shared` / `server` / `web-*`。
- 作業ディレクトリはリポジトリルート `C:\Users\caads\workspace`。パスは特記が無ければルート相対。

---

## ファイル構成（作成 / 変更）

| 区分 | パス | 責務 |
|---|---|---|
| 変更 | `editor/server/src/config.ts` | `filledDir` の追加、`requireAuth` 既定 true、Host 検査コメント |
| 変更 | `editor/server/src/files/templateFiles.ts` | `filled/` の解決子・一覧・読み取り |
| 変更 | `editor/server/src/repositories/templateMeta.ts` | `fileToMeta` の mtime 取得元を切り替え可能に |
| 変更 | `editor/server/src/repositories/templateRepo.ts` | 一覧 = `filled/` + `pending/`、取得順 `filled/` → `templates/` → `pending/` |
| 変更 | `editor/server/src/repositories/confirmedWrite.ts` | `target: 'filled' \| 'template'` による書込先の切替 |
| 変更 | `editor/server/src/repositories/reviewRepo.ts` | `origin` → `target` の写像、基準 HTML の探索順 |
| 変更 | `editor/server/src/repositories/historyRepo.ts` | pathspec を `filled/` へ |
| 変更 | `editor/server/src/sync/pairSyncService.ts` / `noteMasterService.ts` | `target` に応じた読み書き |
| 変更 | `editor/server/scripts/e2e-rest-server.ts` / `e2e-rest-paths.ts` | `filled/` の seed、ポートの既定 24680、`PYTHON_BIN` の既定 |
| 変更 | `editor/scripts/init-data-repo.ps1` | `filled/` の作成 |
| 変更 | `editor/web/src/main.ts` / `lib/storageKeys.ts` / `vite-env.d.ts` | 既定 rest |
| 変更 | `editor/web/src/features/preview/services/templatePreviewService.ts` / `PreviewView.vue` / `lib/pdfDocument.ts` | 値入り文書は `toTemplate` も nunjucks も通さない |
| 変更 | `editor/web/src/features/compare/services/compareService.ts` / `features/reviews/services/{changedSummary,reviewDiffService}.ts` / `features/merge/services/mergePdfService.ts` | 同上 |
| 変更 | `editor/web/src/api/rest/templateRepo.ts` / `stores/auth.ts` | `getSampleData` の sessionStorage キャッシュ |
| 変更 | `editor/web/src/api/local/templateRepo.ts` / `store.ts` | `origin='edit'` の承認は `filled` を更新 |
| 変更 | `editor/start.bat` | 既定 rest |
| 変更 | `offline/setup-offline.ps1` | msnodesqlv8 失敗を fatal に |
| 変更 | `editor/playwright.config.ts` / `package.json` / `editor/e2e/**` | rest フェイク方式への移行 |
| 変更 | `editor/README.md` / `CONTRIBUTING.md` / `docs/editor/src/設計書.md` / `設計正典.md` / `README.md` | 既定 rest の記述 |

---

## Stage 1: server

### Task 1: `config.filledDir` と `init-data-repo.ps1`

**Files:**
- Modify: `editor/server/src/config.ts:48-62`（schema）, `:284-289`（paths）
- Modify: `editor/scripts/init-data-repo.ps1:9`, `:48`
- Test: `editor/server/test/config.paths.test.ts`

**Interfaces:**
- Produces: `config.filledDir: string`（env `FILLED_DIR` < `appconfig.json` `paths.filledDir` < `<dataRoot>/filled`）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/config.paths.test.ts` の `PATH_ENV_KEYS` に `'FILLED_DIR'` を足し（`'CSS_DIR'` の次）、`derives every data directory from DATA_ROOT` に 1 行足す:

```ts
    expect(config.filledDir).toBe(path.join(DATA_ROOT, 'filled'));
```

`lets an explicit per-directory env win over DATA_ROOT` の直後に新しい it を足す:

```ts
  it('lets FILLED_DIR win over DATA_ROOT for the filled directory only', async () => {
    const filledDir = path.resolve(path.sep, 'tmp', 'editor-filled-elsewhere');
    const { config } = await importConfigWithEnv({ DATA_ROOT, FILLED_DIR: filledDir });

    expect(config.filledDir).toBe(filledDir);
    expect(config.templatesDir).toBe(path.join(DATA_ROOT, 'templates'));
  });
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/config.paths.test.ts`
Expected: FAIL（`config.filledDir` が undefined）

- [ ] **Step 3: 実装する**

`config.ts` の schema（`paths` オブジェクト）で `cssDir: z.string().optional(),` の次の行に足す:

```ts
        filledDir: z.string().optional(),
```

`cssDir: resolveDataPath(...)` の直後に足す:

```ts
  /**
   * 値入り HTML(filled)を置くディレクトリ。編集タブが読み書きする本文で、別ツールが
   * `<テンプレID>.html` を置き、承認(`origin='edit'`)が上書きする。`templatesDir` は作成タブの
   * Jinja スケルトン専用で、両者を同じフォルダに置くと一覧走査が互いを別テンプレとして拾う。
   * git 管理**内**(承認コミットに本文と一緒に載せる。管理外だと巻き戻しで本文だけが戻る)。
   */
  filledDir: resolveDataPath(process.env.FILLED_DIR, file.paths?.filledDir, 'filled'),
```

`editor/scripts/init-data-repo.ps1` の 9 行目のコメント `templates/ css/ drafts/ pending/` を `templates/ filled/ css/ drafts/ pending/` に、48 行目の `foreach ($d in 'templates', 'css', 'drafts', 'pending')` を `foreach ($d in 'templates', 'filled', 'css', 'drafts', 'pending')` にする。`.ps1` は UTF-8 BOM を保つ（`Get-Content -Encoding utf8` で読み `Set-Content -Encoding utf8` で書くか、エディタで BOM 付き保存）。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/config.paths.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/config.ts editor/server/test/config.paths.test.ts
git add editor/server/src/config.ts editor/server/test/config.paths.test.ts editor/scripts/init-data-repo.ps1
git commit -m "feat(server): 値入り HTML の置き場 filledDir を設定に足す"
```

---

### Task 2: `files/templateFiles.ts` に `filled/` の読み取り層を足す

**Files:**
- Modify: `editor/server/src/files/templateFiles.ts`
- Modify: `editor/server/test/confirmedWrite.guard.test.ts:76-90`
- Test: `editor/server/test/filledFiles.test.ts`（新規）

**Interfaces:**
- Produces:
  - `filledPath(fileName: string): string`（`assertTemplateFileName` を内蔵。書込側専用）
  - `listFilledFiles(): Promise<string[]>`
  - `filledMtime(fileName: string): Promise<string | null>`
  - `filledExists(fileName: string): Promise<boolean>`
  - `readFilledHtml(fileName: string): Promise<string>`（規約外・ENOENT は `''`、他は throw）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/filledFiles.test.ts`:

```ts
// =============================================================================
// filledFiles.test.ts — 値入り HTML(filled/)の読み取り層の単体テスト
// =============================================================================
// `templateFiles.ts` の filled 版が templates 版と同じ規約(名前検査の内蔵・ENOENT は空文字・
// 一覧は拡張子で絞る)で動くことを固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-filled-files-'));
process.env.DATA_ROOT = tmp;
process.env.FILLED_DIR = path.join(tmp, 'filled');

const ID = 'AM01_510037_20240710_交付版';

describe('filled/ の読み取り層', () => {
  let mod: typeof import('../src/files/templateFiles.js');

  beforeAll(async () => {
    mod = await import('../src/files/templateFiles.js');
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'filled', `${ID}.html`), '<p>値入り</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'filled', 'memo.txt'), 'x', 'utf8');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('filledPath は filledDir と連結し、規約外の名前は例外にする', () => {
    expect(mod.filledPath(`${ID}.html`)).toBe(path.join(tmp, 'filled', `${ID}.html`));
    expect(() => mod.filledPath('../x.html')).toThrow();
  });

  it('listFilledFiles は *.html だけを返す', async () => {
    expect(await mod.listFilledFiles()).toEqual([`${ID}.html`]);
  });

  it('readFilledHtml は本文を返し、無いファイルと規約外の名前は空文字にする', async () => {
    expect(await mod.readFilledHtml(`${ID}.html`)).toBe('<p>値入り</p>');
    expect(await mod.readFilledHtml('AM01_999999_20240710_交付版.html')).toBe('');
    expect(await mod.readFilledHtml('../x.html')).toBe('');
  });

  it('filledExists / filledMtime は有無を返す', async () => {
    expect(await mod.filledExists(`${ID}.html`)).toBe(true);
    expect(await mod.filledExists('AM01_999999_20240710_交付版.html')).toBe(false);
    expect(await mod.filledMtime(`${ID}.html`)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await mod.filledMtime('../x.html')).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/filledFiles.test.ts`
Expected: FAIL（`filledPath` 等が無い）

- [ ] **Step 3: 実装する**

`templateFiles.ts` の `cssPath` の直後に足す:

```ts
/**
 * 値入り HTML(`filledDir`)の解決子。`templatePath` と同じく名前検査を内蔵し、書込側
 * (`confirmedWrite.ts`)だけが使う。読み取りは下の `readFilledHtml` 等を通す。
 */
export const filledPath = (fileName: string): string =>
  path.join(config.filledDir, assertTemplateFileName(fileName));
```

`cssPathOrNull` の直後に足す:

```ts
const filledPathOrNull = (fileName: string): string | null => {
  try {
    return filledPath(fileName);
  } catch {
    return null;
  }
};
```

ファイル末尾に足す:

```ts
// ── filled/(値入り HTML)。templates/ と同じ規約で、置き場だけが違う ──

/** 値入り HTML の `*.html` 一覧(編集タブの一覧はここが源)。 */
export async function listFilledFiles(): Promise<string[]> {
  const entries = await fs.readdir(config.filledDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.html'));
}

/** 値入り HTML の最終更新時刻(ISO)。無ければ(名前が規約外なら)null。 */
export function filledMtime(fileName: string): Promise<string | null> {
  const p = filledPathOrNull(fileName);
  if (!p) return Promise.resolve(null);
  return fs
    .stat(p)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/** 値入り HTML が存在するか(名前が規約外なら false)。 */
export function filledExists(fileName: string): Promise<boolean> {
  const p = filledPathOrNull(fileName);
  if (!p) return Promise.resolve(false);
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * 値入り HTML を読む。`readTemplateHtml` と同方針で、規約外の名前と ENOENT だけを
 * 空文字へ倒し、それ以外の読み取り失敗は例外にする(承認の基準と履歴の入力になるため)。
 */
export function readFilledHtml(fileName: string): Promise<string> {
  const p = filledPathOrNull(fileName);
  if (!p) return Promise.resolve('');
  return fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
}
```

ファイル冒頭コメントの「`templatesDir` / `cssDir` へバイト列を書けるのは…」に準じ、2 行目の見出しを `templateFiles.ts — 確定 template 本体(HTML)・値入り HTML(filled)・ファンド別共有 CSS(ディスク I/O)` に直す。

`editor/server/test/confirmedWrite.guard.test.ts` の 76〜90 行付近、`templatePath / cssPath を import してよいのは confirmedWrite.ts だけ` の正規表現 `/\b(templatePath|cssPath)\b/` を `/\b(templatePath|cssPath|filledPath)\b/` に、it の題名を `templatePath / cssPath / filledPath を import してよいのは confirmedWrite.ts だけ` にする。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/filledFiles.test.ts editor/server/test/confirmedWrite.guard.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/files/templateFiles.ts editor/server/test/filledFiles.test.ts editor/server/test/confirmedWrite.guard.test.ts
git add editor/server/src/files/templateFiles.ts editor/server/test/filledFiles.test.ts editor/server/test/confirmedWrite.guard.test.ts
git commit -m "feat(server): filled/ の読み取り層を templateFiles に足す"
```

---

### Task 3: 一覧は `filled/` + `pending/`、取得は `filled/` → `templates/` → `pending/`

**Files:**
- Modify: `editor/server/src/repositories/templateMeta.ts`
- Modify: `editor/server/src/repositories/templateRepo.ts:143-199`
- Test: `editor/server/test/templateRepo.filled.test.ts`（新規）

**Interfaces:**
- Produces: `fileToMeta(fileName: string, source: 'template' | 'filled' = 'template')`
- `getTemplate(id)` は `filled/` にあるとき `{ html: <filled 本文>, filled: <filled 本文>, css, meta(status:'published') }` を返す

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/templateRepo.filled.test.ts`:

```ts
// =============================================================================
// templateRepo.filled.test.ts — 編集タブの一覧・取得が filled/ を主、templates/ を従とすること
// =============================================================================
// 値入り HTML(filled/)を置いたテンプレだけが一覧に出て、取得は filled/ の本文を `html` と
// `filled` の両方に返す。templates/(作成タブの Jinja)にしか無い id は一覧に出ないが、
// 取得では読める(作成経路の承認直後に精査画面が確定版を読むため)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-filled-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const FILLED_ID = 'AM01_510037_20240710_交付版';
const JINJA_ONLY_ID = 'AM01_510037_20240710_全体版';
const BOTH_ID = 'AM01_110024_20251117_交付版';

describe('templateRepo と filled/', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'css', 'pending']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, 'filled', `${FILLED_ID}.html`), '<p>値入り 510037</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'templates', `${JINJA_ONLY_ID}.html`), '<p>{{ x }}</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'templates', `${BOTH_ID}.html`), '<p>{{ y }}</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'filled', `${BOTH_ID}.html`), '<p>値入り 110024</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', '510037.css'), '.a{}', 'utf8');
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('一覧は filled/ にあるテンプレだけを published として返す', async () => {
    const ids = (await repo.listTemplates({})).map((m) => `${m.id}:${m.status}`);
    expect(ids).toEqual([`${BOTH_ID}:published`, `${FILLED_ID}:published`]);
  });

  it('取得は filled/ の本文を html と filled の両方に返す', async () => {
    const t = await repo.getTemplate(FILLED_ID);
    expect(t.html).toBe('<p>値入り 510037</p>');
    expect(t.filled).toBe('<p>値入り 510037</p>');
    expect(t.css).toBe('.a{}');
    expect(t.meta.status).toBe('published');
  });

  it('filled/ と templates/ の両方にあれば filled/ が勝つ', async () => {
    const t = await repo.getTemplate(BOTH_ID);
    expect(t.html).toBe('<p>値入り 110024</p>');
  });

  it('templates/ にしか無い id は一覧に出ないが取得はできる(filled は空)', async () => {
    const t = await repo.getTemplate(JINJA_ONLY_ID);
    expect(t.html).toBe('<p>{{ x }}</p>');
    expect(t.filled).toBe('');
  });

  it('どこにも無い id は notFound', async () => {
    await expect(repo.getTemplate('AM01_999999_20240710_交付版')).rejects.toMatchObject({
      kind: 'notFound',
    });
  });
});
```

`./helpers/offlineSproc.js` は既存（`reviews.test.ts` が使う）。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/templateRepo.filled.test.ts`
Expected: FAIL（一覧が空 / `filled` が `''`）

- [ ] **Step 3: 実装する**

`templateMeta.ts` を次に置き換える（import に `filledMtime` を足す）:

```ts
import { parseTemplateFileName, type TemplateMeta, templateIdFromFileName } from '@editor/shared';
import { filledMtime, templateMtime } from '../files/templateFiles.js';

/**
 * ファイル名 + 更新時刻から `TemplateMeta` を組む(台帳は引かない)。`source` は更新時刻を
 * どちらの実体から取るか。編集タブの一覧は値入り HTML(`filled`)の時刻を出す。
 */
export async function fileToMeta(
  fileName: string,
  source: 'template' | 'filled' = 'template',
): Promise<TemplateMeta | null> {
  const attrs = parseTemplateFileName(fileName);
  if (!attrs) return null;
  return {
    id: templateIdFromFileName(fileName),
    attributes: attrs,
    fileName,
    // 本体ファイルが在る分は published 扱い(確定状態は git コミット有無で表す予定)。
    status: 'published',
    updatedAt: source === 'filled' ? await filledMtime(fileName) : await templateMtime(fileName),
    updatedBy: null,
  };
}
```

`templateRepo.ts`: import に `filledExists, listFilledFiles, readFilledHtml` を足す（`../files/templateFiles.js` の既存 import に追加）。`listTemplates` の冒頭 `const files = await listTemplateFiles();` を `const files = await listFilledFiles();` に、`files.map(fileToMeta)` を `files.map((f) => fileToMeta(f, 'filled'))` にする。doc comment の 1 行目を「既存テンプレの一覧は台帳でなく `filled/`(値入り HTML = 編集タブの本文)と `pending/`(生成直後の未確定実体)のファイル走査から導く。`templates/`(作成タブの Jinja)は一覧に出さない — 値入り HTML が無いテンプレを編集して申請する事故を防ぐため。」に直す。`listTemplateFiles` の import が未使用になったら外す。

`getTemplate` を次に置き換える:

```ts
    /**
     * 1 件取得。メタはファイル名規約、本体はファイル(台帳は引かない)。
     *
     * 探索順は ① `filled/`(値入り HTML。編集タブの本文)→ ② `templates/`(作成タブの Jinja。
     * 作成経路の承認直後に精査画面が確定版を読む)→ ③ `pending/`(生成直後の未確定実体)。
     * ①②は `status:'published'`、③は `status:'draft'`、どこにも無ければ 404。
     * **確定を先に見る順序が契約**である。逆順にすると pending を書ける者が承認済みテンプレの
     * 表示内容を差し替えられ、編集画面・結合 PDF・比較タブが揃って汚染される。
     * ①で見つかったときだけ `filled` に本文を入れる(値入り HTML は Jinja を持たないので
     * `html` と同じ内容。web は `filled` が非空の文書を完成描画として扱う)。
     */
    async getTemplate(id) {
      const fileName = `${id}.html`;
      if (await filledExists(fileName)) {
        const meta = await fileToMeta(fileName, 'filled');
        if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
        const html = await readFilledHtml(fileName);
        const css = await readFundCss(meta.attributes.fundCode);
        return { meta, html, css, filled: html };
      }
      const meta = await fileToMeta(fileName);
      if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
      if (await templateExists(fileName)) {
        const html = await readTemplateHtml(fileName);
        const css = await readFundCss(meta.attributes.fundCode);
        return { meta, html, css, filled: '' };
      }
      const pending = await readPending(id);
      if (!pending) throw notFound(`テンプレートが見つかりません: ${id}`);
      return {
        meta: { ...meta, status: 'draft', updatedAt: await pendingMtime(id) },
        html: pending.html,
        css: pending.css,
        filled: '',
      };
    },
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/templateRepo.filled.test.ts editor/server/test/templates.routes.test.ts`
Expected: PASS。`templates.routes.test.ts` が一覧の件数で落ちるなら、その seed が `templates/` にしか書いていないのが原因。seed の書き先を `filled/`（`process.env.FILLED_DIR = path.join(root, 'data', 'filled')` を env に足す）へ変える。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/repositories editor/server/test/templateRepo.filled.test.ts editor/server/test/templates.routes.test.ts
git add editor/server/src/repositories/templateMeta.ts editor/server/src/repositories/templateRepo.ts editor/server/test/templateRepo.filled.test.ts editor/server/test/templates.routes.test.ts
git commit -m "feat(server): テンプレ一覧を filled/ 起点にし、取得は filled/ を最優先で読む"
```

---

### Task 4: 承認の書込先を `origin` で切り替える

**Files:**
- Modify: `editor/server/src/repositories/confirmedWrite.ts`
- Modify: `editor/server/src/repositories/templateRepo.ts:255-265`（`applyConfirmedSave`）
- Modify: `editor/server/src/repositories/reviewRepo.ts:65-70`, `:155-162`, `:238-246`
- Modify: `editor/server/test/confirmedWrite.rollback.test.ts`（op に `target` を足す）
- Test: `editor/server/test/reviews.test.ts`

**Interfaces:**
- Produces:
  - `type ConfirmedTarget = 'filled' | 'template'`（`confirmedWrite.ts` から export）
  - `ConfirmedWriteOp` の `review-approve` と `pair-sync` に `target: ConfirmedTarget` を追加
  - `baselineTemplateHtml(templateId: string, target: ConfirmedTarget): Promise<string>`
  - `applyConfirmedSave(req & { target: ConfirmedTarget })`
  - `targetOfOrigin(origin: 'edit' | 'create'): ConfirmedTarget`（`reviewRepo.ts` から export）

- [ ] **Step 1: 失敗するテストを書く**

`reviews.test.ts` の `submit` ヘルパを origin 付きに変える:

```ts
  const submit = (templateId: string, fundCode: string, html: string, origin: 'edit' | 'create' = 'edit') =>
    reviews.submitReview({ templateId, html, css: '.x{}', fundCode, origin }, submitter);
```

既存 `approve writes the template file, commits, and marks the request approved` の中で `templates/` への書込を主張している箇所（`path.join(tmp, 'templates', ...)`）を `filled/` に変え、末尾に 2 つの it を足す:

```ts
  it("origin='edit' の承認は filled/ に書き、templates/ には触れない", { timeout: 60_000 }, async () => {
    const tplId = 'AM01_444444_20250101_交付版';
    const meta = await submit(tplId, '444444', '<p>値入り本文</p>', 'edit');
    await reviews.approveReview(meta.id, {}, approver);
    expect(fs.readFileSync(path.join(tmp, 'filled', `${tplId}.html`), 'utf8')).toBe('<p>値入り本文</p>');
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
  });

  it("origin='create' の承認は templates/ に書き、filled/ には触れない", { timeout: 60_000 }, async () => {
    const tplId = 'AM01_555555_20250101_交付版';
    const meta = await submit(tplId, '555555', '<p>{{ fund.name }}</p>', 'create');
    await reviews.approveReview(meta.id, {}, approver);
    expect(fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8')).toBe('<p>{{ fund.name }}</p>');
    expect(fs.existsSync(path.join(tmp, 'filled', `${tplId}.html`))).toBe(false);
  });
```

ファイル冒頭の env に `process.env.FILLED_DIR = path.join(tmp, 'filled');` を足す。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/reviews.test.ts`
Expected: FAIL（`filled/` に書かれない）

- [ ] **Step 3: 実装する**

`confirmedWrite.ts`:

import を `import { cssPath, filledPath, readFilledHtml, readTemplateHtml, templatePath } from '../files/templateFiles.js';` にする。

型を足す（`ConfirmedWriteOp` の直前）:

```ts
/**
 * 書込先。`filled` = 値入り HTML(編集タブの承認)、`template` = Jinja スケルトン(作成タブの
 * 承認)。申請の `origin` から `reviewRepo.targetOfOrigin` が決め、ペア同期は承認と同じ先へ書く。
 */
export type ConfirmedTarget = 'filled' | 'template';

const htmlPathOf = (target: ConfirmedTarget, fileName: string): string =>
  target === 'filled' ? filledPath(fileName) : templatePath(fileName);
const htmlDirOf = (target: ConfirmedTarget): string =>
  target === 'filled' ? config.filledDir : config.templatesDir;
```

`ConfirmedWriteOp` の両 variant に `target: ConfirmedTarget;` を足す（`kind` の次の行）。

`writeTemplateAndCss` / `writeTemplateHtml` / `snapshotCurrent` / `restoreTemplateAndCss` に `target` 引数を足し、`templatePath(fileName)` を `htmlPathOf(target, fileName)`、`config.templatesDir` を `htmlDirOf(target)` に置き換える。シグネチャ:

```ts
async function writeTemplateAndCss(target: ConfirmedTarget, fileName: string, html: string, fundCode: string, css: string): Promise<void>
async function writeTemplateHtml(target: ConfirmedTarget, fileName: string, html: string): Promise<void>
async function snapshotCurrent(target: ConfirmedTarget, fileName: string, fundCode: string | null): Promise<Snapshot>
async function restoreTemplateAndCss(target: ConfirmedTarget, fileName: string, fundCode: string | null, prev: Snapshot): Promise<void>
```

`baselineTemplateHtml` を置き換える:

```ts
/**
 * 実行コード不変性の基準となる HTML を返す。`target='filled'` は 値入り HTML → Jinja →
 * pending の順、`target='template'` は Jinja → pending の順に探し、どれも無ければ空文字。
 * 空文字を基準にすると「実行コードを 1 つも持てない」に倒れる(fail-closed)。
 * **確定を先に見る順序が契約**で、逆にすると pending を書ける者が基準そのものを差し替えられる。
 */
export async function baselineTemplateHtml(
  templateId: string,
  target: ConfirmedTarget,
): Promise<string> {
  const fileName = `${templateId}.html`;
  if (target === 'filled') {
    const filled = await readFilledHtml(fileName);
    if (filled !== '') return filled;
  }
  const confirmed = await readTemplateHtml(fileName);
  if (confirmed !== '') return confirmed;
  const pending = await readPending(templateId);
  return pending?.html ?? '';
}
```

`applyConfirmedWrite` 内: `assertTemplateScriptsUnchanged(await baselineTemplateHtml(templateId), ...)` を `baselineTemplateHtml(templateId, op.target)` に、`snapshotCurrent(fileName, fundCode)` を `snapshotCurrent(op.target, fileName, fundCode)` に、`restoreTemplateAndCss(fileName, fundCode, prev)` を `restoreTemplateAndCss(op.target, fileName, fundCode, prev)` に、`writeTemplateAndCss(fileName, ...)` / `writeTemplateHtml(fileName, ...)` に `op.target` を先頭引数で渡す。監査の `resource` に `target: op.target` を足す（両 variant とも）。末尾の `fileToMeta(fileName)` を `fileToMeta(fileName, op.target === 'filled' ? 'filled' : 'template')` にする。

`templateRepo.ts` の `applyConfirmedSave` の引数型に `target: ConfirmedTarget;` を足し（`import type { ConfirmedTarget } from './confirmedWrite.js'`）、本体はそのまま spread する。

`reviewRepo.ts`:

import に `import { baselineTemplateHtml, type ConfirmedTarget } from './confirmedWrite.js';` と `readFilledHtml` を足す。

`currentBaseHash` の直前に足す:

```ts
/** 申請元の経路 → 書込先。編集タブは値入り HTML、作成タブは Jinja スケルトン。 */
export function targetOfOrigin(origin: 'edit' | 'create'): ConfirmedTarget {
  return origin === 'edit' ? 'filled' : 'template';
}
```

`currentBaseHash(templateId, fundCode)` に第 3 引数 `target: ConfirmedTarget` を足し、`readTemplateHtml(fileName)` を `target === 'filled' ? readFilledHtml(fileName) : readTemplateHtml(fileName)` にする。呼び出し 2 か所（submit の `baseHash:` と approve の `staleWarning`）に `targetOfOrigin(req.origin)` / `targetOfOrigin(review.origin)` を渡す。

`submitReview` の `assertTemplateScriptsUnchanged(await baselineTemplateHtml(req.templateId), ...)` を `baselineTemplateHtml(req.templateId, targetOfOrigin(req.origin))` にする。

`approveReview` の `applyConfirmedSave({...})` に `target: targetOfOrigin(review.origin),` を足し、`pairSync.syncPairAfterConfirm(review.templateId, actor.username)` と `noteMaster.reflectNoteMasterAfterConfirm(review.templateId, actor.username)` に第 3 引数 `targetOfOrigin(review.origin)` を足す（Task 6 で受ける。型エラーは Task 6 完了まで残るので、Task 4 と Task 6 は同じ typecheck 実行で確認する）。

`confirmedWrite.rollback.test.ts` の `kind: 'review-approve'` を持つ op に `target: 'template',` を足す（複数あれば全部）。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/reviews.test.ts editor/server/test/confirmedWrite.rollback.test.ts editor/server/test/confirmedWrite.guard.test.ts`
Expected: PASS（typecheck は Task 6 の後にまとめて通す）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/repositories editor/server/test/reviews.test.ts editor/server/test/confirmedWrite.rollback.test.ts
git add editor/server/src/repositories editor/server/test/reviews.test.ts editor/server/test/confirmedWrite.rollback.test.ts
git commit -m "feat(server): 承認の書込先を申請の origin で filled/ と templates/ に振り分ける"
```

---

### Task 5: 版履歴の pathspec を `filled/` にする

**Files:**
- Modify: `editor/server/src/repositories/historyRepo.ts:27-28`
- Test: `editor/server/test/historyRepo.multiTemplate.test.ts:37-40`

- [ ] **Step 1: テストを書き換える**

`historyRepo.multiTemplate.test.ts` の seed で `path.join(tmp, 'templates')` を使う 3 行（mkdir と 2 つの writeFileSync）を `path.join(tmp, 'filled')` に変える。5 行目付近のコメント `templates/*.html` を `filled/*.html` に直す。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/historyRepo.multiTemplate.test.ts`
Expected: FAIL（`templates/` を見ているので版が 0 件）

- [ ] **Step 3: 実装する**

`historyRepo.ts` の `const TEMPLATES_PATHSPEC = 'templates';` を次に置き換える:

```ts
// 版履歴は値入り HTML(`filled/`)のコミットで数える。編集タブ・比較画面が見る履歴は
// 編集タブが読み書きする本文のもので、作成タブの Jinja(`templates/`)の履歴は画面から参照しない。
const TEMPLATES_PATHSPEC = 'filled';
```

`templateFilesOf` の doc comment の `templates/*.html` を `filled/*.html` に、`getEditHistory` の doc の `templates/ に触れた各コミット` を `filled/ に触れた各コミット` に直す。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project server editor/server/test/historyRepo.multiTemplate.test.ts editor/server/test/history.routes.test.ts`
Expected: PASS（`history.routes.test.ts` が `templates/` を seed していれば同様に `filled/` へ変える）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/repositories/historyRepo.ts editor/server/test
git add editor/server/src/repositories/historyRepo.ts editor/server/test/historyRepo.multiTemplate.test.ts editor/server/test/history.routes.test.ts
git commit -m "feat(server): 版履歴を filled/ のコミットから引く"
```

---

### Task 6: ペア同期と注記マスタが承認の書込先を読む

**Files:**
- Modify: `editor/server/src/sync/pairSyncService.ts`
- Modify: `editor/server/src/sync/noteMasterService.ts`
- Test: `editor/server/test/noteMasterService.test.ts`

**Interfaces:**
- Produces:
  - `syncPairAfterConfirm(sourceTemplateId, actor, target: ConfirmedTarget)`
  - `reflectNoteMasterAfterConfirm(templateId, actor, target: ConfirmedTarget)`
  - `getPairSyncStatus(templateId)` は `filled/` の有無で `pairExists` を返す（編集タブのバナー用）

- [ ] **Step 1: 失敗するテストを書く**

`noteMasterService.test.ts` の `vi.mock('../src/files/templateFiles.js', ...)` を次にする:

```ts
vi.mock('../src/files/templateFiles.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/templateFiles.js')>();
  return { ...orig, readTemplateHtml: vi.fn(), readFilledHtml: vi.fn() };
});
```

import に `readFilledHtml` を足し、`const readFilledHtmlMock = vi.mocked(readFilledHtml);` を置く。既存の `reflectNoteMasterAfterConfirm(...)` 呼び出しには第 3 引数 `'template'` を足す。`describe('reflectNoteMasterAfterConfirm', ...)` に it を足す:

```ts
  it("target='filled' のときは値入り HTML を読む(templates/ は読まない)", async () => {
    listPartsMock.mockResolvedValue([catalogItem('note1', '反映')]);
    readFilledHtmlMock.mockResolvedValue(doc(part('note1', '値入り注記')));
    readTemplateHtmlMock.mockResolvedValue(doc(part('note1', 'Jinja 注記')));
    const r = await reflectNoteMasterAfterConfirm('AM01_510037_20240710_交付版', 'u', 'filled');
    expect(r?.updated).toEqual(['note1']);
    expect(readTemplateHtmlMock).not.toHaveBeenCalled();
    const args = callSprocMock.mock.calls[0]?.[2] as Param[];
    expect(args.find((a) => a.name === '注記HTML')?.value).toContain('値入り注記');
  });
```

（`Param` の形は同ファイル既存テストに合わせる。`name`/`value` でなければ既存の取り出し方をコピーする。）

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/noteMasterService.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`noteMasterService.ts`: import を `import { readFilledHtml, readTemplateHtml } from '../files/templateFiles.js';` と `import type { ConfirmedTarget } from '../repositories/confirmedWrite.js';` にする。interface と実装の `reflectNoteMasterAfterConfirm(templateId, actor)` に第 3 引数 `target: ConfirmedTarget` を足し、`readTemplateHtml(\`${templateId}.html\`)` を `(target === 'filled' ? readFilledHtml : readTemplateHtml)(\`${templateId}.html\`)` にする。doc comment に「読む実体は承認が書いた先（`target`）と同じ」と 1 文足す。

`pairSyncService.ts`: import に `filledExists, readFilledHtml` と `type ConfirmedTarget` を足す。

- `getPairSyncStatus`: `templateExists(\`${pairId}.html\`)` を `filledExists(\`${pairId}.html\`)` にする（編集タブのバナーは値入り HTML のペアの有無を見る）。
- `syncPairAfterConfirm(sourceTemplateId, actor)` に第 3 引数 `target: ConfirmedTarget` を足す。冒頭に `const exists = target === 'filled' ? filledExists : templateExists; const readHtml = target === 'filled' ? readFilledHtml : readTemplateHtml;` を置き、`templateExists(pairFile)` → `exists(pairFile)`、2 つの `readTemplateHtml(...)` → `readHtml(...)` にする。`applyConfirmedWrite({ kind: 'pair-sync', ... })` に `target,` を足す。

`deps.ts` は変更不要。`routes/` で `getPairSyncStatus` を呼ぶ箇所は引数不変。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm typecheck:editor && pnpm exec vitest run --project server`
Expected: PASS（server 全体。落ちたテストが `templates/` seed 起因なら `filled/` へ直す）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/sync editor/server/test/noteMasterService.test.ts
git add editor/server/src/sync editor/server/test
git commit -m "feat(server): ペア同期と注記マスタ書き戻しが承認の書込先と同じ実体を読む"
```

---

### Task 7: `AUTH_REQUIRED` の既定を true にする

**Files:**
- Modify: `editor/server/src/config.ts:518-524`, `:561-565`
- Modify: `editor/server/test/config.security.test.ts:241-245`
- Modify: `editor/server/test/auth.localMode.test.ts:24`, `editor/server/test/notes.entryId.test.ts:25`, `editor/server/test/generate.routes.local.test.ts`（env 設定の直後）

- [ ] **Step 1: テストを書き換える**

`config.security.test.ts` の `keeps the loopback default (no HOST) loading without authentication` を次に置き換える:

```ts
  it('requires authentication by default (AUTH_REQUIRED unset)', async () => {
    const mod = await importConfigWithEnv({ HOST: undefined, AUTH_REQUIRED: undefined });
    expect(mod.config.host).toBe('127.0.0.1');
    expect(mod.config.requireAuth).toBe(true);
  });

  it('turns authentication off only with an explicit AUTH_REQUIRED=false', async () => {
    const mod = await importConfigWithEnv({ HOST: undefined, AUTH_REQUIRED: 'false' });
    expect(mod.config.requireAuth).toBe(false);
  });
```

`auth.localMode.test.ts` の `delete process.env.AUTH_REQUIRED;` を `process.env.AUTH_REQUIRED = 'false';` にし、直前のコメントを「config は起動時に env を読む。認証を課さない配備は `AUTH_REQUIRED=false` を明示した local モードだけなので、その形を再現する。」に直す。`notes.entryId.test.ts:25` も同様。`generate.routes.local.test.ts` は env ブロックに `process.env.AUTH_REQUIRED = 'false';` を足し、2 行目と 35 行目の `AUTH_REQUIRED 未設定` を `AUTH_REQUIRED=false` に直す。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project server editor/server/test/config.security.test.ts`
Expected: FAIL（既定が false）

- [ ] **Step 3: 実装する**

`config.ts` の `requireAuth` を次に置き換える:

```ts
  /**
   * データルートにセッション認証を強制する。既定 on。DB モード(rest)が既定になったので
   * 「設定し忘れると無認証で起動する」形を作らない。認証を課さないのは `AUTH_REQUIRED=false`
   * を明示した local モード(`start.bat local`。DB なし / ログインなし)だけ。
   */
  requireAuth: envFlag('AUTH_REQUIRED', process.env.AUTH_REQUIRED) ?? true,
```

同ファイル `resolveAllowedHosts` の doc comment の段落「効きどころは**認証を課さない配備**(既定の local モード)である。」を「効きどころは**認証を課さない配備**(`AUTH_REQUIRED=false` を明示した local モード)である。」に直す。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project server`
Expected: PASS。既定 false に依存して落ちるテストが他にあれば、そのファイルの env に `process.env.AUTH_REQUIRED = 'false';` を明示する（意図が「認証なし」のテストの場合）か、`'true'` を明示する。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/config.ts editor/server/test
git add editor/server/src/config.ts editor/server/test
git commit -m "feat(server): AUTH_REQUIRED の既定を true にし、認証なしは明示指定に限る"
```

---

### Task 8: e2e 用サーバの seed とポート

**Files:**
- Modify: `editor/server/scripts/e2e-rest-paths.ts`
- Modify: `editor/server/scripts/e2e-rest-server.ts`

**Interfaces:**
- Produces: `E2E_REST_PORT`（env `E2E_REST_PORT`、既定 `24680`）、`E2E_REST_WEB_PORT`（env `E2E_REST_WEB_PORT`、既定 `24681`）

- [ ] **Step 1: 実装する**

`e2e-rest-paths.ts` の `E2E_REST_PORT` を置き換える:

```ts
/**
 * e2e のサーバ待受ポート。既定は通常の dev サーバと同じ 24680(chromium project が
 * これを使う)。並走させたいときは env で変える。
 */
export const E2E_REST_PORT = Number(process.env.E2E_REST_PORT ?? '24680');
/** e2e の Vite dev ポート。`playwright.config.ts` の webServer と揃える。 */
export const E2E_REST_WEB_PORT = Number(process.env.E2E_REST_WEB_PORT ?? '24681');
```

`e2e-rest-server.ts` の `seedDataRoot` に `filled/` を足す。`const cssDir = ...` の次に:

```ts
  const filledDir = path.join(E2E_REST_DATA_ROOT, 'filled');
  await fs.mkdir(filledDir, { recursive: true });
```

`fixturesCssDir` の次に:

```ts
  // 編集タブの一覧は filled/ が源。値入り HTML の seed は web 同梱の round-trip 形式 fixture
  // (`{%` を含まない)をそのまま使う。
  const fixturesFilledDir = path.join(repoRoot, 'editor/web/src/api/fixtures/filled');
```

css のコピーループの後に:

```ts
  for (const name of await fs.readdir(fixturesFilledDir)) {
    await fs.copyFile(path.join(fixturesFilledDir, name), path.join(filledDir, name));
  }
```

`main()` の env 設定に足す:

```ts
  // 作成タブ(`POST /api/generate`)は Python 生成器を子プロセスで呼ぶ。素の `python` は
  // Windows で Store のスタブへ解決される端末があるため(exit 9009)、ランチャを既定にする。
  process.env.PYTHON_BIN ??= process.platform === 'win32' ? 'py' : 'python3';
```

doc comment の `24690` 系の記述を「既定 24680 / 24681」に直す。

- [ ] **Step 2: 単独起動で seed を確認する**

Run（PowerShell）: `$env:E2E_REST_PORT='24690'; pnpm --filter server exec tsx scripts/e2e-rest-server.ts` を別ウィンドウで起動し、`Get-ChildItem editor\.tmp\e2e-rest-dataroot\filled` に 8 ファイルあること、`curl http://127.0.0.1:24690/api/health` が 200 を返すことを確認して停止する。

- [ ] **Step 3: コミット**

```bash
pnpm exec biome check --write editor/server/scripts
git add editor/server/scripts/e2e-rest-paths.ts editor/server/scripts/e2e-rest-server.ts
git commit -m "feat(server): e2e 用サーバに filled/ の seed を足し、既定ポートを 24680/24681 にする"
```

---

## Stage 2: web

### Task 9: 既定モードを rest に反転する

**Files:**
- Modify: `editor/web/src/main.ts:26-29`, `:33`, `:47-55`
- Modify: `editor/web/src/lib/storageKeys.ts:72-77`
- Modify: `editor/web/src/vite-env.d.ts:14-16`
- Test: `editor/web/test/editorSession.dom.test.ts`（`vi.stubEnv('VITE_API_MODE', 'rest')` の近く）

- [ ] **Step 1: 失敗するテストを書く**

`editorSession.dom.test.ts` の `vi.stubEnv('VITE_API_MODE', 'rest')` を使う it の隣に、同じ構造で次を足す（既存 it の本文をコピーし、env の行だけ変える）:

```ts
  it('VITE_API_MODE 未設定でも Undo ミラーはログイン ID でスコープされる(既定は rest)', () => {
    vi.stubEnv('VITE_API_MODE', '');
    // …既存の「rest のとき undoStacksKey にログイン ID が入る」it と同じ主張…
  });
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/editorSession.dom.test.ts`
Expected: FAIL（未設定は local 扱いで固定スコープになる）

- [ ] **Step 3: 実装する**

`main.ts`:

```ts
// データソース: `VITE_API_MODE=local` のときだけ local fixtures + localStorage 一式(開発用の
// opt-in)。未設定を含むそれ以外は REST(SQL Server backend + 認証)。
const useLocal = import.meta.env.VITE_API_MODE === 'local';
const repositories = useLocal ? localRepositories : restRepositories;
```

`if (!useRest) {` → `if (useLocal) {`、`if (useRest) {` → `if (!useLocal) {`。

`storageKeys.ts` の `userScope`:

```ts
/** 現在のユーザーのスコープ。local は単一利用者前提の固定値、それ以外(既定 rest)はログイン ID。 */
function userScope(): string {
  return import.meta.env.VITE_API_MODE === 'local'
    ? LOCAL_UNDO_SCOPE
    : (undoLoginId ?? ANONYMOUS_UNDO_SCOPE);
}
```

`vite-env.d.ts` のコメントを `/** データソース: 'local' は fixtures + localStorage(開発用 opt-in)、未設定を含むそれ以外は REST。 */` にする。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/editorSession.dom.test.ts editor/web/test/restBundle.guard.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/main.ts editor/web/src/lib/storageKeys.ts editor/web/src/vite-env.d.ts editor/web/test/editorSession.dom.test.ts
git add editor/web/src/main.ts editor/web/src/lib/storageKeys.ts editor/web/src/vite-env.d.ts editor/web/test/editorSession.dom.test.ts
git commit -m "feat(web): データモードの既定を rest にし、local は明示指定だけにする"
```

---

### Task 10: プレビュー画面の値入り文書は `toTemplate` も nunjucks も通さない

**Files:**
- Modify: `editor/web/src/lib/pdfDocument.ts:54-63`
- Modify: `editor/web/src/features/preview/services/templatePreviewService.ts:78-137`, `:140-143`
- Modify: `editor/web/src/features/preview/PreviewView.vue:141-143`
- Test: `editor/web/test/templatePreviewService.dom.test.ts`

**Interfaces:**
- Produces:
  - `renderPdfDocument(html, css, sample, opts?: { cropMarks?: boolean; skipJinja?: boolean })`
  - `loadForPreview(id)` の戻り値に `isFilled: boolean` を追加
  - `renderPdf(html, css, sample, cropMarks, skipJinja: boolean)`

- [ ] **Step 1: 失敗するテストを書く**

`templatePreviewService.dom.test.ts` は `renderHostClient` を本物の nunjucks で差し替えている（`vi.mock('@/lib/renderHostClient', …)`）。「描画を通さない」は、Jinja 風の字面がそのまま残ることで黒箱的に主張できる。同ファイルの `tpl` / `history` / `ownerOf` を使い、`describe('TemplatePreviewService.loadForPreview', …)` に it を 2 つ足す:

```ts
  it('filled が非空のテンプレは隔離描画を通さず、本文をそのまま文書にする', async () => {
    // `{{ raw }}` は値入り HTML に紛れた地の文。描画を通すと空になる。
    const filledTpl: Template = {
      ...tpl,
      html: '<html><body><p>値入り本文 {{ raw }}</p></body></html>',
      filled: '<html><body><p>値入り本文 {{ raw }}</p></body></html>',
    };
    const templates = {
      getTemplate: vi.fn(async () => ok(filledTpl)),
      getSampleData: vi.fn(async () => ok({})),
      getDraft: vi.fn(async () => ok(null)),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history);
    const res = await svc.loadForPreview('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.isFilled).toBe(true);
      expect(res.value.restoredHtml).toBe(filledTpl.html);
      expect(res.value.previewDoc).toContain('値入り本文 {{ raw }}');
      expect(res.value.renderError).toBeNull();
    }
  });

  it('filled が非空のテンプレの下書きは Jinja 復元を通さず本文を差し替える', async () => {
    const filledTpl: Template = { ...tpl, filled: tpl.html };
    const templates = {
      getTemplate: vi.fn(async () => ok(filledTpl)),
      getSampleData: vi.fn(async () => ok({})),
      getDraft: vi.fn(async () =>
        ok({ templateId: 't1', html: '<p>下書き {{ raw }}</p>', css: '.d{}', savedAt: '', savedBy: '' }),
      ),
    } as unknown as TemplateRepository;
    const svc = createTemplatePreviewService(templates, history, ownerOf(true));
    const res = await svc.loadForPreview('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // toTemplate を通すと `{{ raw }}` はチップ復元の対象外なので残るが、本文全体が
      // 整形(pretty)される。整形されずそのまま差し替わっていることを body で主張する。
      expect(res.value.restoredHtml).toBe('<html><body><p>下書き {{ raw }}</p></body></html>');
      expect(res.value.previewDoc).toContain('下書き {{ raw }}');
      expect(res.value.hasDraft).toBe(true);
    }
  });
```

`Template` 型の `filled` が必須なら既存の `tpl` 定数に `filled: ''` を足す。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/templatePreviewService.dom.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`pdfDocument.ts` の `renderPdfDocument`:

```ts
export async function renderPdfDocument(
  html: string,
  css: string,
  sample: SampleData,
  opts?: { cropMarks?: boolean; skipJinja?: boolean },
): Promise<Result<{ html: string; css: string }>> {
  // 値入り HTML(編集タブの本文。Jinja を持たない)は隔離描画を通さない — nunjucks は
  // コンパイラで、本文中の `{{` 風の字面まで式として解釈してしまう。
  let renderedHtml: string;
  if (opts?.skipJinja) {
    renderedHtml = html;
  } else {
    // Jinja のコンパイルは opaque オリジンの iframe(`renderHostClient`)で行う。…(既存コメント)
    const rendered = await renderJinjaIsolated(html, sample);
    if (rendered.error) return err(conflict(PDF_ERROR_MSG, { cause: rendered.error }));
    renderedHtml = rendered.html;
  }
  // …以降 `rendered.html` を `renderedHtml` に置き換えて既存どおり
```

`templatePreviewService.ts`:

`PreviewLoad` に `isFilled: boolean;`（doc: 「`tpl.filled` が非空 = 値入り HTML。申請本文と描画は Jinja を通さない」）を足す。

`loadForPreview` で `const draft = ...` の後を次にする:

```ts
      // `filled` はテストのフェイクや旧応答で欠けうるので、空文字と未定義をまとめて「無し」にする。
      const isFilled = Boolean(tpl.filled);
      let restoredHtml: string;
      let css: string;
      if (draft && isFilled) {
        // 値入り HTML の下書きは値を保った本文そのもの。Jinja 復元は掛けない(掛けると
        // round-trip 用のチップから Jinja が戻り、承認で filled/ に Jinja が書かれる)。
        restoredHtml = replaceBodyInner(tpl.html, draft.html);
        css = formatCss(draft.css);
      } else if (draft) {
        // …既存の toTemplate 経路(そのまま)…
      } else {
        // …既存…
      }

      let previewDoc = '';
      let renderError: string | null = null;
      if (isFilled) {
        previewDoc = assemblePreviewDocument(restoredHtml, css);
      } else {
        const rendered = await renderJinjaIsolated(restoredHtml, sample);
        // …既存…
      }
      return ok({ template: tpl, sample, restoredHtml, css, previewDoc, renderError, hasDraft: !!draft, isFilled });
```

`getSampleData` の呼び出しは `isFilled` でも残す（タイトル表示に使う。失敗時は空 sample で続行する既存の形）。

`renderPdf` のシグネチャに `skipJinja: boolean` を足し、`renderPdfDocument(html, css, sample, { cropMarks, skipJinja })` にする。interface のコメントに「`skipJinja` は値入り HTML のとき true」と足す。

`PreviewView.vue`: `const isFilled = ref(false);` を足し、`onMounted` で `isFilled.value = v.isFilled;`。`exportPdf` の `preview.renderPdf(restoredHtml.value, css.value, sample.value, cropMarks.value)` を `preview.renderPdf(restoredHtml.value, css.value, sample.value, cropMarks.value, isFilled.value)` にする。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm typecheck:editor && pnpm exec vitest run --project web-dom editor/web/test/templatePreviewService.dom.test.ts editor/web/test/mergePdfService.dom.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/lib/pdfDocument.ts editor/web/src/features/preview editor/web/test/templatePreviewService.dom.test.ts
git add editor/web/src/lib/pdfDocument.ts editor/web/src/features/preview editor/web/test/templatePreviewService.dom.test.ts
git commit -m "feat(web): 値入り HTML のプレビュー・申請本文は Jinja 復元と隔離描画を通さない"
```

---

### Task 11: 比較・精査・結合 PDF も値入り文書をそのまま使う

**Files:**
- Modify: `editor/web/src/features/compare/services/compareService.ts:136-172`
- Modify: `editor/web/src/features/reviews/services/changedSummary.ts:125`
- Modify: `editor/web/src/features/reviews/services/reviewDiffService.ts:170`
- Modify: `editor/web/src/features/merge/services/mergePdfService.ts:85-104`
- Test: `editor/web/test/compareService.test.ts`, `editor/web/test/mergePdfService.dom.test.ts`

**Interfaces:**
- Produces: `renderTemplateBody(html, css, fundCode, origin: 'edit' | 'create')`（`'edit'` は描画を通さない）
- `renderVersionHtml`: 現行版は `tpl.filled` 非空なら描画なし。スナップショットは `filled/` の履歴なので描画なし（`getSampleData` も呼ばない）

- [ ] **Step 1: 失敗するテストを書く**

`compareService.test.ts` は `renderHostClient` を本物の nunjucks で差し替えているので、「描画を通さない」は `{{ fund.name }}` が字面のまま残ることで主張する。`describe('CompareService.renderVersionHtml', …)` に足す:

```ts
  it('現行版: filled が非空なら隔離描画を通さず本文をそのまま返す', async () => {
    const templates = {
      getTemplate: vi.fn(async () =>
        ok({
          meta: { attributes: { fundCode: '510037' } },
          html: '<p>値入り {{ fund.name }}</p>',
          css: '.base{}',
          filled: '<p>値入り {{ fund.name }}</p>',
        }),
      ),
      getSampleData: vi.fn(async () => ok({ fund: { name: '原本ファンド' } })),
    } as unknown as TemplateRepository;
    const svc = createCompareService(templates, {} as HistoryRepository);
    const res = await svc.renderVersionHtml('baseline:AM01_510037_20240710_kr');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.html).toBe('<p>値入り {{ fund.name }}</p>');
    expect(templates.getSampleData).not.toHaveBeenCalled();
  });

  it('スナップショット: filled/ の履歴なので隔離描画も getSampleData も通さない', async () => {
    const history = { getSnapshot: vi.fn(async () => ok(snapshot)) } as unknown as HistoryRepository;
    const templates = { getSampleData: vi.fn(async () => ok({ fund: { name: 'x' } })) } as unknown as TemplateRepository;
    const svc = createCompareService(templates, history);
    const res = await svc.renderVersionHtml('eh-1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual({ html: snapshot.html, css: snapshot.css });
    expect(templates.getSampleData).not.toHaveBeenCalled();
  });
```

`snapshot.html` は `'<p>{{ fund.name }}</p>'` のままでよい（描画されないことがそのまま主張になる）。既存の「snapshot を描画する」it は削除する（filled/ の履歴に Jinja は無い）。`describe('CompareService.renderTemplateBody', …)`（無ければ新設）に足す:

```ts
  it("origin='edit' の本文は描画を通さずそのまま返す", async () => {
    const templates = { getSampleData: vi.fn(async () => ok({})) } as unknown as TemplateRepository;
    const svc = createCompareService(templates, {} as HistoryRepository);
    const res = await svc.renderTemplateBody('<p>{{ raw }}</p>', '.c{}', '510037', 'edit');
    expect(isOk(res) && res.value).toEqual({ html: '<p>{{ raw }}</p>', css: '.c{}' });
    expect(templates.getSampleData).not.toHaveBeenCalled();
  });
```

既存の `renderTemplateBody(...)` 呼び出しには第 4 引数 `'create'` を足す。

`mergePdfService.dom.test.ts` の `templatesOf` に倣い、`filled` 付きのテンプレを返すスタブで it を足す（`{{ report.editionType }}` が字面のまま残ることで描画なしを主張する）:

```ts
  it('filled が非空のテンプレは描画を通さず、値入り HTML をそのまま PDF 入力にする', async () => {
    const templates = {
      getTemplate: vi.fn(async (id: string) =>
        ok({
          meta: { id, attributes: { companyCode: 'A', fundCode: 'F', baseDate: '20240101', editionType: '交付版' }, fileName: `${id}.html`, status: 'published', updatedAt: null, updatedBy: null },
          html: `<html><body><p>doc-${id} {{ report.editionType }}</p></body></html>`,
          css: '.f{}',
          filled: `<html><body><p>doc-${id} {{ report.editionType }}</p></body></html>`,
        } as Template),
      ),
      getSampleData: vi.fn(async () => ok({})),
    } as unknown as TemplateRepository;
    // …既存の it と同じ手順で 1 件を結合し、送信ボディの html に `{{ report.editionType }}` が残り、
    // `templates.getSampleData` が呼ばれていないことを主張する…
  });
```

（送信ボディの取り出し方は同ファイルの既存 it（`fetch` スタブ）をそのまま使う。）

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project web-node editor/web/test/compareService.test.ts` と `--project web-dom editor/web/test/mergePdfService.dom.test.ts`（project は既存ファイルの拡張子で判断）
Expected: FAIL

- [ ] **Step 3: 実装する**

`compareService.ts` `renderVersionHtml`:

```ts
      if (isBaselineId(historyId)) {
        const tplRes = await templates.getTemplate(baselineTemplateId(historyId));
        if (isErr(tplRes)) return tplRes;
        const tpl = tplRes.value;
        // 値入り HTML(編集タブの本文)は Jinja を持たない。描画を通さずそのまま比較に使う。
        if (tpl.filled) return ok({ html: tpl.filled, css: tpl.css });
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        // …既存…
      }

      const snapRes = await history.getSnapshot(historyId, templateId);
      if (isErr(snapRes)) return snapRes;
      const snap = snapRes.value;
      // 版履歴は filled/(値入り HTML)のコミットなので、スナップショットも完成描画そのもの。
      return ok({ html: snap.html, css: snap.css });
```

`renderTemplateBody(html, css, fundCode, origin)`: interface と実装に第 4 引数 `origin: 'edit' | 'create'` を足し、冒頭に `if (origin === 'edit') return ok({ html, css });` を置く（doc: 「編集タブ由来の申請本文は値入り HTML で、描画を通さない」）。

`changedSummary.ts:125`: `compare.renderTemplateBody(html, css, fundCode)` → `compare.renderTemplateBody(html, css, fundCode, input.origin)`。`renderAfter` の型と呼び出しに `origin` を通す（`SummaryDeps.renderAfter` に第 4 引数 `origin: 'edit' | 'create'` を足し、呼び出し側は `input.origin` を渡す）。

`reviewDiffService.ts:170`: `compare.renderTemplateBody(review.html, review.css, review.fundCode)` → `compare.renderTemplateBody(review.html, review.css, review.fundCode, review.origin)`。

`mergePdfService.ts` `renderOne`: `const tpl = tplRes.value;` の直後に:

```ts
  // 値入り HTML は Jinja を持たないので、サンプル取得も隔離描画も飛ばす。
  if (tpl.filled) {
    const doc = await renderPdfDocument(tpl.filled, formatCss(tpl.css), {}, { cropMarks: false, skipJinja: true });
    if (isErr(doc)) return err(conflict(`テンプレート${nth}のレンダリングに失敗しました。`, { cause: doc.error }));
    return doc;
  }
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm typecheck:editor && pnpm exec vitest run --project "web-*"`
Expected: PASS（`changedSummary` のテストが `renderAfter` の引数数で落ちたら 4 引数へ直す）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features editor/web/test
git add editor/web/src/features editor/web/test
git commit -m "feat(web): 比較・精査・結合 PDF が値入り HTML を描画なしで使う"
```

---

### Task 12: `getSampleData` の sessionStorage キャッシュ

**Files:**
- Modify: `editor/web/src/api/rest/templateRepo.ts:81-83`
- Modify: `editor/web/src/stores/auth.ts:90-107`
- Test: `editor/web/test/restRepos.dom.test.ts`

**Interfaces:**
- Produces: `clearSampleDataCache(): void`（`api/rest/templateRepo.ts` から export）。キーは `editor:sample:<fundCode>`

- [ ] **Step 1: 失敗するテストを書く**

`restRepos.dom.test.ts` の `restTemplateRepo` の describe に足す:

```ts
  it('getSampleData は同じファンドの 2 回目を sessionStorage から返し、clear で捨てる', async () => {
    sessionStorage.clear();
    const calls = stubFetch(() => json({ fund: { code: '510037', name: 'F' } }));
    const first = await restTemplateRepo.getSampleData('510037');
    const second = await restTemplateRepo.getSampleData('510037');
    expect(calls).toHaveLength(1);
    expect(isOk(second) && second.value).toEqual(isOk(first) && first.value);
    expect(sessionStorage.getItem('editor:sample:510037')).not.toBeNull();
    clearSampleDataCache();
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
    await restTemplateRepo.getSampleData('510037');
    expect(calls).toHaveLength(2);
  });

  it('getSampleData は失敗を保存しない', async () => {
    sessionStorage.clear();
    stubFetch(() => new Response('{}', { status: 500 }));
    expect(isErr(await restTemplateRepo.getSampleData('510037'))).toBe(true);
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
  });
```

import に `clearSampleDataCache` を足す。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/restRepos.dom.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`rest/templateRepo.ts` に足す（`seriesFetch` の前）:

```ts
// ファンド名・会社名(`getSampleData`)は作成タブの表示にしか使わず、同じタブの間に何度も
// 変わらない。sessionStorage に持ち、タブを閉じれば消える(端末に残さない)。
const SAMPLE_CACHE_PREFIX = 'editor:sample:';
const sampleCacheKey = (fundCode: string) => `${SAMPLE_CACHE_PREFIX}${fundCode}`;

function readSampleCache(fundCode: string): SampleData | null {
  try {
    const raw = sessionStorage.getItem(sampleCacheKey(fundCode));
    return raw ? (JSON.parse(raw) as SampleData) : null;
  } catch {
    return null;
  }
}

function writeSampleCache(fundCode: string, data: SampleData): void {
  try {
    sessionStorage.setItem(sampleCacheKey(fundCode), JSON.stringify(data));
  } catch {
    /* 容量超過・無効化時は保存しない(次回も取得するだけ) */
  }
}

/** ログアウト時に呼ぶ。次の利用者に前の利用者が見たファンド名を残さない。 */
export function clearSampleDataCache(): void {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(SAMPLE_CACHE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* sessionStorage が無い環境では何もしない */
  }
}
```

`getSampleData` を置き換える:

```ts
  getSampleData: async (fundCode: string) => {
    const cached = readSampleCache(fundCode);
    if (cached) return ok(cached);
    const res = await attemptRest(() =>
      apiFetch<SampleData>(buildPath(apiPaths.fundSampleData, { fundCode })),
    );
    if (isOk(res)) writeSampleCache(fundCode, res.value);
    return res;
  },
```

import に `isOk, ok` を `@editor/shared` から足す。

`stores/auth.ts` の `logout` で `localStorage.removeItem(AUTH_EPOCH_KEY);` の直前に `clearSampleDataCache();` を足し、`import { clearSampleDataCache } from '@/api/rest/templateRepo';` を足す（`restBundle.guard.test.ts` は `api/local` の import を数えるだけなので影響しない）。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/restRepos.dom.test.ts editor/web/test/restBundle.guard.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/api/rest/templateRepo.ts editor/web/src/stores/auth.ts editor/web/test/restRepos.dom.test.ts
git add editor/web/src/api/rest/templateRepo.ts editor/web/src/stores/auth.ts editor/web/test/restRepos.dom.test.ts
git commit -m "feat(web): ファンド名の取得結果をセッション中だけ sessionStorage に持つ"
```

---

### Task 13: local 実装の追随（`origin='edit'` の承認は `filled` を更新）

**Files:**
- Modify: `editor/web/src/api/local/store.ts:157-161`（`WORKING_KEYS`）と `K` の定義
- Modify: `editor/web/src/api/local/templateRepo.ts:48-60`（`putContentOverrides`）, `:203-213`（`getTemplate`）
- Test: `editor/web/test/localRepos.dom.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`localRepos.dom.test.ts` の `localTemplateRepo` の describe に足す（`confirmSaveLocal` の既存呼び出しの形に合わせる）:

```ts
  it("origin='edit' の確定保存は filled を更新し html は据え置く", async () => {
    const id = 'AM01_510037_20240710_交付版';
    const before = await localTemplateRepo.getTemplate(id);
    await confirmSaveLocal({ templateId: id, html: '<p>値入り更新</p>', css: '', fundCode: '510037', origin: 'edit' });
    const after = await localTemplateRepo.getTemplate(id);
    expect(isOk(after) && after.value.filled).toBe('<p>値入り更新</p>');
    expect(isOk(after) && isOk(before) && after.value.html).toBe(before.value.html);
  });

  it("origin='create' の確定保存は html を更新し filled を空にする(従来どおり)", async () => {
    const id = 'AM01_510037_20240710_全体版';
    await confirmSaveLocal({ templateId: id, html: '<p>{{ x }}</p>', css: '', fundCode: '510037', origin: 'create' });
    const after = await localTemplateRepo.getTemplate(id);
    expect(isOk(after) && after.value.html).toBe('<p>{{ x }}</p>');
    expect(isOk(after) && after.value.filled).toBe('');
  });
```

`ConfirmSaveRequest` は `editor/shared/src/index.ts:198` の interface。`fundCode: string;` の次に足す:

```ts
  /** 申請元の経路。`'edit'` は値入り HTML(filled)を、`'create'` は Jinja(html)を更新する。 */
  origin: 'edit' | 'create';
```

`web/src/api/local/reviewRepo.ts:123-130` の `confirmSaveLocal({...})` に `origin: review.origin,` を足す。他に `confirmSaveLocal` を呼ぶ箇所（テスト含む）は `origin: 'edit'` を足す（typecheck で列挙される）。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project web-dom editor/web/test/localRepos.dom.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`store.ts`: `K` に `filledOverride: 'editor:filledOverride'` を足し（`htmlOverride` の隣。既存の命名規則に合わせる）、`WORKING_KEYS` に `K.filledOverride` を足す。

`templateRepo.ts` `putContentOverrides`:

```ts
function putContentOverrides(req: ConfirmSaveRequest): void {
  if (req.origin === 'edit') {
    // 編集タブの承認は値入り HTML を上書きする(server の filled/ と同じ契約)。Jinja は据え置く。
    const filledOverride = read<Record<string, string>>(K.filledOverride, {});
    filledOverride[req.templateId] = req.html;
    write(K.filledOverride, filledOverride);
  } else {
    const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
    htmlOverride[req.templateId] = req.html;
    write(K.htmlOverride, htmlOverride);
  }
  const cssOverride = read<Record<string, string>>(K.cssOverride, {});
  // …既存の css 行…
}
```

`getTemplate` の `filled` 行を次にする:

```ts
      const filledOverride = read<Record<string, string>>(K.filledOverride, {});
      // 編集タブの承認で上書きした値入り HTML → 未編集 fixture の静的 filled の順。作成タブの
      // 承認で Jinja が変わった id は静的 filled が古いので空にし、editor が再差込する。
      const filled = filledOverride[id] ?? (htmlOverride[id] ? '' : (fixtureFilled[meta.fileName] ?? ''));
```

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm typecheck:editor && pnpm exec vitest run --project web-dom editor/web/test/localRepos.dom.test.ts editor/web/test/localReviewRepo.dom.test.ts editor/web/test/twoSystems.guard.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/api/local editor/web/test/localRepos.dom.test.ts
git add editor/web/src/api/local editor/web/test/localRepos.dom.test.ts editor/shared/src/schemas.ts
git commit -m "feat(web): local 実装でも編集タブの承認は filled を更新する"
```

---

### Task 14: 2 系統ガードに rest 経路の検査を足す

**Files:**
- Modify: `editor/web/test/twoSystems.guard.test.ts`

- [ ] **Step 1: 検査を足す**

ファイル末尾に describe を足す:

```ts
describe('editor 2系統の原則: rest 経路の値入り HTML', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8');

  it('既定のデータモードは rest(main.ts は local を明示指定でだけ選ぶ)', () => {
    const src = read('main.ts');
    expect(src).toMatch(/VITE_API_MODE === 'local'/);
    expect(src).not.toMatch(/VITE_API_MODE === 'rest'/);
  });

  it('プレビューは filled が非空の文書で toTemplate を通さない', () => {
    const src = read('features/preview/services/templatePreviewService.ts');
    expect(src).toMatch(/draft && isFilled/);
  });

  it('比較の現行版は filled が非空なら描画を通さない', () => {
    const src = read('features/compare/services/compareService.ts');
    expect(src).toMatch(/if \(tpl\.filled\) return ok\(\{ html: tpl\.filled/);
  });
});
```

`import fs from 'node:fs'; import path from 'node:path';` を足す。

- [ ] **Step 2: 通ることを確認する**

Run: `pnpm exec vitest run --project "web-*" editor/web/test/twoSystems.guard.test.ts`
Expected: PASS

- [ ] **Step 3: コミット**

```bash
pnpm exec biome check --write editor/web/test/twoSystems.guard.test.ts
git add editor/web/test/twoSystems.guard.test.ts
git commit -m "test(web): 2 系統ガードに既定 rest と値入り HTML の非描画を足す"
```

---

## Stage 3: 起動と配布

### Task 15: `start.bat` の既定を rest にする

**Files:**
- Modify: `editor/start.bat:5-31`（ヘッダ）, `:57`, `:101-107`

- [ ] **Step 1: 実装する**

- 57 行目 `set "APIMODE=local"` → `set "APIMODE=rest"`。
- 62 行目のコメント `Set when 'local' was typed, to tell it apart from 'local' being the default.` → `Set when 'local' was typed (the explicit opt-in for the no-DB developer mode).`
- 95〜98 行の `if "%LAN%"=="1" if /I "%APIMODE%"=="local" ( ... )` ブロックは既定が rest なので到達しない。削除する。
- 104〜107 行を次にする:

```bat
rem REST (default): server-side auth enforcement + DB audit mirroring.
rem local (explicit opt-in, no DB): switch auth off; config.ts defaults AUTH_REQUIRED to
rem true, so the developer mode has to say so out loud.
if /I "%APIMODE%"=="rest" (
  set "AUTH_REQUIRED=true"
  set "AUDIT_DB=true"
) else (
  set "AUTH_REQUIRED=false"
  set "AUDIT_DB=false"
)
```

- ヘッダ（5〜31 行）の用例を次にする:

```bat
rem    start.bat               production, REST data mode (SQL Server backend; needs login)
rem    start.bat dev           development + REST
rem    start.bat local         production, local data (fixtures + localStorage, no DB, no login)
rem    start.bat dev local     development + local data
rem    start.bat lan           production + REST, exposed to the intranet LAN (HTTPS)
rem    start.bat lan-plain     same but plain HTTP (opt-in, discouraged)
rem
rem  Args are order-free. The data mode (rest|local) sets VITE_API_MODE, which the
rem  web app reads to pick the REST repositories (rest, default) or localStorage
rem  (local, developer opt-in). 'db' is an alias of 'rest'.
```

`Double-click runs production mode with local data.` → `Double-click runs production mode against SQL Server.`。

- [ ] **Step 2: CRLF に戻し、動作を確認する**

Run（PowerShell）: `$p='editor\start.bat'; $t=[IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p, ($t -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)`（非 ASCII が含まれないことを先に `Select-String -Pattern '[^\x00-\x7F]'` で確認する）。
その後 `cmd /c "editor\start.bat local lan"` が `'lan' cannot be combined with 'local'` で止まること、`cmd /c "editor\start.bat dev local"` が `VITE_API_MODE=local` で起動すること（起動後 Ctrl+C）を確認する。

- [ ] **Step 3: コミット**

```bash
git add editor/start.bat
git commit -m "feat(editor): start.bat の既定データモードを rest にし、local を明示指定にする"
```

---

### Task 16: オフライン setup の msnodesqlv8 失敗を fatal にする

**Files:**
- Modify: `offline/setup-offline.ps1:195-223`

- [ ] **Step 1: 実装する**

195〜199 行のコメントの最後の 1 文「REST/DB 入力を使わない構成では無くても動くため失敗は警告止まりで setup を続行する。」を「editor の既定は DB モードなので、ここが欠けると setup は成功したのに起動できない端末ができる。3 段（prebuild と install 先の有無 / 版一致 / 展開と require 疎通）のどれかで失敗したら setup を失敗にする。」に直す。

`Write-Warning "[warn] msnodesqlv8 の install 版(...)と prebuild(...)の版が不一致。..."` → `Write-Error "[error] msnodesqlv8 の install 版($instVer)と prebuild($($pbTar.Name))の版が不一致。native-prebuilds の差し替えが必要です。"; exit 1`

`Write-Warning '[warn] msnodesqlv8 prebuild の展開に失敗（...）。'` → `Write-Error '[error] msnodesqlv8 prebuild の展開に失敗しました。'; exit 1`

`else { Write-Warning '[warn] msnodesqlv8 の require に失敗。...' }` → `else { Write-Error '[error] msnodesqlv8 の require に失敗しました。Node の ABI（24.x=137）と prebuild の対応を確認してください。'; exit 1 }`

最後の `Write-Warning '[warn] msnodesqlv8 prebuild または install 先が見つからず、...'` → `Write-Error '[error] msnodesqlv8 prebuild または install 先が見つからず、ネイティブ .node を配置できませんでした。'; exit 1`

同ファイル冒頭の `.SYNOPSIS`/`.DESCRIPTION` に msnodesqlv8 の警告継続を書いた行があれば「失敗で中止」に直す。UTF-8 BOM を保つ。

- [ ] **Step 2: 構文を確認する**

Run（PowerShell）: `[ScriptBlock]::Create((Get-Content offline/setup-offline.ps1 -Raw -Encoding utf8)) | Out-Null; pnpm run ci:offline`
Expected: 構文エラーなし、Pester が緑（`verify.Tests.ps1` は setup 本体を走らせないので通る）

- [ ] **Step 3: コミット**

```bash
git add offline/setup-offline.ps1
git commit -m "feat(offline): msnodesqlv8 の配置に失敗したら setup を失敗にする"
```

---

## Stage 4: e2e

### Task 17: playwright.config を rest フェイク方式にし、ログインヘルパを cookie 対応にする

**Files:**
- Modify: `editor/playwright.config.ts`
- Modify: `editor/e2e/helpers.ts:16-27`
- Modify: `package.json:18`, `:27`
- Rename: `editor/e2e/approval.rest.spec.ts` → `editor/e2e/approval.spec.ts`、`editor/e2e/users.rest.spec.ts` → `editor/e2e/users.spec.ts`

- [ ] **Step 1: `playwright.config.ts` を書き換える**

`REST` / `wantsRest` の判定と throw を削除する。`use.baseURL` を `'http://localhost:24681'`、projects を次にする:

```ts
  projects: [
    {
      // 挙動を検証する spec 全部。`test:e2e`(`ci` と GitHub Actions)と `e2e:editor` の両方で走る。
      // `capture_docs.spec.ts` を外すのは、あの spec が git 管理下の `docs/editor/images/*.png` を
      // 書き換えるため。
      // `workers: 1` はログインが並列に集中して `loginRateLimit` に当たるのを避けるため
      // (承認フローは admin→approver の 2 名を直列に使う)。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/capture_docs.spec.ts'],
      workers: 1,
    },
    {
      // (docs project は既存のまま)
    },
  ],
```

`webServer` を次にする（`E2E_REST` 分岐を撤去）:

```ts
  webServer: [
    {
      // sproc フェイク + 一時 dataRoot(`<repo>/editor/.tmp/e2e-rest-dataroot`)を毎回作り直して
      // 24680 で待つ。開発中の実サーバを使い回さない(実 DB・実 dataRoot を汚さない)。
      command: 'pnpm --filter server exec tsx scripts/e2e-rest-server.ts',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // ヘルスチェック先を `127.0.0.1` で書くのは、このサーバが `HOST=127.0.0.1` で待つため
      // (`localhost` は環境により `::1` へ解決されて到達しない)。
      url: 'http://127.0.0.1:24680/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter web exec vite --port 24681',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // `VITE_API_MODE=rest` は既定と同じだが、呼び出し元シェルの `local` 指定に引きずられない
      // よう明示する。`API_PROXY_TARGET` は vite.config.ts の proxy 先の上書き。
      env: { VITE_API_MODE: 'rest', API_PROXY_TARGET: 'http://127.0.0.1:24680' },
      url: 'http://localhost:24681',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
```

ファイル冒頭のコメントを「既定 project(chromium/docs)は sproc フェイク + 一時 dataRoot のサーバ(24680)と Vite(24681)を自前で起動して走る。SQL Server は不要。」に書き換える。`fullyParallel: true` は残してよい（`workers: 1` が効く）。

- [ ] **Step 2: ログインヘルパを cookie 対応にする**

`e2e/helpers.ts` の `login` の `clearSession` ブロックを次にする:

```ts
  if (clearSession) {
    // rest のセッションはサーバ発行の cookie。同じコンテキストでユーザーを切り替える
    // (admin で申請 → approver で承認)ときは cookie を捨ててからログイン画面へ行く。
    // ログイン画面は認証済みだと router guard がアプリへ押し戻すため、先に捨てる。
    await page.context().clearCookies();
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/login/);
  }
```

doc comment（12〜15 行）を「先にセッション cookie を捨てる」趣旨に直す。

- [ ] **Step 3: spec の改名と scripts**

```bash
git mv editor/e2e/approval.rest.spec.ts editor/e2e/approval.spec.ts
git mv editor/e2e/users.rest.spec.ts editor/e2e/users.spec.ts
```

両ファイル冒頭コメントの「`E2E_REST=1` のときだけ走る project `rest` 専用 spec」を「chromium project で走る（サーバは sproc フェイク + 一時 dataRoot）」に直す。`approval.spec.ts` の 9〜12 行（「rest では `filled` が空で…」）を「編集 canvas は `filled/` に seed した値入り HTML を表示する」に直し、`test.setTimeout`/serial はそのまま。

`package.json`: `"e2e:rest": ...` の行を削除する。`test:e2e` は変更なし。

- [ ] **Step 4: 通ることを確認する**

Run: `pnpm exec playwright test -c editor/playwright.config.ts --project chromium smoke.spec.ts approval.spec.ts users.spec.ts`
Expected: PASS（サーバの起動ログに `dataRoot=…e2e-rest-dataroot` が出る）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/playwright.config.ts editor/e2e
git add editor/playwright.config.ts editor/e2e package.json
git commit -m "test(e2e): chromium project を sproc フェイク + 一時 dataRoot 方式へ移す"
```

---

### Task 18: 残りの spec を rest 経路へ合わせる

**Files:**
- Modify: `editor/e2e/approve.spec.ts:39`
- Modify: `editor/e2e/canvas.spec.ts:163-173`, `:242`, `:285-295`
- Modify: `editor/e2e/tabbed_layout.spec.ts:176-180`
- Modify: `editor/e2e/capture_docs.spec.ts:6-10`
- Modify: `editor/e2e/create.spec.ts:4-5`
- Modify: `editor/e2e/helpers.ts`（ヘルパ追加）

- [ ] **Step 1: 下書きの実体を API で読むヘルパを足す**

`helpers.ts` 末尾に:

```ts
/**
 * 自動保存された下書きをサーバから読む(無ければ null)。rest の下書きは
 * `dataRoot/drafts/` にあり、localStorage には無い。
 */
export async function readDraft(page: Page, id: string): Promise<{ html: string; css: string } | null> {
  // `GET /api/templates/:id/draft` は下書きが無いと JSON の `null` を 200 で返す
  // (`templates.routes.ts` は `getDraft` の戻りをそのまま返す)。
  const res = await page.request.get(`/api/templates/${encodeURIComponent(id)}/draft`);
  return (await res.json()) as { html: string; css: string } | null;
}
```

- [ ] **Step 2: spec を直す**

- `approve.spec.ts:39`: `'精査花子'` → `'承認 花子'`、コメントを `// approver の displayName(sproc フェイク)` に。
- `canvas.spec.ts:170-173`: `page.evaluate(() => Object.keys(localStorage)...)` を `const draft = await readDraft(page, SEED_ID); const leaked = draft !== null && draft.html.includes('data-redline');` に。163〜164 行のコメントの「(local モードは localStorage)」を「(サーバの `drafts/`)」に。
- `canvas.spec.ts:242`: `expect(await page.evaluate(() => localStorage.getItem('editor:drafts'))).toBeNull();` → `expect(await readDraft(page, SEED_ID)).toBeNull();`
- `canvas.spec.ts:285-295`: `expect.poll(() => page.evaluate(... localStorage ...))` → `expect.poll(() => readDraft(page, SEED_ID), { timeout: 15_000 }).toBeNull();`
- `tabbed_layout.spec.ts:176-180`: `reopened.evaluate(() => (localStorage.getItem('editor:drafts') ?? '').includes('E2E破棄'))` → `(await readDraft(reopened, <その spec の id 定数>))?.html.includes('E2E破棄') ?? false` に。コメントの「(local モードは localStorage の `editor:drafts`)」を「(サーバの `drafts/`)」に。
- `capture_docs.spec.ts:6-10`: コメントを「webServer が sproc フェイクのサーバ(:24680)と Vite(:24681)を起動する。ログインはサーバ発行の cookie で、承認系は admin で申請 → approver で承認タブを開く(`login()` が cookie を捨てて切り替える)。」に。
- `create.spec.ts:4-5`: 「`localTemplateRepo.generate` を直接呼ぶ(/api/generate 不要)」を「`POST /api/generate`（Python 生成器 `server/scripts/generate_template.py`）を経て `pending/` に置かれる」に直す。

- [ ] **Step 3: 全 spec を通す**

Run: `pnpm run test:e2e`
Expected: PASS。落ちた spec はサーバログ（`editor/.tmp/e2e-rest-dataroot` の中身と Playwright の trace）で原因を切り分け、次のどれかで直す:
  - `create.spec.ts` が生成で落ちる → `py editor/server/scripts/generate_template.py "{\"companyCode\":\"AM01\",\"fundCode\":\"510037\",\"editionType\":\"交付版\"}"` を手で走らせ、生成器自体が動くかを見る。sproc フェイクの `生成登録` が属性 4 つとファイル名を要求する（`sprocFake.ts:475-483`）ので、ルートが渡す引数と照合する。
  - `header_layout.spec.ts` がヘッダの折り返しで落ちる → sproc フェイクの 510124 の `name` が全角（`ＳＭＴ ＪＰＸ…`）で fixture の `sample/510124.json` と同じ。幅の差は 1440px で 13px しか余裕が無い（設計正典）。落ちるなら `DEFAULT_FUNDS` は変えず、spec の `LONG_NAME_ID` の期待と実測を trace で確かめ、レイアウト側の要件（設計正典「EditorTopBar」）に従って判断する。自己判断で幅の要件を変えない — 結果を報告して指示を仰ぐ。
  - 表示名（`管理者` 等）を主張する spec → sproc フェイクの名前（`管理 次郎` / `承認 花子` / `編集 太郎`）に直す。

- [ ] **Step 4: コミット**

```bash
pnpm exec biome check --write editor/e2e
git add editor/e2e
git commit -m "test(e2e): 下書き・表示名の主張を rest 経路(サーバの drafts/・sproc フェイク)に合わせる"
```

---

### Task 19: docs スクショの再撮影と HTML 再生成

**Files:**
- Regenerate: `docs/editor/images/*.png`, `docs/editor/editor_手引き.html`, `docs/editor/editor_設計.html`

- [ ] **Step 1: 撮影する**

Run: `cd editor && pnpm exec playwright test --project docs`
Expected: PASS。`git status` で `docs/editor/images/` の PNG が変わる（表示名の差）。

- [ ] **Step 2: HTML を作り直す**

Run: `py -3.13 docs/_build/build_all.py --project editor`

- [ ] **Step 3: コミット**

```bash
git add docs/editor/images docs/editor/*.html
git commit -m "docs(editor): sproc フェイクの表示名でスクリーンショットを再撮影"
```

---

## Stage 5: ドキュメント

### Task 20: README / CONTRIBUTING / 設計書 / 設計正典

**Files:**
- Modify: `editor/README.md:27-29`, `:41-51`, `:99-117`, `:145-146`, `:185-189`
- Modify: `editor/CONTRIBUTING.md:20`, `:58-59`
- Modify: `docs/editor/src/設計書.md:218-222`, `:225-240`, `:253-270`, `:676`, `:686`
- Modify: `docs/editor/src/設計正典.md:36`, `:48`, `:61-63`
- Modify: `README.md:102`（フル `ci` の前提）

- [ ] **Step 1: `editor/README.md`**

- 27〜29 行: 「フェーズ 1: フロント先行…」の注記を「データソースは `VITE_API_MODE` で切り替える。既定は `rest`（SQL Server + 認証）。`local`（fixtures + localStorage、DB なし・ログインなし）は開発用の opt-in。`web/src/api/repositories.ts` の 1 オブジェクトを差し替えるだけで画面/サービス/ストアは無改修。」に。
- 41 行: 「（`local`／`rest`・既定 local）」→「（`rest`／`local`・既定 rest）」。表を次にする:

```
| `start.bat` | 本番（build → server 単体 :24680）/ REST（SQL Server バックエンド・認証必須） |
| `start.bat dev` | 開発（Fastify :24680 + Vite :24681）/ REST |
| `start.bat local` | 本番 / ローカルデータ（fixtures + localStorage。DB なし・ログインなし。開発用） |
| `start.bat dev local` | 開発 / ローカルデータ |
| `start.bat lan` | 本番 / REST + **社内 LAN 公開**（下記「LAN 公開」節） |
```

- 51 行: 「デモログイン `admin / admin`」の前に「REST では DB のユーザーで、`local` では」を添える。
- 99〜117 行「REST e2e（opt-in 統合テスト）」節を「e2e（sproc フェイク）」に書き換える: 「`test:e2e` / `e2e:editor` の chromium/docs project は `editor/server/scripts/e2e-rest-server.ts` が起動するサーバ（sproc は `server/test/fakes/sprocFake.ts` の in-memory フェイク、dataRoot は `<repo>/editor/.tmp/e2e-rest-dataroot` を毎回作り直し）を相手に走る。SQL Server は不要。`filled/` には `web/src/api/fixtures/filled/*.html` を seed する。worker 数は 1（ログイン試行の集中回避）。」`E2E_REST` と `e2e:rest` の記述は削除。
- 145〜146 行: 「`start.bat lan`（local データ）でも公開はできるが」→ 「`lan` は REST を含意し、`local lan` は起動しない（認証なしの公開を作らない）。」
- 185〜189 行: 「（既定はローカルモード相当の無効値）」を削除し、`AUTH_REQUIRED` の既定を `true`、用途を「認証強制（`start.bat local` が `false` にする）」に。

- [ ] **Step 2: `editor/CONTRIBUTING.md`**

- 20 行: README 51 行と同じ補足。
- 58 行: 「★VITE_API_MODE で local / rest を切替える唯一の点」→「★`VITE_API_MODE` で rest（既定）/ local を切替える唯一の点」。59 行: 「Phase1 のローカル実装」→「開発用のローカル実装（`VITE_API_MODE=local` で選ぶ）」。

- [ ] **Step 3: `docs/editor/src/設計書.md`**

- 218〜222 行: コード片を `const useLocal = import.meta.env.VITE_API_MODE === 'local'; const repositories = useLocal ? localRepositories : restRepositories;` に、文を「既定は rest。`local` は明示指定のときだけ」に。
- 225〜240 行（4.2 節）: local 側のコード片に `filledOverride` の行を反映し、rest 側の説明を「`getTemplate` は `filled/`（値入り HTML）→ `templates/`（作成タブの Jinja）→ `pending/` の順に探し、`filled/` で見つかれば `html` と `filled` の両方に本文を返す」に。
- 253〜270 行（4.3 節）: 見出しを「4.3 値入り HTML の出どころ（2 系統の原則のデータ源）」にし、次の 3 段落にする: ①local は `genFilled.ts` が `fixtures/filled/*.html` を作る（既存の説明を残す）。②rest は dataRoot の `filled/<テンプレID>.html` を返す。別ツールが置き、承認（`origin='edit'`）が上書きする。値入り HTML に Jinja は残らないので、プレビュー・比較・結合 PDF は nunjucks を通さずそのまま組版する（`tpl.filled !== ''` で判定）。③作成タブ（`origin='create'`）の承認は従来どおり `templates/` に Jinja を書く。270 行の「REST は per-fund 実サンプルで filled を生成する」の段落は削除する。
- 676 行: 「既定 local」→「既定 rest」。686 行: 「（= dev/local 相当）」→「（= dev/rest 相当）」。

- [ ] **Step 4: `docs/editor/src/設計正典.md`**

- 36 行: 「`dev`/`prod` × `local`/`rest` × `lan`」→「`dev`/`prod` × `rest`（既定）/`local` × `lan`」。
- 48 行: 「local（fixtures+localStorage）⇄ rest の唯一の差し替え点」→「rest（既定）⇄ local（fixtures+localStorage、開発用）の唯一の差し替え点」。
- 61〜63 行の「編集 2 系統」の箇条書きに 1 文足す: 「rest の `tpl.filled` は dataRoot `filled/<id>.html`（別ツールが置く値入り HTML。Jinja なし）。承認は申請の `origin` で `filled/`（edit）と `templates/`（create）を書き分け、値入り HTML はプレビュー・比較・結合 PDF でも nunjucks を通さない。」

- [ ] **Step 5: ルート `README.md`**

102 行「フル `ci` の前提」の節に 1 文足す: 「e2e は sproc フェイクと一時 dataRoot で走るため SQL Server は不要。」

- [ ] **Step 6: docs をビルドして確認する**

Run: `py -3.13 docs/_build/build_all.py --project editor && pnpm run check:comments && pnpm run test:docs`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add editor/README.md editor/CONTRIBUTING.md docs/editor README.md
git commit -m "docs(editor): 既定を DB モードに改め、値入り HTML(filled/)の出どころを書く"
```

---

### Task 21: フル CI

- [ ] **Step 1: 実行する**

Run: `pnpm run ci`（11〜12 分。背景実行の上限 10 分を超えるので、ユーザーに `! pnpm run ci` で走らせてもらうか、`run_in_background` で起動して Monitor で待つ）
Expected: 全段 PASS。coverage の閾値（ファイル単位 85%）で新規ファイルが引っかかる場合、`vitest.config.ts` の include に足したファイルのテストを増やす（`templateFiles.ts` は既に include 対象なので `filled` 系関数の分岐を Task 2 のテストが覆う）。

- [ ] **Step 2: push**

pre-push CI が走る。`auto-push` フックが 900s で打ち切るときはユーザーに `! git push` を依頼する。

---

## 自己点検（spec との対応）

| spec 節 | タスク |
|---|---|
| 4 dataRoot 構成（`filledDir`・init-data-repo・git 管理内） | 1, 2（`.gitignore` には入れない = `ensureGitignore` の `required` に足さない） |
| 5.1 ファイル層 | 2 |
| 5.2 一覧・取得 | 3（`getDropdownOptions` / `listSeriesFunds` は台帳(sproc)由来のまま。spec の「filled/ 走査」はファイル一覧 `listTemplates` にだけ当たる） |
| 5.3 申請・承認の `target` | 4 |
| 5.4 履歴・ペア同期・注記マスタ | 5, 6 |
| 5.6 既定値 | 7 |
| 5.7 e2e サーバ | 8 |
| 6.1 既定モード | 9 |
| 6.2 編集タブの申請本文 | 10 |
| 6.3 比較・結合 PDF | 11 |
| 6.4 ファンド名キャッシュ | 12 |
| 6.5 local 追随 | 13 |
| 6.6 start.bat / setup | 15, 16 |
| 7 e2e | 17, 18, 19（ユーザー切替は `test()` 分割でなく `login()` の cookie 破棄で実現。spec からの簡略化） |
| 8 ガード | 3, 4, 7（server テスト）, 14（web） |
| 9 ドキュメント | 20 |
