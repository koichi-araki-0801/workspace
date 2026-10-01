# editor フォント置き場の css/fonts 移設と js の外出し — 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フォントを `cssDir/fonts`（配信パス `css/fonts/`）へ、js を `dataRoot/js` へ移し、リクエスト CSS の相対 `url()` を `css/` 基準で解決させ、既存環境を移行パッチで新構成へ移せるようにする。

**Architecture:** `@editor/shared` に `rebaseCssUrls` を 1 つ置き、リクエスト CSS が文書へ入る 5 か所（サーバ 3・web 2）でだけ 1 回呼ぶ。配信の許可リスト（`docAssets.ts`）は配信パスの最長一致でグループを引き、`css/fonts` 専用グループを持つ。旧設定 `assetsDir` は起動エラーで案内し、移行は `editor/patches/2026-10-fonts-to-css/` の ps1 で行う。

**Tech Stack:** TypeScript（Node 24 / Fastify / Vue 3 / vitest 4）、PowerShell 5.1（パッチ）、Pester 3/4（パッチのテスト）。

**Spec:** `docs/superpowers/specs/2026-10-01-editor-fonts-to-css-design.md`

## Global Constraints

- リクエスト CSS の付け替えは 1 経路で 1 回だけ。呼んでよいのはサーバの `vivliostyle/requestCss.ts`（`build.ts` の 3 入口から呼ぶ）と web の `lib/nunjucksRender.ts`・`features/reviews/services/reviewCompareDocs.ts` だけ。
- 付け替え後の書き戻しは必ず `url("…")` の引用形。
- 配信パス `fonts/` は廃止。フォントは `css/fonts/…` だけで配る。
- 新しい設定名は `jsDir` / 環境変数 `JS_DIR` / appconfig `paths.jsDir`。`assetsDir` / `ASSETS_DIR` / `paths.assetsDir` が指定されていたら起動エラー。
- `.gitignore` の必須行に `/css/fonts/` を加える（`gitRepo.ts`・`init-data-repo.ps1`・パッチの 3 か所）。
- 日本語を含む `.ps1` は UTF-8 BOM。`.bat` は CRLF・`chcp 65001 >nul`・`.claude/rules/powershell.md` の 4 行雛形。
- コメント規約（`docs/コメント規約.md`）: なぜを書く。経緯・日付・所見番号は書かない。100 桁。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write <変更ファイル>` を実行する。
- 新規の shared / server ファイルでテストしたものは、ルート `vitest.config.ts` の coverage include に追加し、単体で 85% を満たす。
- 型チェックは `pnpm typecheck:editor`（`@editor/shared` の先行ビルド込み）。

## Review Focus

1. 編集キャンバスで保存した CSS が、次の PDF で `css/css/fonts/…` にならないこと（キャンバス側は付け替えない。Task 5 の import ガードで固定）。
2. `url(fonts/a b.woff2)`・`url("fonts/x).woff2")`・エスケープ `url(\66 onts/x.woff2)` を含む CSS が、付け替え後も CSS として壊れないこと（Task 1 のテスト）。
3. `css/fonts/x.css` のように、css 置き場の `fonts` 配下に置いた `.css` を配信しないこと、`cssDir` 直下のフォントを配信しないこと（Task 3 のテスト）。
4. `paths.assetsDir` だけ残した appconfig、`ASSETS_DIR` だけ残した環境で、どちらも「assetsDir は廃止」の起動エラーになること（Task 2 のテスト）。
5. 移行パッチを `-Apply` で 2 回実行しても 2 回目は何も変えず、移動元と移動先で内容が食い違うときは中止すること（Task 8 のテスト）。

---

### Task 1: shared に `rebaseCssUrls` を作る

**Files:**
- Create: `editor/shared/src/security/cssRebase.ts`
- Modify: `editor/shared/src/index.ts`（`security/cssExternalRefs.js` の export の直後に 1 行）
- Modify: `vitest.config.ts`（coverage include の `editor/shared/src/security/htmlEntities.ts` の直後）
- Test: `editor/shared/test/cssRebase.test.ts`

**Interfaces:**
- Consumes: `collectCssUrlSpans(css): CssUrlSpan[]`、`isSelfContainedUrl(url): boolean`（`cssExternalRefs.ts`）、`resolveServedAssetPath(url): string | undefined`（`htmlExternalRefs.ts`）
- Produces: `export function rebaseCssUrls(css: string, baseDir: string): string`、`export const REQUEST_CSS_BASE = 'css'`

- [ ] **Step 1: 失敗するテストを書く**

`editor/shared/test/cssRebase.test.ts`:

```ts
// =============================================================================
// cssRebase.test.ts — リクエスト CSS の相対 url() を css/ 基準へ付け替える関数の固定
// =============================================================================
import { describe, expect, it } from 'vitest';
import { collectCssUrlCandidates, findExternalRefsInCss } from '../src/security/cssExternalRefs.js';
import { REQUEST_CSS_BASE, rebaseCssUrls } from '../src/security/cssRebase.js';

const rebase = (css: string): string => rebaseCssUrls(css, REQUEST_CSS_BASE);

describe('rebaseCssUrls', () => {
  it('相対 url() を css/ 基準の配信ルート相対へ直し、引用形で書き戻す', () => {
    expect(rebase('@font-face{src:url(fonts/a.woff2)}')).toBe(
      '@font-face{src:url("css/fonts/a.woff2")}',
    );
  });

  it('../ は正規化する(css/../js/x.js → js/x.js)', () => {
    expect(rebase('.a{background:url(../js/x.png)}')).toBe('.a{background:url("js/x.png")}');
  });

  it('ルートの外へ出る形は原文のまま残す', () => {
    const css = '.a{background:url(../../x.png)}';
    expect(rebase(css)).toBe(css);
  });

  it.each([
    ['data:', '.a{background:url(data:image/png;base64,AAAA)}'],
    ['断片', '.a{fill:url(#grad)}'],
    ['ルート絶対', '.a{background:url(/x.png)}'],
    ['絶対 URL', '.a{background:url(https://example.com/x.png)}'],
    ['scheme 相対', '.a{background:url(//example.com/x.png)}'],
  ])('%s は付け替えない', (_label, css) => {
    expect(rebase(css)).toBe(css);
  });

  it('local() と引用符文字列は付け替えない', () => {
    const css =
      '@font-face{src:local("fonts/a"),url(fonts/a.woff2)} .b{content:"fonts/x"}' +
      ' .c{background:image-set("fonts/y.png" 1x)}';
    expect(rebase(css)).toBe(
      '@font-face{src:local("fonts/a"),url("css/fonts/a.woff2")} .b{content:"fonts/x"}' +
        ' .c{background:image-set("fonts/y.png" 1x)}',
    );
  });

  it('クエリと断片は保つ', () => {
    expect(rebase('@font-face{src:url(fonts/a.eot?#iefix)}')).toBe(
      '@font-face{src:url("css/fonts/a.eot?#iefix")}',
    );
  });

  it('空白・括弧・引用符・エスケープを含む値でも CSS を壊さない', () => {
    const out = rebase(
      '.a{background:url("fonts/a b.png")} .b{background:url("fonts/x).png")} ' +
        '.c{background:url(\\66 onts/e.png)} .d{color:red}',
    );
    expect(out).toContain('url("css/fonts/a%20b.png")');
    expect(out).toContain('url("css/fonts/x).png")');
    expect(out).toContain('url("css/fonts/e.png")');
    // 後続の規則が生き残る(引用なしで書き戻すと `)` で url() が閉じて崩れる)。
    expect(out).toContain('.d{color:red}');
    expect(collectCssUrlCandidates(out)).toEqual([
      'css/fonts/a%20b.png',
      'css/fonts/x).png',
      'css/fonts/e.png',
    ]);
  });

  it('エスケープで隠した </style> を生の字面へ戻さない', () => {
    const out = rebase('.a{background:url(fonts/\\3c /style\\3e x.png)}');
    expect(out.toLowerCase()).not.toContain('</style');
  });

  it('外部参照の検査結果を変えない(付け替え前後で同じ)', () => {
    const css =
      '.a{background:url(fonts/a.png)} .b{background:url(https://evil/x)} @import "x.css";';
    expect(findExternalRefsInCss(rebase(css))).toEqual(findExternalRefsInCss(css));
  });

  it('2 回掛けると二重になる(冪等ではない = 呼び出しは入口 1 回に限る理由)', () => {
    expect(rebase(rebase('.a{background:url(fonts/a.png)}'))).toBe(
      '.a{background:url("css/css/fonts/a.png")}',
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter @editor/shared exec vitest run test/cssRebase.test.ts`
Expected: FAIL（`Cannot find module '../src/security/cssRebase.js'`）

- [ ] **Step 3: 実装する**

`editor/shared/src/security/cssRebase.ts`:

```ts
// =============================================================================
// cssRebase.ts — リクエスト CSS の相対 url() を css/ 基準の配信ルート相対へ付け替える
// =============================================================================
// ファンド CSS は `css/<fund>.css` に置かれ、CSS 自身から見た相対パス(`url(fonts/x.woff2)`)で
// 書かれる。ところが PDF・プレビューでは、その CSS を文書の `<style>` へ埋め込むため、相対
// URL は配信ルート直下を基準に解決されてしまう。埋め込む瞬間に `css/` 基準へ付け替えて、
// 「`<link>` で読んだときと同じ実体」に届くようにする。
//
// ⚠ この関数は冪等ではない(`fonts/x` → `css/fonts/x` → `css/css/fonts/x`)。著者が `css/` と
// 書いたのかを区別できないので、冪等化はしない。呼び出しは「リクエスト CSS が文書へ入る
// 入口で 1 回」に限り、その場所は import のガードテストで固定している
// (`server/test/requestCss.guard.test.ts`・`web/test/cssRebase.guard.test.ts`)。
//
// 走査は検査・配置と同じ `collectCssUrlSpans` を使う。別の正規表現で拾い直すと「検査は見たが
// 付け替えは見ていない」形の食い違いが生まれる。引用符文字列(`image-set("…")`・`content`)は
// 付け替えない — 本文の文字列を壊さないため、相対参照は `url()` で書く契約にしている。

import { collectCssUrlSpans, isSelfContainedUrl } from './cssExternalRefs.js';
import { resolveServedAssetPath } from './htmlExternalRefs.js';

/** リクエスト CSS が置かれているとみなす配信ルート相対のディレクトリ。 */
export const REQUEST_CSS_BASE = 'css';

/**
 * `css` の中の相対 `url()` を、`baseDir` に置かれた CSS から見た相対として解決し直し、
 * 配信ルート相対の `url("…")` へ書き換える。付け替えられない値(絶対 URL・`data:`・`#`・
 * `/` 始まり・ルートの外へ出る形)は原文のまま残す。
 */
export function rebaseCssUrls(css: string, baseDir: string): string {
  let out = css;
  // 後ろから置換して、先行する範囲のオフセットを保つ。
  for (const span of [...collectCssUrlSpans(css)].reverse()) {
    const rebased = rebaseUrlValue(span.value, baseDir);
    if (rebased === undefined) continue;
    out = `${out.slice(0, span.start)}url("${rebased}")${out.slice(span.end)}`;
  }
  return out;
}

/** 1 つの URL 値を付け替える。対象外なら `undefined`。 */
function rebaseUrlValue(value: string, baseDir: string): string | undefined {
  const v = value.trim();
  if (v === '' || v.startsWith('#') || v.startsWith('/') || v.startsWith('\\')) return undefined;
  if (!isSelfContainedUrl(v) || /^data:/i.test(v)) return undefined;
  const cut = v.search(/[?#]/);
  const pathPart = cut < 0 ? v : v.slice(0, cut);
  const suffix = cut < 0 ? '' : v.slice(cut);
  const resolved = resolveServedAssetPath(`${baseDir}/${pathPart}`);
  if (resolved === undefined) return undefined;
  try {
    // 値はエスケープ解決後の字面なので、`"` `\` 改行や `</style` を含みうる。各セグメントと
    // クエリ・断片を百分率符号化して、引用形の中で CSS・HTML のどちらとしても無害にする。
    const encodedPath = resolved.split('/').map(encodeURIComponent).join('/');
    return encodedPath + encodeURI(suffix).replace(/"/g, '%22');
  } catch {
    // 孤立サロゲートなど符号化できない値は触らない(原文のまま = 従来どおりの解決)。
    return undefined;
  }
}
```

`editor/shared/src/index.ts` の `export * from './security/cssExternalRefs.js';` の直後に追加:

```ts
export * from './security/cssRebase.js';
```

`vitest.config.ts` の coverage include で `'editor/shared/src/security/htmlEntities.ts',` の直後に追加:

```ts
        'editor/shared/src/security/cssRebase.ts',
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter @editor/shared exec vitest run test/cssRebase.test.ts`
Expected: PASS（全 11 件）。`a b` は `a%20b` に、`x)` は `)` が `encodeURIComponent` で残る（`)` は予約外）ことに注意。テストの期待値と実装が食い違ったら、期待値ではなく「CSS が壊れない・`</style` を作らない」という不変則を満たす方へ実装を直す。

- [ ] **Step 5: shared のビルドと既存テスト**

Run: `pnpm --filter @editor/shared run build && pnpm --filter @editor/shared exec vitest run`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/shared/src/security/cssRebase.ts editor/shared/test/cssRebase.test.ts editor/shared/src/index.ts
git add editor/shared/src/security/cssRebase.ts editor/shared/test/cssRebase.test.ts editor/shared/src/index.ts vitest.config.ts
git commit -m "feat(shared): リクエスト CSS の相対 url() を css/ 基準へ付け替える rebaseCssUrls を追加する"
```

---

### Task 2: config に `jsDir` を足し、`assetsDir` を起動エラーで廃止する

**Files:**
- Modify: `editor/server/src/config.ts`（スキーマ 48-64 行、置き場 297-306 行、末尾の `assertSafeExposure` 呼び出しの直前）
- Modify: `editor/server/test/config.paths.test.ts`
- Modify: `editor/server/test/previewHost.test.ts`（17-35 行の env と置き場）

**Interfaces:**
- Produces: `config.jsDir: string`（既定 `dataRoot/js`）、`export function assertNoRetiredAssetsDir(opts: { env: string | undefined; file: string | undefined }): void`
- 削除: `config.assetsDir`

- [ ] **Step 1: 失敗するテストを書く**

`config.paths.test.ts` の `PATH_ENV_KEYS` の `'ASSETS_DIR',` を `'JS_DIR',` に置き換え、さらに `'ASSETS_DIR',` を末尾に残す（既定観測のため外す対象に含める）:

```ts
const PATH_ENV_KEYS = [
  'DATA_ROOT',
  'TEMPLATES_DIR',
  'CSS_DIR',
  'FILLED_DIR',
  'JS_DIR',
  'DRAFTS_DIR',
  'PENDING_DIR',
  'REVIEWS_DIR',
  'SYNC_DIR',
  'GIT_REPO_DIR',
  'ASSETS_DIR',
] as const;
```

`derives every data directory from DATA_ROOT` の `expect(config.assetsDir)…` 行を置き換える:

```ts
    expect(config.jsDir).toBe(path.join(DATA_ROOT, 'js'));
    expect('assetsDir' in config).toBe(false);
```

ファイル末尾の `describe` 内に追加:

```ts
  it('JS_DIR が jsDir を上書きする', async () => {
    const jsDir = path.resolve(path.sep, 'tmp', 'editor-js-elsewhere');
    const { config } = await importConfigWithEnv({ DATA_ROOT, JS_DIR: jsDir });
    expect(config.jsDir).toBe(jsDir);
  });

  it('ASSETS_DIR が残っていたら起動エラーで jsDir への移行を案内する', async () => {
    await expect(
      importConfigWithEnv({ DATA_ROOT, ASSETS_DIR: path.join(DATA_ROOT, 'assets') }),
    ).rejects.toThrow(/assetsDir は廃止しました.*JS_DIR.*2026-10-fonts-to-css/s);
  });
});

describe('assertNoRetiredAssetsDir', () => {
  it('appconfig の paths.assetsDir だけでも拒む', async () => {
    const { assertNoRetiredAssetsDir } = await importConfigWithEnv({ DATA_ROOT });
    expect(() => assertNoRetiredAssetsDir({ env: undefined, file: 'data/assets' })).toThrow(
      /paths\.assetsDir/,
    );
  });

  it('どちらも無ければ何もしない', async () => {
    const { assertNoRetiredAssetsDir } = await importConfigWithEnv({ DATA_ROOT });
    expect(() => assertNoRetiredAssetsDir({ env: undefined, file: undefined })).not.toThrow();
  });
```

（最後の `});` は既存の `describe('config paths', …)` を閉じる位置に合わせて調整する。追加した `describe('assertNoRetiredAssetsDir')` はファイル末尾で閉じる。）

`previewHost.test.ts` の env と置き場を置き換える:

```ts
process.env.DATA_ROOT = tmp;
process.env.JS_DIR = path.join(tmp, 'js');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.AUTH_REQUIRED = 'false';
```

同ファイル内の `path.join(tmp, 'assets', 'js'…)` を `path.join(tmp, 'js'…)` に、`path.join(tmp, 'assets', 'fonts'…)` を `path.join(tmp, 'css', 'fonts'…)` に、URL の `/fonts/` を `/css/fonts/` に置き換える（`grep -n "assets\|fonts" editor/server/test/previewHost.test.ts` で全件を確認する）。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/config.paths.test.ts`
Expected: FAIL（`config.jsDir` が undefined、`assertNoRetiredAssetsDir` が無い）

- [ ] **Step 3: 実装する**

`config.ts` のスキーマ `paths` に `jsDir` を足す（`assetsDir` は検出のため残す）:

```ts
        assetsDir: z.string().optional(),
        jsDir: z.string().optional(),
```

297-306 行の `assetsDir:` の定義（doc コメントごと）を置き換える:

```ts
  /**
   * **全ファンド共通**のテンプレ JS(`js/…`)を置くディレクトリ。テンプレはこれを `js/…` の
   * 相対パスで参照し、PDF ビルド / プレビューの配信ルートへ `vivliostyle/docAssets.ts` が写す。
   * フォントは CSS 側の資産なので `<cssDir>/fonts` に置く(CSS から `url(fonts/…)` で引く)。
   *
   * ⚠ この配下は **headless ブラウザが読む配信ルートへ写される**。任意のファイルを置く
   * 場所ではなく、写す対象は `docAssets.ts` の拡張子許可リストで絞る。
   */
  jsDir: resolveDataPath(process.env.JS_DIR, file.paths?.jsDir, 'js'),
```

`allowPlaintextLan` の定義の直前（`// ── 2. セキュリティ方針 ──` より後ろ、関数群の並び）に追加:

```ts
/**
 * 廃止した設定 `assetsDir`(appconfig `paths.assetsDir` / env `ASSETS_DIR`)が残っていないか。
 * 黙って無視すると、独自の置き場に置いた js が配信ルートへ載らず、JS の効かない PDF が成功扱いで
 * 出る。誤記を起動中止で運用者に届ける方針(`envFlag`)に揃えて、ここで止める。
 */
export function assertNoRetiredAssetsDir(opts: {
  env: string | undefined;
  file: string | undefined;
}): void {
  const where = [
    ...(opts.env === undefined ? [] : ['環境変数 ASSETS_DIR']),
    ...(opts.file === undefined ? [] : ['appconfig.json の paths.assetsDir']),
  ];
  if (where.length === 0) return;
  throw new Error(
    `[config] ${where.join(' と ')} が指定されていますが、assetsDir は廃止しました。` +
      ' js は jsDir(環境変数 JS_DIR / appconfig の paths.jsDir)へ、フォントは <cssDir>/fonts へ' +
      ' 移してください。移行パッチ: editor/patches/2026-10-fonts-to-css/',
  );
}
```

ファイル末尾の `assertSafeExposure({…});` の直前に追加:

```ts
// 廃止した置き場の指定が残っていたら、listen より前に止める。
assertNoRetiredAssetsDir({ env: process.env.ASSETS_DIR, file: file.paths?.assetsDir });
```

- [ ] **Step 4: `config.assetsDir` の参照を直す**

Run: `grep -rn "assetsDir" editor/server/src editor/web/src editor/shared/src`
`docAssets.ts` の `ASSET_GROUPS` で `config.assetsDir` を使う 2 か所を、型が通る最小の形に直す（構造の作り直しは Task 3 で行う）:

```ts
    sourceDir: () => path.join(config.cssDir, 'fonts'),   // fonts グループ
```

```ts
    sourceDir: () => config.jsDir,                          // js グループ
```

それ以外のファイルに参照があれば `jsDir` へ直す。Run: `pnpm typecheck:editor` → エラー 0。

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/config.paths.test.ts test/previewHost.test.ts`
Expected: PASS（previewHost.test は Task 3 の配信変更後に通るものがあれば、Task 3 完了時に再確認する）

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/server/src/config.ts editor/server/test/config.paths.test.ts editor/server/test/previewHost.test.ts
git add editor/server/src/config.ts editor/server/test/config.paths.test.ts editor/server/test/previewHost.test.ts
git commit -m "feat(editor): js の置き場を jsDir(dataRoot/js)へ外出しし、廃止した assetsDir の指定を起動エラーで案内する"
```

---

### Task 3: 配信の許可リストを css/fonts グループと最長一致へ変える

**Files:**
- Modify: `editor/server/src/vivliostyle/docAssets.ts`（冒頭コメント 1-21 行、`AssetGroup` 31-37 行、`ASSET_GROUPS` 57-73 行、`collectGroup` 113-146 行、`resolveServedAssetSource` 159-178 行、`expandReferenced` のコメント 196-197 行）
- Modify: `editor/server/src/vivliostyle/docRefs.ts`（21-27 行のコメント）
- Modify: `editor/server/test/docAssets.test.ts`
- Modify: `editor/server/test/docRefs.test.ts`

**Interfaces:**
- Consumes: `config.cssDir`、`config.jsDir`（Task 2）
- Produces: 配信パス `css/fonts/<…>.{ttf,otf,woff,woff2}`、`css/<…>.css`（`css/fonts/` 配下を除く）、`js/<…>.{js,mjs}`。`resolveServedAssetSource(rel)` と `stageDocAssets(dir, opts)` のシグネチャは不変。

- [ ] **Step 1: 失敗するテストを書く**

`docAssets.test.ts` の置き場変数を置き換える:

```ts
let root: string;
let cssDir: string;
let jsDir: string;
let dest: string;
```

`loadStage` と `resolve` 用の `vi.doMock` の `config: { cssDir, assetsDir }` を 2 か所とも `config: { cssDir, jsDir }` に置き換え、`beforeEach` の `assetsDir = path.join(root, 'data', 'assets');` を `jsDir = path.join(root, 'data', 'js');` に置き換える。

既存テストの置き場を機械的に置き換える:
- `path.join(assetsDir, 'fonts', …)` → `path.join(cssDir, 'fonts', …)`
- `path.join(assetsDir, 'js', …)` → `path.join(jsDir, …)`
- 期待値の配信パス `'fonts/…'` → `'css/fonts/…'`
- `it('assetsDir 直下(fonts/js の外)のファイルは写らない'…)` は削除し、下の新規テストで置き換える
- `'@font-face{font-family:BIZ;src:url(../fonts/BIZUD.woff2) format("woff2")}'`（CSS ファイル内の参照）は `url(fonts/BIZUD.woff2)` に変える（CSS ファイルから見た相対）

新規テストを `describe` 内に追加:

```ts
  it('フォントは css/fonts 配下だけ配る(cssDir 直下のフォントは写らない)', async () => {
    await write(path.join(cssDir, 'fonts', 'BIZUD.woff2'), 'font');
    await write(path.join(cssDir, 'loose.woff2'), 'font');
    const served = await (await loadStage())(dest);
    expect([...served].sort()).toEqual(['css/fonts/BIZUD.woff2']);
  });

  it('css/fonts 配下の .css は配らない(css グループは fonts 配下を見ない)', async () => {
    await write(path.join(cssDir, 'fonts', 'x.css'), '.a{}');
    await write(path.join(cssDir, '510037.css'), '.b{}');
    const served = await (await loadStage())(dest);
    expect([...served].sort()).toEqual(['css/510037.css']);
  });

  it('旧配信パス fonts/ は解決しない', async () => {
    await write(path.join(cssDir, 'fonts', 'BIZUD.woff2'), 'font');
    const resolve = await loadResolve();
    expect(await resolve('fonts/BIZUD.woff2')).toBeUndefined();
    expect(await resolve('css/fonts/BIZUD.woff2')).toBe(path.join(cssDir, 'fonts', 'BIZUD.woff2'));
  });

  it('css/fonts/x.css は css グループにも css/fonts グループにも解決しない', async () => {
    await write(path.join(cssDir, 'fonts', 'x.css'), '.a{}');
    const resolve = await loadResolve();
    expect(await resolve('css/fonts/x.css')).toBeUndefined();
  });

  it('jsDir 直下の js を js/ で配る', async () => {
    await write(path.join(jsDir, 'column-width.js'), 'ok()');
    const served = await (await loadStage())(dest);
    expect([...served]).toEqual(['js/column-width.js']);
  });
```

（`loadResolve` は既存の `resolveServedAssetSource` を読み込むヘルパ。名前が違う場合は既存の 184 行付近のヘルパ名に合わせる。）

`docRefs.test.ts` の `resolveRefFrom` の表（76-78 行）に 1 行足す:

```ts
    ['css/510037.css', 'fonts/a.woff2', 'css/fonts/a.woff2'],
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/docAssets.test.ts test/docRefs.test.ts`
Expected: FAIL（`css/fonts` グループが無い・`config.jsDir` を見ていない）

- [ ] **Step 3: 実装する**

`AssetGroup` に除外ディレクトリを足す:

```ts
interface AssetGroup {
  /** 配信ルート側のディレクトリ(= テンプレの相対参照の先頭。`css/fonts` のように複数段もある)。 */
  readonly mount: string;
  /** 実体の置き場を返す(`config` を毎回読むのはテストで差し替えられるようにするため)。 */
  readonly sourceDir: () => string;
  readonly extensions: ReadonlySet<string>;
  /**
   * 置き場の直下で降りないディレクトリ名(小文字で比較)。css の置き場の `fonts/` は
   * 別グループ(`css/fonts`)の持ち物で、css グループが降りると `css/fonts/x.css` を
   * 片方の判定だけが配る食い違いが生まれる。
   */
  readonly skipTopDirs?: ReadonlySet<string>;
}
```

`ASSET_GROUPS` を置き換える（doc コメントの `.js` / `.map` の段落はそのまま残す）:

```ts
const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.ttf', '.otf', '.woff', '.woff2']);

const ASSET_GROUPS: readonly AssetGroup[] = [
  {
    mount: 'css/fonts',
    sourceDir: () => path.join(config.cssDir, 'fonts'),
    extensions: FONT_EXTENSIONS,
  },
  {
    mount: 'css',
    sourceDir: () => config.cssDir,
    extensions: new Set(['.css']),
    skipTopDirs: new Set(['fonts']),
  },
  {
    mount: 'js',
    sourceDir: () => config.jsDir,
    extensions: new Set(['.js', '.mjs']),
  },
];

/**
 * 配信ルート相対パスを持つグループを引く。`css/fonts/x` が `css` に当たらないよう、
 * mount の段数が多い方を先に照合する(最長一致)。
 */
function groupFor(rel: string): { group: AssetGroup; rest: string[] } | undefined {
  const segments = rel.split('/');
  const byDepth = [...ASSET_GROUPS].sort(
    (a, b) => b.mount.split('/').length - a.mount.split('/').length,
  );
  for (const group of byDepth) {
    const mountSegs = group.mount.split('/');
    if (segments.length <= mountSegs.length) continue;
    if (!mountSegs.every((s, i) => segments[i] === s)) continue;
    const rest = segments.slice(mountSegs.length);
    if (group.skipTopDirs?.has(rest[0].toLowerCase()) && rest.length > 1) return undefined;
    return { group, rest };
  }
  return undefined;
}
```

`collectGroup` の `walk` で、置き場直下の除外ディレクトリを飛ばす（`if (entry.isDirectory()) {` の中を置き換える）:

```ts
      if (entry.isDirectory()) {
        if (depth === 0 && group.skipTopDirs?.has(entry.name.toLowerCase())) continue;
        await walk(full, rel, depth + 1);
        continue;
      }
```

`resolveServedAssetSource` の先頭 6 行（`const segments …` から拡張子判定まで）を置き換える:

```ts
export async function resolveServedAssetSource(rel: string): Promise<string | undefined> {
  const hit = groupFor(rel);
  if (hit === undefined) return undefined;
  const { group, rest } = hit;
  if (rest.length > MAX_ASSET_DEPTH + 1) return undefined;
  if (rest.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  if (!group.extensions.has(path.extname(rest[rest.length - 1]).toLowerCase())) return undefined;
  let current = group.sourceDir();
```

（以降の `for (const [i, seg] of rest.entries())` は不変。）

冒頭コメントの「置き場」節を置き換える:

```ts
// ── 置き場(利用者決定・変更しないこと) ──
//   css       = `config.cssDir`        (per-fund。`<fund>.css`。直下の `fonts/` は下の別グループ)
//   css/fonts = `config.cssDir/fonts`  (全ファンド共通のフォント。CSS から `url(fonts/…)`)
//   js        = `config.jsDir`         (全ファンド共通のテンプレ JS)
// 配信ルートでの名前は `css/` `css/fonts/` `js/` に固定する(テンプレ側の相対参照と対)。
```

`expandReferenced` の doc コメントの例 `url(../fonts/a.woff2)` を `url(fonts/a.woff2)` に、`docRefs.ts` 21-27 行の例 `css/x.css → fonts/y.woff2` / `../fonts/a.woff2` / `fonts/a.woff2` を `css/x.css → css/fonts/y.woff2` / `fonts/a.woff2` / `css/fonts/a.woff2` に直す。

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/docAssets.test.ts test/docRefs.test.ts test/previewHost.test.ts test/inlineCss.test.ts`
Expected: PASS。`inlineCss.test.ts` の `served` 集合や `<link rel=preload href="fonts/…">` の期待値で落ちるものは、配信パスを `css/fonts/…` に置き換えて直す。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/vivliostyle/docAssets.ts editor/server/src/vivliostyle/docRefs.ts editor/server/test/docAssets.test.ts editor/server/test/docRefs.test.ts editor/server/test/inlineCss.test.ts
git add editor/server/src/vivliostyle/docAssets.ts editor/server/src/vivliostyle/docRefs.ts editor/server/test/docAssets.test.ts editor/server/test/docRefs.test.ts editor/server/test/inlineCss.test.ts
git commit -m "feat(editor): フォントを css/fonts 専用グループで配り、配信グループを最長一致で引く"
```

---

### Task 4: サーバの 3 入口でリクエスト CSS を 1 回だけ付け替える

**Files:**
- Create: `editor/server/src/vivliostyle/requestCss.ts`
- Modify: `editor/server/src/vivliostyle/build.ts`（`buildInlinePdf` 154-161 行、`buildMergedPdf` 280-299 行、`prepareInlineDoc` 307-330 行）
- Test: `editor/server/test/requestCss.test.ts`、`editor/server/test/requestCss.guard.test.ts`
- Modify: `vitest.config.ts`（coverage include に `editor/server/src/vivliostyle/requestCss.ts`）

**Interfaces:**
- Consumes: `rebaseCssUrls`、`REQUEST_CSS_BASE`（Task 1）
- Produces: `export function rebaseRequestCss(css: string | undefined): string`

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/requestCss.test.ts`:

```ts
// =============================================================================
// requestCss.test.ts — build 入口でのリクエスト CSS の付け替え
// =============================================================================
import { describe, expect, it } from 'vitest';
import { rebaseRequestCss } from '../src/vivliostyle/requestCss.js';

describe('rebaseRequestCss', () => {
  it('css/ 基準へ付け替える', () => {
    expect(rebaseRequestCss('@font-face{src:url(fonts/a.woff2)}')).toBe(
      '@font-face{src:url("css/fonts/a.woff2")}',
    );
  });

  it('未指定・空は空文字', () => {
    expect(rebaseRequestCss(undefined)).toBe('');
    expect(rebaseRequestCss('')).toBe('');
  });
});
```

`editor/server/test/requestCss.guard.test.ts`:

```ts
// =============================================================================
// requestCss.guard.test.ts — リクエスト CSS の付け替えは入口で 1 回だけ、の配線を固定する
// =============================================================================
// `rebaseCssUrls` は冪等ではない。2 か所で掛かると `css/css/fonts/…` になって
// フォントが黙って消える(実体の無い参照は inlineCss が落とすのでエラーにならない)。
// 個々の入力ではなく呼び出しの形が不変則なので、ソース走査で固定する。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) found.push(full);
  }
  return found;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ALL = sourceFiles(SRC).map((f) => ({ f, code: stripComments(readFileSync(f, 'utf8')) }));
const rel = (f: string): string => path.relative(SRC, f).replace(/\\/g, '/');

describe('リクエスト CSS の付け替えの配線', () => {
  it('rebaseCssUrls を使うのは requestCss.ts だけ', () => {
    const users = ALL.filter(({ code }) => /\brebaseCssUrls\b/.test(code)).map(({ f }) => rel(f));
    expect(users).toEqual(['vivliostyle/requestCss.ts']);
  });

  it('rebaseRequestCss を呼ぶのは build.ts の 3 入口だけ', () => {
    const callers = ALL.filter(({ f }) => rel(f) !== 'vivliostyle/requestCss.ts')
      .filter(({ code }) => /\brebaseRequestCss\(/.test(code))
      .map(({ f }) => rel(f));
    expect(callers).toEqual(['vivliostyle/build.ts']);
    const build = ALL.find(({ f }) => rel(f) === 'vivliostyle/build.ts')?.code ?? '';
    expect(build.match(/\brebaseRequestCss\(/g)).toHaveLength(3);
  });

  it('付け替えは外部参照検査より前', () => {
    const build = ALL.find(({ f }) => rel(f) === 'vivliostyle/build.ts')?.code ?? '';
    for (const label of ['build.inline', 'preview.inline', 'build.merge']) {
      const check = build.indexOf(`'${label}`) >= 0 ? build.indexOf(`'${label}`) : build.indexOf(`\`${label}`);
      const fnStart = build.lastIndexOf('function', check);
      expect(build.slice(fnStart, check)).toMatch(/rebaseRequestCss\(/);
    }
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/requestCss.test.ts test/requestCss.guard.test.ts`
Expected: FAIL（`requestCss.js` が無い）

- [ ] **Step 3: 実装する**

`editor/server/src/vivliostyle/requestCss.ts`:

```ts
// =============================================================================
// requestCss.ts — build 入口でリクエスト CSS を css/ 基準へ付け替える(入口 1 回だけ)
// =============================================================================
// リクエストの `css` は `css/<fund>.css` の位置に置かれた CSS として解釈する(外部 API の契約。
// OpenAPI の説明と設計正典に明記)。文書へは `<style>` として埋め込むので、埋め込む前に相対
// `url()` を `css/` 基準へ直す。付け替えは冪等ではないため、呼ぶのは `build.ts` の 3 入口
// (`/api/build`・`/build/merge`・`/api/preview`)の先頭だけ — 配線は
// `test/requestCss.guard.test.ts` が固定する。HTML の `<style>`・`style` 属性は付け替えない。

import { REQUEST_CSS_BASE, rebaseCssUrls } from '@editor/shared';

/** リクエスト CSS を付け替える。未指定は空文字(以降の処理は `css ?? ''` と同じ扱い)。 */
export function rebaseRequestCss(css: string | undefined): string {
  return css ? rebaseCssUrls(css, REQUEST_CSS_BASE) : '';
}
```

`build.ts` の import に `import { rebaseRequestCss } from './requestCss.js';` を足し、3 入口を変える。

`buildInlinePdf`:

```ts
export async function buildInlinePdf(input: BuildInlineInput): Promise<Buffer> {
  // リクエスト CSS は入口で 1 回だけ付け替える(`requestCss.ts`)。検査は付け替え後の CSS に
  // 対して行う — 実際に文書へ入る形を見る(fail closed)。
  const doc = { ...input, css: rebaseRequestCss(input.css) };
  // 外部参照の関門は**ここ**(サーバの build 入口)。…(既存コメントはそのまま)
  assertNoDocumentExternalRefs(doc.html, doc.css, 'build.inline');
  return withBuildSlot((runBuild) => buildInlineInSlot(doc, runBuild));
}
```

`buildMergedPdf`:

```ts
export async function buildMergedPdf(input: {
  documents: MergeDocument[];
  size?: string;
}): Promise<Buffer> {
  // 文書ごとのリクエスト CSS を入口で 1 回だけ付け替える(`requestCss.ts`)。
  const documents = input.documents.map((d) => ({ ...d, css: rebaseRequestCss(d.css) }));
  // 結合は文書毎に実体化されるので、…(既存コメントはそのまま)
  for (const [i, doc] of documents.entries()) {
    assertNoDocumentExternalRefs(doc.html, doc.css, `build.merge[${i}]`);
  }
  return withBuildSlot(async (runBuild) => {
    const { dir, config: mergeConfig } = await materializeMergeProject(documents, input.size);
    // …(以降不変)
```

`prepareInlineDoc`（関数の先頭、`fs.mkdir` より前）:

```ts
  // リクエスト CSS は入口で 1 回だけ付け替える(`requestCss.ts`)。
  const css = rebaseRequestCss(input.css);
```

同関数内の `input.css ?? ''` 3 か所（`assertNoDocumentExternalRefs`・`collectDocumentAssetRefs`・`inlineCss`）をすべて `css` に置き換える。

`vitest.config.ts` の coverage include の server 節（`'editor/server/src/security/templateScripts.ts',` の直前）に追加:

```ts
        'editor/server/src/vivliostyle/requestCss.ts',
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/requestCss.test.ts test/requestCss.guard.test.ts test/externalRefs.test.ts`
Expected: PASS。ガードの「検査より前」の判定がラベルの書き方（`'build.inline'` と `` `build.merge[${i}]` ``）で拾えないときは、判定を `indexOf('build.merge')` のように引用符なしに緩めてよい。

- [ ] **Step 5: 型チェック**

Run: `pnpm typecheck:editor`
Expected: エラー 0

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/server/src/vivliostyle/requestCss.ts editor/server/src/vivliostyle/build.ts editor/server/test/requestCss.test.ts editor/server/test/requestCss.guard.test.ts
git add editor/server/src/vivliostyle/requestCss.ts editor/server/src/vivliostyle/build.ts editor/server/test/requestCss.test.ts editor/server/test/requestCss.guard.test.ts vitest.config.ts
git commit -m "feat(editor): build の 3 入口でリクエスト CSS を css/ 基準へ 1 回だけ付け替える"
```

---

### Task 5: web のプレビュー・精査比較で付け替え、埋め込み判定を css/fonts/ にする

**Files:**
- Modify: `editor/web/src/lib/nunjucksRender.ts`（`assemblePreviewDocument` 66-87 行）
- Modify: `editor/web/src/features/reviews/services/reviewCompareDocs.ts`（`wrapDoc` 98-104 行）
- Modify: `editor/web/src/lib/previewSelfContain.ts`（153-170 行）
- Test: `editor/web/test/cssRebase.guard.test.ts`（新規）、`editor/web/test/previewSelfContain.dom.test.ts`、`editor/web/test/nunjucksRender.dom.test.ts`

**Interfaces:**
- Consumes: `rebaseCssUrls`、`REQUEST_CSS_BASE`（Task 1）
- Produces: なし（呼び出し側の挙動のみ）

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/cssRebase.guard.test.ts`（`ssti.guard.test.ts` の `sourceFiles` / `stripComments` と同じ書き方）:

```ts
// =============================================================================
// cssRebase.guard.test.ts — web でリクエスト CSS を付け替える場所を 2 か所に固定する
// =============================================================================
// 付け替えは冪等ではない。編集キャンバス(GrapesJS の setStyle)で付け替えると、付け替え済みの
// CSS が getCss() 経由で下書き・申請・確定 CSS に保存され、サーバの入口でもう一度掛かって
// `css/css/fonts/…` になる。だから付け替えてよいのは「表示用の文書を組み立てる 2 か所」だけ。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|vue)$/.test(name)) found.push(full);
  }
  return found;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('web の CSS 付け替えの配線', () => {
  it('rebaseCssUrls を使うのは nunjucksRender.ts と reviewCompareDocs.ts だけ', () => {
    const users = sourceFiles(WEB_SRC)
      .filter((f) => /\brebaseCssUrls\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(WEB_SRC, f).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual([
      'features/reviews/services/reviewCompareDocs.ts',
      'lib/nunjucksRender.ts',
    ]);
  });
});
```

`nunjucksRender.dom.test.ts` に追加（既存の import に `assemblePreviewDocument` があることを確認して使う）:

```ts
  it('本文 CSS の相対 url() を css/ 基準へ 1 回だけ付け替える(filledHtml 経由の再入でも二重にしない)', () => {
    const css = '@font-face{font-family:a;src:url(fonts/a.woff2)}';
    const once = assemblePreviewDocument('<p>x</p>', css);
    expect(once).toContain('url("css/fonts/a.woff2")');
    // 申請の filledHtml(= 上の出力)を本文として再度組み立てても、HTML 側の <style> は触らない。
    const again = assemblePreviewDocument(once, css);
    expect(again).not.toContain('css/css/');
  });
```

`previewSelfContain.dom.test.ts` の `fonts/` を `css/fonts/` へ置き換える（`grep -n "fonts/" editor/web/test/previewSelfContain.dom.test.ts` の全件。`fetcherFor({ 'fonts/biz.woff2': … })` → `fetcherFor({ 'css/fonts/biz.woff2': … })`、`url(fonts/biz.woff2)` → `url(css/fonts/biz.woff2)`）。さらに追加:

```ts
  it('旧配信パス fonts/ は埋め込まない', async () => {
    const fetcher = fetcherFor({ 'fonts/old.woff2': new Uint8Array([1]) });
    const out = await selfContainPreviewDoc(
      DOC('', '<style>@font-face{src:url(fonts/old.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('url(fonts/old.woff2)');
  });
```

（`selfContainPreviewDoc` / `DOC` / `fetcherFor` は同ファイルの既存ヘルパ名に合わせる。）

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter web exec vitest run test/cssRebase.guard.test.ts test/nunjucksRender.dom.test.ts test/previewSelfContain.dom.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`nunjucksRender.ts` の import に `REQUEST_CSS_BASE, rebaseCssUrls` を `@editor/shared` から足し、`assemblePreviewDocument` の `appendPreviewStyle(root, formatCss(css), …)` を置き換える:

```ts
  // 本文 CSS は `css/<fund>.css` の位置の CSS として書かれている(相対 url() は css/ 基準)。
  // `<style>` へ埋め込むと文書基準になるので、ここで 1 回だけ付け替える。HTML 側の
  // `<style>` は触らない — 申請の filledHtml を本文として再入させる経路があり、触ると二重になる。
  appendPreviewStyle(root, formatCss(rebaseCssUrls(css, REQUEST_CSS_BASE)), {
    'data-preview-css': '',
  });
```

`reviewCompareDocs.ts` の import に同じ 2 つを足し、`wrapDoc` の `<style>${css}</style>` を `<style>${rebaseCssUrls(css, REQUEST_CSS_BASE)}</style>` にする。直前に 1 行コメントを足す:

```ts
  // 申請者 CSS は css/ 基準で書かれているので、文書へ埋め込む前に 1 回だけ付け替える。
```

`previewSelfContain.ts` の doc コメント 153 行の `url(fonts/…)` を `url(css/fonts/…)` にし、170 行を置き換える:

```ts
      if (rel === undefined || !rel.startsWith('css/fonts/')) continue;
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter web exec vitest run`
Expected: PASS（`twoSystems.guard`・`ssti.guard` を含む全件）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/lib/nunjucksRender.ts editor/web/src/features/reviews/services/reviewCompareDocs.ts editor/web/src/lib/previewSelfContain.ts editor/web/test/cssRebase.guard.test.ts editor/web/test/nunjucksRender.dom.test.ts editor/web/test/previewSelfContain.dom.test.ts
git add editor/web/src/lib/nunjucksRender.ts editor/web/src/features/reviews/services/reviewCompareDocs.ts editor/web/src/lib/previewSelfContain.ts editor/web/test/cssRebase.guard.test.ts editor/web/test/nunjucksRender.dom.test.ts editor/web/test/previewSelfContain.dom.test.ts
git commit -m "feat(web): プレビューと精査比較で本文 CSS を css/ 基準へ付け替え、フォント埋め込みを css/fonts/ に揃える"
```

---

### Task 6: .gitignore の必須行と init-data-repo を新構成にする

**Files:**
- Modify: `editor/server/src/git/gitRepo.ts`（214 行の `required`）
- Modify: `editor/server/test/gitRepo.test.ts`（`'/notes/'` を確認しているテスト）
- Modify: `editor/scripts/init-data-repo.ps1`（`$dirs` と `.gitignore` の中身、DESCRIPTION の 1. の行）

**Interfaces:**
- Produces: `.gitignore` 必須行 `['/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '*.tmp-*']`

- [ ] **Step 1: 失敗するテストを書く**

`gitRepo.test.ts` で `.gitignore` の中身に `'/notes/'` を期待している箇所（`grep -n "/notes/" editor/server/test/gitRepo.test.ts`）に、同じ形で `'/css/fonts/'` の期待を足す。例:

```ts
    expect(gitignore.split('\n')).toContain('/css/fonts/');
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/gitRepo.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`gitRepo.ts` の `required` を置き換え、直前のコメントに 1 段落足す:

```ts
  // `/css/fonts/` は手で置く全ファンド共通のフォント(和文 1 本 5〜20MB)。追跡すると承認
  // コミットの `git add -A -- css` が、置いた人ではなく次の承認者の名前でフォントを巻き込む。
  const required = ['/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '*.tmp-*'];
```

`init-data-repo.ps1`:

```powershell
$dirs = 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes',
  'js'
```

```powershell
    [IO.File]::WriteAllText((Join-Path $DataRoot '.gitignore'),
      "/drafts/`n/reviews/`n/pending/`n/notes/`n/css/fonts/`n*.tmp-*`n", $utf8NoBom)
```

DESCRIPTION の 1. の行を「templates/ filled/ css/ css/fonts/ sync/ drafts/ pending/ reviews/ notes/ js/」に直す。

- [ ] **Step 4: テストと実行確認**

Run: `pnpm --filter server exec vitest run test/gitRepo.test.ts`
Expected: PASS

Run（PowerShell）: `$t = Join-Path $env:TEMP ("idr-" + [guid]::NewGuid().ToString('N').Substring(0,8)); cmd /c "editor\scripts\init-data-repo.bat -DataRoot $t 2>nul"; Get-ChildItem $t, (Join-Path $t css) -Name; Get-Content (Join-Path $t .gitignore); Remove-Item -Recurse -Force $t -Confirm:$false`
Expected: `css\fonts` と `js` があり `assets` が無い。`.gitignore` に `/css/fonts/`。BOM が保たれていること（`head -c 3 editor/scripts/init-data-repo.ps1 | od -An -tx1` が `ef bb bf`）。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/git/gitRepo.ts editor/server/test/gitRepo.test.ts
git add editor/server/src/git/gitRepo.ts editor/server/test/gitRepo.test.ts editor/scripts/init-data-repo.ps1
git commit -m "feat(editor): css/fonts を git 管理外の必須行に加え、init-data-repo が css/fonts と js を作るようにする"
```

---

### Task 7: 利用者向け文言・OpenAPI の契約・コメントを追随させる

**Files:**
- Modify: `editor/server/src/security/externalRefs.ts`（24-27 行のコメント、43-47 行の `EXTERNAL_REF_MESSAGE`）
- Modify: `editor/web/src/lib/pdfDocument.ts`（32 行付近の `fonts/…` 表記）
- Modify: `editor/web/src/features/editor/services/templateEditorService.ts`（118 行付近。`grep -rn "fonts/" editor/web/src` で実際の場所を確認）
- Modify: `editor/server/src/openapi/document.ts`（105 行付近）→ `editor/server/openapi.json` 再生成
- Modify: コメントのみ: `editor/shared/src/security/htmlExternalRefs.ts`（4 行）、`editor/server/src/render/renderHost.ts`（285 行）、`editor/server/src/vivliostyle/previewHost.ts`（65・407 行）、`editor/server/src/vivliostyle/mergeInput.ts`（トンボ CSS の注記を `materializeMergeProject` の doc コメントに 1 行）
- Test: `editor/server/test/externalRefs.test.ts`（文言を照合していれば更新）、`openapiArtifact.guard.test.ts`

- [ ] **Step 1: 文言と契約を書き換える**

`EXTERNAL_REF_MESSAGE`:

```ts
export const EXTERNAL_REF_MESSAGE =
  'CSSまたはHTMLに外部参照(@import / 絶対URLのurl() / 絶対URLのhref・src)が含まれるため' +
  'PDFを作成できません。' +
  'フォントや画像やスクリプトは文書に同梱するか、同梱資産への相対パス(css/… css/fonts/… js/…)で' +
  '指定してください。';
```

`openapi/document.ts` の該当説明文を次の趣旨に置き換える（既存の文の形に合わせる）:

```ts
  'テンプレは per-fund CSS・共通フォント・テンプレ JS を `css/…` `css/fonts/…` `js/…` の相対パスで' +
  '参照し、サーバが配信ルートへ同梱する。リクエストの `css` は `css/<fund>.css` の位置に置かれた' +
  ' CSS として解釈する(相対 `url()` は `css/` 基準。例: `url(fonts/a.woff2)` → `css/fonts/a.woff2`)。' +
  '相対参照は `url()` で書くこと(引用符文字列の相対参照は解決されない)。',
```

`pdfDocument.ts`・`templateEditorService.ts`・各コメントの `fonts/…` を `css/fonts/…` に、`assets` の表記を `js`（`jsDir`）に直す。`mergeInput.ts` の `materializeMergeProject` の doc コメントの CSS の行の後に追加:

```ts
 * - リクエスト CSS は `build.ts` の入口で css/ 基準へ付け替え済み。ここで連結する
 *   `MERGE_PAGE_COUNTER_CSS` やトンボの CSS に相対 url() を足すと、PDF とプレビューで解決先が
 *   食い違う(プレビューはそれらを別の `<style>` に入れ、付け替えない)。
```

- [ ] **Step 2: OpenAPI を再生成する**

Run: `pnpm --filter @editor/shared run build && pnpm --filter server run openapi:gen`
Expected: `editor/server/openapi.json`（生成先は `gen-openapi.ts` の出力先）が更新される。

- [ ] **Step 3: テスト**

Run: `pnpm --filter server exec vitest run test/externalRefs.test.ts test/openapiArtifact.guard.test.ts test/renderHost.test.ts test/previewProxy.test.ts`
Expected: PASS。文言・URL を照合しているテストは新しい表記に合わせて直す（`renderHost.test.ts:119` の `/api/render-host/fonts/x.woff2` は `/api/render-host/css/fonts/x.woff2` に。`previewProxy.test.ts:89` の `/__vivliostyle-viewer/fonts/fa-solid-900.woff2` はビューア自身の同梱フォントなので**変えない**）。

- [ ] **Step 4: コメント検査**

Run: `pnpm run check:comments`
Expected: 0 error

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/security/externalRefs.ts editor/server/src/openapi/document.ts editor/web/src/lib/pdfDocument.ts editor/web/src/features/editor/services/templateEditorService.ts editor/shared/src/security/htmlExternalRefs.ts editor/server/src/render/renderHost.ts editor/server/src/vivliostyle/previewHost.ts editor/server/src/vivliostyle/mergeInput.ts
git add -u editor
git commit -m "docs(editor): 同梱資産の表記を css/fonts・js へ揃え、リクエスト css を css/ 基準で解釈する契約を OpenAPI に明記する"
```

（`git add -u editor` の前に `git status --short` で、この Task 以外の変更が混ざっていないことを確認する。）

---

### Task 8: 移行パッチを作る

**Files:**
- Create: `editor/patches/2026-10-fonts-to-css/migrate.ps1`（UTF-8 BOM）
- Create: `editor/patches/2026-10-fonts-to-css/migrate.bat`（CRLF）
- Create: `editor/patches/2026-10-fonts-to-css/rollback.ps1`（UTF-8 BOM）
- Create: `editor/patches/2026-10-fonts-to-css/rollback.bat`（CRLF）
- Create: `editor/patches/2026-10-fonts-to-css/README.md`
- Test: `editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1`（Pester 3/4 書式。`offline/lib/verify.Tests.ps1` と同じ）
- Modify: ルート `README.md`（入口スクリプト一覧に節を 1 つ）

**Interfaces:**
- Produces: `migrate.bat [-DataRoot <path>] [-Apply] [-Port <n>]`、`rollback.bat [-DataRoot <path>] [-Date <yyyyMMdd>] [-Apply]`

- [ ] **Step 1: 失敗するテストを書く**

`migrate.Tests.ps1`:

```powershell
# migrate.ps1 の Pester 3/4 テスト。旧構成の dataRoot を一時フォルダに作り、確認モード・適用・
# 再実行・競合・未コミット変更での中止を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'migrate.ps1'

function New-OldLayout {
  $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  foreach ($d in 'assets\fonts', 'assets\js', 'css', 'drafts', 'reviews\r1', 'templates', 'filled') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $root 'assets\fonts\a.woff2') -Value 'FONT' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'assets\js\w.js') -Value 'w()' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -NoNewline `
    -Value '@font-face{src:url(../fonts/a.woff2)} .x{background:url(../../fonts/no.png)}'
  Set-Content -LiteralPath (Join-Path $root 'drafts\T1.css') -Value '.d{src:url("../fonts/a.woff2")}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'reviews\r1\body.css') -Value '.r{src:url(../fonts/a.woff2)}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<style>@font-face{src:url(fonts/a.woff2)}</style>' -NoNewline
  [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/drafts/`n/reviews/`n", (New-Object Text.UTF8Encoding $false))
  git -C $root init -q
  # 実環境と同じく、追跡するのは確定領域だけ(assets・drafts・reviews は追跡しない)。
  git -C $root add -- .gitignore css templates filled
  git -C $root -c user.name=t -c user.email=t@t commit -q -m init
  return $root
}

Describe 'migrate.ps1' {
  It '確認モードでは何も変えない' {
    $root = New-OldLayout
    try {
      & $script -DataRoot $root -Port 1 | Out-Null
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '-Apply で移動・書き換え・コミットし、HTML は報告だけ' {
    $root = New-OldLayout
    try {
      $out = & $script -DataRoot $root -Apply -Port 1 *>&1 | Out-String
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      (Get-ChildItem $root -Directory -Filter 'assets.migrated-*').Count | Should Be 1
      $css = Get-Content -Raw (Join-Path $root 'css\510037.css')
      $css | Should Match 'url\(fonts/a\.woff2\)'
      $css | Should Match 'url\(\.\./\.\./fonts/no\.png\)'
      (Get-Content -Raw (Join-Path $root 'drafts\T1.css')) | Should Match 'url\("fonts/a\.woff2"\)'
      (Get-Content -Raw (Join-Path $root 'reviews\r1\body.css')) | Should Match 'url\(fonts/a\.woff2\)'
      (Get-Content -Raw (Join-Path $root 'templates\T1.html')) | Should Match 'url\(fonts/a\.woff2\)'
      $out | Should Match 'templates\\T1\.html'
      (Get-Content (Join-Path $root '.gitignore')) -contains '/css/fonts/' | Should Be $true
      # 件名の日本語は PowerShell 5.1 が git の出力を OEM コードページで読むため化ける。
      # 照合は ASCII の目印と作者名で行う。
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
      (git -C $root status --porcelain -- .gitignore css templates filled sync) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '再実行しても何も変えない' {
    $root = New-OldLayout
    try {
      & $script -DataRoot $root -Apply -Port 1 | Out-Null
      $head = git -C $root rev-parse HEAD
      & $script -DataRoot $root -Apply -Port 1 | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '移動先に別内容があれば競合で中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'OTHER' -NoNewline
      { & $script -DataRoot $root -Apply -Port 1 } | Should Throw
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '未コミットの変更があれば中止する' {
    $root = New-OldLayout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      { & $script -DataRoot $root -Apply -Port 1 } | Should Throw
    } finally { Remove-Item -Recurse -Force $root }
  }
}
```

（`-Port 1` は「サーバ稼働中」判定を無害なポートへ向けるため。テスト中に TCP 1 番を誰も待ち受けていない前提。）

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1"`
Expected: FAIL（`migrate.ps1` が無い）

- [ ] **Step 3: migrate.ps1 を実装する**

`migrate.ps1`（UTF-8 BOM で保存する）:

```powershell
<#
.SYNOPSIS
  editor の data リポジトリを新構成へ移す(フォント: assets\fonts → css\fonts、js: assets\js → js)。

.DESCRIPTION
  既定は確認モードで、移動元・移動先、書き換える CSS、報告事項を表示するだけで何も変えない。
  -Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /css/fonts/ を追記する(フォントが承認コミットへ巻き込まれないよう、移動より先)
    2. assets\fonts → <cssDir>\fonts、assets\js → <dataRoot>\js をコピーし、SHA256 で照合してから
       旧 assets\ を assets.migrated-<yyyyMMdd> へ改名して残す(共有フォルダでの途中失敗に備える)
    3. CSS の url( 直後の ../fonts/ を fonts/ に直す(css\*.css と、承認前の作業コピー
       drafts\*.css・pending\*.css・reviews\<id>\body.css)
    4. appconfig の paths.assetsDir を paths.jsDir(<旧 assetsDir>\js)へ書き換える
    5. 確定領域の変更(css/*.css と .gitignore)を system 名義で 1 コミットする
  templates / filled の HTML 内の fonts/ 参照と、url(css/…) を持つ CSS は報告だけする。
  サーバ稼働中、または dataRoot の git に未コミットの変更があるときは中止する。

.PARAMETER DataRoot
  data リポジトリの場所。省略時は init-data-repo.ps1 と同じ規則(環境変数 DATA_ROOT → ユーザー
  環境変数 DATA_ROOT → 既定)で決める。

.PARAMETER Apply
  実際に変更する。付けなければ確認モード。

.PARAMETER Port
  稼働確認に使う editor サーバのポート(既定 24680)。

.EXAMPLE
  editor\patches\2026-10-fonts-to-css\migrate.bat
  確認モードで、何が変わるかを表示する。

.EXAMPLE
  editor\patches\2026-10-fonts-to-css\migrate.bat -Apply
  移行を実行する(サーバを止めてから)。
#>
param(
  [string]$DataRoot,
  [switch]$Apply,
  [int]$Port = 24680
)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$stamp = Get-Date -Format 'yyyyMMdd'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

# ── 1. 置き場の解決(init-data-repo.ps1 と同じ規則 + 個別の上書き設定) ──
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User'); $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'; $source = '既定' }
}
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }
$cssDir = if ($env:CSS_DIR) { Resolve-EditorPath $env:CSS_DIR }
  elseif ($cfgPaths -and $cfgPaths.cssDir) { Resolve-EditorPath $cfgPaths.cssDir }
  else { Join-Path $DataRoot 'css' }
$assetsDir = if ($env:ASSETS_DIR) { Resolve-EditorPath $env:ASSETS_DIR }
  elseif ($cfgPaths -and $cfgPaths.assetsDir) { Resolve-EditorPath $cfgPaths.assetsDir }
  else { Join-Path $DataRoot 'assets' }
$jsDir = Join-Path $DataRoot 'js'

Write-Host "dataRoot : $DataRoot ($source)"
Write-Host "cssDir   : $cssDir"
Write-Host "旧 assets: $assetsDir"
Write-Host "jsDir    : $jsDir"
Write-Host ("モード   : " + $(if ($Apply) { '適用(-Apply)' } else { '確認(何も変えません)' }))
Write-Host ''

# ── 2. 実行条件 ──
$listening = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $listening = $client.ConnectAsync('127.0.0.1', $Port).Wait(500)
  $client.Close()
} catch { $listening = $false }
if ($listening) { throw "editor サーバがポート $Port で動いています。停止してから実行してください。" }
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
# 見るのは確定領域(承認コミットの対象)だけ。js\ や assets.migrated-* のような追跡外の
# フォルダまで見ると、移行後の再実行が「未コミットの変更あり」で止まってしまう。
$dirty = git -C $DataRoot status --porcelain -- .gitignore .gitattributes templates filled css sync
if ($dirty) { throw "dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください:`n$dirty" }

# ── 3. 計画 ──
function Get-FileHashHex([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }

$moves = @()
foreach ($pair in @(@{ From = (Join-Path $assetsDir 'fonts'); To = (Join-Path $cssDir 'fonts') },
                    @{ From = (Join-Path $assetsDir 'js'); To = $jsDir })) {
  if (-not (Test-Path -LiteralPath $pair.From)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $pair.From -Recurse -File) {
    $rel = $f.FullName.Substring($pair.From.Length).TrimStart('\')
    $dest = Join-Path $pair.To $rel
    if (Test-Path -LiteralPath $dest) {
      if ((Get-FileHashHex $dest) -ne (Get-FileHashHex $f.FullName)) {
        throw "競合: $dest に別の内容があります(移動元 $($f.FullName))。どちらを残すか決めてから再実行してください。"
      }
      continue
    }
    $moves += @{ From = $f.FullName; To = $dest }
  }
}

$rewriteRe = '(?i)(url\(\s*["'']?)\.\./fonts/'
$cssTargets = @()
$cssTargets += Get-ChildItem -LiteralPath $cssDir -Filter '*.css' -File -ErrorAction SilentlyContinue
foreach ($d in 'drafts', 'pending') {
  $cssTargets += Get-ChildItem -LiteralPath (Join-Path $DataRoot $d) -Filter '*.css' -File -ErrorAction SilentlyContinue
}
$cssTargets += Get-ChildItem -LiteralPath (Join-Path $DataRoot 'reviews') -Filter 'body.css' -File -Recurse -ErrorAction SilentlyContinue
$rewrites = @($cssTargets | Where-Object { (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) -match $rewriteRe })

$reportHtml = @()
foreach ($d in 'templates', 'filled') {
  foreach ($f in Get-ChildItem -LiteralPath (Join-Path $DataRoot $d) -Filter '*.html' -File -ErrorAction SilentlyContinue) {
    if ((Get-Content -Raw -Encoding UTF8 -LiteralPath $f.FullName) -match '(?i)(url\(\s*["'']?|(href|src)\s*=\s*["'']?)fonts/') {
      $reportHtml += $f.FullName
    }
  }
}
$reportCssCss = @($cssTargets | Where-Object { (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) -match '(?i)url\(\s*["'']?css/' })
$gitignorePath = Join-Path $DataRoot '.gitignore'
$needsIgnore = -not ((Get-Content -LiteralPath $gitignorePath -ErrorAction SilentlyContinue) -contains '/css/fonts/')
$needsConfig = [bool]($cfgPaths -and $cfgPaths.assetsDir)

Write-Host "コピーするファイル: $($moves.Count) 件"
$moves | ForEach-Object { Write-Host "  $($_.From) -> $($_.To)" }
Write-Host "../fonts/ を書き換える CSS: $($rewrites.Count) 件"
$rewrites | ForEach-Object { Write-Host "  $($_.FullName)" }
Write-Host ".gitignore に /css/fonts/ を追記: $needsIgnore"
Write-Host "appconfig の paths.assetsDir を paths.jsDir へ: $needsConfig"
if ($env:ASSETS_DIR) { Write-Host "※ 環境変数 ASSETS_DIR が設定されています。JS_DIR=$jsDir に置き換えてください(パッチは環境変数を変えません)。" }
if ($reportHtml.Count -gt 0) {
  Write-Host "【報告】HTML 内に fonts/ 参照があります(移行後は配信されません。承認経路で css/fonts/ へ直してください):"
  $reportHtml | ForEach-Object { Write-Host "  $_" }
}
if ($reportCssCss.Count -gt 0) {
  Write-Host "【報告】url(css/…) を持つ CSS があります(新しい規則では css/css/ になります):"
  $reportCssCss | ForEach-Object { Write-Host "  $($_.FullName)" }
}
if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 4. 適用 ──
if ($needsIgnore) {
  $current = if (Test-Path -LiteralPath $gitignorePath) { [IO.File]::ReadAllText($gitignorePath) } else { '' }
  if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
  [IO.File]::WriteAllText($gitignorePath, $current + "/css/fonts/`n", $utf8NoBom)
}
foreach ($m in $moves) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $m.To) | Out-Null
  Copy-Item -LiteralPath $m.From -Destination $m.To
  if ((Get-FileHashHex $m.To) -ne (Get-FileHashHex $m.From)) { throw "照合に失敗しました: $($m.To)" }
}
if ((Test-Path -LiteralPath $assetsDir) -and ($moves.Count -gt 0 -or (Test-Path -LiteralPath (Join-Path $assetsDir 'fonts')) -or (Test-Path -LiteralPath (Join-Path $assetsDir 'js')))) {
  Rename-Item -LiteralPath $assetsDir -NewName ("{0}.migrated-{1}" -f (Split-Path -Leaf $assetsDir), $stamp)
}
foreach ($f in $rewrites) {
  $text = [IO.File]::ReadAllText($f.FullName)
  [IO.File]::WriteAllText($f.FullName, ($text -replace $rewriteRe, '${1}fonts/'), $utf8NoBom)
}
if ($needsConfig) {
  Copy-Item -LiteralPath $appConfigPath -Destination "$appConfigPath.bak-$stamp"
  $newJs = Join-Path (Resolve-EditorPath $cfgPaths.assetsDir) 'js'
  $cfgPaths.PSObject.Properties.Remove('assetsDir')
  $cfgPaths | Add-Member -NotePropertyName 'jsDir' -NotePropertyValue $newJs -Force
  [IO.File]::WriteAllText($appConfigPath, ($appConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
}
git -C $DataRoot add -- .gitignore css | Out-Null
$staged = git -C $DataRoot diff --cached --name-only
if ($staged) {
  # 末尾の [fonts-to-css] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  git -C $DataRoot -c user.name=system -c user.email=system@editor.local commit -q -m '移行: フォント置き場の移設(assets/fonts → css/fonts) [fonts-to-css]'
  Write-Host '確定領域の変更を system 名義でコミットしました。'
}
Write-Host '移行が完了しました。editor を起動してください。'
```

`migrate.bat` と `rollback.bat`（CRLF。`.claude/rules/powershell.md` の雛形）:

```bat
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate.ps1" %*
exit /b %ERRORLEVEL%
```

（`rollback.bat` は `migrate.ps1` を `rollback.ps1` に置き換えたもの。Bash で書く場合は `printf '…\r\n'` で CRLF にする。）

- [ ] **Step 4: rollback.ps1 を実装する**

```powershell
<#
.SYNOPSIS
  2026-10-fonts-to-css の移行を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。処理順:
    1. 移行コミット(作者 system、件名に [fonts-to-css])を git revert する
    2. assets.migrated-<日付> を assets へ改名して戻し、移行で作った css\fonts と js を削除する
    3. appconfig.json.bak-<日付> があれば appconfig.json へ戻す
  実行前に editor サーバを止め、戻したあとは旧版の editor を配置して起動すること。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は migrate.ps1 と同じ規則)。

.PARAMETER Date
  戻す移行の日付(yyyyMMdd)。省略時は assets.migrated-* が 1 つだけならそれを使う。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [string]$Date, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT
  if (-not $DataRoot) { $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User') }
  if (-not $DataRoot) { $DataRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $editorDir)) 'editor-data' }
  elseif (-not [IO.Path]::IsPathRooted($DataRoot)) { $DataRoot = [IO.Path]::GetFullPath((Join-Path $editorDir $DataRoot)) }
}
$migrated = @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*')
if ($Date) { $migrated = @($migrated | Where-Object { $_.Name -eq "assets.migrated-$Date" }) }
if ($migrated.Count -ne 1) { throw "戻す対象の assets.migrated-* が 1 つに決まりません。-Date で指定してください。" }
$commit = git -C $DataRoot log --author=system --grep '\[fonts-to-css\]' --format=%H -1
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$bak = "$appConfigPath.bak-" + $migrated[0].Name.Substring('assets.migrated-'.Length)

Write-Host "dataRoot: $DataRoot"
Write-Host "revert するコミット: $(if ($commit) { $commit } else { '(なし)' })"
Write-Host "改名して戻す: $($migrated[0].FullName) -> assets"
Write-Host "削除する: $(Join-Path $DataRoot 'css\fonts') と $(Join-Path $DataRoot 'js')"
Write-Host "appconfig を戻す: $(if (Test-Path -LiteralPath $bak) { $bak } else { '(バックアップなし)' })"
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

if ($commit) { git -C $DataRoot -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null }
Rename-Item -LiteralPath $migrated[0].FullName -NewName 'assets'
foreach ($d in 'css\fonts', 'js') {
  $p = Join-Path $DataRoot $d
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination $appConfigPath -Force }
Write-Host '元に戻しました。旧版の editor を配置して起動してください。'
```

- [ ] **Step 5: README を書く**

`editor/patches/2026-10-fonts-to-css/README.md`（通常の日本語で）: 目的（フォントを `css\fonts`、js を `js` へ）、前提（新版の editor を配置済み）、手順（1. サーバ停止 → 2. `migrate.bat` で確認 → 3. `migrate.bat -Apply` → 4. 報告に HTML が出たら承認経路で `css/fonts/` へ直す → 5. 環境変数 `ASSETS_DIR` があれば `JS_DIR` へ → 6. 起動）、CSS の書き方（`url(fonts/x.woff2)`、小文字の `fonts/`）、元に戻し方（`rollback.bat` → `-Apply`）、管理者作業であること（確定 CSS を承認なしで system 名義コミットする）。旧 assets を dataRoot の外（`ASSETS_DIR` / `paths.assetsDir` で別の場所）に置いていた環境では、`rollback.bat` は `assets.migrated-*` を dataRoot の中しか探さないので、その場所の改名は手で戻す、と明記する。

ルート `README.md` の入口スクリプト一覧の表に行を足す:

```markdown
| `editor/patches/2026-10-fonts-to-css/migrate.bat` | data リポジトリのフォント・js の置き場を新構成へ移す(既定は確認モード、`-Apply` で実行) |
| `editor/patches/2026-10-fonts-to-css/rollback.bat` | 上の移行を元に戻す |
```

同 README の「スクリプトの置き場ルール」に 1 文足す: 「一度だけ流すデータ移行は `<project>/patches/<yyyy-MM-名前>/` に置く」。

- [ ] **Step 6: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1"`
Expected: 5 件 PASS

Run: `head -c 3 editor/patches/2026-10-fonts-to-css/migrate.ps1 | od -An -tx1` と `rollback.ps1` も同様
Expected: `ef bb bf`

Run: `file editor/patches/2026-10-fonts-to-css/*.bat`
Expected: `with CRLF line terminators`

- [ ] **Step 7: コミット**

```bash
git add editor/patches/2026-10-fonts-to-css README.md
git commit -m "feat(editor): フォントと js の置き場を新構成へ移す移行パッチ(確認モード既定・元に戻す手順つき)を追加する"
```

---

### Task 9: 運用手順書と設計正典を更新する

**Files:**
- Modify: `docs/editor/src/デプロイ運用手順書.md`（設定表の `paths.assetsDir` 行、3.1 節のフォルダ構成図と手順、改訂履歴 1.4）
- Modify: `docs/editor/src/設計正典.md`（相対参照の節 259-263 行付近、却下済み設計に 2 項目）
- Modify: `.claude/rules/design-canon-summary.md`（却下項目の一覧に 2 行。git 管理外のローカルファイル）
- Modify: `docs/editor/editor_設計.html`（再生成）

- [ ] **Step 1: 運用手順書を直す**

- 設定表の `paths.assetsDir` 行を置き換える:

```markdown
| `paths.jsDir` | 全ファンド共通のテンプレ JS（既定 `dataRoot/js`。git 管理外） | `JS_DIR` |
```

  表の直後に注記を足す: 「`paths.assetsDir` / `ASSETS_DIR` は廃止した。指定が残っていると起動を中止する（移行は `editor/patches/2026-10-fonts-to-css/`）。」
- 3.1 節のフォルダ構成図の `assets\fonts\  assets\js\` の行を置き換える:

```
  css\fonts\                             全ファンド共通のフォント。中身は手で置く（git 管理外）
  js\                                    全ファンド共通のテンプレ JS。中身は手で置く
```

- 3.1 節の末尾に「フォントの書き方」を足す: ファンド CSS から `@font-face { src: url(fonts/x.woff2) }`（CSS 自身から見た相対、小文字の `fonts/`）。HTML の `<style>` から参照する場合は `css/fonts/x.woff2`。
- 3.1 節に「旧構成からの移行」を足す: サーバ停止 → 新版を配置 → `migrate.bat`（確認）→ `migrate.bat -Apply` → 起動。元に戻すのは `rollback.bat`。
- front-matter の `version` を `"1.4"` にし、`rev` に `- 1.4 | <実施日> | フォント置き場の css/fonts への移設と js の外出し（設定表・3.1 節）` を足す。

- [ ] **Step 2: 設計正典を直す**

相対参照の節に、次の不変則を足す（既存の文体に合わせる）:
- 置き場と配信パス: `css/`（ファンド CSS）、`css/fonts/`（`<cssDir>/fonts`、全ファンド共通）、`js/`（`jsDir`）。配信グループは最長一致。
- リクエストの `css` は `css/<fund>.css` の位置の CSS として解釈し、入口で 1 回だけ `rebaseCssUrls` で `css/` 基準へ付け替える。呼ぶのはサーバ `vivliostyle/requestCss.ts`（`build.ts` の 3 入口）と web `nunjucksRender.ts`・`reviewCompareDocs.ts` だけ（`requestCss.guard.test.ts`・`cssRebase.guard.test.ts`）。HTML の `<style>`・`style` 属性は付け替えない。

却下済み設計に 2 項目を足す（番号は既存の最後の続き）:
- **HTML の `<style>` / `style` 属性も付け替える**: しない。申請の `filledHtml` は付け替え済みの `<style data-preview-css>` を含み、本文として再入する経路があるため二重になる。
- **フォントを複数の配信パス（`fonts/` と `css/fonts/`）で配る**: しない。同じ実体が 2 つのパスで見え、許可リストの判定が 2 系統になる。

- [ ] **Step 3: 要約と HTML を更新する**

`.claude/rules/design-canon-summary.md` の editor の「却下済み設計」に上の 2 項目の見出しを足す。

Run: `pnpm run check:canon-summary -- --update && pnpm run check:canon-summary`
Expected: OK

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `[ok] editor/editor_設計.html`

- [ ] **Step 4: コミット**

```bash
git add "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計正典.md" "docs/editor/editor_設計.html"
git commit -m "docs(editor): フォント置き場の css/fonts 移設・js の外出し・リクエスト CSS の付け替え契約を手順書と設計正典に反映する"
```

（`.claude/` は git 管理外なのでコミットに含めない。）

---

### Task 10: 全体の検証

**Files:** なし（確認のみ。直しが出たら該当 Task のファイルを直して追加コミット）

- [ ] **Step 1: 型・テスト・検査**

Run: `pnpm typecheck:editor && pnpm run test:editor && pnpm run check:comments && pnpm run check:canon-summary`
Expected: すべて成功

- [ ] **Step 2: coverage**

Run: `pnpm run test:coverage`
Expected: `cssRebase.ts`・`requestCss.ts` がそれぞれ 85% 以上、全体の閾値を満たす

- [ ] **Step 3: 実機で PDF にフォントが効くことを確かめる**

1. 一時の dataRoot を `init-data-repo.bat -DataRoot <tmp>` で作り、`<tmp>\css\fonts\` に手持ちの woff2 を 1 つ置く。
2. `<tmp>\css\510037.css` に `@font-face{font-family:T;src:url(fonts/<名前>.woff2)} body{font-family:T}` を書く。
3. `set DATA_ROOT=<tmp>` で editor を起動し、該当ファンドのテンプレで PDF を出力する。
4. PDF のフォント一覧（Edge の PDF ビューアの文書のプロパティ、または `py -3.13 -c "import fitz;print(fitz.open('<pdf>').get_page_fonts(0))"`）に、置いたフォントが埋め込まれていることを確認する。画面内プレビューでも同じフォントで表示されることを目視する。

- [ ] **Step 4: 結果を報告する**

失敗した項目は出力をそのまま添えて報告し、成功扱いにしない。
