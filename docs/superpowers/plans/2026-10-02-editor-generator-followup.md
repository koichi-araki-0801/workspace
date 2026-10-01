# editor 生成器の起動を PATH 上の python へ・旧構成の片付けをパッチへ — 実装計画（追補 6 章）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設計書 6 章（追補 2026-10-02、6.1〜6.8）を実装する。生成器の既定の起動コマンドを PATH 上の `python`（引数なし）にし、offline の setup も PATH 上の python が 3.13 かを確かめる。旧構成を理由に起動を止める検査（assets）を外し、代わりに起動ログで警告する。構築済み環境の断面より前の形式を読む互換処理（旧形式メモ・保留の申請・ブラウザ保存領域の旧キー）を外す。旧構成の片付け（appconfig の旧い設定）をフォント移設パッチへ統合し、2 本のパッチに「既知の形の未コミット変更の取り込み」「追跡済みのフォント・画像・js の追跡解除」「dataRoot の取り違えの検出」「GIT_BIN」などを足す。`init-data-repo` は初回コミットを確定領域だけに絞り、`.git` はあるが HEAD の無いリポジトリと `GIT_BIN` に対応する。運用手順書に構築済み環境の更新手順と PATH の設定方法を書く。

**Architecture:** サーバ側は `config.ts`（`resolvePythonCommand` の単純化、`paths.assetsDir` と 2 つの起動時検査の撤去）、`generate/generatorCheck.ts`（警告文）、新設の `files/legacyLayoutCheck.ts`（旧構成の残りの警告。`serve.ts` が待たずに呼ぶ）、`files/notesFile.ts`・`files/reviewFiles.ts`（互換処理の撤去）。web 側は local 版の `noteRepo.ts`・`reviewRepo.ts`・`store.ts`・`lib/storageKeys.ts`・`stores/auth.ts`。PowerShell 側は `offline/lib/verify.ps1`、`editor/scripts/init-data-repo.ps1`、`editor/patches/2026-10-fonts-to-css/{migrate,rollback}.ps1`、`editor/patches/2026-10-fund-images/{apply,rollback}.ps1`。パッチの未コミット変更の点検は、内容を UTF-8 で読むため git を `System.Diagnostics.Process` で起動する読み取り専用の関数（`Invoke-GitUtf8`）を使い、変更を伴う git 呼び出しは既存の `Invoke-Git`（`$ErrorActionPreference = 'Continue'` で包み、終了コードで判定する）を使う。2 本のパッチは共通 lib を作らない既存の方針のまま、同じ関数をそれぞれに持つ。

**Tech Stack:** TypeScript（Node 24 / Fastify / Vue 3 / vitest 4）、PowerShell 5.1（Pester 3/4 書式）、Python 3.13（docs のビルドと実機確認）。

**Spec:** `docs/superpowers/specs/2026-10-01-editor-generator-launch-design.md` の 6 章（6.1〜6.8。6.7 が 6.2〜6.6 を、6.8 がそれ以前を改める）

## Global Constraints

- 生成器の起動コマンドの既定は `python.bin = 'python'`・`python.args = []`。`python` は PATH から探し、版は指定しない。上書きは env `PYTHON_BIN` → appconfig `python.bin` → 既定の順。引数は appconfig `python.args` だけで足せる。env `PYTHON_ARGS` は作らない。`resolvePythonCommand` の `explicitBin` と `DEFAULT_PYTHON_ARGS` は削る。
- 起動時の版確認（`-c "import sys; print('%d.%d' % sys.version_info[:2])"`、10 秒、3.13 以外は警告、起動は止めない）は変えない。警告文に PATH の直し方（ユーザー環境変数 PATH、WindowsApps より前、システム PATH が先、新しいコマンドプロンプト）を入れる。
- `assertNoRetiredAssetsDir` と `assertNoLegacyAssetsDir` を外す。appconfig のスキーマから `paths.assetsDir` を外す（`.strict()` なので残っていれば「不明なキー」として読み込みエラー）。env `ASSETS_DIR` は読まない。`assertImagesDirOutsideCommittedAreas` は残す。
- 起動時の警告（止めない）: `<dataRoot>/assets` がディレクトリとして残っている、`cssDir` 直下の `*.css` に `url(` 直後の `../fonts/`（正規表現 `/url\(\s*["']?\.\.\/fonts\//i`。パッチの `$rewriteRe` と同じ形）がある。接頭辞は `[layout]`、文面に「フォント移設パッチ editor/patches/2026-10-fonts-to-css/ を流してください」を入れる。並べる CSS は 5 件まで。
- 互換処理の撤去: `notesFile.ts` の `legacy:<pathKey>` 変換（配列でない値は読み捨てる）、web の `noteRepo.ts` の `kind` の読み捨て、`reviewFiles.ts` と web の `reviewRepo.ts` の `held` → `pending` 読み替え（3 状態の外の申請は 1 件ずつ読み飛ばし、一覧全体は落とさない）、`storageKeys.ts` の `LEGACY_NOTES_KEY`・`LEGACY_UNDO_STACKS_KEY`・`legacyUndoStacksKeyV1` とその利用。`gitRepo.ts` の `ensureGitattributes` と `.gitignore` の補修は残す。
- offline の確認関数は `Test-Python313OnPath`（`Test-Python313Launcher` と `Get-NativeExitCode` は削る）。版は標準出力から読む（`Get-NativeOutput`）。案内文は「Python 3.13 を入れ、ユーザー環境変数 PATH に通してください」。止めずに警告する。`docs/_build/build_all.bat` は `py -3.13` のまま。
- `init-data-repo.ps1` の初回コミットは確定領域 `templates`・`filled`・`css`（`css/fonts` を除く）・`sync`・`.gitignore`・`.gitattributes` だけ（`git/committedAreas.ts` の `COMMITTED_AREAS` + 2 ファイル）。`.git` はあるが HEAD が無ければ初回コミットを作る。HEAD があれば git に触らない。git は `GIT_BIN` を優先する。
- パッチの system コミットは作者 `system <system@editor.local>`、件名末尾の目印は `[fonts-to-css]` / `[fund-images]`（ASCII）。git は `GIT_BIN` を優先する。
- 未コミット変更の点検範囲は既存と同じ `.gitignore .gitattributes templates filled css sync ':(exclude)css/fonts'`。取り込む形（BOM を除き CRLF を LF にしてから比べる）: CSS（`css/<名前>.css`）の `../fonts/` → `fonts/` の書き換えだけ、`.gitignore` に必須行（`/drafts/` `/reviews/` `/pending/` `/notes/` `/css/fonts/` `/images/` `*.tmp-*`）を足しただけ、`.gitattributes` を `* text eol=lf`（+ 既存の他の行。旧い `* text=lf` は落とす）にしただけ、空のフォルダの新規作成（git には見えない）。状態コードは `^[ MA?][ M?]$` だけを候補にする。それ以外が 1 件でもあれば一覧を出して中止。途中停止の形跡（`.git\index.lock`・`REVERT_HEAD`・`MERGE_HEAD`・`CHERRY_PICK_HEAD`、フォント移設では移行コミットの無い `assets.migrated-*`）があれば「前回のパッチ（または rollback）が途中で止まった」、無ければ「手作業の変更が残っています」と分けて案内する。
- 追跡の解除: `git ls-files -- css/fonts images js assets` に当たる置き場を `git rm -r -q --cached` し、同じ system コミットに含める（2 本のパッチとも）。
- HEAD の無い data リポジトリでは、`init-data-repo.bat` で初回コミットを作るよう案内して中止する（2 本のパッチとも）。
- dataRoot の取り違え: `<dataRoot>\templates` も `<dataRoot>\css` も無ければ警告し、何も変えずに `exit 2`（2 本のパッチとも）。
- フォント移設パッチの appconfig の片付け: editor のフォルダの中（`Resolve-EditorPath` で絶対パスにし、`<editorDir>\` で始まるか。大文字小文字を区別しない）を指す `paths.{dataRoot,templatesDir,filledDir,cssDir,jsDir,imagesDir,draftsDir,pendingDir,reviewsDir,syncDir,assetsDir}` は置き場の解決で無視し、`-Apply` で外す（`tmpDir`・`logDir`・`webDist` は対象外）。editor の外を指す `paths.assetsDir` は従来どおり `paths.jsDir=<dataRoot>\js` へ置き換える。`python.bin` / `python.args` は (`python`, 無し)・(`py`, `["-3.13"]`)・(`python`, `["-3.13"]`) を外す（bin の無指定は `python` とみなし、`args` の空配列は「無し」とみなす）。それ以外は触らずに報告する。`python.script` が `<editorDir>\server\scripts\generate_template.py` か `fake_generate_template.py` なら外し、「本番の生成器は PY_GENERATE_SCRIPT で指す」と案内する。env が editor の中を指していれば報告だけする（解決には使う）。空になった `paths` / `python` は外す。
- appconfig のバックアップ: 1 か所でも変えるなら変える前に `<appconfig>.bak-<yyyyMMdd>`。既にあれば `-2`、`-3` … を付けて別名で残す（最初のものを上書きしない）。
- フォント移設パッチは `assets` が残っていれば中身にかかわらず `assets.migrated-<yyyyMMdd>` へ改名する（フォントと js 以外のものは報告）。同じ名前が既にあれば競合として中止する。競合（中身の違う同名ファイル）は全件を列挙してから中止する（確認モードでも）。
- 報告だけするもの（フォント移設パッチ）: editor のフォルダの `data`、editor の中を指す環境変数、`<dataRoot>\fonts`、`css` 直下のフォント（`.woff2` `.woff` `.ttf` `.otf`）、`assets.migrated-*` 以外の `assets*`、`notes\*.json` の配列でない値、`reviews\<id>\meta.json` の `status: held`、`filled` フォルダの無いこと。
- フォント移設の `rollback.ps1` は、戻す日付を `assets.migrated-<日付>`・`<appconfig>.bak-<日付>[-n]`・`.fonts-to-css-backup-<日付>` から決め（1 つなら自動、複数なら `-Date` を求める、無ければ revert だけ）、`assets.migrated-*` が無くても止まらない。
- 更新手順（運用手順書 3.3 節）の順番: サーバ停止・配置 → **（必須）**フォント移設パッチ → 画像の置き場パッチ → `init-data-repo.bat`（2 本のパッチの後に固定）→ Python 3.13 の確認と生成器の設定 → 起動ログと PDF の確認。
- `.ps1` は UTF-8 BOM を保つ。改行は既存のまま（`editor/patches/**/*.ps1` と `editor/scripts/init-data-repo.ps1` は LF、`offline/**/*.ps1` は CRLF）。`.bat` は変えない。PowerShell 5.1 は git の日本語出力を化かすので、テストの照合は ASCII の目印と作者名で行い、手での git の確認は Bash で行う。
- パッチと `init-data-repo` の Pester テストの実行: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script <Tests.ps1> -EnableExit"`（リポジトリ直下で）。
- コミットに含めないもの: `docs/editor/editor_手引き.html`、`docs/editor/images/*.png`、`docs/pdf-to-svg/*`、ルート `.gitignore` の既存の未コミット変更。`.claude/rules/design-canon-summary.md` は git 管理外（編集と `--update` はするがステージしない）。
- コメント規約（`docs/コメント規約.md`）: なぜを書く。経緯・日付・所見番号は書かない。100 桁。新規 `.ts` は装飾ボックスの見出しを付ける。
- `editor/**` の TS/Vue を変えたコミットの前に `pnpm exec biome check --write <変更ファイル>` を実行する。
- 新規の server ファイルでテストしたものは、ルート `vitest.config.ts` の coverage include に足し、単体で 85% を満たす。
- 型チェックは `pnpm typecheck:editor`。
- この端末の開発用データ `C:\Users\caads\editor-data` には触らない（読むだけ）。実機確認は一時フォルダの dataRoot で、`DATA_ROOT`・`GIT_REPO_DIR`・すべての `*_DIR`・`APP_CONFIG` を上書きして行う。
- コミットメッセージに Co-Authored-By・Claude-Session などの署名行を付けない。
- 実行中は auto-push を止めている（`.claude/auto-push.paused`）。push は全タスク後にユーザーが手で行う（フル CI が 11〜12 分かかるため）。実装者は push しない。
- パッチの rollback は、revert が戻すパス（移行コミットで削除扱いになったもの = 追跡を外したファイル）に作業ツリーのファイルがあれば、revert の前に `<dataRoot>\.rollback-tmp-<日付>\` へ退避し、revert の後に SHA256 で比べる（同じなら退避を消す、違えば残して報告）。フォント移設の rollback は、revert が `assets` を戻した場合、`assets.migrated-*` の側にしか無いファイルだけを `assets` へ移し、同じものは消し、違うものは残して報告し、空になった退避名のフォルダを消す。

## Review Focus

1. **既知の形の判定が緩すぎないか・きつすぎないか。** CSS の `../fonts/` → `fonts/` の書き換えだけ（BOM 付きで書き直したものを含む）・`.gitignore` の必須行の追加・BOM 付き `* text=lf` から `* text eol=lf` への置き換えは取り込み、空白 1 つの追加・`/other/` の追加・テンプレの編集が 1 件でも混ざれば何も変えずに中止すること（Task 9 と Task 12 のテスト「既知の形」「中止」群）。
2. **appconfig の片付けが正当な設定を消さないこと。** editor の中を指す `tmpDir` `logDir` `webDist` は残り、絶対パスの `python.bin`・`-X utf8` のような引数・共有フォルダの `python.script` は残って報告されること。同じ日の 2 回目でも最初のバックアップが上書きされず、書き戻した `python.args` が JSON の配列のままであること（Task 10 のテスト「旧例の appconfig」「python.bin / python.args」「バックアップ」）。
3. **assets の検査を外しても、`paths.assetsDir` は起動を止め、`ASSETS_DIR` は無視されること。** 前者は不明なキーとして読み込みエラー、後者は設定されていても起動して `jsDir` は既定のまま（Task 3 のテスト）。代わりの警告は起動を止めず、例外を漏らさないこと（Task 2 のテスト）。
4. **互換処理の撤去が一覧全体を落とさないこと。** `held` の申請が 1 件あっても他の申請の一覧は出て、その 1 件は見つからない扱いになる（server・web とも。Task 5）。配列でない値のメモは読み捨て、配列の投稿は残り、次の書き込みで配列でない値が消える（Task 4）。
5. **追跡を外した後でも rollback が通ること。** 追跡されたフォント・js・画像を `-Apply` で外した後、`rollback -Apply` が「untracked working tree files would be overwritten」で止まらず、`assets` も戻り、内容の違う退避は残って報告されること（Task 11 と Task 12 のテスト「追跡を外した後の rollback」）。
6. **手で作り直した dataRoot で `init-data-repo` が余計なものを記録しないこと。** `assets`・`js`・`images`・`notes`・`css\fonts` が残っていても、`.git` があって HEAD が無くても、初回コミットは確定領域だけになり、HEAD があれば git に触らないこと（Task 8 のテスト）。

---

### Task 1: 生成器の既定の起動コマンドを PATH 上の `python`（引数なし）にする

対応する設計: 6.1、6.6 の 1 点目、6.7.5 の「`e2e-rest-server.ts` のコメント」「運用手順書の PATH の設定方法と落とし穴」、6.8.7。

**Files:**
- Modify: `editor/server/src/config.ts`（233〜253 行の `DEFAULT_PYTHON_BIN`〜`resolvePythonCommand`）
- Modify: `editor/server/src/generate/generatorCheck.ts`（4〜6 行の見出しコメント、12 行のコメント、73〜85 行の警告文）
- Modify: `editor/server/src/generate/pyTemplate.ts`（92〜95 行のコメント）
- Modify: `editor/server/scripts/e2e-rest-server.ts`（27〜28 行のコメント）
- Modify: `editor/server/test/config.python.test.ts`
- Modify: `editor/server/test/generatorCheck.test.ts`
- Modify: `docs/editor/src/デプロイ運用手順書.md`（設定表の `python.bin` / `python.args`、3.2 節の冒頭・PATH の設定・警告の表）
- Modify: `docs/editor/src/設計書.md`（7.3 節 492 行、16.2 節 815 行）
- Modify: `editor/README.md`（159 行、180 行）
- Modify: `editor/OFFLINE.md`（96 行）

`py -3.13` の残りの扱い（この Task で変えないもの）: `editor/server/test/fakeGenerator.test.ts` の `['py', ['-3.13']]` は 6.1 の「テスト用の偽の生成器を開発機で動かすテストは `py -3.13` でよい」により残す。`editor/README.md` 98 行と `docs/_build/build_all.bat` は docs のビルド（開発機だけ。6.6）なので残す。`editor/shared/test/fixtures/svg/tools/README.md` 24 行は開発用の道具の説明なので残す。`AGENTS.md` の方針は開発作業の話（6.1）なので残す。`docs/editor/src/デプロイ運用手順書.md` の改訂履歴 1.6 行の「py -3.13」は履歴なので残す。

**Interfaces:**
- Produces: `export const DEFAULT_PYTHON_BIN = 'python'`、`export function resolvePythonCommand(opts: { envBin: string | undefined; fileBin: string | undefined; fileArgs: readonly string[] | undefined }): { bin: string; args: string[] }`（`args` は `fileArgs` の写し。無ければ `[]`）
- Removes: `DEFAULT_PYTHON_ARGS`（参照は `config.ts` の中だけ。`git grep -n DEFAULT_PYTHON_ARGS` で確認済み）

- [ ] **Step 1: 失敗するテストを書く（config）**

`editor/server/test/config.python.test.ts` の import を次に替える:

```ts
import { DEFAULT_PYTHON_BIN, parseScriptSha256, resolvePythonCommand } from '../src/config.js';
```

`describe('resolvePythonCommand', …)` の全体（58〜89 行）を次に替える:

```ts
describe('resolvePythonCommand', () => {
  it('何も指定しなければ PATH 上の python を引数なしで使う', () => {
    expect(DEFAULT_PYTHON_BIN).toBe('python');
    expect(
      resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs: undefined }),
    ).toEqual({ bin: 'python', args: [] });
  });

  it('PYTHON_BIN を指定したらそれを使い、引数は付けない', () => {
    expect(
      resolvePythonCommand({
        envBin: 'C:\\Python313\\python.exe',
        fileBin: undefined,
        fileArgs: undefined,
      }),
    ).toEqual({ bin: 'C:\\Python313\\python.exe', args: [] });
  });

  it('appconfig の python.bin だけを指定しても引数は付けない', () => {
    expect(
      resolvePythonCommand({ envBin: undefined, fileBin: 'python3', fileArgs: undefined }),
    ).toEqual({ bin: 'python3', args: [] });
  });

  it('PYTHON_BIN は appconfig の python.bin より優先される', () => {
    expect(
      resolvePythonCommand({ envBin: 'C:\\a\\python.exe', fileBin: 'python3', fileArgs: undefined })
        .bin,
    ).toBe('C:\\a\\python.exe');
  });

  it('appconfig の python.args は既定の python にも PYTHON_BIN にも付く', () => {
    expect(
      resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs: ['-X', 'utf8'] }),
    ).toEqual({ bin: 'python', args: ['-X', 'utf8'] });
    expect(
      resolvePythonCommand({ envBin: 'py', fileBin: undefined, fileArgs: ['-3.13'] }),
    ).toEqual({ bin: 'py', args: ['-3.13'] });
  });

  it('返す引数は設定の配列とは別物(呼び出し側が書き換えても設定は変わらない)', () => {
    const fileArgs = ['-X', 'utf8'];
    const { args } = resolvePythonCommand({ envBin: undefined, fileBin: undefined, fileArgs });
    args.push('extra');
    expect(fileArgs).toEqual(['-X', 'utf8']);
  });
});
```

`describe('config.python', …)` の最初の 2 件（113〜126 行）を次に替える（3 件目以降は変えない）:

```ts
  it('既定は PATH 上の python・引数なし・指紋なし・同時 2・待ち 8', async () => {
    const { config } = await importConfig({});
    expect(config.python.bin).toBe('python');
    expect(config.python.args).toEqual([]);
    expect(config.python.scriptSha256).toBeUndefined();
    expect(config.python.maxConcurrency).toBe(2);
    expect(config.python.maxQueue).toBe(8);
  });

  it('PYTHON_BIN を指定したら args は空', async () => {
    const { config } = await importConfig({ PYTHON_BIN: 'C:\\Python313\\python.exe' });
    expect(config.python.bin).toBe('C:\\Python313\\python.exe');
    expect(config.python.args).toEqual([]);
  });
```

- [ ] **Step 2: 失敗するテストを書く（起動時確認）**

`editor/server/test/generatorCheck.test.ts` の `vi.hoisted` の中、`process.env.LOG_DIR = …` の次の行に追加する（リポジトリの `editor/appconfig.json` の有無に結果を左右させない）:

```ts
  process.env.APP_CONFIG = `${tmpRoot}/editor-generator-check-no-appconfig.json`;
```

`it('exit 9009(Store のスタブ・py が無い)は起動失敗として警告する', …)` を次に替える:

```ts
  it('exit 9009(Store の偽物・python が無い)は起動失敗として、PATH の直し方を添えて警告する', async () => {
    answer(Object.assign(new Error('Command failed: python -c ...'), { code: 9009 }), '');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/起動できません[\s\S]*9009/));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ユーザー環境変数 PATH'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('WindowsApps'));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('新しいコマンドプロンプトからサーバを起動し直す'),
    );
  });
```

`it('3.13 以外なら版を添えて警告する', …)` を次に替える:

```ts
  it('3.13 以外なら版を添え、システム PATH が先に探されることを案内して警告する', async () => {
    answer(null, '3.12\n');
    const log = fakeLog();
    await checkGeneratorAtStartup(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/3\.12[\s\S]*3\.13/));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('システム PATH'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('PYTHON_BIN'));
  });
```

`describe('checkGeneratorAtStartup', …)` の末尾（最後の `it` の後）に追加する:

```ts
  it('PYTHON_BIN が無ければ PATH 上の python を引数なしで確かめ、info にその名前を出す', async () => {
    const saved = process.env.PYTHON_BIN;
    delete process.env.PYTHON_BIN;
    vi.resetModules();
    try {
      const { checkGeneratorAtStartup: check } = await import('../src/generate/generatorCheck.js');
      answer(null, '3.13\n');
      const log = fakeLog();
      await check(log);
      const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe('python');
      expect(args).toEqual(['-c', expect.stringContaining('sys.version_info')]);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('3.13(python)'));
    } finally {
      if (saved !== undefined) process.env.PYTHON_BIN = saved;
      vi.resetModules();
    }
  });
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm exec vitest run editor/server/test/config.python.test.ts editor/server/test/generatorCheck.test.ts`
Expected: FAIL（`DEFAULT_PYTHON_BIN` が `'py'`、既定の `args` が `['-3.13']`、警告文に `ユーザー環境変数 PATH`・`システム PATH` が無い）

- [ ] **Step 4: config を実装する**

`editor/server/src/config.ts` の次の部分（233〜253 行）:

```ts
/** 生成器を起動する既定のコマンド(リポジトリの方針 `py -3.13`)。 */
export const DEFAULT_PYTHON_BIN = 'py';
export const DEFAULT_PYTHON_ARGS: readonly string[] = ['-3.13'];

/**
 * 生成器を起動する実行ファイルと、スクリプトの前に付ける引数を決める。
 *
 * 実行ファイルを明示した(env `PYTHON_BIN` / appconfig `python.bin`)ときは引数の既定を空にする。
 * 絶対パスの python.exe を直接指す運用で、py ランチャ用の `-3.13` が付くと起動できないため。
 * 引数を env で受けない(`PYTHON_ARGS` を設けない)のは、空白で区切る規則がパスの空白と衝突するため。
 */
export function resolvePythonCommand(opts: {
  envBin: string | undefined;
  fileBin: string | undefined;
  fileArgs: readonly string[] | undefined;
}): { bin: string; args: string[] } {
  const bin = opts.envBin ?? opts.fileBin ?? DEFAULT_PYTHON_BIN;
  const explicitBin = opts.envBin !== undefined || opts.fileBin !== undefined;
  const args = opts.fileArgs ?? (explicitBin ? [] : DEFAULT_PYTHON_ARGS);
  return { bin, args: [...args] };
}
```

を次に替える:

```ts
/**
 * 生成器を起動する既定のコマンド。PATH 上の `python` を版を指定せずに使う(配置先では運用者が
 * ユーザー環境変数 PATH に Python 3.13 を通す)。3.13 かどうかは起動時の確認
 * (`generate/generatorCheck.ts`)が知らせる。
 */
export const DEFAULT_PYTHON_BIN = 'python';

/**
 * 生成器を起動する実行ファイルと、スクリプトの前に付ける引数を決める。
 *
 * 実行ファイルは env `PYTHON_BIN` → appconfig `python.bin` → 既定の順。引数は appconfig
 * `python.args` でだけ足せる(既定は無し)。引数を env で受けない(`PYTHON_ARGS` を設けない)のは、
 * 空白で区切る規則がパスの空白と衝突するため。
 */
export function resolvePythonCommand(opts: {
  envBin: string | undefined;
  fileBin: string | undefined;
  fileArgs: readonly string[] | undefined;
}): { bin: string; args: string[] } {
  return { bin: opts.envBin ?? opts.fileBin ?? DEFAULT_PYTHON_BIN, args: [...(opts.fileArgs ?? [])] };
}
```

- [ ] **Step 5: 起動時確認の文面・コメントを直す**

`editor/server/src/generate/generatorCheck.ts`:

4〜6 行:

```ts
// 生成器を起動できない環境(py ランチャが無い・3.13 が無い・Microsoft Store のスタブに解決
// される)は、最初の「新規作成」まで誰も気づかない。起動ログで先に知らせる。起動は止めない —
// 生成を使わない運用(local・閲覧専用)まで止まるため。
```

を次に替える:

```ts
// 生成器を起動できない環境(PATH に python が無い・PATH で先に見つかる python が 3.13 でない・
// Microsoft Store の偽物 WindowsApps\python.exe に解決される)は、最初の「新規作成」まで誰も
// 気づかない。起動ログで先に知らせる。起動は止めない — 生成を使わない運用(local・閲覧専用)
// まで止まるため。
```

12 行 `/** 生成器が前提とする Python の版(リポジトリの方針 `py -3.13`)。 */` を次に替える:

```ts
/**
 * 生成器が前提とする Python の版。既定の起動コマンド(PATH 上の python)は版を指定しないので、
 * ここで確かめる。
 */
```

`runChecks` の 2 つの `log.warn`（起動失敗と版違い）を次に替える:

```ts
  if ('failure' in probe) {
    log.warn(
      `[generate] 生成器の Python を起動できません(${command}): ${probe.failure} — ` +
        '作成タブの「新規作成」は失敗します。Python 3.13 を入れてユーザー環境変数 PATH に通し' +
        '(WindowsApps の python より前)、新しいコマンドプロンプトからサーバを起動し直すか、' +
        'PYTHON_BIN / appconfig の python.bin・python.args を確認してください',
    );
  } else if (probe.version !== EXPECTED_PYTHON_VERSION) {
    log.warn(
      `[generate] 生成器の Python が ${probe.version} です(${command})。` +
        `${EXPECTED_PYTHON_VERSION} を前提にしています — PATH で先に見つかる python が ` +
        `${EXPECTED_PYTHON_VERSION} になるよう PATH を直す(システム PATH はユーザー PATH より先に` +
        `探されます)か、PYTHON_BIN に ${EXPECTED_PYTHON_VERSION} の python.exe を指定してください`,
    );
  } else {
```

`editor/server/src/generate/pyTemplate.ts` 92〜95 行:

```ts
/**
 * 親から引き継ぐ環境変数。Windows で py ランチャと Python が動く最小限
 * (`SYSTEMROOT` が無いと Python の乱数・ソケットの初期化が失敗する)。
 */
```

を次に替える:

```ts
/**
 * 親から引き継ぐ環境変数。Windows で Python(既定の PATH 上の python。py ランチャを指定した場合は
 * それも)が動く最小限(`SYSTEMROOT` が無いと Python の乱数・ソケットの初期化が失敗する)。
 */
```

`editor/server/scripts/e2e-rest-server.ts` 27〜28 行:

```ts
  // 作成タブ(`POST /api/generate`)は生成器を子プロセスで呼ぶ。Windows は既定の `py -3.13`
  // をそのまま使い、py ランチャの無い Linux(CI)だけ python3 を直接指す。
```

を次に替える:

```ts
  // 作成タブ(`POST /api/generate`)は生成器を子プロセスで呼ぶ。Windows は既定の PATH 上の
  // `python` を使う(開発機もユーザー環境変数 PATH の先頭に Python 3.13 を置く)。`python` が
  // Python 3 を指すとは限らない Linux(CI)だけ python3 を直接指す。
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm exec vitest run editor/server/test/config.python.test.ts editor/server/test/generatorCheck.test.ts editor/server/test/pyTemplate.test.ts editor/server/test/generate.routes.test.ts editor/server/test/generate.routes.local.test.ts`
Expected: PASS

Run: `pnpm typecheck:editor`
Expected: 成功

- [ ] **Step 7: 文書を直す**

`docs/editor/src/デプロイ運用手順書.md` の設定表の 2 行:

```
| `python.bin` | 生成器を起動する Python（既定 `py`） | `PYTHON_BIN` |
| `python.args` | `python.bin` の後ろに付ける引数（既定 `["-3.13"]`。`python.bin` か `PYTHON_BIN` を指定したときの既定は空） | （appconfig のみ） |
```

を次に替える:

```
| `python.bin` | 生成器を起動する Python（既定 `python`。PATH から探す。3.2 節） | `PYTHON_BIN` |
| `python.args` | `python.bin` の後ろに付ける引数（既定は無し） | （appconfig のみ） |
```

3.2 節の冒頭の文「作成タブの「新規作成」は、既存のテンプレート生成器（Python のスクリプト）を `py -3.13 <スクリプト> <属性の JSON>` として起動する。」を次に替える:

```
作成タブの「新規作成」は、既存のテンプレート生成器（Python のスクリプト）を `python <スクリプト> <属性の JSON>` として起動する。`python` は PATH から探し、版は指定しない（3.13 かどうかは起動時の確認が知らせる）。
```

3.2 節の「指紋（SHA256）の設定:」の行の直前に、次の段落を挿入する:

```
Python 3.13 を PATH に通す（本番機・開発機とも、運用者が手で設定する）:

1. Python 3.13 を入れる。インストーラで「Add python.exe to PATH」を選ぶと、ユーザー環境変数 PATH の先頭に `…\Python313\` と `…\Python313\Scripts\` が入る。
2. 手で設定するときは、スタートメニューで「環境変数」と検索して「環境変数を編集」を開き、ユーザー環境変数 `Path` に上の 2 つを足して、`%LOCALAPPDATA%\Microsoft\WindowsApps` より**上**へ移す。WindowsApps の `python.exe` は Microsoft Store の偽物で、先に当たると終了コード 9009 で起動できない。「設定 → アプリ → アプリ実行エイリアス」で `python.exe` / `python3.exe` をオフにしてもよい。
3. `setx` で PATH を設定しない。1024 文字で切れ、既存の PATH の後半が失われる。
4. Windows のプロセスの PATH は「システム環境変数 `Path` の後にユーザー環境変数 `Path`」の順で探す。システムの `Path` に別の版の Python があると、ユーザーの `Path` の先頭に置いても負ける。その場合はシステムの `Path` からその行を外す（管理者が行う）か、`PYTHON_BIN` に Python 3.13 の `python.exe` の絶対パスを設定する。起動時の確認が版違いとして警告するので、それで気づける。
5. 設定したら**新しいコマンドプロンプト**で `where python`（1 件目が Python 3.13 の `python.exe`）と `python --version`（`Python 3.13.x`）を確かめる。起動中のサーバには反映されないので、サーバも新しいコマンドプロンプトから起動し直す。
6. サーバをサービスや別のアカウントで動かす場合は、そのアカウントの PATH が使われる。そのアカウントで同じ設定をする。

設定を誤ったときは、サーバの起動ログ（下の表）と offline の setup（`offline\setup-offline.bat`）の警告が知らせる。

```

3.2 節の警告の表の 3 行:

```
| `[generate] 生成器の Python: 3.13(py -3.13)` | 正常 |
| `[generate] 生成器の Python を起動できません` | py ランチャか Python 3.13 が無い（終了コード 9009 は Microsoft Store のスタブ）。Python 3.13 と py ランチャを入れるか、`PYTHON_BIN` に python.exe の絶対パスを設定する |
| `[generate] 生成器の Python が 3.12 です` | 3.13 以外の Python で起動している。`python.args` で `-3.13` を指定するか、3.13 の python.exe を `PYTHON_BIN` に設定する。appconfig に `python.args` を書いている場合は、`PYTHON_BIN` に絶対パスを指定するときに外す（appconfig の `python.args` が優先され、`python.exe -3.13` で起動して失敗するため） |
```

を次に替える:

```
| `[generate] 生成器の Python: 3.13(python)` | 正常 |
| `[generate] 生成器の Python を起動できません` | PATH に `python` が無い、または Microsoft Store の偽物（WindowsApps。終了コード 9009）に当たっている。上の「Python 3.13 を PATH に通す」に従い、新しいコマンドプロンプトから起動し直す |
| `[generate] 生成器の Python が 3.12 です` | PATH で先に見つかる `python` が 3.13 でない（システムの `Path` にある別の版など）。PATH を直すか、3.13 の `python.exe` の絶対パスを `PYTHON_BIN` に設定する。appconfig に `python.args` が残っていれば外す（`python.exe` に余計な引数が付いて失敗するため） |
```

`docs/editor/src/設計書.md`:

- 7.3 節の「既定の起動コマンドは `py -3.13`（`config.python.bin` / `config.python.args`）。」を「既定の起動コマンドは PATH 上の `python`（引数なし。`config.python.bin` / `config.python.args`。版は指定せず、3.13 かは起動時の確認が知らせる）。」に替える。
- 16.2 節の「生成器の起動（`py -3.13`）・置き方・」を「生成器の起動（PATH 上の `python`）・置き方・」に替える。

`editor/README.md`:

- 159 行の「（既定はテスト用の偽物 `server/scripts/fake_generate_template.py` を `py -3.13` で呼ぶ）」を「（既定はテスト用の偽物 `server/scripts/fake_generate_template.py` を PATH 上の `python` で呼ぶ）」に替える。
- 180 行 `| `PYTHON_BIN` | `py`（引数 `-3.13` 付き） | 生成器を起動する Python。指定すると引数の既定は空（絶対パスの python.exe を直接指す） |` を `| `PYTHON_BIN` | `python`（PATH から探す。引数なし） | 生成器を起動する Python。3.13 でなければ起動ログに警告が出る |` に替える。

`editor/OFFLINE.md` 96 行 `| `python.bin` / `python.args` / `python.script` / `python.scriptSha256` / `python.timeoutMs` | `py` / `["-3.13"]` / `server/scripts/fake_generate_template.py` / なし / 30000 | テンプレート生成器（本番は `python.script` で既存の生成器を指す） |` を次に替える:

```
| `python.bin` / `python.args` / `python.script` / `python.scriptSha256` / `python.timeoutMs` | `python` / なし / `server/scripts/fake_generate_template.py` / なし / 30000 | テンプレート生成器（`python` は PATH から探す。本番は `python.script` で既存の生成器を指す） |
```

- [ ] **Step 8: 整形してコミット**

Run: `pnpm exec biome check --write editor/server/src/config.ts editor/server/src/generate/generatorCheck.ts editor/server/src/generate/pyTemplate.ts editor/server/scripts/e2e-rest-server.ts editor/server/test/config.python.test.ts editor/server/test/generatorCheck.test.ts`
Expected: エラーなし

```bash
git add editor/server/src/config.ts editor/server/src/generate/generatorCheck.ts editor/server/src/generate/pyTemplate.ts editor/server/scripts/e2e-rest-server.ts editor/server/test/config.python.test.ts editor/server/test/generatorCheck.test.ts "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計書.md" editor/README.md editor/OFFLINE.md
git commit -m "feat(editor): 生成器の既定の起動コマンドを PATH 上の python(引数なし)にし、起動時の警告で PATH の直し方を案内する"
```

---

### Task 2: 旧構成の残りを起動ログで警告する

対応する設計: 6.7.3。

**Files:**
- Create: `editor/server/src/files/legacyLayoutCheck.ts`
- Create: `editor/server/test/legacyLayoutCheck.test.ts`
- Modify: `editor/server/src/serve.ts`（import と、`checkGeneratorAtStartup().catch(() => {});` の直後）
- Modify: `vitest.config.ts`（coverage include。`'editor/server/src/generate/generatorCheck.ts',` の直後）

**Interfaces:**
- Produces: `export const LEGACY_FONT_URL_RE: RegExp`、`export interface LegacyLayoutLog { warn(msg: string): void }`、`export interface LegacyLayoutFindings { assetsDir: string | null; cssFiles: string[] }`、`export async function findLegacyLayout(opts: { dataRoot: string; cssDir: string }): Promise<LegacyLayoutFindings>`、`export async function warnLegacyLayoutAtStartup(log?: LegacyLayoutLog, opts?: { dataRoot: string; cssDir: string }): Promise<void>`（既定は `logger` と `{ dataRoot: config.dataRoot, cssDir: config.cssDir }`。reject しない）

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/legacyLayoutCheck.test.ts`:

```ts
// =============================================================================
// legacyLayoutCheck.test.ts — 旧構成の残り(assets・CSS の ../fonts/)を起動時に警告するか
// =============================================================================
// 一時フォルダに実物の置き場を作って確かめる。起動を止めない(reject しない)ことも固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // config の既定(dataRoot・cssDir)を、存在しない一時の場所へ向けてから import させる。
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  process.env.LOG_DIR = `${tmpRoot}/editor-legacy-layout-logs`;
  process.env.DATA_ROOT = `${tmpRoot}/editor-legacy-layout-missing-root`;
  process.env.APP_CONFIG = `${tmpRoot}/editor-legacy-layout-no-appconfig.json`;
});

import {
  findLegacyLayout,
  LEGACY_FONT_URL_RE,
  warnLegacyLayoutAtStartup,
} from '../src/files/legacyLayoutCheck.js';
import { logger } from '../src/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];

function makeRoot(): { dataRoot: string; cssDir: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-legacy-layout-'));
  roots.push(dataRoot);
  const cssDir = path.join(dataRoot, 'css');
  fs.mkdirSync(cssDir, { recursive: true });
  return { dataRoot, cssDir };
}

const fakeLog = () => ({ warn: vi.fn() });

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('LEGACY_FONT_URL_RE', () => {
  it.each([
    ['url(../fonts/a.woff2)', true],
    ['url( "../fonts/a.woff2")', true],
    ["URL('../FONTS/a.woff2')", true],
    ['url(fonts/a.woff2)', false],
    ['url(../../fonts/a.woff2)', false],
    ['url(css/fonts/a.woff2)', false],
  ])('%s → %s', (css, expected) => {
    expect(LEGACY_FONT_URL_RE.test(css)).toBe(expected);
  });
});

describe('findLegacyLayout', () => {
  it('cssDir 直下の .css だけを見て、名前順に返す', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, 'b.css'), '@font-face{src:url(../fonts/b.woff2)}');
    fs.writeFileSync(path.join(r.cssDir, 'a.css'), '@font-face{src:url("../fonts/a.woff2")}');
    fs.writeFileSync(path.join(r.cssDir, 'new.css'), '@font-face{src:url(fonts/n.woff2)}');
    fs.writeFileSync(path.join(r.cssDir, 'note.txt'), 'url(../fonts/x.woff2)');
    fs.mkdirSync(path.join(r.cssDir, 'sub'));
    fs.writeFileSync(path.join(r.cssDir, 'sub', 'd.css'), 'url(../fonts/d.woff2)');
    expect(await findLegacyLayout(r)).toEqual({ assetsDir: null, cssFiles: ['a.css', 'b.css'] });
  });

  it('assets がファイルなら残っていない扱い', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.dataRoot, 'assets'), 'not a folder');
    expect((await findLegacyLayout(r)).assetsDir).toBeNull();
  });
});

describe('warnLegacyLayoutAtStartup', () => {
  it('assets が残っていれば、場所とパッチの案内を添えて警告する', async () => {
    const r = makeRoot();
    fs.mkdirSync(path.join(r.dataRoot, 'assets', 'fonts'), { recursive: true });
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const msg = log.warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/^\[layout\] /);
    expect(msg).toContain(path.join(r.dataRoot, 'assets'));
    expect(msg).toContain('フォント移設パッチ editor/patches/2026-10-fonts-to-css/ を流してください');
  });

  it('CSS に url(../fonts/ が残っていれば、ファイル名を並べて警告する', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, '510037.css'), '@font-face{src:url(../fonts/a.woff2)}');
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const msg = log.warn.mock.calls[0][0] as string;
    expect(msg).toContain('url(../fonts/');
    expect(msg).toContain('510037.css');
    expect(msg).toContain('フォント移設パッチ');
  });

  it('6 件以上は 5 件まで並べ、残りの件数を添える', async () => {
    const r = makeRoot();
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(r.cssDir, `f${i}.css`), 'src:url(../fonts/a.woff2)');
    }
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    const msg = log.warn.mock.calls[0][0] as string;
    expect(msg).toContain('f1.css, f2.css, f3.css, f4.css, f5.css ほか 2 件');
    expect(msg).not.toContain('f6.css');
  });

  it('何も残っていなければ警告しない', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, '510037.css'), '@font-face{src:url(fonts/a.woff2)}');
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('置き場が無くても reject せず、警告もしない', async () => {
    const log = fakeLog();
    const missing = path.join(os.tmpdir(), 'editor-legacy-layout-none', 'x');
    await expect(
      warnLegacyLayoutAtStartup(log, { dataRoot: missing, cssDir: path.join(missing, 'css') }),
    ).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('出力先が例外を投げても reject せず、サーバのロガーへ警告する', async () => {
    const r = makeRoot();
    fs.mkdirSync(path.join(r.dataRoot, 'assets'));
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const log = {
      warn: () => {
        throw new Error('boom');
      },
    };
    await expect(warnLegacyLayoutAtStartup(log, r)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('旧構成の確認に失敗しました: boom'));
  });

  it('既定ではサーバの設定(dataRoot・cssDir)を見る', async () => {
    const log = fakeLog();
    await expect(warnLegacyLayoutAtStartup(log)).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('serve.ts は起動時に待たずに呼ぶ(listen を遅らせず、例外で起動を止めない)', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../src/serve.ts'), 'utf8');
    expect(src).toMatch(/\n\s*warnLegacyLayoutAtStartup\(\)\.catch\(\(\) => \{\}\);/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run editor/server/test/legacyLayoutCheck.test.ts`
Expected: FAIL（`../src/files/legacyLayoutCheck.js` が無い）

- [ ] **Step 3: 実装する**

`editor/server/src/files/legacyLayoutCheck.ts`:

```ts
// =============================================================================
// legacyLayoutCheck.ts — 旧い data 構成の残りを起動時に 1 回だけ確かめて警告する
// =============================================================================
// フォントは `<cssDir>/fonts`、js は `jsDir` に置く構成で、旧構成の `<dataRoot>/assets` や CSS の
// `url(../fonts/…)` が残っていると、PDF のフォントと JS が黙って欠けたまま成功扱いになる。
// 起動は止めない — 片付けはフォント移設パッチ(`editor/patches/2026-10-fonts-to-css/`)の役目で、
// 止めるとパッチを流す前の確認や生成を使わない運用まで止まる。警告で運用者に気づかせる。
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** 警告の出力先(既定はサーバのロガー。テストで差し替える)。 */
export interface LegacyLayoutLog {
  warn(msg: string): void;
}

/** 旧構成の残り。 */
export interface LegacyLayoutFindings {
  /** 残っている `<dataRoot>/assets`(ディレクトリでなければ null)。 */
  assetsDir: string | null;
  /** `url(../fonts/` を含む cssDir 直下の CSS のファイル名(名前順)。 */
  cssFiles: string[];
}

/**
 * `url(` の直後の旧いフォント参照。フォント移設パッチ(`migrate.ps1` の `$rewriteRe`)が書き換える
 * 形と同じにする(`../../fonts/` のような別の相対参照は対象外)。
 */
export const LEGACY_FONT_URL_RE = /url\(\s*["']?\.\.\/fonts\//i;

const PATCH_HINT = 'フォント移設パッチ editor/patches/2026-10-fonts-to-css/ を流してください';
/** 警告に並べる CSS の件数の上限(多数あっても 1 行に収める)。 */
const MAX_LISTED = 5;

/** 旧構成の残りを調べる。置き場が無い・読めないものは「残っていない」として扱う。 */
export async function findLegacyLayout(opts: {
  dataRoot: string;
  cssDir: string;
}): Promise<LegacyLayoutFindings> {
  const assets = path.join(opts.dataRoot, 'assets');
  const assetsDir = await fs.stat(assets).then(
    (s) => (s.isDirectory() ? assets : null),
    () => null,
  );
  // 見るのは cssDir 直下だけ(パッチが書き換えるのも直下の確定 CSS)。
  const entries = await fs.readdir(opts.cssDir, { withFileTypes: true }).catch(() => null);
  const cssFiles: string[] = [];
  for (const e of entries ?? []) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.css')) continue;
    const text = await fs.readFile(path.join(opts.cssDir, e.name), 'utf8').catch(() => '');
    if (LEGACY_FONT_URL_RE.test(text)) cssFiles.push(e.name);
  }
  cssFiles.sort();
  return { assetsDir, cssFiles };
}

/**
 * 旧構成の残りを確かめて警告する。reject しない — 呼び出し側は待たずに投げるため、ここで例外を
 * 漏らすと unhandled rejection でプロセスが落ちる。
 */
export async function warnLegacyLayoutAtStartup(
  log: LegacyLayoutLog = logger,
  opts: { dataRoot: string; cssDir: string } = {
    dataRoot: config.dataRoot,
    cssDir: config.cssDir,
  },
): Promise<void> {
  try {
    const found = await findLegacyLayout(opts);
    if (found.assetsDir !== null) {
      log.warn(
        `[layout] 旧構成の ${found.assetsDir} が残っています。フォントは <cssDir>/fonts、js は ` +
          `jsDir へ移す構成のため、このままでは PDF のフォントと JS が欠けます — ${PATCH_HINT}`,
      );
    }
    if (found.cssFiles.length > 0) {
      const listed = found.cssFiles.slice(0, MAX_LISTED).join(', ');
      const rest = found.cssFiles.length - MAX_LISTED;
      log.warn(
        `[layout] ${opts.cssDir} の CSS に url(../fonts/ が残っています(${listed}` +
          `${rest > 0 ? ` ほか ${rest} 件` : ''})。新構成では url(fonts/…) と書きます — ${PATCH_HINT}`,
      );
    }
  } catch (err) {
    logger.warn(
      `[layout] 旧構成の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

`editor/server/src/serve.ts`:

- import 群の `import { checkGeneratorAtStartup } from './generate/generatorCheck.js';` の直前に `import { warnLegacyLayoutAtStartup } from './files/legacyLayoutCheck.js';` を足す（biome の import 整理に従う）。
- `checkGeneratorAtStartup().catch(() => {});` の行の直後に追加する:

```ts
  // 旧構成の残り(assets・CSS の ../fonts/ 参照)を知らせる。待たない・止めない — 片付けは
  // フォント移設パッチの役目で、起動を止めるとパッチを流す前の確認まで止まるため。
  warnLegacyLayoutAtStartup().catch(() => {});
```

`vitest.config.ts` の `'editor/server/src/generate/generatorCheck.ts',` の行の直後に `'editor/server/src/files/legacyLayoutCheck.ts',` を足す。

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run editor/server/test/legacyLayoutCheck.test.ts`
Expected: PASS（全件）

Run: `pnpm exec vitest run --project server --coverage --coverage.include=editor/server/src/files/legacyLayoutCheck.ts editor/server/test/legacyLayoutCheck.test.ts`
Expected: `legacyLayoutCheck.ts` が全指標 85% 以上

Run: `pnpm typecheck:editor`
Expected: 成功

- [ ] **Step 5: 整形してコミット**

Run: `pnpm exec biome check --write editor/server/src/files/legacyLayoutCheck.ts editor/server/test/legacyLayoutCheck.test.ts editor/server/src/serve.ts`
Expected: エラーなし

```bash
git add editor/server/src/files/legacyLayoutCheck.ts editor/server/test/legacyLayoutCheck.test.ts editor/server/src/serve.ts vitest.config.ts
git commit -m "feat(editor): 旧構成の assets と CSS の ../fonts/ 参照が残っていれば、起動ログで警告する"
```

---

### Task 3: 旧構成を理由に起動を止める assets の検査と `paths.assetsDir` を外す

対応する設計: 6.3、6.7.6 の「文書の更新先」のうち設計正典・要約・運用手順書の `assetsDir` / `ASSETS_DIR` の書き分け。

**Files:**
- Modify: `editor/server/src/config.ts`（スキーマ 55〜56 行、`assertNoRetiredAssetsDir`・`assertNoLegacyAssetsDir` の定義 895〜933 行、呼び出し 980〜982 行）
- Modify: `editor/server/test/config.paths.test.ts`
- Modify: `docs/editor/src/デプロイ運用手順書.md`（設定表直後の段落と警告の表）
- Modify: `docs/editor/src/設計書.md`（15.3 節の表）
- Modify: `docs/editor/src/設計正典.md`（front matter の rev、265 行、却下済み設計の末尾）
- Modify（git 管理外・ステージしない）: `.claude/rules/design-canon-summary.md`

削る・名前を変える記号の残り（`git grep -n -E "assertNoRetiredAssetsDir|assertNoLegacyAssetsDir|assetsDir|ASSETS_DIR" -- . ':!docs/superpowers' ':!*.html'` の結果ごとの扱い）:

- `editor/server/src/config.ts` 56・896〜933・981〜982 行 → 削る（この Task）。
- `editor/server/test/config.paths.test.ts` 27・60・98〜102・117〜153 行 → 27 行（`PATH_ENV_KEYS` の `'ASSETS_DIR'`）と 60 行（`'assetsDir' in config` が false）は残す（`ASSETS_DIR` を読まないことのテストに使う）。98〜102 行と 117〜153 行は差し替え・削除（この Task）。
- `editor/patches/2026-10-fonts-to-css/migrate.ps1`・`migrate.Tests.ps1`・`README.md` → 残す。パッチは旧い assets の場所を `ASSETS_DIR` / `paths.assetsDir` から読み、`paths.assetsDir` を `paths.jsDir` へ置き換えるのが仕事（Task 10・Task 11 で文面を直す）。
- `docs/editor/src/デプロイ運用手順書.md` 70 行 → この Task で書き直す。117 行 → Task 13 で書き直す。
- `docs/editor/src/設計正典.md` 265 行 → この Task で書き直す。

**Interfaces:**
- Removes: `export function assertNoRetiredAssetsDir`、`export function assertNoLegacyAssetsDir`、appconfig の `paths.assetsDir`
- Keeps: `export function assertImagesDirOutsideCommittedAreas(...)` とその呼び出し

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/config.paths.test.ts`:

import に次を足す（既存の `import path from 'node:path';` の前後に。biome の並びに従う）:

```ts
import fs from 'node:fs';
import os from 'node:os';
```

`PATH_ENV_KEYS` の末尾（`'ASSETS_DIR',` の後）に `'APP_CONFIG',` を足す。

`it('ASSETS_DIR が残っていたら起動エラーで jsDir への移行を案内する', …)`（98〜102 行）を次の 3 件に替える:

```ts
  it('ASSETS_DIR は読まない(設定されていても起動でき、jsDir は既定のまま)', async () => {
    const { config } = await importConfigWithEnv({
      DATA_ROOT,
      ASSETS_DIR: path.join(DATA_ROOT, 'assets'),
    });
    expect(config.jsDir).toBe(path.join(DATA_ROOT, 'js'));
    expect('assetsDir' in config).toBe(false);
  });

  it('dataRoot に旧構成の assets が残っていても起動は止めない(警告は files/legacyLayoutCheck.ts)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-config-assets-'));
    try {
      fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
      const { config } = await importConfigWithEnv({ DATA_ROOT: root });
      expect(config.dataRoot).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('appconfig の paths.assetsDir は不明なキーとして読み込みエラーになる', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-config-assetsdir-'));
    const file = path.join(dir, 'appconfig.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ paths: { assetsDir: 'D:\\old\\assets' } }), 'utf8');
      await expect(importConfigWithEnv({ DATA_ROOT, APP_CONFIG: file })).rejects.toThrow(
        /appconfig\.json の内容が不正です[\s\S]*assetsDir/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
```

`describe('assertNoRetiredAssetsDir', …)` と `describe('assertNoLegacyAssetsDir', …)`（117〜153 行）を丸ごと削る。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run editor/server/test/config.paths.test.ts`
Expected: FAIL（`ASSETS_DIR` と `assets` の 2 件が「assetsDir は廃止しました」「残っています」で reject する）

- [ ] **Step 3: 実装する**

`editor/server/src/config.ts`:

- スキーマの次の 2 行を削る:

```ts
        // 廃止済み。専用の起動エラーを出すため検出用に残す(消すと .strict() の汎用エラーに退化する)。
        assetsDir: z.string().optional(),
```

- `/**\n * 廃止した設定 \`assetsDir\`(appconfig …` で始まる `assertNoRetiredAssetsDir` の JSDoc と関数、続く `assertNoLegacyAssetsDir` の JSDoc と関数（895〜933 行。`/**\n * \`imagesDir\` が確定領域…` の JSDoc の直前まで）を削る。
- 末尾の次の 3 行:

```ts
// 廃止した置き場の指定が残っていたら、listen より前に止める。
assertNoRetiredAssetsDir({ env: process.env.ASSETS_DIR, file: file.paths?.assetsDir });
assertNoLegacyAssetsDir({ dataRoot: config.dataRoot, exists: fs.existsSync });
```

を次の 1 行に替える（直後の `assertImagesDirOutsideCommittedAreas({ … });` は残す）:

```ts
// imagesDir が確定領域の内側なら、listen より前に止める。
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run editor/server/test/config.paths.test.ts editor/server/test/config.python.test.ts editor/server/test/config.security.test.ts`
Expected: PASS

Run: `git grep -n -E "assertNoRetiredAssetsDir|assertNoLegacyAssetsDir" -- editor`
Expected: 出力なし

Run: `pnpm typecheck:editor`
Expected: 成功（`fs` は `loadFileConfig` などでまだ使う）

- [ ] **Step 5: 文書を直す**

`docs/editor/src/デプロイ運用手順書.md` の設定表直後の段落:

```
`paths.assetsDir` / `ASSETS_DIR` は廃止した。指定が残っていると起動を中止する（移行は `editor/patches/2026-10-fonts-to-css/`）。フォントは `paths.cssDir` の下の `fonts/` に置く。
```

を次に替える:

```
`paths.assetsDir` は廃止した。appconfig に残っていると、不明なキーとして読み込みエラーになり起動しない（フォント移設パッチ `editor/patches/2026-10-fonts-to-css/` が `paths.jsDir` へ置き換える）。環境変数 `ASSETS_DIR` は読まない（設定されていても何も起きないので、手で外す）。フォントは `paths.cssDir` の下の `fonts/` に、js は `paths.jsDir` に置く。

旧構成（`<dataRoot>\assets`、CSS の `url(../fonts/…)`）が残っていても起動は止まらず、起動ログに次の警告が出る（左の列は各ログ行の先頭部分の引用）。そのまま使うと、フォントと JS が欠けた PDF が成功扱いで出る。

| 起動ログ（…で始まる行） | 意味と対応 |
|---|---|
| `[layout] 旧構成の … が残っています` | `<dataRoot>\assets` が残っている。フォント移設パッチ（`editor/patches/2026-10-fonts-to-css/`）を流す |
| `[layout] … の CSS に url(../fonts/ が残っています` | `paths.cssDir` 直下の CSS が旧い書き方のまま（括弧の中に該当するファイル名が 5 件まで出る）。フォント移設パッチを流す |
| `[layout] 旧構成の確認に失敗しました` | 確認そのものが失敗した（置き場の読み取り権限など）。起動は続く。メッセージの原因を確かめる |
```

`docs/editor/src/設計書.md` 15.3 節の表の `| PDF 生成が失敗する | … |` の行の直後に追加する:

```
| PDF のフォント・JS が効かない | 起動ログの `[layout]` 警告（旧構成の `assets`、CSS の `url(../fonts/…)` が残っている。`server/src/files/legacyLayoutCheck.ts`）を確認し、フォント移設パッチ（`editor/patches/2026-10-fonts-to-css/`）を流す |
```

`docs/editor/src/設計正典.md`:

- front matter の `rev:` の最後の行の後に `  - 1.2 | 2026-10-02 | 旧構成を理由に起動を止める検査を警告へ改め、旧データ向けの互換処理を外したことの反映` を足し、`version: "1.1"` を `version: "1.2"` にする。
- 265 行 `  \`assetsDir\` / \`ASSETS_DIR\` は廃止で、指定が残っていると起動を中止する。` を次の 3 行に替える:

```
  `assetsDir` は廃止した（appconfig の `paths.assetsDir` は不明なキーとして読み込みエラー、環境変数
  `ASSETS_DIR` は読まない）。旧構成の残り（`<dataRoot>/assets`・`cssDir` の CSS の `url(../fonts/…)`）は
  起動ログで警告するだけで起動は止めない（`files/legacyLayoutCheck.ts`。片付けはフォント移設パッチ）。
```

- 「してはならないこと・却下済み設計（再提案しない）」の最後の項目（`- **画像をプレビューホストのワイルドカード（\`/api/preview-host/*\`）でも配る**: しない。SVG 検査を` で始まる 2 行）の直後に追加する:

```
- **旧構成（`<dataRoot>/assets`・CSS の `url(../fonts/…)`・旧 `editor/data`）を理由に起動を止める**:
  しない（2026-10）。片付けはフォント移設パッチ（`editor/patches/2026-10-fonts-to-css/`）に任せ、
  サーバは残りを起動ログで警告するだけにする（`files/legacyLayoutCheck.ts`）。止めると、パッチを
  流す前の確認や生成を使わない運用まで止まる。流し忘れるとフォントと JS の欠けた PDF が成功扱いで
  出るリスクは了承済みで、運用手順書の更新手順で「フォント移設パッチは必須」と目立たせて補う。
```

`.claude/rules/design-canon-summary.md` の editor の「却下済み設計」の `52. 画像をプレビューホストのワイルドカード（\`/api/preview-host/*\`）でも配る` の行の直後に追加する:

```
53. 旧構成（`<dataRoot>/assets`・CSS の `url(../fonts/…)`・旧 `editor/data`）を理由に起動を止める
```

Run: `pnpm run check:canon-summary -- --update`
Expected: editor の却下済み設計の sha を書き戻した旨の警告

Run: `pnpm run check:canon-summary`
Expected: 成功

- [ ] **Step 6: 整形してコミット**

Run: `pnpm exec biome check --write editor/server/src/config.ts editor/server/test/config.paths.test.ts`
Expected: エラーなし

```bash
git add editor/server/src/config.ts editor/server/test/config.paths.test.ts "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計書.md" "docs/editor/src/設計正典.md"
git commit -m "refactor(editor): 旧構成を理由に起動を止める assets の検査と paths.assetsDir を外し、残りは起動ログの警告に任せる"
```

---

### Task 4: 旧形式メモの変換と `kind` の読み捨てを外す

対応する設計: 6.4 の 1 点目、6.4 の「外す前に確かめる」、6.7.6 の「互換処理を外す範囲」（`schemas.ts` の説明文・`openapi.json` の再生成・`notes.entryId.test.ts`・`notesFile.thread.test.ts`・`noteRepo.test.ts`）。

**Files:**
- Modify: `editor/server/src/files/notesFile.ts`（93〜154 行の `withCommentDefaults` の JSDoc と `normalizeStored`）
- Modify: `editor/web/src/api/local/noteRepo.ts`（31〜60 行の `withCommentDefaults` と `readStore`）
- Modify: `editor/web/src/features/editor/comments/CommentPanel.vue`（101〜103 行のコメント）
- Modify: `editor/web/src/features/editor/NoteBubble.vue`（40〜45 行のコメント）
- Modify: `editor/shared/src/schemas.ts`（599 行の説明文）
- Modify: `editor/server/openapi/openapi.json`（再生成）
- Modify: `editor/server/test/notesFile.thread.test.ts`
- Modify: `editor/server/test/noteRepo.test.ts`
- Delete: `editor/server/test/notes.entryId.test.ts`（中身が `legacy:<pathKey>` の ID の URL 往復だけで、互換処理を外すと対象が無くなる。新しい ID は乱数 UUID で `/` `#` を含まない。`buildPath` のエスケープは `editor/shared/test/partNote.test.ts` が見ている）
- Modify: `editor/web/test/noteRepo.dom.test.ts`
- Modify: `docs/editor/src/設計正典.md`（中核原則のコメントの段落。95〜100 行）

`legacy` の残りの扱い（`git grep -n -E "legacy:|\blegacy|Legacy" -- editor ':!*.html'`）: `partSync.redos.test.ts` の `LEGACY_TAG_RE`・`legacyScan`、`geom.test.ts`・`htmlBlockDiff.dom.test.ts` の "legacy" は別の意味（旧い書き方の正規表現・改ページの旧綴り）なので残す。`gitRepo.ts` の `LEGACY_GITATTRIBUTES_LINE` は 6.4 で残すと決めた補修なので残す。

- [ ] **Step 1: 開発用データに旧形式メモが無いことを確かめる（読むだけ）**

Run: `py -3.13 -c "import json,glob; fs=glob.glob(r'C:\Users\caads\editor-data\notes\*.json'); bad=[f for f in fs if any(not isinstance(v,list) for v in json.load(open(f,encoding='utf-8')).values())]; print(len(fs), len(bad), bad)"`
Expected: `<件数> 0 []`（旧形式が 1 件でもあれば、外さずに止めて報告する）

- [ ] **Step 2: 失敗するテストを書く（server）**

`editor/server/test/notesFile.thread.test.ts`:

- 2 行目の見出し `// notesFile.thread.test.ts — 追記型スレッドのファイル形式と旧形式からの遅延変換` を `// notesFile.thread.test.ts — 追記型スレッドのファイル形式と配列でない値の読み捨て` に替える。
- 冒頭のコメント 4〜6 行を次に替える:

```ts
// メモは `dataRoot/notes/<templateId>.json` に `pathKey → 投稿配列` で持つ。配列でない値は
// 読み捨てること(表示用・書き込み用のどちらの読み取りでも)を主張する。
```

- `const KEY = '.page#1/cover#1';` の次の行に `const KEY2 = '.page#1/cover#2';` を足す。
- `describe('旧形式の遅延変換', …)`（60〜108 行）を次に替える:

```ts
describe('配列でない値の読み捨て', () => {
  const stored = {
    id: 'e1',
    content: '新形式',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'u',
    updatedAt: null,
    updatedBy: null,
  };

  it('配列でない値(1 パーツ 1 件の形・null・文字列)は読み捨て、配列の投稿は残す', async () => {
    const files = await importNotesFile();
    await writeRaw({
      [KEY]: { content: '旧メモ', updatedAt: 'x', updatedBy: 'u' },
      [KEY2]: [stored],
      '.page#2/x#1': null,
      '.page#3/x#1': '文字列',
    });
    const map = await files.readNotes(TPL);
    expect(Object.keys(map)).toEqual([KEY2]);
    expect(map[KEY2][0]).toMatchObject({ id: 'e1', content: '新形式' });
  });

  it('書き込み用の読み取り(readNotesStrict)も同じく読み捨てる', async () => {
    const files = await importNotesFile();
    await writeRaw({ [KEY]: { content: '旧メモ' }, [KEY2]: [stored] });
    expect(Object.keys(await files.readNotesStrict(TPL))).toEqual([KEY2]);
  });
});
```

- `it('旧形式(1 パーツ 1 件)の変換分も 2 フィールドを持つ', …)`（182〜204 行）を削る。

`editor/server/test/noteRepo.test.ts` の `describe('旧形式ファイル(複数 pathKey)での id 衝突を防ぐ', …)`（252〜291 行）を次に替える:

```ts
describe('配列でない値の扱い', () => {
  // 読み取りで捨てた値は、次の書き込みの元にもならない(書き込みも同じ読み取りから組む)。
  async function writeMixedFile(): Promise<void> {
    const notesDir = path.join(tmpRoot, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      path.join(notesDir, `${KOUFU}.json`),
      JSON.stringify({
        [KEY]: { content: '旧', updatedAt: 'x', updatedBy: 'u' },
        [OTHER_KEY]: [
          {
            id: 'e1',
            content: '残る',
            createdAt: '2026-09-01T00:00:00.000Z',
            createdBy: 'u',
            updatedAt: null,
            updatedBy: null,
          },
        ],
      }),
      'utf8',
    );
  }

  it('一覧には配列の投稿だけが出る', async () => {
    const { repo } = await importRepo();
    await writeMixedFile();
    expect((await repo.listNotes(KOUFU)).map((e) => e.id)).toEqual(['e1']);
  });

  it('同じファイルへ書き込むと、配列でない値は残らない', async () => {
    const { repo } = await importRepo();
    await writeMixedFile();
    await repo.addNote(KOUFU, KEY, '新しい投稿', 'editor1', PARENT);
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpRoot, 'notes', `${KOUFU}.json`), 'utf8'),
    ) as Record<string, Array<{ id: string; content: string }>>;
    expect(raw[KEY].map((e) => e.content)).toEqual(['新しい投稿']);
    expect(raw[OTHER_KEY][0].id).toBe('e1');
  });
});
```

- [ ] **Step 3: 失敗するテストを書く（web）**

`editor/web/test/noteRepo.dom.test.ts`:

- `it('2 属性を持たない投稿は open / null で一覧に出る', …)` の中の `expect(isOk(list) && list.value[0]).not.toHaveProperty('kind');` の行を削る（種は `kind` を持たない）。
- `it('列挙外の status と空文字の replyTo は既定値へ落ちる。旧形式の kind は読み取りで捨てる', …)` を次に替える:

```ts
  it('列挙外の status と空文字の replyTo は既定値へ落ちる', async () => {
    const invalid = {
      id: 'bad1',
      templateId: KOUFU,
      pathKey: KEY,
      content: '不正値',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'u',
      updatedAt: null,
      updatedBy: null,
      status: 'archived',
      replyTo: '',
    };
    localStorage.setItem(K.notes, JSON.stringify({ [KOUFU]: { [KEY]: [invalid] } }));
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value).toEqual([
      expect.objectContaining({ id: 'bad1', status: 'open', replyTo: null }),
    ]);
  });

  it('パーツの値が配列でなければ読み捨て、他のパーツの投稿は出す', async () => {
    const entry = {
      id: 'n1',
      templateId: KOUFU,
      pathKey: KEY,
      content: '残る',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'u',
      updatedAt: null,
      updatedBy: null,
      status: 'open',
      replyTo: null,
    };
    localStorage.setItem(
      K.notes,
      JSON.stringify({ [KOUFU]: { [KEY]: [entry], '.page#9/x#1': { content: '旧' } } }),
    );
    const list = await localNoteRepo.listNotes(KOUFU);
    expect(isOk(list) && list.value.map((e) => e.id)).toEqual(['n1']);
  });
```

- [ ] **Step 4: テストが失敗することを確認する**

Run: `pnpm exec vitest run editor/server/test/notesFile.thread.test.ts editor/server/test/noteRepo.test.ts editor/web/test/noteRepo.dom.test.ts`
Expected: FAIL（server は旧形式を `legacy:<pathKey>` として読む、web は配列でない値で `.map` が例外になり一覧が err になる）

- [ ] **Step 5: 実装する（server）**

`editor/server/src/files/notesFile.ts`:

- `withCommentDefaults` の JSDoc の最後の 2 行:

```ts
 * `raw.kind` は旧形式(コメント種別が在った頃)の名残で、読み取っても返却値へは持ち込まない
 * (コメントはメモ 1 種類になったため)。
```

を次に替える:

```ts
 * 返却値は既知のフィールドだけで組む(保存内容に未知のフィールドがあっても持ち込まない)。
```

- `normalizeStored` の JSDoc と関数（122〜154 行）を次に替える:

```ts
/**
 * 保存形式(`pathKey` → 投稿配列)を読む。配列でない値は読み捨てる(この形式の外の値を投稿として
 * 扱わない)。書き込みもこの戻り値から組むので、読み捨てた値は次の書き込みで消える。
 */
function normalizeStored(parsed: Record<string, unknown>): NoteEntriesMap {
  const out: NoteEntriesMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter(looksLikeStoredNoteEntry).map(withCommentDefaults);
  }
  return out;
}
```

- [ ] **Step 6: 実装する（web と説明文）**

`editor/web/src/api/local/noteRepo.ts` の `withCommentDefaults` の JSDoc と関数、`readStore` を次に替える（31〜60 行）:

```ts
/**
 * `status`/`replyTo` を持たない投稿へ既定値を補う。server の `files/notesFile.ts` の
 * `withCommentDefaults` と同じ規則(status は 'open'、replyTo は非空文字列でなければ null)。
 * 補わないと `parent.replyTo !== null` が `undefined !== null` で真になり、その投稿への返信・
 * 解決が常に拒否される。列挙の外の値も既定へ戻す(1 件の破損で読み取り全体を落とさない)。
 */
function withCommentDefaults(raw: PartNoteEntry): PartNoteEntry {
  const status =
    typeof raw.status === 'string' && NOTE_STATUSES.has(raw.status) ? raw.status : 'open';
  const replyTo = typeof raw.replyTo === 'string' && raw.replyTo !== '' ? raw.replyTo : null;
  return { ...raw, status, replyTo };
}

/**
 * `K.notes` を読み、全投稿へコメント属性の既定値を補って返す(読み取りの唯一の入口)。
 * パーツの値が配列でなければ読み捨てる(server の `normalizeStored` と同じ)。
 */
function readStore(): NoteStore {
  const all = read<NoteStore>(K.notes, {});
  const out: NoteStore = {};
  for (const [templateId, tpl] of Object.entries(all)) {
    const outTpl: Record<string, PartNoteEntry[]> = {};
    for (const [pathKey, entries] of Object.entries(tpl)) {
      if (!Array.isArray(entries)) continue;
      outTpl[pathKey] = entries.map(withCommentDefaults);
    }
    out[templateId] = outTpl;
  }
  return out;
}
```

`editor/web/src/features/editor/comments/CommentPanel.vue` 101〜103 行:

```
// キーは `id` 単体ではなく `templateId/id` の対で持つ(`NoteBubble.vue` の `entryKey` と同じ
// 理由。旧形式ファイルの遅延変換が `legacy:<pathKey>` を id に使うため、版が違えば同じ id を
// 名乗りうる)。
```

を次に替える:

```
// キーは `id` 単体ではなく `templateId/id` の対で持つ(`NoteBubble.vue` の `entryKey` と同じ
// 理由。投稿 id の一意性は版インスタンスのファイルの中でだけ約束されている)。
```

`editor/web/src/features/editor/NoteBubble.vue` 40〜45 行:

```
// キー・比較は `id` 単体ではなく `templateId/id` の対で行う。旧形式ファイルの遅延変換
// (`server/src/files/notesFile.ts` の `normalizeStored`)は `legacy:<pathKey>` を id に
// 使うため、ファイル(= 版インスタンス)が違えば同じ pathKey を持つ投稿が同じ id を名乗り
// うる。表示は今は自版のスレッドに閉じているが、`templateId` を含めておけば他ファイル由来の
// 投稿が並ぶ表示に変わっても id 衝突で 2 件を同時に編集モードへ開くことはない。
```

を次に替える:

```
// キー・比較は `id` 単体ではなく `templateId/id` の対で行う。投稿 id の一意性はファイル
// (= 版インスタンス)の中でだけ約束されている(`server/src/repositories/noteRepo.ts` の `locate` も
// ファイル単位で探す)。表示は今は自版のスレッドに閉じているが、`templateId` を含めておけば
// 他ファイル由来の投稿が並ぶ表示に変わっても、id の重なりで 2 件を同時に編集モードへ開かない。
```

`editor/shared/src/schemas.ts` 599 行の `description: '投稿 ID(UUID。旧形式からの変換分は \`legacy:<pathKey>\`)'` を `description: '投稿 ID(UUID)'` に替える。

`openapi.json` を作り直す:

Run: `pnpm --filter @editor/shared run build && pnpm --filter server run openapi:gen`
Run: `git diff --stat editor/server/openapi/openapi.json`
Expected: 1 ファイル・1 行の追加と 1 行の削除（`"description": "投稿 ID(UUID)"`）

`docs/editor/src/設計正典.md` の中核原則のコメントの段落:

- 「メモ 1 種類。旧データ・旧クライアントの `kind` は読み取りで捨てる)。返信は同じパーツの」を「メモ 1 種類)。返信は同じパーツの」に替える。
- 「そのテンプレの全コメントが保存不能になる)。旧形式(1 パーツ 1 件)と 2 属性を持たない投稿は\n  読み取り時に既定値(open / null)を補って読む(ID は `legacy:<pathKey>` 固定)。」の 2 行を次に替える:

```
  そのテンプレの全コメントが保存不能になる)。2 属性を持たない投稿は読み取り時に既定値
  (open / null)を補って読み、`pathKey` の値が配列でなければ読み捨てる。
```

`notes.entryId.test.ts` を削る:

Run: `git rm -q editor/server/test/notes.entryId.test.ts`

- [ ] **Step 7: テストが通ることを確認する**

Run: `pnpm exec vitest run editor/server/test/notesFile.thread.test.ts editor/server/test/noteRepo.test.ts editor/server/test/notesFile.test.ts editor/server/test/notes.routes.test.ts editor/server/test/notes.limits.test.ts editor/server/test/openapiArtifact.guard.test.ts editor/web/test/noteRepo.dom.test.ts`
Expected: PASS

Run: `git grep -n "legacy:" -- editor ':!*.html'`
Expected: 出力なし

Run: `pnpm typecheck:editor && pnpm run check:canon-summary`
Expected: 成功（変えた段落は要約の検査対象の節ではない）

- [ ] **Step 8: 整形してコミット**

Run: `pnpm exec biome check --write editor/server/src/files/notesFile.ts editor/web/src/api/local/noteRepo.ts editor/web/src/features/editor/comments/CommentPanel.vue editor/web/src/features/editor/NoteBubble.vue editor/shared/src/schemas.ts editor/server/test/notesFile.thread.test.ts editor/server/test/noteRepo.test.ts editor/web/test/noteRepo.dom.test.ts`
Expected: エラーなし

```bash
git add editor/server/src/files/notesFile.ts editor/web/src/api/local/noteRepo.ts editor/web/src/features/editor/comments/CommentPanel.vue editor/web/src/features/editor/NoteBubble.vue editor/shared/src/schemas.ts editor/server/openapi/openapi.json editor/server/test/notesFile.thread.test.ts editor/server/test/noteRepo.test.ts editor/web/test/noteRepo.dom.test.ts "docs/editor/src/設計正典.md"
git commit -m "refactor(editor): 旧形式メモの変換と kind の読み捨てを外し、配列でない値は読み捨てる"
```

（`notes.entryId.test.ts` の削除は Step 6 の `git rm` でステージ済み。）

---

### Task 5: 保留（`held`）の申請を `pending` へ読み替える処理を外す

対応する設計: 6.4 の 2 点目、6.7.6（`reviews.test.ts`・`localReviewRepo.dom.test.ts`、「reviews の `held` は 1 件ずつ読み飛ばして一覧全体は落とさない」）。

**Files:**
- Modify: `editor/server/src/files/reviewFiles.ts`（import と 46〜62 行の `readReviewMeta`）
- Modify: `editor/web/src/api/local/reviewRepo.ts`（import と 36〜51 行の `readReviews`）
- Modify: `editor/server/test/reviews.test.ts`（243〜274 行）
- Modify: `editor/web/test/localReviewRepo.dom.test.ts`（23〜57 行）
- Modify: `docs/editor/src/設計正典.md`（中核原則の承認タブの段落。410〜411 行）
- Modify: `docs/editor/src/設計書.md`（528 行）

`held` の残りの扱い（`git grep -n "held\|heldBy" -- editor ':!*.html'`）: `editor/server/src/vivliostyle/egressGuard.ts` の `held`（待ち受けを保持する配列の変数名）は別の意味なので残す。`editor/shared/test/review.test.ts` 30・41 行（`ReviewStatus` が `held` を受けない・`heldBy` が無い）は現行の契約のテストなので残す。`docs/editor/src/設計正典.md` の却下済み設計「申請の保留（`held`）」と、`設計書.md` の改訂履歴 2.5 行は残す。

**Interfaces:**
- Changes: `reviewFiles.ts` の内部関数 `readReviewMeta(reqId: string): Promise<ReviewRequestMeta | null>` — `status` が `ReviewStatus` の外なら警告ログ（申請ごとにプロセスで 1 回。モジュール内の `warnedUnknownStatus: Set<string>`）を出して `null`。`readReview` / `listReviewMetas` / `updateReviewMeta` / `countPendingReviews` はこれ経由で同じ扱いになる（単件は「見つからない」）。
- Changes: web `readReviews(): Record<string, ReviewRequest>` — `status` が 3 状態の外の申請を含めない。

- [ ] **Step 1: 開発用データに保留の申請が無いことを確かめる（読むだけ）**

Run: `grep -l '"status": *"held"' /c/Users/caads/editor-data/reviews/*/meta.json 2>/dev/null | wc -l`
Expected: `0`（1 以上なら外さずに止めて報告する）

- [ ] **Step 2: 失敗するテストを書く**

`editor/server/test/reviews.test.ts` の vitest の import に `vi` を足す（`import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';`）。

`editor/server/test/reviews.test.ts` の `describe('旧 held 申請の読み取り', …)`（243〜274 行）を次に替える:

```ts
  describe('現行の 3 状態の外にある申請', () => {
    /** 申請の meta.json の status だけを書き換える(旧い保留の申請が残った状態を作る)。 */
    const markHeld = (id: string) => {
      const metaPath = path.join(tmp, 'reviews', id, 'meta.json');
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(metaPath, JSON.stringify({ ...raw, status: 'held', heldBy: 'approver1' }));
    };

    it('status が held の申請は 1 件ずつ読み飛ばし、他の申請の一覧は落とさない', async () => {
      const held = await submit('AM01_141414_20250101_交付版', '141414', '<p>旧保留</p>');
      const kept = await submit('AM01_161616_20250101_交付版', '161616', '<p>残る</p>');
      markHeld(held.id);
      const files = await import('../src/files/reviewFiles.js');
      const ids = (await files.listReviewMetas()).map((m) => m.id);
      expect(ids).toContain(kept.id);
      expect(ids).not.toContain(held.id);
      expect(await files.readReview(held.id)).toBeNull();
    });

    it('読み飛ばしの警告は申請ごとに 1 回だけ出す(一覧を開くたびにログを埋めない)', async () => {
      const held = await submit('AM01_171717_20250101_交付版', '171717', '<p>旧保留</p>');
      markHeld(held.id);
      const files = await import('../src/files/reviewFiles.js');
      const { logger } = await import('../src/logger.js');
      const spy = vi.spyOn(logger, 'warn');
      try {
        await files.listReviewMetas();
        await files.listReviewMetas();
        const forHeld = spy.mock.calls.filter(
          (c) => (c[0] as { reqId?: string } | undefined)?.reqId === held.id,
        );
        expect(forHeld).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('status が held の申請は承認できず、見つからない扱いになる', async () => {
      const meta = await submit('AM01_151515_20250101_交付版', '151515', '<p>旧保留→承認</p>');
      markHeld(meta.id);
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'not_found',
      });
    });
  });
```

`editor/web/test/localReviewRepo.dom.test.ts` の `describe('localReviewRepo の旧 held 申請', …)`（23〜57 行）を次に替える:

```ts
describe('localReviewRepo の現行の 3 状態の外にある申請', () => {
  it('held で残る申請は読み飛ばし、他の申請は一覧に出す', async () => {
    await loginAdmin();
    const listed = await localTemplateRepo.listTemplates({});
    const [t1, t2] = isOk(listed) ? listed.value : [];
    expect(t2).toBeDefined();
    if (!t1 || !t2) return;
    const submit = (t: typeof t1) =>
      localReviewRepo.submitReview({
        templateId: t.id,
        fundCode: t.attributes.fundCode,
        origin: 'edit',
        html: `<div>${t.id}</div>`,
        css: '',
      });
    const a = await submit(t1);
    const b = await submit(t2);
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;

    const all = JSON.parse(localStorage.getItem(K.reviews) ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    all[a.value.id] = { ...all[a.value.id], status: 'held', heldBy: 'x' };
    localStorage.setItem(K.reviews, JSON.stringify(all));

    const list = await localReviewRepo.listReviews({});
    expect(isOk(list)).toBe(true);
    const ids = isOk(list) ? list.value.map((m) => m.id) : [];
    expect(ids).toContain(b.value.id);
    expect(ids).not.toContain(a.value.id);
    const got = await localReviewRepo.getReview(a.value.id);
    expect(isErr(got) && got.error.kind).toBe('not_found');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm exec vitest run editor/server/test/reviews.test.ts editor/web/test/localReviewRepo.dom.test.ts`
Expected: FAIL（`held` が `pending` として一覧に出る・承認できる）

- [ ] **Step 4: 実装する**

`editor/server/src/files/reviewFiles.ts`:

- import 群に `import { ReviewStatus } from '@editor/shared/schemas';` を足す（`@editor/shared` の import の直後。biome の並びに従う）。
- `readReviewMeta` の JSDoc と関数（46〜62 行）を次に替える:

```ts
/**
 * 状態が不明で読み飛ばした申請の id。一覧は開くたびに全件を読むので、警告は申請ごとに
 * プロセスで 1 回だけ出す(同じ警告でログを埋めない)。
 */
const warnedUnknownStatus = new Set<string>();

/**
 * 申請メタを読む。無ければ null(モジュール内部ヘルパ)。
 *
 * `status` が現行の 3 状態(`ReviewStatus`)の外にあるメタは読み飛ばし(null)、警告ログに残す。
 * 応答のスキーマに合わない 1 件のために一覧全体を落とさないため。単件の読み取りでは
 * 「見つからない」になる。
 */
async function readReviewMeta(reqId: string): Promise<ReviewRequestMeta | null> {
  const raw = await fs.readFile(metaPath(reqId), 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as ReviewRequestMeta;
  if (!ReviewStatus.safeParse(parsed.status).success) {
    if (!warnedUnknownStatus.has(reqId)) {
      warnedUnknownStatus.add(reqId);
      logger.warn({ reqId, status: parsed.status }, '申請の状態が不明なため読み飛ばしました');
    }
    return null;
  }
  return parsed;
}
```

`editor/web/src/api/local/reviewRepo.ts`:

- `@editor/shared` の import に `type ReviewStatus,` を足す（`type ReviewRequest,` の次。並びは biome に従う）。
- `readReviews` の JSDoc と関数（36〜51 行）を次に替える:

```ts
const REVIEW_STATUSES: ReadonlySet<string> = new Set<ReviewStatus>([
  'pending',
  'approved',
  'rejected',
]);

/**
 * 保存済みの申請を読む。`status` が現行の 3 状態の外にある申請は読み飛ばす(server の
 * `reviewFiles.readReviewMeta` と同じ規則。1 件のために一覧全体を落とさない)。書き戻しは
 * この戻り値から組むので、読み飛ばした申請は次の書き込みで消える。
 */
function readReviews(): Record<string, ReviewRequest> {
  const raw = read<Record<string, ReviewRequest>>(K.reviews, {});
  const out: Record<string, ReviewRequest> = {};
  for (const [id, r] of Object.entries(raw)) {
    if (REVIEW_STATUSES.has(r.status)) out[id] = r;
  }
  return out;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm exec vitest run editor/server/test/reviews.test.ts editor/server/test/reviews.routes.test.ts editor/server/test/reviews.metaFailure.test.ts editor/server/test/reviewFiles.scan.test.ts editor/web/test/localReviewRepo.dom.test.ts editor/shared/test/review.test.ts`
Expected: PASS

Run: `git grep -n "heldBy\|holdComment\|'held'" -- editor/server/src editor/web/src editor/shared/src`
Expected: 出力なし

- [ ] **Step 6: 文書を直す**

`docs/editor/src/設計正典.md` の承認タブの段落の「（保留は撤去。旧 `held` は読み取りで `pending` に\n  正規化する）」を次に替える（行の折り返しは前後に合わせる）:

```
（保留は撤去。3 状態の外（旧 `held` など）の申請は
  1 件ずつ読み飛ばし、一覧全体は落とさない）
```

`docs/editor/src/設計書.md` 528 行の「旧い `meta.json` に残る `held` はサーバの読み取り（`reviewFiles.readReviewMeta`）で `pending` に正規化し、`heldBy` / `heldAt` / `holdComment` は読み捨てる。」を次に替える:

```
`status` が 3 状態の外（`held` など）にある申請は、サーバの読み取り（`reviewFiles.readReviewMeta`）が 1 件ずつ読み飛ばし（警告ログに残す）、一覧全体は落とさない。単件では「見つからない」になる。web の local 版（`api/local/reviewRepo.ts`）も同じ。
```

Run: `pnpm typecheck:editor && pnpm run check:canon-summary`
Expected: 成功

- [ ] **Step 7: 整形してコミット**

Run: `pnpm exec biome check --write editor/server/src/files/reviewFiles.ts editor/web/src/api/local/reviewRepo.ts editor/server/test/reviews.test.ts editor/web/test/localReviewRepo.dom.test.ts`
Expected: エラーなし

```bash
git add editor/server/src/files/reviewFiles.ts editor/web/src/api/local/reviewRepo.ts editor/server/test/reviews.test.ts editor/web/test/localReviewRepo.dom.test.ts "docs/editor/src/設計正典.md" "docs/editor/src/設計書.md"
git commit -m "refactor(editor): 保留(held)の申請を pending へ読み替える処理を外し、3 状態の外の申請は 1 件ずつ読み飛ばす"
```

---

### Task 6: ブラウザ保存領域の旧キーの後片付けを外す

対応する設計: 6.4 の 3 点目、6.7.6（`auth.store.dom.test.ts`・`stores/auth.ts`・`lib/storageKeys.ts` の旧キー定数）。

**Files:**
- Modify: `editor/web/src/lib/storageKeys.ts`（36〜42 行 `LEGACY_NOTES_KEY`、51〜53 行 `UNDO_STACKS_PREFIX_V1`、61〜62 行 `LEGACY_UNDO_STACKS_KEY`、85〜89 行 `legacyUndoStacksKeyV1`）
- Modify: `editor/web/src/api/local/store.ts`（import 25〜27 行、`WORKING_KEYS` 170〜172 行）
- Modify: `editor/web/src/stores/auth.ts`（import 21〜22 行、`logout` 97〜102 行）
- Modify: `editor/web/test/auth.store.dom.test.ts`
- Modify: `docs/editor/src/設計正典.md`（却下済み設計「旧 Undo ミラーを正規化で救う」）
- Modify（git 管理外・ステージしない）: `.claude/rules/design-canon-summary.md`（sha の貼り直しだけ）

旧キーの残りの扱い（`git grep -n -E "LEGACY_NOTES_KEY|LEGACY_UNDO_STACKS_KEY|legacyUndoStacksKeyV1|UNDO_STACKS_PREFIX_V1|'editor:notes'" -- editor`）: 上の 4 ファイルとテストだけ。`editor/web/test/editorSession.dom.test.ts` 357〜364 行の `'editor:session:undo:local'`（旧形式のミラーを読まないことのテスト）は、互換処理ではなく現行の読み取りの性質なので残す。`storageKeys.ts` の `K.notes` のコメント（`:v2` の意味）は残す。

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/auth.store.dom.test.ts`:

- `@/lib/storageKeys` の import から `LEGACY_UNDO_STACKS_KEY,` と `legacyUndoStacksKeyV1,` を削る。
- `describe('useAuthStore.logout()', …)` を次に替える:

```ts
describe('useAuthStore.logout()', () => {
  it('Undo ミラー・下書き所属・authEpoch・sample cache を消す', async () => {
    const store = setupStore();
    await store.login('admin', 'admin');
    localStorage.setItem(undoStacksKey(), '{}');
    localStorage.setItem(draftOwnerKey(), '{}');
    sessionStorage.setItem('editor:sample:510037', '{}');
    const key = undoStacksKey();
    await store.logout();
    expect(store.user).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(draftOwnerKey())).toBeNull();
    expect(localStorage.getItem('editor:authEpoch')).toBeNull();
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
  });

  it('旧形式の Undo ミラーのキーには触らない(読まれないだけで害はない)', async () => {
    const store = setupStore();
    await store.login('admin', 'admin');
    localStorage.setItem('editor:session:undo', '{}');
    await store.logout();
    expect(localStorage.getItem('editor:session:undo')).toBe('{}');
  });
});

describe('storageKeys', () => {
  it('旧キーの定数を持たない', async () => {
    const keys = await import('@/lib/storageKeys');
    for (const name of ['LEGACY_NOTES_KEY', 'LEGACY_UNDO_STACKS_KEY', 'legacyUndoStacksKeyV1']) {
      expect(name in keys).toBe(false);
    }
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run editor/web/test/auth.store.dom.test.ts`
Expected: FAIL（logout が `editor:session:undo` を消す、旧キーの定数が残っている）

- [ ] **Step 3: 実装する**

`editor/web/src/lib/storageKeys.ts`:

- `/**\n * \`:v2\` 形式化(スレッド化)より前の旧メモキー。…` で始まる JSDoc と `export const LEGACY_NOTES_KEY = 'editor:notes';`（36〜42 行）を削る。
- 次の 3 行を削る:

```ts
// v2 より前のミラー。自動 id と protectedCss が snapshot に混入しており、読み込むと確定版との
// 内容比較が永久に外れる。後片付け(logout / スキーマ bump)でのみ参照する。
const UNDO_STACKS_PREFIX_V1 = 'editor:session:undo';
```

- 次の 2 行（と直前の空行）を削る:

```ts
/** ユーザー非分離だった旧形式キー。後片付け(logout / スキーマ bump)でのみ参照する。 */
export const LEGACY_UNDO_STACKS_KEY = UNDO_STACKS_PREFIX_V1;
```

- 次の 4 行（と直前の空行）を削る:

```ts
/** 現在のユーザー向け v1 ミラーキー(後片付け用)。 */
export function legacyUndoStacksKeyV1(): string {
  return `${UNDO_STACKS_PREFIX_V1}:${userScope()}`;
}
```

`editor/web/src/api/local/store.ts`:

- `@/lib/storageKeys` の import から `LEGACY_NOTES_KEY,`・`LEGACY_UNDO_STACKS_KEY,`・`legacyUndoStacksKeyV1,` を削る。
- `WORKING_KEYS` から次の 3 行を削る:

```ts
  LEGACY_NOTES_KEY, // `:v2`(スレッド化)より前の旧キー。移行時に一覧から漏れていた孤立データ
  LEGACY_UNDO_STACKS_KEY,
  legacyUndoStacksKeyV1(),
```

（スキーマ版 `SCHEMA_VERSION` は上げない。消す対象を減らすだけで、保存形式は変わらない。）

`editor/web/src/stores/auth.ts`:

- `@/lib/storageKeys` の import から `LEGACY_UNDO_STACKS_KEY,` と `legacyUndoStacksKeyV1,` を削る。
- `logout` の次の 5 行:

```ts
    // Undo ミラーは端末に残るため、現行キーと旧形式キーを消してから scope を落とす
    // (残すと次の利用者の画面へ前の利用者の編集内容が復元されうる)。
    localStorage.removeItem(undoStacksKey());
    localStorage.removeItem(LEGACY_UNDO_STACKS_KEY);
    localStorage.removeItem(legacyUndoStacksKeyV1());
```

を次に替える:

```ts
    // Undo ミラーは端末に残るため、現在のユーザーのキーを消してから scope を落とす
    // (残すと次の利用者の画面へ前の利用者の編集内容が復元されうる)。
    localStorage.removeItem(undoStacksKey());
```

`docs/editor/src/設計正典.md` の却下済み設計の次の 3 行:

```
- **旧 Undo ミラーを正規化で救う**: しない。明示属性化した自動 id はテンプレ由来 id と
  判別できないため、`:v1` 以前のミラーは読み込まず後片付け（logout / スキーマ bump）だけの
  対象にする。
```

を次に替える:

```
- **旧 Undo ミラーを正規化で救う**: しない。明示属性化した自動 id はテンプレ由来 id と
  判別できないため、`:v2` より前のミラーは読み込まない（後片付けもしない。端末に残っても
  読まれないだけで害はない）。
```

Run: `pnpm run check:canon-summary -- --update`
Expected: editor の却下済み設計の sha を書き戻した旨の警告（要約の 9 番の文言は変えない）

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run editor/web/test/auth.store.dom.test.ts editor/web/test/editorSession.dom.test.ts editor/web/test/restBundle.guard.test.ts`
Expected: PASS

Run: `git grep -n -E "LEGACY_NOTES_KEY|LEGACY_UNDO_STACKS_KEY|legacyUndoStacksKeyV1|UNDO_STACKS_PREFIX_V1" -- editor`
Expected: 出力なし

Run: `pnpm typecheck:editor && pnpm run check:canon-summary`
Expected: 成功

- [ ] **Step 5: 整形してコミット**

Run: `pnpm exec biome check --write editor/web/src/lib/storageKeys.ts editor/web/src/api/local/store.ts editor/web/src/stores/auth.ts editor/web/test/auth.store.dom.test.ts`
Expected: エラーなし

```bash
git add editor/web/src/lib/storageKeys.ts editor/web/src/api/local/store.ts editor/web/src/stores/auth.ts editor/web/test/auth.store.dom.test.ts "docs/editor/src/設計正典.md"
git commit -m "refactor(editor): ブラウザ保存領域の旧キー(旧メモ・v1 の Undo ミラー)の後片付けを外す"
```

---

### Task 7: offline の setup で PATH 上の python が 3.13 かを確かめる

対応する設計: 6.1 の offline の点、6.6 の 2・3 点目、6.7.6 の「offline の確認」。

6.6 の 3 点目（前回見送った 2 件）はコードの変更が要らないことを確かめるだけ: `editor/scripts/offline/python-wheelhouse.ps1` 54・60 行が `& python -m pip …` で既定（PATH 上の python）と揃っている（読んで確認済み）。`LOCALAPPDATA` の件は py ランチャを使わなくなるので対象外。

**Files:**
- Modify: `offline/lib/verify.ps1`（224〜257 行）
- Modify: `offline/lib/verify.Tests.ps1`（434〜456 行）
- Modify: `offline/setup-offline.ps1`（101〜103 行）
- Modify: `editor/OFFLINE.md`（36 行）

**Interfaces:**
- Produces: `function Get-NativeOutput { param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @()) }` — `[pscustomobject]@{ ExitCode = <int>; Output = <標準出力を改行で連結して Trim した文字列> }`
- Produces: `function Test-Python313OnPath { param([scriptblock]$Invoke) }` — 終了コード 0 で `Output` が `3.13` なら `$null`、それ以外は案内文。`$Invoke` は `ExitCode` と `Output` を持つオブジェクトを返す。
- Removes: `Test-Python313Launcher`、`Get-NativeExitCode`（参照は `verify.ps1`・`verify.Tests.ps1`・`setup-offline.ps1` だけ。`git grep` で確認済み）

- [ ] **Step 1: 失敗するテストを書く**

`offline/lib/verify.Tests.ps1` の `Describe 'Test-Python313Launcher（py -3.13 が起動できるか）' { … }`（434〜456 行）を次に替える:

```powershell
Describe 'Test-Python313OnPath（PATH 上の python が 3.13 か）' {
  It '終了コード 0 で版が 3.13 なら null（案内なし）' {
    ($null -eq (Test-Python313OnPath -Invoke { [pscustomobject]@{ ExitCode = 0; Output = '3.13' } })) | Should Be $true
  }
  It 'python が無い・Store の偽物(9009)なら、Python 3.13 を PATH に通すよう案内し、終了コードを添える' {
    $msg = Test-Python313OnPath -Invoke { [pscustomobject]@{ ExitCode = 9009; Output = '' } }
    $msg | Should Match 'Python 3\.13 を入れ、ユーザー環境変数 PATH に通してください'
    $msg | Should Match '終了コード: 9009'
  }
  It '版が 3.13 でなければ、その版を添えて同じ案内を出す' {
    $msg = Test-Python313OnPath -Invoke { [pscustomobject]@{ ExitCode = 0; Output = '3.12' } }
    $msg | Should Match 'ユーザー環境変数 PATH に通してください'
    $msg | Should Match '版が 3\.12'
  }
  It '版は標準出力から読み、stderr を出して失敗しても Stop のもとで例外にならない' {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Stop'
    try {
      $r = Get-NativeOutput -Command 'cmd.exe' -Arguments @('/c', 'echo 3.13& echo err 1>&2& exit 3')
    } finally { $ErrorActionPreference = $prev }
    $r.ExitCode | Should Be 3
    $r.Output | Should Be '3.13'
  }
  It 'setup-offline.ps1 がこの確認を呼び、py ランチャの確認は残っていない' {
    $setup = [IO.File]::ReadAllText((Join-Path $repoRoot 'offline\setup-offline.ps1'), [Text.Encoding]::UTF8)
    $setup | Should Match 'Test-Python313OnPath'
    $setup | Should Not Match 'Test-Python313Launcher'
    (Get-Command Test-Python313Launcher -ErrorAction SilentlyContinue) | Should BeNullOrEmpty
    (Get-Command Get-NativeExitCode -ErrorAction SilentlyContinue) | Should BeNullOrEmpty
  }
}
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm run ci:offline`
Expected: FAIL（`Test-Python313OnPath` と `Get-NativeOutput` が無い）

- [ ] **Step 3: 実装する**

`offline/lib/verify.ps1` の `# ── 前提ツールの確認: py -3.13 ──` から末尾の `Test-Python313Launcher` の閉じ括弧まで（224〜257 行）を次に替える:

```powershell
# ── 前提ツールの確認: PATH 上の python が 3.13 か ──
# editor の作成タブ（テンプレ生成器）は既定で PATH 上の `python` を版を指定せずに起動する。
# 3.13 でない・起動できない（Microsoft Store の偽物 WindowsApps\python.exe は終了コード 9009）端末は、
# setup が成功しても最初の「新規作成」まで気づかないので、setup の時点で案内する。止めはしない
# （生成を使わない運用もある）。

# ネイティブコマンドを実行して終了コードと標準出力を返す。stderr は $ErrorActionPreference='Stop' の
# もとで NativeCommandError になり（リダイレクトされたホストで顕著）、setup が止まる。「警告するだけで
# 止めない」ための確認なので、呼ぶ区間だけ設定を緩め、finally で必ず戻す（content-key.ps1 と同じ作法）。
function Get-NativeOutput {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $Command @Arguments 2>$null)
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output   = (($out | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
  } finally { $ErrorActionPreference = $prevEap }
}

# -Invoke は ExitCode と Output（標準出力）を持つオブジェクトを返すスクリプトブロック（テストで差し替える）。
# 既定は PATH 上の python の有無を Get-Command で見てから版を出させる（無い端末で例外にしない）。
function Test-Python313OnPath {
  param(
    [scriptblock]$Invoke = {
      if (-not (Get-Command 'python' -CommandType Application -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ ExitCode = 9009; Output = '' }
      }
      return (Get-NativeOutput -Command 'python' -Arguments @('-c', "import sys; print('%d.%d' % sys.version_info[:2])"))
    }
  )
  $r = & $Invoke
  if ($r.ExitCode -eq 0 -and $r.Output -eq '3.13') { return $null }
  $state = if ($r.ExitCode -ne 0) { "起動できません。終了コード: $($r.ExitCode)" } else { "版が $($r.Output) です" }
  return ("Python 3.13 を入れ、ユーザー環境変数 PATH に通してください（PATH 上の python: $state）。" +
    'editor の作成タブ（テンプレ生成）が使います。WindowsApps の python より前に置き、' +
    '設定後は新しいコマンドプロンプトから起動し直してください。')
}
```

`offline/setup-offline.ps1` の次の 3 行:

```powershell
# editor の作成タブと docs のビルドが使う Python の確認（止めずに案内だけ出す）。
$pyNote = Test-Python313Launcher
if ($pyNote) { Write-Warning "[warn] $pyNote" } else { Write-Host '[info] py -3.13 を確認しました。' }
```

を次に替える:

```powershell
# editor の作成タブ（テンプレ生成器）が使う PATH 上の Python の確認（止めずに案内だけ出す）。
$pyNote = Test-Python313OnPath
if ($pyNote) { Write-Warning "[warn] $pyNote" } else { Write-Host '[info] PATH 上の python が 3.13 であることを確認しました。' }
```

`editor/OFFLINE.md` 36 行 `- **Python 3.13 と py ランチャ**（`/api/generate` の生成器を `py -3.13` で起動する。テスト用の偽の生成器は標準ライブラリのみ）` を次に替える:

```
- **Python 3.13（ユーザー環境変数 PATH に通す）**（`/api/generate` の生成器を PATH 上の `python` で起動する。setup が版を確かめ、3.13 でなければ警告する。PATH の設定方法は運用手順書 3.2 節。テスト用の偽の生成器は標準ライブラリのみ）
```

3 つの `.ps1` は UTF-8 BOM・CRLF を保つ。Edit で LF になった場合に備えて揃え直す:

Run: `py -3.13 -c "import pathlib,sys; [pathlib.Path(p).write_bytes(pathlib.Path(p).read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')) for p in sys.argv[1:]]" offline/lib/verify.ps1 offline/lib/verify.Tests.ps1 offline/setup-offline.ps1`

Run: `file offline/lib/verify.ps1 offline/lib/verify.Tests.ps1 offline/setup-offline.ps1`
Expected: 3 つとも `UTF-8 (with BOM) text, with CRLF line terminators`

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm run ci:offline`
Expected: PASS（差し替えた 5 件を含め全件）

Run（PowerShell）: `. .\offline\lib\verify.ps1; Test-Python313OnPath`
Expected: 何も出ない（この端末は PATH 上の python が 3.13.15 = `$null`）

Run: `pnpm run check:comments`
Expected: 成功

- [ ] **Step 5: コミット**

```bash
git add offline/lib/verify.ps1 offline/lib/verify.Tests.ps1 offline/setup-offline.ps1 editor/OFFLINE.md
git commit -m "feat(offline): setup の Python の確認を PATH 上の python が 3.13 かへ改め、版を標準出力から読む"
```

---

### Task 8: `init-data-repo` の初回コミットを確定領域に絞り、HEAD の無い `.git` と `GIT_BIN` に対応する

対応する設計: 6.7.2 の 2 点目、6.8.1、6.8.2（6.7.4「足りないフォルダ」の前提）。

**Files:**
- Modify: `editor/scripts/init-data-repo.ps1`（全体を置き換える。UTF-8 BOM・LF）
- Create: `editor/scripts/init-data-repo.Tests.ps1`（UTF-8 BOM。Pester 3/4 書式）
- Modify: `docs/editor/src/デプロイ運用手順書.md`（3.1 節の手順 3）

**Interfaces:**
- Produces（スクリプト内）: `Invoke-Git`（`$ErrorActionPreference = 'Continue'` で包み、終了コード非 0 で stderr を載せて throw）、`Test-GitHead`（HEAD があれば `$true`）、`Get-CommittedPathspecs`（`templates` `filled` `css` `sync` `.gitignore` `.gitattributes` のうち、ファイルがあるもの。`css` は `css\fonts` の外にファイルがあるときだけ）
- 振る舞い: `.git` 無し → `git init` して初回コミット。`.git` あり・HEAD 無し → そのまま初回コミット。HEAD あり → git に触らない。`.gitignore` は無ければ書き、あれば足りない必須行だけを足す。`.gitattributes` はサーバの `ensureGitattributes` と同じ形（先頭 `* text eol=lf`、`* text=lf` を落とし他の行は残す、BOM 無し・LF）に揃える。初回コミットは `git add -A -- <確定領域> ':(exclude)css/fonts'`、作者 `system`。

- [ ] **Step 1: 失敗するテストを書く**

`editor/scripts/init-data-repo.Tests.ps1`:

```powershell
# init-data-repo.ps1 の Pester 3/4 テスト。手で作り直した dataRoot(assets・js・images・notes・
# css\fonts が残っている)を一時フォルダに作り、初回コミットが確定領域だけになること、
# HEAD の無い .git へ初回コミットを足すこと、履歴があれば git に触らないこと、GIT_BIN を使うことを
# 確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'init-data-repo.ps1'

# 実データへ触れないよう DATA_ROOT と GIT_BIN を退避して空にし、-DataRoot は呼び出し側が必ず渡す。
# $extraEnv のキーは $names のどれか(終わったら元へ戻す)。
function Invoke-Init([hashtable]$params, [hashtable]$extraEnv) {
  $names = 'DATA_ROOT', 'GIT_BIN'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  if ($extraEnv) { foreach ($k in $extraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $extraEnv[$k]) } }
  try { & $script @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}

function New-Root { Join-Path $env:TEMP ('init-data-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }

function New-HandMadeContent([string]$root) {
  foreach ($d in 'templates', 'css\fonts', 'assets\fonts', 'js', 'images', 'notes') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<p>t</p>' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '.a{}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'FONT' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'assets\fonts\b.woff2') -Value 'OLD' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'notes\T1.json') -Value '{}' -NoNewline
}

function Get-Tracked([string]$root) { (@(git -C $root ls-files) | Sort-Object) -join ',' }

$expectedTracked = '.gitattributes,.gitignore,css/510037.css,templates/T1.html'

Describe 'init-data-repo.ps1' {
  It '新規の dataRoot では置き場をすべて作り、確定領域だけを初回コミットに入れる' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      Invoke-Init @{ DataRoot = $root } | Out-Null
      foreach ($d in 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes', 'js', 'images') {
        Test-Path (Join-Path $root $d) | Should Be $true
      }
      Get-Tracked $root | Should Be $expectedTracked
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (Get-Content (Join-Path $root '.gitattributes')) -contains '* text eol=lf' | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '.git はあるが履歴(HEAD)が無ければ、確定領域だけで初回コミットを作る' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      Get-Tracked $root | Should Be $expectedTracked
      @(git -C $root rev-list HEAD).Count | Should Be 1
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴の無いリポジトリの既存の .gitignore は消さず、足りない必須行だけを足す' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/local-only/`n/notes/`n", (New-Object Text.UTF8Encoding $false))
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')))
      $lines -contains '/local-only/' | Should Be $true
      $lines -contains '/css/fonts/' | Should Be $true
      $lines -contains '/images/' | Should Be $true
      @($lines | Where-Object { $_ -eq '/notes/' }).Count | Should Be 1
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴の無いリポジトリの BOM 付き * text=lf は、* text eol=lf に揃えて初回コミットに入れる(他の行は残す)' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      $bytes = [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n*.png binary`r`n"))
      [IO.File]::WriteAllBytes((Join-Path $root '.gitattributes'), $bytes)
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      ((git -C $root show HEAD:.gitattributes) -join '|') | Should Be '* text eol=lf|*.png binary'
      (Get-Content -Encoding Byte -TotalCount 3 (Join-Path $root '.gitattributes')) -join ',' | Should Not Be '239,187,191'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴があれば git に触らず、足りないフォルダだけを作る' {
    $root = New-Root
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'templates') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<p>t</p>' -NoNewline
      git -C $root init -q
      git -C $root add -- templates
      git -C $root -c user.name=t -c user.email=t@t commit -q -m init
      $head = git -C $root rev-parse HEAD
      Invoke-Init @{ DataRoot = $root } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'images') | Should Be $true
      Test-Path (Join-Path $root '.gitignore') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'PATH に git が無くても GIT_BIN の git で初期化できる' {
    $root = New-Root
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      New-HandMadeContent $root
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Init @{ DataRoot = $root } @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      @(git -C $root rev-list HEAD).Count | Should Be 1
      Get-Tracked $root | Should Be $expectedTracked
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }
}
```

BOM を付ける（Write は BOM を付けないため）:

Run（Bash）: `p=editor/scripts/init-data-repo.Tests.ps1; { printf '\xef\xbb\xbf'; cat "$p"; } > "$p.tmp" && mv "$p.tmp" "$p" && head -c 3 "$p" | od -An -tx1`
Expected: ` ef bb bf`

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/scripts/init-data-repo.Tests.ps1 -EnableExit"`
Expected: FAIL（`git add -A` が assets・js・images・notes を記録する、HEAD の無い `.git` を飛ばす、`GIT_BIN` を使わない）

- [ ] **Step 3: 実装する**

`editor/scripts/init-data-repo.ps1` を次の内容で置き換える（先頭に UTF-8 BOM を保つ。改行は LF）:

```powershell
<#
.SYNOPSIS
  editor のテンプレ版管理用 data リポジトリ(dataRoot)を初期化する。

.DESCRIPTION
  確定保存したテンプレ(templates) とファンド別 CSS(css) を git で版管理するため、
  ワークスペースリポジトリの外に置く data リポジトリを作る(ネスト git の回避)。
  処理内容:
    1. dataRoot 配下にサーバが使う置き場をすべて作成する(templates/ filled/ css/ css/fonts/ sync/
       drafts/ pending/ reviews/ notes/ js/ images/)。サーバも必要時に作るが、
       共有フォルダへ置く運用では権限設定や目視確認のために最初から揃っている方が扱いやすい。
    2. git の履歴(HEAD)が無ければ初回コミットを作る。.git が無ければ git init から行い、
       .git はあるが HEAD が無い(git init だけした)ときは、そのリポジトリへ初回コミットを足す。
       .gitignore は無ければ書き、あれば足りない必須行だけを足す。.gitattributes はサーバと同じ形(先頭
       を * text eol=lf にし、無効な * text=lf を落とす。BOM 無し)に揃える。
       初回コミットに入れるのは、サーバの承認コミットと同じ確定領域(templates・filled・
       css(css/fonts を除く)・sync・.gitignore・.gitattributes)だけ。手で作り直した dataRoot に
       assets・js・images・notes などが残っていても記録しない。
    履歴が既にあれば git には触らない(何度流してもよい)。
  サーバは環境変数 DATA_ROOT(または appconfig.json の paths.dataRoot)でこの場所を
  参照する。drafts/ pending/ と一時ファイルは追跡しない(.gitignore)。pending/ を
  追跡しないのは整理ではなく防御の一部で、承認コミットに未承認の生成物が混ざると
  「確定領域へは承認経路からしか書けない」不変則が崩れるため。.gitattributes は
  `* text eol=lf`: text で改行正規化を有効にし eol=lf で作業ツリーも LF に固定するので、
  core.autocrlf の設定に関わらず Windows でも byte が揺れない。
  git は環境変数 GIT_BIN があればそれを使う(サーバと同じ。PATH に git が無い端末向け)。

.PARAMETER DataRoot
  data リポジトリの場所。UNC パス(\\server\share\editor-data)も指定できる。省略時は
  環境変数 DATA_ROOT(このプロセス → ユーザー環境変数の順)を使い、それも無ければ
  ワークスペースの 1 つ上の editor-data(例: C:\Users\<user>\editor-data)。いずれも
  サーバ(config.ts の dataRoot)と同じ解決で、相対パスは editor/ 基準になる。
  ユーザー環境変数まで見るのは、setx 直後の同じウィンドウでは $env: に反映されず、
  サーバ(新しいウィンドウから起動)と違う場所へ作ってしまうため。

.EXAMPLE
  editor\scripts\init-data-repo.bat
  環境変数 DATA_ROOT の場所(未設定なら既定の場所)に初期化する。

.EXAMPLE
  editor\scripts\init-data-repo.bat -DataRoot D:\editor-data
  指定した場所に初期化する。サーバ側は DATA_ROOT=D:\editor-data を設定する。

.EXAMPLE
  editor\scripts\init-data-repo.bat -DataRoot \\fileserver\share\editor-data
  ファイルサーバの共有上に初期化する。所有者が実行アカウントと異なる共有では、git が
  dubious ownership で止まるため、先に safe.directory を登録しておく。
#>
param(
  [string]$DataRoot
)

$ErrorActionPreference = 'Stop'

# このスクリプトは editor/scripts/ にあるため、2 つ上が editor/、3 つ上が
# ワークスペースの場所になる。data リポジトリの既定値はこれらを基準に解決する。
$editorDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$workspace = Split-Path -Parent $editorDir
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する。PortableGit だけの端末で PATH に
# git が無くても流せるようにするため。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $fromEnv = $env:DATA_ROOT
  $source = '環境変数 DATA_ROOT'
  if (-not $fromEnv) {
    $fromEnv = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User')
    $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if ($fromEnv) {
    # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
    $DataRoot = if ([IO.Path]::IsPathRooted($fromEnv)) { $fromEnv } else {
      [IO.Path]::GetFullPath((Join-Path $editorDir $fromEnv))
    }
  } else {
    $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'
    $source = '既定'
  }
}

Write-Host "dataRoot: $DataRoot ($source)"

function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと、
  # 出力をリダイレクトしたホストで PowerShell 5.1 がそれを例外にするので、stderr は自前で受けて
  # 終了コードで失敗を判定する。成功時の警告は捨て、失敗時だけ原因として例外メッセージへ載せる。
  $ErrorActionPreference = 'Continue'
  $all = @(& $gitExe -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function Test-GitHead {
  # HEAD が無い(git init だけした)リポジトリでは rev-parse が非 0 で終わる。それを例外にしない
  # よう、呼ぶ区間だけ設定を緩めて finally で戻す。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $gitExe -C $DataRoot rev-parse --verify -q HEAD 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $prev }
}

function Get-CommittedPathspecs {
  # サーバの承認コミット(gitRepo.ts の stageTrackedAreas と committedAreas.ts)と同じ確定領域。
  # 中身の無い置き場は渡さない(git add が pathspec の不一致で止まりうるため)。
  $fontsPrefix = (Join-Path $DataRoot 'css\fonts') + '\'
  foreach ($a in 'templates', 'filled', 'css', 'sync', '.gitignore', '.gitattributes') {
    $p = Join-Path $DataRoot $a
    if (Test-Path -LiteralPath $p -PathType Leaf) { $a; continue }
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { continue }
    $files = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force |
      Where-Object { -not $_.FullName.StartsWith($fontsPrefix, [StringComparison]::OrdinalIgnoreCase) })
    if ($files.Count -gt 0) { $a }
  }
}

# 1. ディレクトリ構成を用意する。名前は server/src/config.ts の既定と
#    notesFile.ts の notes/、gitRepo.ts の COMMITTED_PATHSPECS に合わせる。
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
$dirs = 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes',
  'js', 'images'
foreach ($d in $dirs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $d) | Out-Null
}

# 2. 履歴が無ければ初回コミットを作る(.git が無ければ init から)。
$hasGit = Test-Path -LiteralPath (Join-Path $DataRoot '.git')
if ($hasGit -and (Test-GitHead)) {
  Write-Host 'git リポジトリは既に初期化済みです(スキップ)。'
} else {
  if (-not $hasGit) { Invoke-Git init -q | Out-Null }
  # 中身は gitRepo.ts の ensureGitignore の必須行と揃える。BOM 無しで書くのは、PowerShell 5.1 の
  # -Encoding utf8 が付ける BOM で先頭行がサーバの照合に一致せず、同じ行が重複して足されるため。
  # 既にある .gitignore は消さず、足りない必須行だけを足す(手で作り直した dataRoot の設定を残す)。
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $required = '/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '/images/', '*.tmp-*'
  $ignorePath = Join-Path $DataRoot '.gitignore'
  $current = if (Test-Path -LiteralPath $ignorePath) { [IO.File]::ReadAllText($ignorePath) } else { '' }
  $lines = @($current -split "`r?`n" | ForEach-Object { $_.Trim() })
  $missing = @($required | Where-Object { $lines -cnotcontains $_ })
  if ($missing.Count -gt 0) {
    if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
    [IO.File]::WriteAllText($ignorePath, $current + (($missing -join "`n") + "`n"), $utf8NoBom)
  }
  # .gitattributes はサーバ(gitRepo.ts の ensureGitattributes)と同じ形に揃えてから記録する: 先頭を
  # `* text eol=lf` にし、無効な `* text=lf` を落とし、他の行は残す(BOM 無し・LF)。初回コミットへ
  # 無効な行や BOM を持ち込まないため。既に同じ形なら書かない。
  $attrPath = Join-Path $DataRoot '.gitattributes'
  $attrNow = if (Test-Path -LiteralPath $attrPath) { [IO.File]::ReadAllText($attrPath) } else { '' }
  $attrOthers = @($attrNow -split "`r?`n" | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne '' -and $_ -cne '* text=lf' -and $_ -cne '* text eol=lf' })
  $attrWanted = $utf8NoBom.GetBytes(((@('* text eol=lf') + $attrOthers) -join "`n") + "`n")
  $attrBytes = if (Test-Path -LiteralPath $attrPath) { [IO.File]::ReadAllBytes($attrPath) } else { [byte[]]@() }
  if ([Convert]::ToBase64String($attrBytes) -ne [Convert]::ToBase64String($attrWanted)) {
    [IO.File]::WriteAllBytes($attrPath, $attrWanted)
  }
  $specs = @(Get-CommittedPathspecs)
  Invoke-Git add -A -- @specs ':(exclude)css/fonts' | Out-Null
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '初期化: テンプレ版管理リポジトリ' | Out-Null
  if ($hasGit) {
    Write-Host '履歴(HEAD)の無い git リポジトリへ初回コミットを作成しました(確定領域だけを記録)。'
  } else {
    Write-Host 'git リポジトリを初期化し、初回コミットを作成しました。'
  }
}

Write-Host ''
Write-Host '完了しました。次の対応をしてください:'
Write-Host "  - サーバ起動時に環境変数 DATA_ROOT=$DataRoot を設定する(start.bat rest 等)。"
Write-Host '  - TortoiseGit で上記 dataRoot フォルダを開くと履歴/diff を参照できます。'
```

BOM と改行を確かめる:

Run: `head -c 3 editor/scripts/init-data-repo.ps1 | od -An -tx1; file editor/scripts/init-data-repo.ps1`
Expected: ` ef bb bf` と `Unicode text, UTF-8 (with BOM) text`（CRLF の記載なし）。BOM が無ければ Step 1 と同じ `printf` で付ける。

- [ ] **Step 4: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/scripts/init-data-repo.Tests.ps1 -EnableExit"`
Expected: PASS（6 件）

Run: `pnpm run check:comments`
Expected: 成功（`.Tests.ps1` は `.bat` 併設の対象外。BOM あり）

- [ ] **Step 5: 運用手順書を直す**

`docs/editor/src/デプロイ運用手順書.md` 3.1 節の手順 3 の末尾「何度実行してもよい。」を次に替える:

```
何度実行してもよい（履歴があれば git には触らず、足りないフォルダだけを作る）。`.git` はあるが履歴（最初のコミット）が無い場合は、確定領域（`templates`・`filled`・`css`（`css\fonts` を除く）・`sync`・`.gitignore`・`.gitattributes`）だけで初回コミットを作る。`assets`・`js`・`images`・`notes` などは記録しない。git は環境変数 `GIT_BIN` があればそれを使う。
```

- [ ] **Step 6: コミット**

```bash
git add editor/scripts/init-data-repo.ps1 editor/scripts/init-data-repo.Tests.ps1 "docs/editor/src/デプロイ運用手順書.md"
git commit -m "feat(editor): init-data-repo の初回コミットを確定領域だけに絞り、履歴の無い .git と GIT_BIN に対応する"
```

---

### Task 9: フォント移設パッチ — git まわり（GIT_BIN・履歴・取り違え・既知の形の取り込み・追跡の解除）

対応する設計: 6.7.1（フォント移設パッチ側）、6.7.2 の 1 点目（同）、6.7.4「git の場所」、6.8.4、6.8.5、6.8.1 の「パッチはそれを案内する」。

**Files:**
- Modify: `editor/patches/2026-10-fonts-to-css/migrate.ps1`（UTF-8 BOM・LF を保つ）
- Modify: `editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1`（同）

この Task の編集は、現在の `migrate.ps1`（266 行）に対する置き換え。Task 10 はこの Task の後の状態に対して編集する。

**Interfaces:**
- Produces（スクリプト内）: `$gitExe`、`ConvertTo-ProcessArgument([string]$a)`、`Invoke-GitUtf8 -GitArgs <string[]> [-AllowFailure]` → `@{ Code = <int>; Out = <UTF-8 の標準出力> }`、`Get-NormalizedText`、`Get-HeadText([string]$rel)`、`Get-WorkText([string]$rel)`、`Get-Lines`、`Test-KnownShape([string]$xy, [string]$rel)`、変数 `$absorbed`（取り込むパス）・`$trackedFiles`・`$untrackPlaces`・`$requiredIgnore`・`$rewriteRe`（定義を前へ移す）
- 終了コード: dataRoot の取り違えは `exit 2`

- [ ] **Step 1: 失敗するテストを書く**

`migrate.Tests.ps1` の `Invoke-Patch` を次に替える:

```powershell
# 実データへ触れないよう、置き場に効く環境変数と GIT_BIN を退避して空にし、APP_CONFIG を一時ファイル
# (既定は存在しないパス)へ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
# $extraEnv のキーは $names のどれか(終わったら元へ戻す)。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$appConfig, [hashtable]$extraEnv) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'TEMPLATES_DIR', 'FILLED_DIR', 'CSS_DIR', 'JS_DIR', 'IMAGES_DIR',
    'ASSETS_DIR', 'DRAFTS_DIR', 'PENDING_DIR', 'REVIEWS_DIR', 'SYNC_DIR', 'GIT_BIN'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  if (-not $appConfig) { $appConfig = Join-Path $env:TEMP 'fonts-mig-no-appconfig.json' }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', $appConfig)
  if ($extraEnv) { foreach ($k in $extraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $extraEnv[$k]) } }
  try { & $file @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}
```

`New-OldLayout` の直後に補助関数を足す:

```powershell
function Get-Message([scriptblock]$action) {
  $msg = ''
  try { & $action | Out-Null } catch { $msg = $_.Exception.Message }
  return $msg
}

function Write-Utf8([string]$path, [string]$text, [switch]$Bom) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding ([bool]$Bom)))
}

$cssRewritten = '@font-face{src:url(fonts/a.woff2)} .x{background:url(../../fonts/no.png)}'
```

既存の 2 件 `It '未コミットの変更があれば中止する'` と `It '未コミット変更で中止するときは途中停止の可能性を案内する'` を削り、`Describe 'migrate.ps1'` の末尾（最後の `It` の後）に次を足す:

```powershell
  It 'PATH に git が無くても GIT_BIN の git で流せる' {
    $root = New-OldLayout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }

  It '-DataRoot に相対パスを渡しても、今の場所を基準に解決して流せる' {
    $root = New-OldLayout
    Push-Location (Split-Path -Parent $root)
    try {
      Invoke-Patch $script @{ DataRoot = (Split-Path -Leaf $root); Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
    } finally {
      Pop-Location
      Remove-Item -Recurse -Force $root
    }
  }

  It '履歴(HEAD)の無い data リポジトリでは init-data-repo.bat を案内して中止する' {
    $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css'), (Join-Path $root 'templates') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '.a{}' -NoNewline
      git -C $root init -q
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '履歴'
      $msg | Should Match 'init-data-repo\.bat'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'templates も css も無ければ取り違えとして警告し、何も変えずに終了コード 2 で終わる' {
    $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'notes') | Out-Null
      git -C $root init -q
      git -C $root -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
      $head = git -C $root rev-parse HEAD
      $global:LASTEXITCODE = 0
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } *>&1 | Out-String
      $LASTEXITCODE | Should Be 2
      $out | Should Match 'templates も css もありません'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root '.gitignore') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: CSS の ../fonts/ → fonts/ の書き換えだけの未コミット変更は取り込んで同じコミットに含める' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') $cssRewritten
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
      (git -C $root status --porcelain -- .gitignore css templates filled sync) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: BOM 付きで書き直しただけの CSS も、BOM を除いて比べて取り込む' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') $cssRewritten -Bom
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: 書き換えに加えて末尾に改行を 1 つ足しただけの CSS も取り込む' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') ($cssRewritten + "`r`n")
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
      (git -C $root status --porcelain -- css) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: .gitignore に末尾の空白付きで /css/fonts/ を足していても、取り込んだうえで重ねて追記しない' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/ `n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')) | ForEach-Object { $_.Trim() })
      @($lines | Where-Object { $_ -eq '/css/fonts/' }).Count | Should Be 1
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: BOM 付き CRLF の * text=lf を * text eol=lf にしただけの .gitattributes は取り込む' {
    $root = New-OldLayout
    try {
      $attr = Join-Path $root '.gitattributes'
      $bytes = [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n"))
      [IO.File]::WriteAllBytes($attr, $bytes)
      git -C $root add -- .gitattributes
      git -C $root -c user.name=t -c user.email=t@t commit -q -m attr
      Write-Utf8 $attr "* text eol=lf`n"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains '.gitattributes' | Should Be $true
      (git -C $root status --porcelain -- .gitattributes) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: .gitignore に必須行(/css/fonts/・/images/)を足しただけなら取り込む' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/`n/images/`n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')))
      $lines -contains '/images/' | Should Be $true
      @($lines | Where-Object { $_ -eq '/css/fonts/' }).Count | Should Be 1
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '空のフォルダの新規作成は差分にならず、そのまま進む' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'templates\new'), (Join-Path $root 'sync') | Out-Null
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: CSS に書き換え以外の差分があれば「手作業の変更」として一覧を出し、何も変えない' {
    $root = New-OldLayout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match 'css/510037\.css'
      $msg | Should Not Match '途中で止まった'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: .gitignore に必須でない行(/other/)も足されていれば中止する' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/`n/other/`n", (New-Object Text.UTF8Encoding $false))
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '\.gitignore'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 取り込める変更と取り込めない変更が混ざっていれば、何も変えずに中止する' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') $cssRewritten
      Add-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value 'x'
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match 'templates/T1\.html'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 前回のパッチが途中で止まった形跡(移行コミットの無い assets.migrated-*)があれば、その旨を案内する' {
    $root = New-OldLayout
    try {
      $stamp = Get-Date -Format 'yyyyMMdd'
      Rename-Item -LiteralPath (Join-Path $root 'assets') -NewName "assets.migrated-$stamp"
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '途中で止まった'
      $msg | Should Match 'assets\.migrated-'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡されているフォント・画像・js は確認モードで一覧に出し、-Apply で追跡だけ外す(ファイルは残す)' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts'), (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- assets css/fonts images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'assets/fonts/a\.woff2'
      $out | Should Match 'css/fonts/b\.woff2'
      $out | Should Match 'images/510037_logo\.svg'
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- css/fonts images js assets).Count | Should Be 0
      Test-Path (Join-Path $root 'css\fonts\b.woff2') | Should Be $true
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'images\510037_logo.svg') | Should Be $true
      ((git -C $root show --name-status --format= HEAD) -join "`n") | Should Match 'D\s+assets/fonts/a\.woff2'
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }
```

既存の `It 'css\fonts に未追跡のフォントが先に置かれていても -Apply が進む'` の `Set-Content … 'css\fonts\a.woff2' …` の次の行に、`.gitignore` に `/css/fonts/` の無いまま未追跡のフォントがあっても点検の対象外であることを明示する一行を足す:

```powershell
      (Get-Content (Join-Path $root '.gitignore')) -contains '/css/fonts/' | Should Be $false
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit"`
Expected: FAIL（GIT_BIN・履歴・取り違え・既知の形・追跡の解除の各件。既存の件は PASS のまま）

- [ ] **Step 3: 実装する — GIT_BIN と UTF-8 の読み取り**

`migrate.ps1` の `$utf8NoBom = New-Object System.Text.UTF8Encoding $false` の行の直後に追加する:

```powershell
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する。PortableGit だけの端末で PATH に git が
# 無くても流せるようにするため。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
# -DataRoot の相対パスは PowerShell の今の場所を基準に絶対パスへ直す。Invoke-GitUtf8 が起動する git は
# PowerShell の今の場所を引き継がない(プロセスの作業フォルダは別)ため。
if ($DataRoot) { $DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }
```

`Invoke-Git` の中の `  $all = @(& git -C $DataRoot @args 2>&1)` を `  $all = @(& $gitExe -C $DataRoot @args 2>&1)` に替える。

`Invoke-Git` の閉じ括弧（`  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })` の次の `}`）の直後に追加する:

```powershell

function ConvertTo-ProcessArgument([string]$a) {
  # .NET Framework の ProcessStartInfo は引数を 1 本の文字列で受けるので、C ランタイムの規則で囲む
  # (空白・引用符を含む dataRoot や pathspec を 1 引数として渡すため)。
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-GitUtf8 {
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスや
  # ファイルの中身が化ける。未コミットの変更を中身で点検する読み取りは、出力を UTF-8 として自前で
  # 読む(変更を伴う git 呼び出しは Invoke-Git を使う)。
  param([Parameter(Mandatory = $true)][string[]]$GitArgs, [switch]$AllowFailure)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $gitExe
  $psi.Arguments = ((@('-C', $DataRoot) + $GitArgs) | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8NoBom
  $psi.StandardErrorEncoding = $utf8NoBom
  $proc = [Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0 -and -not $AllowFailure) {
    throw "git $($GitArgs -join ' ') が失敗しました(終了コード $($proc.ExitCode))。`n$($errTask.Result)"
  }
  return @{ Code = $proc.ExitCode; Out = $out }
}
```

- [ ] **Step 4: 実装する — 実行条件と未コミット変更の点検**

`migrate.ps1` の次の部分（現在の 132〜141 行）:

```powershell
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
# 見るのは確定領域(承認コミットの対象)だけ。js\ や assets.migrated-* のような追跡外の
# フォルダまで見ると、移行後の再実行が「未コミットの変更あり」で止まってしまう。
$dirty = Invoke-Git status --porcelain -- .gitignore .gitattributes templates filled css sync ':(exclude)css/fonts'
if ($dirty) {
  throw ("dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください。`n" +
    "前回の移行が途中で止まった可能性もあります。git -C `"$DataRoot`" diff で確認し、パッチの変更" +
    "(.gitignore の /css/fonts/ 行と ../fonts/ → fonts/ の書き換え)だけなら、system 名義でコミットして" +
    "から再実行してください:`n$($dirty -join "`n")")
}
```

を次に替える:

```powershell
# templates も css も無い場所は、dataRoot の取り違え(別のフォルダを指している)とみなす。旧構成・
# 新構成の有無では決めない — フォントを使わない正当な環境まで失敗扱いになるため。
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'templates')) -and -not (Test-Path -LiteralPath (Join-Path $DataRoot 'css'))) {
  Write-Warning ("$DataRoot に templates も css もありません。dataRoot を取り違えていないか確かめてください" +
    '(-DataRoot で指定できます)。何も変えずに終了します。')
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
if ((Invoke-GitUtf8 -GitArgs @('rev-parse', '--verify', '-q', 'HEAD') -AllowFailure).Code -ne 0) {
  throw ("$DataRoot の git には履歴(最初のコミット)がありません。editor\scripts\init-data-repo.bat -DataRoot " +
    "`"$DataRoot`" で初回コミット(確定領域だけを記録します)を作ってから再実行してください。")
}

# ── 未コミットの変更の点検 ──
# 手で dataRoot を作り直した直後は必ず未コミットの変更が残る。このパッチ・init-data-repo・サーバが
# 作るのと同じ形の変更だけなら取り込んで同じコミットに含め、それ以外が 1 つでもあれば中止する。
# 見るのは確定領域(承認コミットの対象)だけ。css/fonts は git 管理外の置き場なので除く。比べる前に
# BOM を除き、改行を LF に揃える(構築済み環境の .gitattributes・.gitignore は BOM 付き・CRLF のことがある)。
$requiredIgnore = '/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '/images/', '*.tmp-*'
$rewriteRe = '(?i)(url\(\s*["'']?)\.\./fonts/'

function Get-NormalizedText([string]$s) {
  if ($null -eq $s) { return $null }
  return $s.TrimStart([char]0xFEFF).Replace("`r`n", "`n")
}

function Get-HeadText([string]$rel) {
  $r = Invoke-GitUtf8 -GitArgs @('cat-file', '-p', "HEAD:$rel") -AllowFailure
  if ($r.Code -ne 0) { return $null }
  return Get-NormalizedText $r.Out
}

function Get-WorkText([string]$rel) {
  $p = Join-Path $DataRoot ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  return Get-NormalizedText ([IO.File]::ReadAllText($p, $utf8NoBom))
}

function Get-Lines([string]$s) {
  if ($null -eq $s) { return @() }
  return @($s.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Test-KnownShape([string]$xy, [string]$rel) {
  # 候補は「変更・追加・未追跡」だけ(削除・改名・型の変更はパッチが作らない)。
  if ($xy -notmatch '^[ MA?][ M?]$') { return $false }
  $work = Get-WorkText $rel
  if ($null -eq $work) { return $false }
  $head = Get-HeadText $rel
  if ($rel -ceq '.gitignore') {
    # 既存の行を消さず、足したのが init-data-repo・サーバの必須行だけなら同じ形。
    $before = @(Get-Lines $head)
    $after = @(Get-Lines $work)
    foreach ($l in $before) { if ($after -cnotcontains $l) { return $false } }
    foreach ($l in $after) { if ($before -cnotcontains $l -and $requiredIgnore -cnotcontains $l) { return $false } }
    return $true
  }
  if ($rel -ceq '.gitattributes') {
    # サーバ(gitRepo.ts の ensureGitattributes)と同じ直し方: 先頭を正しい行にし、旧い無効行を落とす。
    $others = @(Get-Lines $head | Where-Object { $_ -cne '* text=lf' -and $_ -cne '* text eol=lf' })
    return ((@(Get-Lines $work) -join "`n") -ceq ((@('* text eol=lf') + $others) -join "`n"))
  }
  if ($rel -cmatch '^css/[^/]+\.css$' -and $null -ne $head) {
    # 末尾の改行 1 つの有無は、エディタが保存時に足すことがあるので差分に数えない。
    $want = ($head -replace $rewriteRe, '${1}fonts/') -replace '\n\z', ''
    return (($work -replace '\n\z', '') -ceq $want)
  }
  return $false
}

$statusOut = (Invoke-GitUtf8 -GitArgs @('status', '--porcelain=v1', '-z', '--untracked-files=all', '--',
  '.gitignore', '.gitattributes', 'templates', 'filled', 'css', 'sync', ':(exclude)css/fonts')).Out
$tokens = @($statusOut.Split([char]0) | Where-Object { $_ -ne '' })
$absorbed = @()
$foreign = @()
for ($i = 0; $i -lt $tokens.Count; $i++) {
  $xy = $tokens[$i].Substring(0, 2)
  $rel = $tokens[$i].Substring(3)
  # 改名・複写は元のパスが次の要素に続く(-z の書式)。どちらもパッチは作らない。
  if ($xy[0] -eq 'R' -or $xy[0] -eq 'C') { $i++ }
  if (Test-KnownShape $xy $rel) { $absorbed += $rel; continue }
  $hint = if ($rel -match '^css/[^/]+\.(woff2?|ttf|otf)$') { '(css 直下のフォントは配信されません。css\fonts へ移してください)' } else { '' }
  $foreign += "  $xy $rel$hint"
}
if ($foreign.Count -gt 0) {
  $list = $foreign -join "`n"
  $traces = @(foreach ($n in 'index.lock', 'REVERT_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD') {
      if (Test-Path -LiteralPath (Join-Path $DataRoot ".git\$n")) { ".git\$n" }
    })
  # 移行コミットが無いのに退避名の assets があれば、前回の -Apply が改名の後で止まった形跡。
  if (-not (Invoke-Git log --author=system --grep '\[fonts-to-css\]' --format=%H -1)) {
    $traces += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  }
  if ($traces.Count -gt 0) {
    throw ("前回のパッチ(または rollback)が途中で止まった形跡があります($($traces -join ', '))。" +
      "git -C `"$DataRoot`" status で状態を確かめ、途中の操作を終えるか戻してから再実行してください。" +
      "次の未コミットの変更は、このパッチが作る形ではありません:`n$list")
  }
  throw ("手作業の変更が残っています。次の未コミットの変更は、このパッチが作る形(CSS の ../fonts/ → " +
    'fonts/ の書き換え・.gitignore への必須行の追記・.gitattributes を * text eol=lf にしただけ)ではない' +
    "ため中止しました。残すなら先にコミットし、要らなければ git -C `"$DataRoot`" checkout -- <ファイル> " +
    "で戻してから再実行してください:`n$list")
}

# 追跡されたフォント・画像・js は、承認コミットのたびに版に残り続け、次の承認者の名前で更新される。
# ファイルは残して追跡だけ外し、同じ system コミットに含める。
$trackedFiles = @((Invoke-GitUtf8 -GitArgs @('ls-files', '-z', '--', 'css/fonts', 'images', 'js', 'assets')).Out.Split([char]0) | Where-Object { $_ -ne '' })
$untrackPlaces = @('css/fonts', 'images', 'js', 'assets' | Where-Object {
    $place = $_
    @($trackedFiles | Where-Object { $_.StartsWith("$place/") }).Count -gt 0
  })
```

後ろにある重複した定義の行を消す。次の 2 行:

```powershell
$rewriteRe = '(?i)(url\(\s*["'']?)\.\./fonts/'
$confirmedCss = @(Get-ChildItem -LiteralPath $cssDir -Filter '*.css' -File -ErrorAction SilentlyContinue)
```

を次の 1 行に替える:

```powershell
$confirmedCss = @(Get-ChildItem -LiteralPath $cssDir -Filter '*.css' -File -ErrorAction SilentlyContinue)
```

- [ ] **Step 5: 実装する — 報告と適用**

`if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }` の行の直前に追加する:

```powershell
# 取り込む未コミットの変更と、追跡を外すファイル。
if ($absorbed.Count -gt 0) {
  Write-Host "取り込む未コミットの変更(このパッチと同じ形。同じコミットに含めます): $($absorbed.Count) 件"
  $absorbed | ForEach-Object { Write-Host "  $_" }
}
Write-Host "git の追跡から外すファイル(ファイルは残します): $($trackedFiles.Count) 件"
$trackedFiles | ForEach-Object { Write-Host "  $_" }
```

適用部の `foreach ($m in $moves) {` の行の直前に追加する:

```powershell
if ($untrackPlaces.Count -gt 0) { Invoke-Git rm -r -q --cached -- @untrackPlaces | Out-Null }
```

計画部の `$needsIgnore = -not ((Get-Content -LiteralPath $gitignorePath -ErrorAction SilentlyContinue) -contains '/css/fonts/')` を次に替える（`Test-KnownShape` と同じく前後の空白を除いて比べる。除かないと、手で足した `/css/fonts/ ` を取り込んだうえで同じ行を重ねて追記してしまう）:

```powershell
$ignoreLines = if (Test-Path -LiteralPath $gitignorePath) { @([IO.File]::ReadAllLines($gitignorePath) | ForEach-Object { $_.Trim() }) } else { @() }
$needsIgnore = -not ($ignoreLines -contains '/css/fonts/')
```

`Invoke-Git add -- .gitignore css | Out-Null` を次に替える:

```powershell
$addPaths = @('.gitignore')
if (Test-Path -LiteralPath (Join-Path $DataRoot 'css')) { $addPaths += 'css' }
if ($absorbed -contains '.gitattributes') { $addPaths += '.gitattributes' }
Invoke-Git add -- @addPaths | Out-Null
```

冒頭のヘルプの `  サーバ稼働中、または dataRoot の git に未コミットの変更があるときは中止する。` の行を次に替える:

```
  サーバ稼働中、dataRoot が git リポジトリでない・履歴(HEAD)が無いときは中止する。未コミットの
  変更は 1 件ずつ点検し、このパッチ・init-data-repo・サーバが作るのと同じ形(CSS の ../fonts/ →
  fonts/、.gitignore への必須行の追記、.gitattributes を * text eol=lf にしただけ)なら取り込んで
  同じコミットに含め、それ以外があれば一覧を出して中止する。追跡されているフォント・画像・js
  (css/fonts・images・js・assets)は追跡だけ外す(ファイルは残す)。templates も css も無いときは
  dataRoot の取り違えとみなし、何も変えずに終了コード 2 で終わる。git は環境変数 GIT_BIN が
  あればそれを使う。
```

BOM と改行を確かめる:

Run: `head -c 3 editor/patches/2026-10-fonts-to-css/migrate.ps1 | od -An -tx1; file editor/patches/2026-10-fonts-to-css/migrate.ps1 editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1`
Expected: ` ef bb bf`。2 つとも `UTF-8 (with BOM) text`（CRLF の記載なし）

- [ ] **Step 6: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit"`
Expected: PASS（既存の件と足した 16 件の全件）

- [ ] **Step 7: コミット**

```bash
git add editor/patches/2026-10-fonts-to-css/migrate.ps1 editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1
git commit -m "feat(editor): フォント移設パッチが既知の形の未コミット変更を取り込み、追跡済みのフォント・画像・js の追跡を外す"
```

---

### Task 10: フォント移設パッチ — appconfig の片付け・assets の改名・競合と報告

対応する設計: 6.2、6.7.4（「appconfig のバックアップ」「`python.bin` / `python.args` の外し方」「`python.script`」「editor のフォルダの中の判定」「置き場違いの報告」「競合は全件」「旧形式データの報告」）、6.8.6、6.8 のユーザー確認 1（安全弁は足さない）。

**Files:**
- Modify: `editor/patches/2026-10-fonts-to-css/migrate.ps1`（Task 9 の後の状態に対する編集。UTF-8 BOM・LF を保つ）
- Modify: `editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1`

**Interfaces:**
- Produces（スクリプト内）: `Test-InsideEditor([string]$p)`、`$insideKeys`（editor の中を指す `paths.*` のキー）、`Get-PlaceCfg([string]$key)`（`$insideKeys` なら `$null`）、`$insideEnvs`、`$filledPlace`、`$conflicts`、`$renameAssets`・`$migratedName`・`$assetsOthers`、`$assetsToJs`・`$py`・`$pyRemove`・`$pyKeep`・`$needsConfig`

- [ ] **Step 1: 失敗するテストを書く**

`migrate.Tests.ps1` の補助関数（`$cssRewritten` の定義の後）に追加する:

```powershell
# editor のフォルダの中の判定を、実リポジトリの editor を汚さずに確かめるための写し。
# 戻り値はワークスペースに当たるフォルダ(<戻り値>\editor が editor のフォルダ)。
function New-FakeEditor {
  $ws = Join-Path $env:TEMP ('fonts-mig-ws-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $patchDir = Join-Path $ws 'editor\patches\2026-10-fonts-to-css'
  New-Item -ItemType Directory -Force -Path $patchDir, (Join-Path $ws 'editor\data\templates') | Out-Null
  Copy-Item -LiteralPath (Join-Path $here 'migrate.ps1'), (Join-Path $here 'rollback.ps1') -Destination $patchDir
  return $ws
}

function New-TempConfig([object]$value) {
  $cfg = Join-Path $env:TEMP ('fonts-mig-cfg-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
  [IO.File]::WriteAllText($cfg, ($value | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  return $cfg
}
```

`Describe 'migrate.ps1'` の末尾に次を足す:

```powershell
  It '旧例の appconfig(editor の中の置き場・旧い生成器・python.bin)を片付け、置き場は dataRoot 配下で解決する' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    $cfg = Join-Path $ws 'editor\appconfig.json'
    try {
      $original = '{"port":24680,"paths":{"templatesDir":"data/templates","cssDir":"data/css","pendingDir":"data/pending","tmpDir":".tmp","logDir":"logs","webDist":"web/dist"},"python":{"bin":"python","script":"server/scripts/generate_template.py","timeoutMs":30000}}'
      [IO.File]::WriteAllText($cfg, $original, (New-Object Text.UTF8Encoding $false))
      $dry = Invoke-Patch $fake @{ DataRoot = $root; Port = 1 } $cfg *>&1 | Out-String
      $dry | Should Match '旧構成の置き場の設定を外す'
      $dry | Should Match 'paths\.templatesDir'
      $dry | Should Match 'paths\.cssDir'
      $dry | Should Match 'paths\.pendingDir'
      $dry | Should Not Match 'paths\.tmpDir'
      $dry | Should Match 'python\.bin を外します'
      $dry | Should Match 'python\.script を外します'
      $dry | Should Match 'PY_GENERATE_SCRIPT'
      $dry | Should Match 'editor のフォルダに data が残っています'
      $dry | Should Match ([regex]::Escape("cssDir   : $(Join-Path $root 'css')"))
      [IO.File]::ReadAllText($cfg) | Should Be $original
      Invoke-Patch $fake @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      $after = Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json
      @($after.paths.PSObject.Properties.Name) -join ',' | Should Be 'tmpDir,logDir,webDist'
      @($after.python.PSObject.Properties.Name) -join ',' | Should Be 'timeoutMs'
      $after.port | Should Be 24680
      [IO.File]::ReadAllText("$cfg.bak-$(Get-Date -Format 'yyyyMMdd')") | Should Be $original
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(fonts/a\.woff2\)'
      Test-Path (Join-Path $ws 'editor\data\templates') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  $pyCases = @(
    @{ Name = '(python, 無し)'; Python = @{ bin = 'python' }; Left = @() },
    @{ Name = '(py, -3.13)'; Python = @{ bin = 'py'; args = @('-3.13') }; Left = @() },
    @{ Name = '(python, -3.13)'; Python = @{ bin = 'python'; args = @('-3.13') }; Left = @() },
    @{ Name = '(bin 無指定, -3.13)'; Python = @{ args = @('-3.13') }; Left = @() },
    @{ Name = '(絶対パス, 無し)'; Python = @{ bin = 'C:\Python313\python.exe' }; Left = @('bin') },
    @{ Name = '(py, 無し)'; Python = @{ bin = 'py' }; Left = @('bin') },
    @{ Name = '(python, -X utf8)'; Python = @{ bin = 'python'; args = @('-X', 'utf8') }; Left = @('bin', 'args') }
  )
  foreach ($c in $pyCases) {
    It "python.bin / python.args $($c.Name) は $(if ($c.Left.Count -eq 0) { '外す' } else { '残して報告する' })" {
      $root = New-OldLayout
      # 偽の生成器の指定は全件で外れるので、appconfig は必ず書き戻される(配列の書き戻しも確かめられる)。
      $py = @{ timeoutMs = 30000; script = 'server/scripts/fake_generate_template.py' } + $c.Python
      $cfg = New-TempConfig @{ python = $py }
      try {
        $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg *>&1 | Out-String
        $raw = [IO.File]::ReadAllText($cfg)
        $after = $raw | ConvertFrom-Json
        foreach ($k in 'bin', 'args') {
          [bool]$after.python.PSObject.Properties[$k] | Should Be ($c.Left -contains $k)
        }
        $after.python.PSObject.Properties['script'] | Should BeNullOrEmpty
        $raw | Should Not Match '"Count"'
        if ($c.Left.Count -gt 0) { $out | Should Match '【報告】python\.bin=' }
        if ($c.Left -contains 'args') { @($after.python.args) -join ' ' | Should Be '-X utf8' }
      } finally {
        Remove-Item -Recurse -Force $root
        Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
      }
    }
  }

  It 'python.script が共有フォルダの生成器を指していれば触らない(書き戻しもバックアップも作らない)' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ script = '\\fileserver\share\gen\generate_template.py' } }
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      (Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json).python.script | Should Be '\\fileserver\share\gen\generate_template.py'
      @(Get-ChildItem (Split-Path $cfg) -Filter ((Split-Path $cfg -Leaf) + '.bak-*')).Count | Should Be 0
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }

  It 'paths.dataRoot が editor の中を指していれば外す(空になった paths も外す)' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    $cfg = Join-Path $ws 'editor\appconfig.json'
    try {
      [IO.File]::WriteAllText($cfg, '{"paths":{"dataRoot":"data"}}', (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $fake @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      (Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json).PSObject.Properties['paths'] | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  It '環境変数が editor の中を指していれば報告だけする(appconfig は変えない)' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    try {
      $out = Invoke-Patch $fake @{ DataRoot = $root; Port = 1 } $null @{ TEMPLATES_DIR = (Join-Path $ws 'editor\data\templates') } *>&1 | Out-String
      $out | Should Match '環境変数 TEMPLATES_DIR が editor のフォルダの中を指しています'
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  It '同じ日に流し直しても、最初のバックアップは上書きせず別名で残す' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      $first = [IO.File]::ReadAllText($cfg)
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      [IO.File]::WriteAllText($cfg, '{"python":{"bin":"py","args":["-3.13"]}}', (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd'
      [IO.File]::ReadAllText("$cfg.bak-$stamp") | Should Be $first
      [IO.File]::ReadAllText("$cfg.bak-$stamp-2") | Should Match '"py"'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It '中身の違う同名ファイルは最初の 1 件で止めず、全件を並べてから中止する(確認モードでも)' {
    $root = New-OldLayout
    try {
      Set-Content -LiteralPath (Join-Path $root 'assets\fonts\b.woff2') -Value 'B' -NoNewline
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'X' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'Y' -NoNewline
      $head = git -C $root rev-parse HEAD
      foreach ($p in @(@{ DataRoot = $root; Port = 1 }, @{ DataRoot = $root; Apply = $true; Port = 1 })) {
        $msg = Get-Message { Invoke-Patch $script $p }
        $msg | Should Match '2 件'
        $msg | Should Match 'a\.woff2'
        $msg | Should Match 'b\.woff2'
      }
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '配信されない場所のフォントと assets* を報告する(assets.migrated-* は報告しない)' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'fonts'), (Join-Path $root 'assets_old'), (Join-Path $root 'assets.migrated-20000101') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'fonts\x.woff2') -Value 'X' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'css\y.ttf') -Value 'Y' -NoNewline
      git -C $root add -- css/y.ttf
      git -C $root -c user.name=t -c user.email=t@t commit -q -m ttf
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match ([regex]::Escape((Join-Path $root 'fonts')))
      $out | Should Match 'css\\y\.ttf'
      $out | Should Match 'assets_old'
      $out | Should Not Match 'assets\.migrated-20000101[^\r\n]*配信されません'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'フォントも js も無い assets も改名して残し、フォントと js 以外のものを報告する' {
    $root = New-OldLayout
    try {
      Remove-Item -Recurse -Force (Join-Path $root 'assets\fonts'), (Join-Path $root 'assets\js')
      Set-Content -LiteralPath (Join-Path $root 'assets\readme.txt') -Value 'r' -NoNewline
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } *>&1 | Out-String
      $out | Should Match 'readme\.txt'
      $stamp = Get-Date -Format 'yyyyMMdd'
      Test-Path (Join-Path $root 'assets') | Should Be $false
      Test-Path (Join-Path $root "assets.migrated-$stamp\readme.txt") | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '同じ日の assets.migrated-<日付> が既にあれば、改名せずに中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root ("assets.migrated-" + (Get-Date -Format 'yyyyMMdd'))) | Out-Null
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '同じ日の退避'
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '旧い形式のデータ(配列でないメモ・held の申請・filled の無いこと)を報告する' {
    $root = New-OldLayout
    try {
      Remove-Item -Recurse -Force (Join-Path $root 'filled')
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'notes') | Out-Null
      Write-Utf8 (Join-Path $root 'notes\T1.json') '{"k":{"content":"x"},"k2":[]}'
      Write-Utf8 (Join-Path $root 'reviews\r1\meta.json') '{"status":"held"}'
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'T1\.json[^\r\n]*配列でない値 1 件'
      $out | Should Match 'meta\.json[^\r\n]*held'
      $out | Should Match 'filled フォルダがありません'
    } finally { Remove-Item -Recurse -Force $root }
  }
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit"`
Expected: FAIL（足した件。Task 9 までの件は PASS のまま）

- [ ] **Step 3: 実装する — 置き場の解決**

`migrate.ps1`:

`Get-CfgPath` の定義（次の 4 行）:

```powershell
function Get-CfgPath([string]$key) {
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) { return [string]$cfgPaths.$key }
  return $null
}
```

の直後に追加する:

```powershell

function Test-InsideEditor([string]$p) {
  # サーバと同じく editor 基準で絶対パスにしてから、<editorDir>\ で始まるかを見る(大文字小文字は
  # 区別しない)。
  $full = [IO.Path]::GetFullPath((Resolve-EditorPath $p)).TrimEnd('\') + '\'
  return $full.StartsWith($editorDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# editor のフォルダの中を指す置き場の設定(旧例の data/templates など)は旧構成の名残。置き場の解決では
# 無視して dataRoot 配下の既定を使い(旧い場所を移設の対象にしないため)、-Apply で appconfig から
# 外す。tmpDir・logDir・webDist は editor の中に置くのが正しい設定なので対象にしない。
$placeKeys = 'dataRoot', 'templatesDir', 'filledDir', 'cssDir', 'jsDir', 'imagesDir', 'draftsDir',
  'pendingDir', 'reviewsDir', 'syncDir', 'assetsDir'
$insideKeys = @($placeKeys | Where-Object { $v = Get-CfgPath $_; $v -and (Test-InsideEditor $v) })
function Get-PlaceCfg([string]$key) {
  if ($insideKeys -contains $key) { return $null }
  return Get-CfgPath $key
}
# 環境変数はパッチが変えられないので、editor の中を指していても報告だけする(解決にはサーバと同じく使う)。
$placeEnvs = 'DATA_ROOT', 'TEMPLATES_DIR', 'FILLED_DIR', 'CSS_DIR', 'JS_DIR', 'IMAGES_DIR', 'DRAFTS_DIR',
  'PENDING_DIR', 'REVIEWS_DIR', 'SYNC_DIR', 'ASSETS_DIR'
$insideEnvs = @($placeEnvs | Where-Object { $v = [Environment]::GetEnvironmentVariable($_); $v -and (Test-InsideEditor $v) })
```

`  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot'; $source = 'appconfig の paths.dataRoot' }` を `  if (-not $DataRoot) { $DataRoot = Get-PlaceCfg 'dataRoot'; $source = 'appconfig の paths.dataRoot' }` に替える。

`Resolve-Place` の中の `  $c = Get-CfgPath $key` を `  $c = Get-PlaceCfg $key` に替える。

`$reviewsPlace = Resolve-Place 'REVIEWS_DIR' 'reviewsDir' 'reviews'` の行の直後に `$filledPlace = Resolve-Place 'FILLED_DIR' 'filledDir' 'filled'` を足す。

`Write-Host "reviews  : $($reviewsPlace.Path) ($($reviewsPlace.Source))"` の行の直後に `Write-Host "filled   : $($filledPlace.Path) ($($filledPlace.Source))"` を足す。

- [ ] **Step 4: 実装する — 移動の計画・競合・assets の改名**

`$moves = @()` を次の 2 行に替える:

```powershell
$moves = @()
$conflicts = @()
```

移動の計画の中の次の 3 行:

```powershell
      if ((Get-FileHashHex $dest) -ne (Get-FileHashHex $f.FullName)) {
        throw "競合: $dest に別の内容があります(移動元 $($f.FullName))。どちらを残すか決めてから再実行してください。"
      }
```

を次に替える:

```powershell
      # 最初の 1 件で止めず全件を集め、報告の後でまとめて中止する(1 件ずつ直して流し直させない)。
      if ((Get-FileHashHex $dest) -ne (Get-FileHashHex $f.FullName)) { $conflicts += "  $dest (移動元 $($f.FullName))" }
```

移動の計画の末尾（次の 3 行）:

```powershell
    $moves += @{ From = $f.FullName; To = $dest }
  }
}
```

の直後に追加する:

```powershell

# 旧 assets は中身にかかわらず改名して残す(画像の置き場パッチが assets の残りで止まり続けない
# ように)。フォントと js 以外のものは移さないので報告する。
$renameAssets = Test-Path -LiteralPath $assetsDir
$migratedName = '{0}.migrated-{1}' -f (Split-Path -Leaf $assetsDir), $stamp
$assetsOthers = @()
if ($renameAssets) {
  $assetsOthers = @(Get-ChildItem -LiteralPath $assetsDir -Force |
    Where-Object { -not ($_.PSIsContainer -and ('fonts', 'js' -contains $_.Name)) } | ForEach-Object { $_.FullName })
  $migratedPath = Join-Path (Split-Path -Parent $assetsDir) $migratedName
  if (Test-Path -LiteralPath $migratedPath) {
    $conflicts += "  $migratedPath (同じ日の退避が既にあります。旧 assets と見比べて片方を手で片付けてください)"
  }
}
```

- [ ] **Step 5: 実装する — appconfig の計画と報告**

`$needsConfig = [bool]($cfgPaths -and $cfgPaths.assetsDir)` を次に替える:

```powershell
# appconfig の片付け。editor の外を指す paths.assetsDir は paths.jsDir=<dataRoot>\js へ置き換える。
$assetsToJs = [bool]((Get-CfgPath 'assetsDir') -and ($insideKeys -notcontains 'assetsDir'))
$py = if ($appConfig -and $appConfig.PSObject.Properties['python']) { $appConfig.python } else { $null }
$pyRemove = @()
$pyKeep = $null
if ($py) {
  # 既定の起動コマンドは PATH 上の python(引数なし)。それと同じ組、元から起動できない組、
  # py ランチャの組(PATH 上の python へ移す)は外す。絶対パスや他の引数は意図した設定なので残す。
  $binProp = $py.PSObject.Properties['bin']
  $argsProp = $py.PSObject.Properties['args']
  if ($binProp -or $argsProp) {
    $bin = if ($binProp) { [string]$binProp.Value } else { 'python' }
    $pyArgs = if ($argsProp) { @($argsProp.Value | ForEach-Object { [string]$_ }) } else { @() }
    $noArgs = $pyArgs.Count -eq 0
    $only313 = $pyArgs.Count -eq 1 -and $pyArgs[0] -ceq '-3.13'
    if (($bin -ieq 'python' -and ($noArgs -or $only313)) -or ($bin -ieq 'py' -and $only313)) {
      if ($binProp) { $pyRemove += 'bin' }
      if ($argsProp) { $pyRemove += 'args' }
    } else {
      $pyKeep = "python.bin=$bin, python.args=[$($pyArgs -join ', ')]"
    }
  }
  $scriptProp = $py.PSObject.Properties['script']
  if ($scriptProp -and $scriptProp.Value) {
    # 旧い仮の生成器と現行の偽の生成器は、どちらも既定(偽の生成器)と同じ扱いなので外す。
    $scriptFull = [IO.Path]::GetFullPath((Resolve-EditorPath ([string]$scriptProp.Value)))
    foreach ($old in 'server\scripts\generate_template.py', 'server\scripts\fake_generate_template.py') {
      if ($scriptFull -ieq (Join-Path $editorDir $old)) { $pyRemove += 'script' }
    }
  }
}
$needsConfig = [bool]($appConfig -and ($assetsToJs -or $insideKeys.Count -gt 0 -or $pyRemove.Count -gt 0))
```

`Write-Host "appconfig の paths.assetsDir を paths.jsDir へ: $needsConfig"` を次に替える:

```powershell
Write-Host "appconfig を書き換える: $needsConfig"
if ($assetsToJs) { Write-Host "  paths.assetsDir を paths.jsDir=$jsDir へ置き換えます" }
if ($insideKeys.Count -gt 0) {
  Write-Host '  旧構成の置き場の設定を外す(editor のフォルダの中を指しています。外すと dataRoot 配下の既定になります):'
  $insideKeys | ForEach-Object { Write-Host "    paths.$_ = $(Get-CfgPath $_)" }
}
foreach ($k in $pyRemove) { Write-Host "  python.$k を外します(既定の PATH 上の python・偽の生成器と同じ、または旧い指定)" }
if ($pyRemove -contains 'script') { Write-Host '  本番の生成器は環境変数 PY_GENERATE_SCRIPT(または appconfig の python.script)で指してください。' }
if ($pyKeep) { Write-Host "【報告】$pyKeep は既定と違う指定なので残します。PATH 上の Python 3.13 を使うなら手で外してください。" }
```

`if ($env:ASSETS_DIR) { Write-Host "※ 環境変数 ASSETS_DIR が設定されています。JS_DIR=$jsDir に置き換えてください(パッチは環境変数を変えません)。" }` を次に替える:

```powershell
if ($env:ASSETS_DIR) {
  Write-Host ("※ 環境変数 ASSETS_DIR が設定されています。新版は読まないので外してください(js の置き場を変えていた" +
    "なら JS_DIR=$jsDir へ。パッチは環境変数を変えません)。")
}
foreach ($n in $insideEnvs) {
  Write-Host ("【報告】環境変数 $n が editor のフォルダの中を指しています($([Environment]::GetEnvironmentVariable($n)))。" +
    'パッチは環境変数を変えないので、手で外してください。')
}
```

- [ ] **Step 6: 実装する — 置き場違い・旧い形式のデータの報告と競合の中止**

次の 4 行:

```powershell
if ($reportCssCss.Count -gt 0) {
  Write-Host "【報告】url(css/…) を持つ CSS があります(新しい規則では css/css/ になります):"
  $reportCssCss | ForEach-Object { Write-Host "  $($_.FullName)" }
}
```

の直後に追加する:

```powershell
if (Test-Path -LiteralPath (Join-Path $editorDir 'data')) {
  Write-Host ("【報告】editor のフォルダに data が残っています($(Join-Path $editorDir 'data'))。新版は使いません。" +
    '中身は動かさず消さないので、不要なら手で片付けてください。')
}
$misplaced = @()
if (Test-Path -LiteralPath (Join-Path $DataRoot 'fonts')) { $misplaced += "$(Join-Path $DataRoot 'fonts') (フォントは $cssDir\fonts に置きます)" }
$misplaced += @(Get-ChildItem -LiteralPath $cssDir -File -ErrorAction SilentlyContinue |
  Where-Object { '.woff2', '.woff', '.ttf', '.otf' -contains $_.Extension.ToLowerInvariant() } |
  ForEach-Object { "$($_.FullName) (css 直下のフォントは配信されません。$cssDir\fonts に置きます)" })
$misplaced += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets*' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'assets' -and $_.Name -notlike 'assets.migrated-*' } |
  ForEach-Object { "$($_.FullName) (assets.migrated-* 以外の assets* は配信されません)" })
if ($misplaced.Count -gt 0) {
  Write-Host '【報告】配信されない場所にフォントや旧い置き場があります(書き換えません):'
  $misplaced | ForEach-Object { Write-Host "  $_" }
}
if ($renameAssets) { Write-Host "旧 assets を改名して残す: $assetsDir -> $migratedName" }
if ($assetsOthers.Count -gt 0) {
  Write-Host "【報告】旧 assets にフォントと js 以外のものがあります(移さずに $migratedName へ残します):"
  $assetsOthers | ForEach-Object { Write-Host "  $_" }
}
# 構築済み環境の断面より前の形式は、新版が読まない(互換処理を外した)ので手で直してもらう。
$oldData = @()
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $DataRoot 'notes') -Filter '*.json' -File -ErrorAction SilentlyContinue) {
  try {
    $obj = [IO.File]::ReadAllText($f.FullName, $utf8NoBom) | ConvertFrom-Json
    $bad = @($obj.PSObject.Properties | Where-Object { $_.Value -isnot [array] })
    if ($bad.Count -gt 0) { $oldData += "$($f.FullName) (配列でない値 $($bad.Count) 件。新版は読み捨てます)" }
  } catch { $oldData += "$($f.FullName) (PowerShell で読めないため点検できません。手で確かめてください)" }
}
foreach ($d in Get-ChildItem -LiteralPath $reviewsPlace.Path -Directory -ErrorAction SilentlyContinue) {
  $meta = Join-Path $d.FullName 'meta.json'
  if (-not (Test-Path -LiteralPath $meta)) { continue }
  try {
    if (([IO.File]::ReadAllText($meta, $utf8NoBom) | ConvertFrom-Json).status -eq 'held') {
      $oldData += "$meta (status が held。新版は一覧に出しません)"
    }
  } catch { $oldData += "$meta (PowerShell で読めないため点検できません。手で確かめてください)" }
}
if (-not (Test-Path -LiteralPath $filledPlace.Path)) {
  $oldData += "$($filledPlace.Path) (filled フォルダがありません。この後の init-data-repo.bat で作れます)"
}
if ($oldData.Count -gt 0) {
  Write-Host ('【報告】新版が読まない旧い形式のデータがあります。手で直してください(メモは投稿の配列へ、' +
    'held の申請は pending へ):')
  $oldData | ForEach-Object { Write-Host "  $_" }
}
```

`if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }` の行の直前に追加する:

```powershell
if ($conflicts.Count -gt 0) {
  throw ("競合: 移動先などに中身の違う同名のものがあります($($conflicts.Count) 件)。どちらを残すか決めてから" +
    "再実行してください:`n$($conflicts -join "`n")")
}
```

- [ ] **Step 7: 実装する — 適用**

次の 3 行:

```powershell
if ((Test-Path -LiteralPath $assetsDir) -and ($moves.Count -gt 0 -or (Test-Path -LiteralPath (Join-Path $assetsDir 'fonts')) -or (Test-Path -LiteralPath (Join-Path $assetsDir 'js')))) {
  Rename-Item -LiteralPath $assetsDir -NewName ("{0}.migrated-{1}" -f (Split-Path -Leaf $assetsDir), $stamp)
}
```

を次に替える:

```powershell
if ($renameAssets) { Rename-Item -LiteralPath $assetsDir -NewName $migratedName }
```

次の 7 行:

```powershell
if ($needsConfig) {
  Copy-Item -LiteralPath $appConfigPath -Destination "$appConfigPath.bak-$stamp"
  $newJs = $jsDir
  $cfgPaths.PSObject.Properties.Remove('assetsDir')
  $cfgPaths | Add-Member -NotePropertyName 'jsDir' -NotePropertyValue $newJs -Force
  [IO.File]::WriteAllText($appConfigPath, ($appConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
}
```

を次に替える:

```powershell
if ($needsConfig) {
  # 同じ日に流し直しても、最初のバックアップ(移行前の状態。rollback.ps1 の復元元)は上書きしない。
  $bak = "$appConfigPath.bak-$stamp"
  $n = 2
  while (Test-Path -LiteralPath $bak) { $bak = "$appConfigPath.bak-$stamp-$n"; $n++ }
  Copy-Item -LiteralPath $appConfigPath -Destination $bak
  foreach ($k in $insideKeys) { $cfgPaths.PSObject.Properties.Remove($k) }
  if ($assetsToJs) {
    $cfgPaths.PSObject.Properties.Remove('assetsDir')
    $cfgPaths | Add-Member -NotePropertyName 'jsDir' -NotePropertyValue $jsDir -Force
  }
  foreach ($k in $pyRemove) { $py.PSObject.Properties.Remove($k) }
  if ($cfgPaths -and @($cfgPaths.PSObject.Properties).Count -eq 0) { $appConfig.PSObject.Properties.Remove('paths') }
  if ($py -and @($py.PSObject.Properties).Count -eq 0) { $appConfig.PSObject.Properties.Remove('python') }
  [IO.File]::WriteAllText($appConfigPath, ($appConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
  Write-Host "appconfig を書き換えました(元は $bak に残しています)。"
}
```

- [ ] **Step 8: ヘルプを直す**

冒頭のヘルプの `.SYNOPSIS` の 1 行目から `  templates / filled の HTML 内の fonts/ 参照と、url(css/…) を持つ CSS は報告だけする。` の行まで（2〜19 行）を次に替える（Task 9 で直した「サーバ稼働中、…」の段落はこの直後に続く）:

```
.SYNOPSIS
  editor の data リポジトリを新構成へ移す(フォント: assets\fonts → css\fonts、js: assets\js → js)。
  あわせて appconfig に残る旧構成の設定を片付ける。

.DESCRIPTION
  既定は確認モードで、移動元・移動先、書き換える CSS、外す設定、報告事項を表示するだけで何も
  変えない。-Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /css/fonts/ を追記する(フォントが承認コミットへ巻き込まれないよう、移動より先)
    2. 追跡されているフォント・画像・js(css/fonts・images・js・assets)を git の追跡から外す
    3. assets\fonts → <cssDir>\fonts、assets\js → <dataRoot>\js をコピーし、SHA256 で照合してから
       旧 assets\ を中身にかかわらず assets.migrated-<yyyyMMdd> へ改名して残す(共有フォルダでの
       途中失敗に備える。フォントと js 以外のものは移さずに報告する)
    4. CSS の url( 直後の ../fonts/ を fonts/ に直す(css\*.css と、承認前の作業コピー
       drafts\*.css・pending\*.css・reviews\<id>\body.css)
    5. appconfig を片付ける: editor の外を指す paths.assetsDir を paths.jsDir(<dataRoot>\js)へ
       置き換え、editor のフォルダの中を指す置き場の設定(旧例の data/templates など)、旧い仮の
       生成器・偽の生成器を指す python.script、既定と同じ・元から起動できない python.bin /
       python.args を外す。変える前に appconfig.json.bak-<yyyyMMdd> を作る(同じ日の 2 回目以降は
       -2, -3 … を付けて別名で残す)
    6. 確定領域の変更(.gitignore・css・取り込んだ .gitattributes)と追跡の解除を system 名義で
       1 コミットする
  作業コピー(drafts / pending / reviews)の CSS は git 管理外なので、書き換え前に
  <dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\ へ退避する(rollback.ps1 がここから戻す)。
  置き場(dataRoot・drafts・pending・reviews・filled・css・旧 assets)はサーバと同じ順(環境変数 →
  appconfig → dataRoot 配下の既定)で決め、出典を表示する。appconfig の値が editor のフォルダの中を
  指すときは無視して既定を使う。環境変数が editor の中を指すときは報告だけする。
  報告だけするもの: templates / filled の HTML 内の fonts/ 参照、url(css/…) を持つ CSS、editor の
  フォルダの data、配信されない場所のフォント(<dataRoot>\fonts・css 直下・assets.migrated-* 以外の
  assets*)、新版が読まない旧い形式のデータ(配列でないメモ・held の申請・filled の無いこと)。
  移動先などに中身の違う同名のものがあれば、全件を並べてから中止する。
```

BOM と改行を確かめる:

Run: `head -c 3 editor/patches/2026-10-fonts-to-css/migrate.ps1 | od -An -tx1; file editor/patches/2026-10-fonts-to-css/migrate.ps1 editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1`
Expected: ` ef bb bf`。2 つとも `UTF-8 (with BOM) text`（CRLF の記載なし）

- [ ] **Step 9: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit"`
Expected: PASS（全件）

- [ ] **Step 10: コミット**

```bash
git add editor/patches/2026-10-fonts-to-css/migrate.ps1 editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1
git commit -m "feat(editor): フォント移設パッチで appconfig の旧構成の設定を片付け、assets を必ず改名し、置き場違いと旧い形式のデータを報告する"
```

---

### Task 11: フォント移設の rollback を `assets.migrated-*` の無い環境でも止めない・README

対応する設計: 6.2 の「元に戻す」、6.7.4「元に戻す」、6.7.4「git の場所」（rollback 側）、6.3 の「パッチの README」、6.7.6 の「2 本のパッチの README」（フォント移設）。

**Files:**
- Modify: `editor/patches/2026-10-fonts-to-css/rollback.ps1`（全体を置き換える。UTF-8 BOM・LF）
- Modify: `editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1`
- Modify: `editor/patches/2026-10-fonts-to-css/README.md`（全体を置き換える）

**Interfaces:**
- 振る舞い: 戻す日付の候補 = `assets.migrated-<日付>` ∪ `<appconfig>.bak-<日付>[-n]` ∪ `.fonts-to-css-backup-<日付>`。`-Date` があればそれ、候補 1 つならそれ、0 なら日付なし（revert だけ）、2 つ以上なら `-Date` を求めて中止。`assets.migrated-<日付>` が無ければ退避名からは戻さない。revert の前に、revert が戻すパス（`git diff-tree -r -z --no-commit-id --name-only --diff-filter=D <移行コミット>`）にある作業ツリーのファイルを `<dataRoot>\.rollback-tmp-<日付>\` へ退避し、revert 後に SHA256 で比べる（同じなら消す、違えば残して報告）。revert が `assets` を戻したときは、`assets.migrated-*` の側にしか無いファイルだけを移し、同じものは消し、違うものは残して報告し、空になった退避名のフォルダを消す。`css\fonts`・`js` の削除は戻した後の `assets` と同一内容のものだけ（`assets` が無ければ触らない）。appconfig は `<appconfig>.bak-<日付>`（同じ日の最初のもの）から戻す。
- Produces（スクリプト内）: `Invoke-GitUtf8`・`ConvertTo-ProcessArgument`（migrate.ps1 と同じ）、`Remove-EmptyDirs([string]$root)`、`Get-DeletePlan([string]$oldRoot)` → `@{ Deletes; Keeps }`

- [ ] **Step 1: 失敗するテストを書く**

`migrate.Tests.ps1` の `Describe 'migrate.ps1'` の末尾に足す:

```powershell
  It 'rollback は assets.migrated-* が無い環境(appconfig の片付けだけが動いた)でも止まらず、revert と appconfig の復元を行う' {
    $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      foreach ($d in 'css\fonts', 'templates') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'FONT' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '@font-face{src:url(../fonts/a.woff2)}' -NoNewline
      [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/css/fonts/`n", (New-Object Text.UTF8Encoding $false))
      git -C $root init -q
      git -C $root add -- .gitignore css
      git -C $root -c user.name=t -c user.email=t@t commit -q -m init
      $original = [IO.File]::ReadAllText($cfg)
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(fonts/a\.woff2\)'
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
      [IO.File]::ReadAllText($cfg) | Should Be $original
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'rollback は移行後に assets.migrated-* を手で消していても、revert と appconfig の復元を行う' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      $original = [IO.File]::ReadAllText($cfg)
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      Get-ChildItem $root -Directory -Filter 'assets.migrated-*' | Remove-Item -Recurse -Force
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
      [IO.File]::ReadAllText($cfg) | Should Be $original
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'rollback は戻す日付の候補が複数あれば -Date を求め、-Date を付ければ戻す' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      Copy-Item -LiteralPath $cfg -Destination "$cfg.bak-20000101"
      $msg = Get-Message { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root } $cfg }
      $msg | Should Match '-Date'
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true; Date = (Get-Date -Format 'yyyyMMdd') } $cfg | Out-Null
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It '追跡されたフォント・js・画像を -Apply で外したあとでも、rollback -Apply が通り、追跡と assets が戻る' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts'), (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- assets css/fonts images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } | Out-Null
      $tracked = (@(git -C $root ls-files -- assets css/fonts images) | Sort-Object) -join ','
      $tracked | Should Be 'assets/fonts/a.woff2,assets/js/w.js,css/fonts/b.woff2,images/510037_logo.svg'
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'assets\js\w.js') | Should Be $true
      @(Get-ChildItem $root -Directory -Filter 'assets.migrated-*').Count | Should Be 0
      @(Get-ChildItem $root -Directory -Force -Filter '.rollback-tmp-*').Count | Should Be 0
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $false
      Test-Path (Join-Path $root 'js\w.js') | Should Be $false
      Test-Path (Join-Path $root 'css\fonts\b.woff2') | Should Be $true
      (git -C $root status --porcelain -- assets css images) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡を外した後に中身を変えたファイルは、rollback で退避を残して報告する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg>new</svg>' -NoNewline
      $out = Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } *>&1 | Out-String
      $stamp = Get-Date -Format 'yyyyMMdd'
      Get-Content -Raw (Join-Path $root ".rollback-tmp-$stamp\images\510037_logo.svg") | Should Be '<svg>new</svg>'
      Get-Content -Raw (Join-Path $root 'images\510037_logo.svg') | Should Be '<svg/>'
      $out | Should Match '退避に残しました'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は同じ日の退避に同じパスのファイルが既にあれば、何も変えずに中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd'
      $old = Join-Path $root ".rollback-tmp-$stamp\images\510037_logo.svg"
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $old) | Out-Null
      Set-Content -LiteralPath $old -Value 'OLD' -NoNewline
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } }
      $msg | Should Match '同じ日の退避'
      Get-Content -Raw $old | Should Be 'OLD'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root "assets.migrated-$stamp") | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback の 2 回目(移行コミットが revert 済み)は、appconfig と作業コピーを戻さない' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      [IO.File]::WriteAllText($cfg, '{"port":1}', (New-Object Text.UTF8Encoding $false))
      Set-Content -LiteralPath (Join-Path $root 'drafts\T1.css') -Value 'edited' -NoNewline
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      [IO.File]::ReadAllText($cfg) | Should Be '{"port":1}'
      Get-Content -Raw (Join-Path $root 'drafts\T1.css') | Should Be 'edited'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'rollback も -DataRoot の相対パスを今の場所を基準に解決する' {
    $root = New-OldLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Push-Location (Split-Path -Parent $root)
      try { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = (Split-Path -Leaf $root); Apply = $true } | Out-Null }
      finally { Pop-Location }
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback も PATH に git が無ければ GIT_BIN の git を使う' {
    $root = New-OldLayout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit"`
Expected: FAIL（rollback が「assets.migrated-* が 1 つに決まりません」で止まる、GIT_BIN を使わない、追跡を外した後の revert が「untracked working tree files would be overwritten」で止まる）

- [ ] **Step 3: 実装する**

`editor/patches/2026-10-fonts-to-css/rollback.ps1` を次の内容で置き換える（先頭に UTF-8 BOM を保つ。改行は LF）:

```powershell
<#
.SYNOPSIS
  2026-10-fonts-to-css の移行を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。処理順:
    1. 移行コミット(作者 system、件名に [fonts-to-css])を git revert する。すでに revert 済みなら
       飛ばす(rollback 自身の Revert コミットは移行コミットとして拾わない)。移行で追跡を外した
       ファイル(revert が戻すパス)が作業ツリーにあると git revert が上書きを拒むので、revert の
       前に <dataRoot>\.rollback-tmp-<日付>\ へ退避し、revert の後に SHA256 で比べる。同じなら
       退避を消し、違えば退避を残して報告する
    2. assets.migrated-<日付> を assets へ戻す。revert が追跡していた assets を戻した場合は、
       退避名の側にしか無いファイルだけを assets へ移し、同じ内容のものは消し、違うものは残して
       報告する。空になった退避名のフォルダは消す
    3. 移行で作った css\fonts と js のうち、戻した assets に同じ相対パス・同じ SHA256 のファイルが
       あるものだけ削除する。旧 assets と内容が違うファイルは消さず、一覧を表示して残す。空になった
       フォルダだけ消す。assets が戻らない(手で assets を消した、appconfig の片付けだけが動いた)
       ときは、同一内容かを確かめられないので css\fonts と js には触らない
    4. <dataRoot>\.fonts-to-css-backup-<日付>\ に退避した作業コピー(drafts / pending / reviews の
       CSS)を元の場所へ戻す。退避に無いファイルは触らない。移行後にこれらを編集していた場合、
       その編集は退避時点の内容で上書きされる
    5. appconfig.json.bak-<日付>(同じ日に複数あれば最初のもの)があれば appconfig.json へ戻す
  移行コミットが revert 済みの 2 回目以降は、4 と 5 を行わない(1 回目の後に直した内容を上書きしない
  ため)。同じ日の退避(.rollback-tmp-<日付>)に同じパスのファイルが既にあれば、何も変えずに中止する。
  git revert が失敗したときは revert --abort で元の状態へ戻し、退避したファイルも元へ戻してから
  中止する。実行前に editor サーバを止め、戻したあとは旧版の editor を配置して起動すること。
  git は環境変数 GIT_BIN があればそれを使う。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は migrate.ps1 と同じ規則: 環境変数 DATA_ROOT → ユーザー環境変数
  DATA_ROOT → appconfig の paths.dataRoot → 既定)。

.PARAMETER Date
  戻す移行の日付(yyyyMMdd)。省略時は assets.migrated-<日付>・appconfig.json.bak-<日付>・
  .fonts-to-css-backup-<日付> の日付が 1 つに決まればそれを使う。1 つも無ければ移行コミットの
  revert だけを行う。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [string]$Date, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する(PATH に git が無い端末向け)。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
# -DataRoot の相対パスは PowerShell の今の場所を基準に絶対パスへ直す。Invoke-GitUtf8 が起動する git は
# PowerShell の今の場所を引き継がない(プロセスの作業フォルダは別)ため。
if ($DataRoot) { $DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと
  # PowerShell 5.1 がそれを例外にするので、stderr は自前で受けて終了コードで失敗を判定する。
  # 成功時の警告は捨て、失敗時だけ原因として例外メッセージへ載せる。
  $ErrorActionPreference = 'Continue'
  $all = @(& $gitExe -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function ConvertTo-ProcessArgument([string]$a) {
  # .NET Framework の ProcessStartInfo は引数を 1 本の文字列で受けるので、C ランタイムの規則で囲む
  # (空白・引用符を含む dataRoot や pathspec を 1 引数として渡すため)。
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-GitUtf8 {
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスが
  # 化ける。revert が戻すパスの一覧は、出力を UTF-8 として自前で読む。
  param([Parameter(Mandatory = $true)][string[]]$GitArgs, [switch]$AllowFailure)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $gitExe
  $psi.Arguments = ((@('-C', $DataRoot) + $GitArgs) | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8NoBom
  $psi.StandardErrorEncoding = $utf8NoBom
  $proc = [Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0 -and -not $AllowFailure) {
    throw "git $($GitArgs -join ' ') が失敗しました(終了コード $($proc.ExitCode))。`n$($errTask.Result)"
  }
  return @{ Code = $proc.ExitCode; Out = $out }
}

function Get-FileHashHex([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }

function Remove-EmptyDirs([string]$root) {
  # 深いフォルダから順に、空になったものだけ消す(中身の残るフォルダは消さない)。
  if (-not (Test-Path -LiteralPath $root)) { return }
  Get-ChildItem -LiteralPath $root -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
  }
  if (-not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force }
}

function Get-DeletePlan([string]$oldRoot) {
  # css\fonts と js のうち、旧 assets($oldRoot)に同じ相対パス・同じ内容があるものだけを消す対象にする。
  $plan = @{ Deletes = @(); Keeps = @() }
  foreach ($pair in @(@{ Dir = (Join-Path $cssDir 'fonts'); Old = (Join-Path $oldRoot 'fonts') },
                      @{ Dir = $jsDir; Old = (Join-Path $oldRoot 'js') })) {
    if (-not (Test-Path -LiteralPath $pair.Dir)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $pair.Dir -Recurse -File) {
      $rel = $f.FullName.Substring($pair.Dir.Length).TrimStart('\')
      $old = Join-Path $pair.Old $rel
      if ((Test-Path -LiteralPath $old) -and ((Get-FileHashHex $old) -eq (Get-FileHashHex $f.FullName))) { $plan.Deletes += $f.FullName }
      else { $plan.Keeps += $f.FullName }
    }
  }
  return $plan
}

# ── 1. 置き場の解決(migrate.ps1 と同じ規則) ──
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }
function Get-CfgPath([string]$key) {
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) { return [string]$cfgPaths.$key }
  return $null
}
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT
  if (-not $DataRoot) { $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User') }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data' }
}
$cssDir = if ($env:CSS_DIR) { Resolve-EditorPath $env:CSS_DIR }
  elseif (Get-CfgPath 'cssDir') { Resolve-EditorPath (Get-CfgPath 'cssDir') }
  else { Join-Path $DataRoot 'css' }
$jsDir = Join-Path $DataRoot 'js'
$assetsDir = Join-Path $DataRoot 'assets'

# ── 2. 戻す対象の特定 ──
# 戻す日付は、移行が残すもの(退避した assets・appconfig のバックアップ・作業コピーの退避)から
# 決める。assets を手で消した環境や、appconfig の片付けだけが動いた環境でも決められるようにする。
$cfgDir = Split-Path -Parent $appConfigPath
$cfgLeaf = Split-Path -Leaf $appConfigPath
$dates = @()
$dates += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Filter 'assets.migrated-*' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Name.Substring('assets.migrated-'.Length) })
$dates += @(Get-ChildItem -LiteralPath $DataRoot -Directory -Force -Filter '.fonts-to-css-backup-*' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Name.Substring('.fonts-to-css-backup-'.Length) })
$dates += @(Get-ChildItem -LiteralPath $cfgDir -File -Filter "$cfgLeaf.bak-*" -ErrorAction SilentlyContinue |
  ForEach-Object { if ($_.Name -match '\.bak-(\d{8})(-\d+)?$') { $Matches[1] } })
$dates = @($dates | Sort-Object -Unique)
if ($Date) { $stamp = $Date }
elseif ($dates.Count -eq 1) { $stamp = $dates[0] }
elseif ($dates.Count -eq 0) { $stamp = $null }
else { throw "戻す日付が 1 つに決まりません(候補: $($dates -join ', '))。-Date で指定してください。" }
$migratedDir = if ($stamp) { Join-Path $DataRoot "assets.migrated-$stamp" } else { $null }
$hasMigrated = [bool]($migratedDir -and (Test-Path -LiteralPath $migratedDir))

# 移行コミットだけを選ぶ。rollback 自身の revert コミットも件名に [fonts-to-css] を含むので、
# Revert で始まる件名は除く。すでに revert 済み(This reverts commit <sha>)なら再 revert しない。
$commit = $null
$alreadyReverted = $false
foreach ($line in (Invoke-Git log --author=system --grep '\[fonts-to-css\]' --format='%H %s')) {
  $sha, $subject = $line -split ' ', 2
  if ($subject -like 'Revert *') { continue }
  $commit = $sha
  break
}
if ($commit -and (Invoke-Git log --grep "This reverts commit $commit" --format=%H -1)) { $alreadyReverted = $true }

# revert が戻すパス(移行コミットで削除扱いになったもの = 追跡を外したファイル)。同じパスに作業
# ツリーのファイルがあると、git revert は .gitignore 済みの置き場では黙って上書きし(終了コード 0)、
# それ以外(js など)では上書きを拒む。どちらでも作業ツリーの内容を失わないよう、戻すパスにある
# ファイルはすべて revert の前に退避する。
$restorePaths = @()
if ($commit -and -not $alreadyReverted) {
  $restorePaths = @((Invoke-GitUtf8 -GitArgs @('diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--diff-filter=D', $commit)).Out.Split([char]0) |
    Where-Object { $_ -ne '' })
}
$toStash = @($restorePaths | Where-Object { Test-Path -LiteralPath (Join-Path $DataRoot ($_ -replace '/', '\')) -PathType Leaf })
$stashRoot = Join-Path $DataRoot ('.rollback-tmp-' + $(if ($stamp) { $stamp } else { Get-Date -Format 'yyyyMMdd' }))
# 同じ日の退避に同じパスのファイルがあると、前回の rollback で残したもの(戻した版と内容が違った
# もの)を黙って上書きしてしまう。何も変えずに中止して片付けを求める。
$stashClash = @($toStash | Where-Object { Test-Path -LiteralPath (Join-Path $stashRoot ($_ -replace '/', '\')) })
if ($stashClash.Count -gt 0) {
  throw ("同じ日の退避が既にあります($stashRoot)。前回の rollback で残したファイルと見比べて片付けてから" +
    "再実行してください:`n$(($stashClash | ForEach-Object { "  $_" }) -join "`n")")
}

# css\fonts と js の削除は、戻した assets と同一内容の分だけ。確認モードでは、退避名の assets
# (無ければ今の assets)を基準に見込みを出す(-Apply では戻した後の assets で決め直す)。
$previewRoot = if ($hasMigrated) { $migratedDir } elseif (Test-Path -LiteralPath $assetsDir) { $assetsDir } else { $null }
$preview = if ($previewRoot) { Get-DeletePlan $previewRoot } else { @{ Deletes = @(); Keeps = @() } }

# 作業コピーの退避。
$restores = @()
if ($stamp) {
  $backupRoot = Join-Path $DataRoot ".fonts-to-css-backup-$stamp"
  $manifestPath = Join-Path $backupRoot 'manifest.tsv'
  if (Test-Path -LiteralPath $manifestPath) {
    foreach ($line in [IO.File]::ReadAllLines($manifestPath, $utf8NoBom)) {
      $parts = $line -split "`t", 2
      if ($parts.Count -ne 2) { continue }
      $src = Join-Path $backupRoot $parts[0]
      if (Test-Path -LiteralPath $src) { $restores += @{ From = $src; To = $parts[1] } }
    }
  }
}
# 同じ日に複数あるときは、移行前の状態を持つ最初のもの(-n の付かない名前)から戻す。
$bak = if ($stamp) { "$appConfigPath.bak-$stamp" } else { $null }
$hasBak = [bool]($bak -and (Test-Path -LiteralPath $bak))

Write-Host "dataRoot: $DataRoot"
Write-Host "戻す日付: $(if ($stamp) { $stamp } else { '(決まらないため、移行コミットの revert だけを行います)' })"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "revert の前に退避するファイル(追跡を戻すパスにあるもの。revert 後に同じ内容なら消します): $($toStash.Count) 件"
$toStash | ForEach-Object { Write-Host "  $_" }
if ($hasMigrated) { Write-Host "戻す: $migratedDir -> assets" }
else { Write-Host '戻す: (assets.migrated-* が無いため、退避名からは戻しません)' }
Write-Host "削除するファイルの見込み(旧 assets と同一内容): $($preview.Deletes.Count) 件"
$preview.Deletes | ForEach-Object { Write-Host "  $_" }
if ($preview.Keeps.Count -gt 0) {
  Write-Host "【残す】旧 assets と内容が違うファイル(移行後に置いた、または git に記録された版と違う)。消さずに残します: $($preview.Keeps.Count) 件"
  $preview.Keeps | ForEach-Object { Write-Host "  $_" }
}
if ($alreadyReverted) {
  Write-Host '退避から戻す作業コピー・appconfig: (移行コミットが revert 済みのため戻しません)'
} else {
  Write-Host "退避から戻す作業コピー: $($restores.Count) 件"
  $restores | ForEach-Object { Write-Host "  $($_.To)" }
  Write-Host "appconfig を戻す: $(if ($hasBak) { $bak } else { '(バックアップなし)' })"
}
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 3. 適用 ──
$stashKept = @()
if ($commit -and -not $alreadyReverted) {
  $moved = @()
  foreach ($rel in $toStash) {
    $src = Join-Path $DataRoot ($rel -replace '/', '\')
    $dst = Join-Path $stashRoot ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Move-Item -LiteralPath $src -Destination $dst -Force
    $moved += $rel
  }
  try {
    Invoke-Git -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null
  } catch {
    # 競合したまま止まると REVERTING 状態と競合マーカーが残るので、元の状態へ戻してから中止する。
    # 退避したファイルも元の場所へ戻す(流す前の作業ツリーに揃える)。
    try { Invoke-Git revert --abort | Out-Null } catch { Write-Warning 'git revert --abort にも失敗しました。手動で確認してください。' }
    foreach ($rel in $moved) {
      $back = Join-Path $DataRoot ($rel -replace '/', '\')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $back) | Out-Null
      Move-Item -LiteralPath (Join-Path $stashRoot ($rel -replace '/', '\')) -Destination $back -Force
    }
    Remove-EmptyDirs $stashRoot
    throw
  }
  foreach ($rel in $moved) {
    $restored = Join-Path $DataRoot ($rel -replace '/', '\')
    $kept = Join-Path $stashRoot ($rel -replace '/', '\')
    if ((Test-Path -LiteralPath $restored) -and ((Get-FileHashHex $restored) -eq (Get-FileHashHex $kept))) {
      Remove-Item -LiteralPath $kept -Force
    } else { $stashKept += $kept }
  }
  Remove-EmptyDirs $stashRoot
}

$assetsDiffer = @()
if ($hasMigrated) {
  if (-not (Test-Path -LiteralPath $assetsDir)) {
    Rename-Item -LiteralPath $migratedDir -NewName 'assets'
  } else {
    # revert が追跡していた assets を戻した。退避名の側にしか無いものだけを移し、同じものは消す。
    foreach ($f in @(Get-ChildItem -LiteralPath $migratedDir -Recurse -File -Force)) {
      $rel = $f.FullName.Substring($migratedDir.Length).TrimStart('\')
      $dst = Join-Path $assetsDir $rel
      if (-not (Test-Path -LiteralPath $dst)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Move-Item -LiteralPath $f.FullName -Destination $dst
      } elseif ((Get-FileHashHex $dst) -eq (Get-FileHashHex $f.FullName)) {
        Remove-Item -LiteralPath $f.FullName -Force
      } else { $assetsDiffer += $f.FullName }
    }
    Remove-EmptyDirs $migratedDir
  }
}

$keeps = @()
if (Test-Path -LiteralPath $assetsDir) {
  $plan = Get-DeletePlan $assetsDir
  foreach ($p in $plan.Deletes) { Remove-Item -LiteralPath $p -Force }
  $keeps = $plan.Keeps
  foreach ($root in (Join-Path $cssDir 'fonts'), $jsDir) { Remove-EmptyDirs $root }
}
# 2 回目以降(移行コミットが revert 済み)は戻さない。1 回目の後に直した作業コピーや appconfig を、
# 退避・バックアップの古い内容で上書きしないため。
if (-not $alreadyReverted) {
  foreach ($r in $restores) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $r.To) | Out-Null
    Copy-Item -LiteralPath $r.From -Destination $r.To -Force
  }
  if ($hasBak) { Copy-Item -LiteralPath $bak -Destination $appConfigPath -Force }
}
if ($stashKept.Count -gt 0) {
  Write-Host '【報告】revert が戻した版と内容が違うため、退避に残しました(必要なら手で見比べてください):'
  $stashKept | ForEach-Object { Write-Host "  $_" }
}
if ($assetsDiffer.Count -gt 0) {
  Write-Host '【報告】戻した assets と内容が違うため、退避名の側に残しました:'
  $assetsDiffer | ForEach-Object { Write-Host "  $_" }
}
if ($keeps.Count -gt 0) {
  Write-Host '【残す】旧 assets と内容が違うファイル(移行後に置いた、または git に記録された版と違う)。消さずに残しました:'
  $keeps | ForEach-Object { Write-Host "  $_" }
}
Write-Host '元に戻しました。旧版の editor を配置して起動してください。'
```

BOM を確かめる（Write は BOM を付けないため、付ける）:

Run（Bash）: `p=editor/patches/2026-10-fonts-to-css/rollback.ps1; head -c 3 "$p" | od -An -tx1 | grep -q 'ef bb bf' || { { printf '\xef\xbb\xbf'; cat "$p"; } > "$p.tmp" && mv "$p.tmp" "$p"; }; head -c 3 "$p" | od -An -tx1; file "$p"`
Expected: ` ef bb bf` と `UTF-8 (with BOM) text`（CRLF の記載なし）

- [ ] **Step 4: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit"`
Expected: PASS（全件。既存の rollback の 3 件を含む）

- [ ] **Step 5: README を書き直す**

`editor/patches/2026-10-fonts-to-css/README.md` を次の内容で置き換える:

````markdown
# 2026-10-fonts-to-css 移行パッチ

editor の data リポジトリで、フォントの置き場を `assets\fonts` から `css\fonts` へ、js の置き場を
`assets\js` から `js` へ移すパッチです。あわせて、CSS 内のフォント参照を `url(../fonts/x.woff2)` から
`url(fonts/x.woff2)` へ書き換え、appconfig に残る旧構成の設定を片付けます。

管理者が行う作業です。確定 CSS などを承認なしで `system` 名義のコミットとして書き換えます。

構築済み環境を新版へ上げるときは、このパッチを**必ず**流します(全体の順番は運用手順書の 3.3 節:
このパッチ → `2026-10-fund-images` → `editor\scripts\init-data-repo.bat`)。新版のサーバは旧構成の
ままでも起動を止めないため、流し忘れるとフォントと JS が欠けた PDF が成功扱いで出ます(起動ログに
`[layout]` の警告は出ます)。

## 前提

- 新版の editor を配置済みであること。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot が git リポジトリで、履歴(最初のコミット)があること。`git init` だけで履歴が無いときは
  中止し、`editor\scripts\init-data-repo.bat` で初回コミット(確定領域だけを記録)を作るよう案内します。

## 手順

1. editor サーバを止める。
2. `migrate.bat` を引数なしで実行し、確認モードで変更内容と報告を見る(何も変えません)。
3. `migrate.bat -Apply` で実行する。
4. 報告に HTML や旧い形式のデータが出たら、手で直す(パッチは書き換えません)。
5. 環境変数 `ASSETS_DIR` を設定していたら外す(新版は読みません。パッチは環境変数を変えません)。
   js の置き場を変えていたなら `JS_DIR` に置き換える。
6. 続けて `2026-10-fund-images` を流し、最後に `editor\scripts\init-data-repo.bat` を流す。

dataRoot は `-DataRoot <path>` で指定できます。省略時はサーバと同じ順(環境変数 `DATA_ROOT`、
ユーザー環境変数、appconfig の `paths.dataRoot`、既定)で決めます。drafts・pending・reviews・filled・
css・旧 assets の置き場も、環境変数(`DRAFTS_DIR` など)、appconfig、dataRoot 配下の既定の順に決め、
出典を表示します。appconfig の値が editor のフォルダの中を指すときは、それを無視して既定を使います。
稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。git は環境変数 `GIT_BIN` があればそれを
使います(PATH に git が無い端末向け)。

## 何をするか

- `.gitignore` に `/css/fonts/` を追記する(フォントを承認コミットへ巻き込まないため)。
- 追跡されているフォント・画像・js(`css/fonts`・`images`・`js`・`assets`)を git の追跡から外す
  (ファイルは残します)。
- `assets\fonts` を `css\fonts` へ、`assets\js` を `js` へコピーし、SHA256 で照合する。照合後に
  旧 `assets\` を中身にかかわらず `assets.migrated-<yyyyMMdd>` へ改名して残す(フォントと js 以外の
  ものは移さず、報告します)。
- `css\*.css`、`drafts\*.css`、`pending\*.css`、`reviews\<id>\body.css` の `url(` 直後の
  `../fonts/` を `fonts/` に直す。
- appconfig を片付ける。
  - editor の外を指す `paths.assetsDir` を `paths.jsDir`(`<dataRoot>\js`)へ置き換える。
  - editor のフォルダの中を指す置き場の設定(`paths.dataRoot`・`templatesDir`・`filledDir`・`cssDir`・
    `jsDir`・`imagesDir`・`draftsDir`・`pendingDir`・`reviewsDir`・`syncDir`・`assetsDir`。旧例の
    `data/templates` など)を外す。`tmpDir`・`logDir`・`webDist` は対象外です。
  - `python.script` が旧い仮の生成器 `server/scripts/generate_template.py` か、偽の生成器
    `server/scripts/fake_generate_template.py` を指していれば外す。本番の生成器は環境変数
    `PY_GENERATE_SCRIPT` で指してください。
  - `python.bin` / `python.args` は次のとおり扱う(bin の無指定は `python`、args の空配列は「無し」と
    みなします)。

    | 今の値(bin, args) | 扱い |
    |---|---|
    | (`python`, 無し) | 両方外す(新しい既定と同じ) |
    | (`py`, `["-3.13"]`) | 両方外す(PATH 上の python へ移る) |
    | (`python`, `["-3.13"]`) | 両方外す(元から起動できない組) |
    | それ以外(絶対パス・他の引数) | 触らずに報告する |

  - 1 か所でも変えるときは、変える前に `appconfig.json.bak-<yyyyMMdd>` を作る。同じ日に流し直した
    ときは既存のバックアップを上書きせず、`-2`・`-3` … を付けて別名で残す。
- 書き換える作業コピー(drafts・pending・reviews の CSS)は git 管理外なので、書き換え前に
  `<dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\` へ退避する(`rollback.bat` の復元元)。
- 確定領域の変更(`.gitignore`・`css`・取り込んだ `.gitattributes`)と追跡の解除を、`system` 名義の
  1 コミット(件名末尾に `[fonts-to-css]`)にまとめる。

再実行しても、すでに済んだ部分は何も変えません。

## 未コミットの変更

確定領域(`templates` / `filled` / `css` / `sync` / `.gitignore` / `.gitattributes`。`css\fonts` は
除く)に未コミットの変更があると、1 件ずつ点検します。次の形だけなら取り込んで、同じコミットに
含めます(BOM と改行コードの違いは除いて比べます)。

- CSS(`css` 直下の `.css`)の `url(../fonts/…)` → `url(fonts/…)` の書き換えだけ
- `.gitignore` に必須の行(`/drafts/` `/reviews/` `/pending/` `/notes/` `/css/fonts/` `/images/`
  `*.tmp-*`)を足しただけ
- `.gitattributes` を `* text eol=lf` にしただけ(旧い `* text=lf` を落とし、他の行は残す)
- 中身の無いフォルダの新規作成(git には見えません)

それ以外が 1 つでもあれば一覧を出して中止します(何も変えません)。前回のパッチや rollback が途中で
止まった形跡(`.git\index.lock`・`REVERT_HEAD` など、移行コミットの無い `assets.migrated-*`)があれば
その旨を、無ければ「手作業の変更が残っています」と案内します。残すなら先にコミットし、要らなければ
`git checkout -- <ファイル>` で戻してから再実行してください。

## 中止・終了コード

- 移動先に中身の違う同名ファイルがある(競合)、同じ日の `assets.migrated-<日付>` が既にある:
  全件を並べてから中止します(確認モードでも)。
- `<dataRoot>\templates` も `<dataRoot>\css` も無い: dataRoot の取り違えとして警告し、何も変えずに
  終了コード 2 で終わります。

## CSS の書き方

新構成では、フォントは `css/fonts/` 配下で配信されます。CSS からは `css/` 基準の相対パスで
`url(fonts/x.woff2)` と書きます。`fonts/` は小文字で書いてください。

## 報告だけするもの

次は書き換えず、確認モードと適用時に一覧で報告します。

- `templates` / `filled` の HTML 内にある `fonts/` 参照(移行後は配信されません)。
- `url(css/…)` を持つ CSS(新しい規則では `css/css/` として解釈されます)。
- editor のフォルダに残っている `data`(中身は動かさず、消しません)。
- editor のフォルダの中を指す環境変数(`TEMPLATES_DIR`・`CSS_DIR`・`PENDING_DIR` など。パッチは
  環境変数を変えません)。
- 既定と違う `python.bin` / `python.args`(上の表の「それ以外」)。
- 配信されない場所のフォント: `<dataRoot>\fonts`、`css` 直下のフォント(`.woff2` `.woff` `.ttf`
  `.otf`)、`assets.migrated-*` 以外の `assets*`。
- 旧 assets のフォントと js 以外のもの。
- 新版が読まない旧い形式のデータ: `notes\*.json` の配列でない値(旧形式メモ。新版は読み捨てます)、
  `reviews\<id>\meta.json` の `status: held`(新版は一覧に出しません)、`filled` フォルダが無いこと
  (`init-data-repo.bat` で作れます)。手で直してください。

## 元に戻す

`2026-10-fund-images` も流していた場合は、先にそちらの `rollback.bat` を流してください(逆の順だと
`.gitignore` の revert が競合します。競合したときは `git revert --abort` で戻して安全に中止しますが、
原因が分かりにくくなります)。

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

`rollback.bat -Apply` は次の順で戻します。

1. 移行コミットを revert する(すでに revert 済みなら飛ばします)。追跡を外したファイルは再び追跡されます。
   revert の前に、戻る場所にあるファイルを `<dataRoot>\.rollback-tmp-<日付>\` へ退避し、revert の後に同じ
   内容なら退避を消し、違えば(戻した版と内容が違うもの)退避に残して報告します。同じ日の退避に同じパスの
   ファイルが既にあれば、何も変えずに中止します。revert が競合したときは `git revert --abort` で戻し、退避した
   ファイルも元へ戻してから中止します。
2. `assets` を戻す。`assets.migrated-<日付>` を `assets` へ改名します。revert が追跡していた `assets` を
   戻したときは、退避名の側にしか無いファイルだけを `assets` へ移し、同じものは消し、違うものは退避名の側に
   残して報告します。
3. 戻した `assets` に同じ内容がある `css\fonts` と `js` のファイルを削除します。旧 assets と内容が違うもの
   (移行後に置いた、または git に記録された版と違う)は消さず、一覧で表示して残します。
4. 退避した作業コピー(drafts・pending・reviews の CSS)を戻します。作業コピーを移行後に編集していた場合、
   その編集は退避時点の内容で上書きされます。
5. appconfig のバックアップ(`appconfig.json.bak-<日付>`。同じ日に複数あれば最初のもの)を戻します。

2 回目以降(移行コミットが revert 済み)は、4 と 5 を行いません(1 回目の後に直した内容を上書きしないため)。

`assets.migrated-*` が無い環境(手で `assets` を消した、appconfig の片付けだけが動いた)でも止まらず、
2 の改名と 3 の削除を飛ばして(revert が `assets` を戻したときは 3 を行います)、残りを行います。戻す日付は `assets.migrated-<日付>`・
`appconfig.json.bak-<日付>`・`.fonts-to-css-backup-<日付>` から決めます。候補が複数あるときは
`-Date <yyyyMMdd>` で指定します。戻したあとは旧版の editor を配置して起動してください。

旧 assets を dataRoot の外(`ASSETS_DIR` / `paths.assetsDir` で別の場所)に置いていた環境では、
`rollback.bat` は `assets.migrated-*` を dataRoot の中しか探しません。その場所の改名は手で
元に戻してください。
````

- [ ] **Step 6: コミット**

```bash
git add editor/patches/2026-10-fonts-to-css/rollback.ps1 editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 editor/patches/2026-10-fonts-to-css/README.md
git commit -m "fix(editor): フォント移設の rollback が assets.migrated-* の無い環境でも revert と appconfig の復元を行い、README を改める"
```

---

### Task 12: 画像の置き場パッチ — 既知の形の取り込み・追跡の解除・GIT_BIN・履歴・取り違え

対応する設計: 6.7.1（画像の置き場パッチ側）、6.7.2 の 1 点目（同）、6.7.4「git の場所」「dataRoot の取り違え」（6.8.4 で改めた形）、6.8.5、6.7.6 の「2 本のパッチの README」（画像）。

**Files:**
- Modify: `editor/patches/2026-10-fund-images/apply.ps1`（UTF-8 BOM・LF を保つ）
- Modify: `editor/patches/2026-10-fund-images/rollback.ps1`（全体を置き換える。UTF-8 BOM・LF）
- Modify: `editor/patches/2026-10-fund-images/apply.Tests.ps1`（同）
- Modify: `editor/patches/2026-10-fund-images/README.md`（全体を置き換える）

削る記号の残り: `Test-OnlyImagesLineAdded` と `$pendingIgnoreOnly` は `apply.ps1` の中だけ（`git grep` で確認済み）。この Task で消す。`assets` が残っていれば中止する検査（136〜139 行）は残す（6.8.6 でフォント移設パッチが `assets` を必ず改名するので、手順どおりなら当たらない）。

**Interfaces:**
- Produces（スクリプト内）: `$gitExe`、`ConvertTo-ProcessArgument`、`Invoke-GitUtf8`、`Get-NormalizedText`、`Get-HeadText`、`Get-WorkText`、`Get-Lines`、`Test-KnownShape`、`$absorbed`・`$trackedFiles`・`$untrackPlaces`（フォント移設パッチと同じ規則の写し。共通 lib は作らない）
- 終了コード: dataRoot の取り違えは `exit 2`

- [ ] **Step 1: 失敗するテストを書く**

`apply.Tests.ps1` の `Invoke-Patch` を次に替える:

```powershell
# 実データへ触れないよう、置き場に効く環境変数と GIT_BIN を退避して空にし、APP_CONFIG を存在しない
# パスへ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
# $extraEnv のキーは $names のどれか(終わったら元へ戻す)。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$imagesDir, [hashtable]$extraEnv) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'IMAGES_DIR', 'GIT_BIN'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', (Join-Path $env:TEMP 'fund-img-no-appconfig.json'))
  if ($imagesDir) { [Environment]::SetEnvironmentVariable('IMAGES_DIR', $imagesDir) }
  if ($extraEnv) { foreach ($k in $extraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $extraEnv[$k]) } }
  try { & $file @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}
```

`Get-IgnoreLines` の定義の後に補助関数を足す:

```powershell
function Get-Message([scriptblock]$action) {
  $msg = ''
  try { & $action | Out-Null } catch { $msg = $_.Exception.Message }
  return $msg
}

function Write-Utf8([string]$path, [string]$text, [switch]$Bom) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding ([bool]$Bom)))
}
```

`Describe 'apply.ps1'` の既存の `It 'それ以外の未コミット変更があれば中止する'` の中の `{ Invoke-Patch … } | Should Throw` の行を次の 3 行に替える（中止の文面を確かめる）:

```powershell
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match 'css/510037\.css'
```

`Describe 'apply.ps1'` の末尾に足す:

```powershell
  It 'PATH に git が無くても GIT_BIN の git で流せる' {
    $root = New-Layout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }

  It '履歴(HEAD)の無い data リポジトリでは init-data-repo.bat を案内して中止する' {
    $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css'), (Join-Path $root 'templates') | Out-Null
      git -C $root init -q
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '履歴'
      $msg | Should Match 'init-data-repo\.bat'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'templates も css も無ければ取り違えとして警告し、何も変えずに終了コード 2 で終わる' {
    $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'notes') | Out-Null
      git -C $root init -q
      git -C $root -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
      $head = git -C $root rev-parse HEAD
      $global:LASTEXITCODE = 0
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } *>&1 | Out-String
      $LASTEXITCODE | Should Be 2
      $out | Should Match 'templates も css もありません'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'images') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: CSS の書き換えに加えて末尾に改行を 1 つ足しただけなら取り込む' {
    $root = New-Layout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') '@font-face{src:url(../fonts/a.woff2)}'
      git -C $root add -- css
      git -C $root -c user.name=t -c user.email=t@t commit -q -m legacy
      Write-Utf8 (Join-Path $root 'css\510037.css') "@font-face{src:url(fonts/a.woff2)}`n"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
      (git -C $root status --porcelain -- css) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形(.gitignore の /images/・CSS の ../fonts/ の書き換え・BOM 付き .gitattributes の置き換え)はまとめて取り込む' {
    $root = New-Layout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') '@font-face{src:url(../fonts/a.woff2)}'
      $attr = Join-Path $root '.gitattributes'
      [IO.File]::WriteAllBytes($attr, [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n")))
      git -C $root add -- css .gitattributes
      git -C $root -c user.name=t -c user.email=t@t commit -q -m legacy
      Write-Utf8 (Join-Path $root 'css\510037.css') '@font-face{src:url(fonts/a.woff2)}' -Bom
      Write-Utf8 $attr "* text eol=lf`n"
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/`n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $names = @(git -C $root show --name-only --format= HEAD)
      $names -contains '.gitignore' | Should Be $true
      $names -contains '.gitattributes' | Should Be $true
      $names -contains 'css/510037.css' | Should Be $true
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root status --porcelain -- .gitignore .gitattributes css) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 前回のパッチが途中で止まった形跡(REVERT_HEAD)があれば、その旨を案内する' {
    $root = New-Layout
    try {
      Set-Content -LiteralPath (Join-Path $root '.git\REVERT_HEAD') -Value (git -C $root rev-parse HEAD)
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '途中で止まった'
      $msg | Should Match 'REVERT_HEAD'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡されている画像・js は確認モードで一覧に出し、-Apply で追跡だけ外す(ファイルは残す)' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images'), (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- images js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'images/510037_logo\.svg'
      $out | Should Match 'js/w\.js'
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- css/fonts images js assets).Count | Should Be 0
      Test-Path (Join-Path $root 'images\510037_logo.svg') | Should Be $true
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      ((git -C $root show --name-status --format= HEAD) -join "`n") | Should Match 'D\s+images/510037_logo\.svg'
    } finally { Remove-Item -Recurse -Force $root }
  }
```

`Describe 'rollback.ps1'` の末尾に足す:

```powershell
  It '追跡された画像・js を -Apply で外したあとでも、rollback -Apply が通り、追跡が戻る' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images'), (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- images js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      ((@(git -C $root ls-files -- images js) | Sort-Object) -join ',') | Should Be 'images/510037_logo.svg,js/w.js'
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      @(Get-ChildItem $root -Directory -Force -Filter '.rollback-tmp-*').Count | Should Be 0
      (git -C $root status --porcelain -- images js) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡を外した後に中身を変えた js は、rollback で退避を残して報告する' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'changed()' -NoNewline
      $out = Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } *>&1 | Out-String
      $stamp = Get-Date -Format 'yyyyMMdd'
      Get-Content -Raw (Join-Path $root ".rollback-tmp-$stamp\js\w.js") | Should Be 'changed()'
      Get-Content -Raw (Join-Path $root 'js\w.js') | Should Be 'w()'
      $out | Should Match '退避に残しました'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は同じ日の退避に同じパスのファイルが既にあれば、何も変えずに中止する' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $old = Join-Path $root (".rollback-tmp-" + (Get-Date -Format 'yyyyMMdd') + '\js\w.js')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $old) | Out-Null
      Set-Content -LiteralPath $old -Value 'OLD' -NoNewline
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } }
      $msg | Should Match '同じ日の退避'
      Get-Content -Raw $old | Should Be 'OLD'
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'apply と rollback は -DataRoot の相対パスを今の場所を基準に解決する' {
    $root = New-Layout
    Push-Location (Split-Path -Parent $root)
    try {
      Invoke-Patch $script @{ DataRoot = (Split-Path -Leaf $root); Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      Invoke-Patch $roll @{ DataRoot = (Split-Path -Leaf $root); Apply = $true } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally {
      Pop-Location
      Remove-Item -Recurse -Force $root
    }
  }

  It 'PATH に git が無くても GIT_BIN の git で戻せる' {
    $root = New-Layout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fund-images/apply.Tests.ps1 -EnableExit"`
Expected: FAIL（足した件と、文面を確かめるようにした既存の 1 件。追跡を外した後の rollback は「untracked working tree files would be overwritten」で止まる）

- [ ] **Step 3: 実装する — apply.ps1**

`$allowedExt = '.svg', '.png', '.jpg', '.jpeg'` の行の直後に追加する:

```powershell
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する。PortableGit だけの端末で PATH に git が
# 無くても流せるようにするため。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
# -DataRoot の相対パスは PowerShell の今の場所を基準に絶対パスへ直す。Invoke-GitUtf8 が起動する git は
# PowerShell の今の場所を引き継がない(プロセスの作業フォルダは別)ため。
if ($DataRoot) { $DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }
```

`Invoke-Git` の中の `  $all = @(& git -C $DataRoot @args 2>&1)` を `  $all = @(& $gitExe -C $DataRoot @args 2>&1)` に替える。

`Invoke-Git` の閉じ括弧（`  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })` の次の `}`）の直後に追加する:

```powershell

function ConvertTo-ProcessArgument([string]$a) {
  # .NET Framework の ProcessStartInfo は引数を 1 本の文字列で受けるので、C ランタイムの規則で囲む
  # (空白・引用符を含む dataRoot や pathspec を 1 引数として渡すため)。
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-GitUtf8 {
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスや
  # ファイルの中身が化ける。未コミットの変更を中身で点検する読み取りは、出力を UTF-8 として自前で
  # 読む(変更を伴う git 呼び出しは Invoke-Git を使う)。
  param([Parameter(Mandatory = $true)][string[]]$GitArgs, [switch]$AllowFailure)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $gitExe
  $psi.Arguments = ((@('-C', $DataRoot) + $GitArgs) | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8NoBom
  $psi.StandardErrorEncoding = $utf8NoBom
  $proc = [Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0 -and -not $AllowFailure) {
    throw "git $($GitArgs -join ' ') が失敗しました(終了コード $($proc.ExitCode))。`n$($errTask.Result)"
  }
  return @{ Code = $proc.ExitCode; Out = $out }
}
```

`if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }` を次に替える:

```powershell
# templates も css も無い場所は、dataRoot の取り違え(別のフォルダを指している)とみなす。
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'templates')) -and -not (Test-Path -LiteralPath (Join-Path $DataRoot 'css'))) {
  Write-Warning ("$DataRoot に templates も css もありません。dataRoot を取り違えていないか確かめてください" +
    '(-DataRoot で指定できます)。何も変えずに終了します。')
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
if ((Invoke-GitUtf8 -GitArgs @('rev-parse', '--verify', '-q', 'HEAD') -AllowFailure).Code -ne 0) {
  throw ("$DataRoot の git には履歴(最初のコミット)がありません。editor\scripts\init-data-repo.bat -DataRoot " +
    "`"$DataRoot`" で初回コミット(確定領域だけを記録します)を作ってから再実行してください。")
}
```

`function Test-OnlyImagesLineAdded {` から、`$dirty` の判定の閉じ括弧までの次の部分（現在の 148〜166 行）:

```powershell
function Test-OnlyImagesLineAdded {
  # 新版のサーバ(gitRepo.ts の ensureGitignore)は承認時に足りない必須行を末尾へ足す。足したのが
  # /images/ の 1 行だけなら、それはこのパッチがする変更と同じなので取り込んで進める。
  $lines = @(Invoke-Git diff HEAD --unified=0 --no-color -- .gitignore)
  $changes = @($lines | Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^(\+\+\+|---)( |$)' })
  return ($changes.Count -eq 1 -and $changes[0] -ceq '+/images/')
}

# 見るのは確定領域(承認コミットの対象)だけ。css/fonts は git 管理外の置き場なので除く。
$dirty = @(Invoke-Git status --porcelain -- .gitignore .gitattributes templates filled css sync ':(exclude)css/fonts')
$pendingIgnoreOnly = $false
if ($dirty.Count -gt 0) {
  if ($dirty.Count -eq 1 -and $dirty[0] -match '^[ M]{2} \.gitignore$' -and (Test-OnlyImagesLineAdded)) {
    $pendingIgnoreOnly = $true
  } else {
    throw ("dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください:`n" +
      ($dirty -join "`n"))
  }
}
```

を次に替える:

```powershell
# ── 未コミットの変更の点検(2026-10-fonts-to-css の migrate.ps1 と同じ規則の写し) ──
# 手で dataRoot を作り直した直後や、新版のサーバが承認時に .gitignore へ必須行を足した後は、未コミット
# の変更が残る。このパッチ・フォント移設パッチ・init-data-repo・サーバが作るのと同じ形の変更だけなら
# 取り込んで同じコミットに含め、それ以外が 1 つでもあれば中止する。見るのは確定領域だけ(css/fonts は
# 除く)。比べる前に BOM を除き、改行を LF に揃える(構築済み環境の .gitattributes・.gitignore は BOM 付き・CRLF のことがある)。
$requiredIgnore = '/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '/images/', '*.tmp-*'
$rewriteRe = '(?i)(url\(\s*["'']?)\.\./fonts/'

function Get-NormalizedText([string]$s) {
  if ($null -eq $s) { return $null }
  return $s.TrimStart([char]0xFEFF).Replace("`r`n", "`n")
}

function Get-HeadText([string]$rel) {
  $r = Invoke-GitUtf8 -GitArgs @('cat-file', '-p', "HEAD:$rel") -AllowFailure
  if ($r.Code -ne 0) { return $null }
  return Get-NormalizedText $r.Out
}

function Get-WorkText([string]$rel) {
  $p = Join-Path $DataRoot ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  return Get-NormalizedText ([IO.File]::ReadAllText($p, $utf8NoBom))
}

function Get-Lines([string]$s) {
  if ($null -eq $s) { return @() }
  return @($s.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Test-KnownShape([string]$xy, [string]$rel) {
  # 候補は「変更・追加・未追跡」だけ(削除・改名・型の変更はパッチが作らない)。
  if ($xy -notmatch '^[ MA?][ M?]$') { return $false }
  $work = Get-WorkText $rel
  if ($null -eq $work) { return $false }
  $head = Get-HeadText $rel
  if ($rel -ceq '.gitignore') {
    # 既存の行を消さず、足したのが init-data-repo・サーバの必須行だけなら同じ形。
    $before = @(Get-Lines $head)
    $after = @(Get-Lines $work)
    foreach ($l in $before) { if ($after -cnotcontains $l) { return $false } }
    foreach ($l in $after) { if ($before -cnotcontains $l -and $requiredIgnore -cnotcontains $l) { return $false } }
    return $true
  }
  if ($rel -ceq '.gitattributes') {
    # サーバ(gitRepo.ts の ensureGitattributes)と同じ直し方: 先頭を正しい行にし、旧い無効行を落とす。
    $others = @(Get-Lines $head | Where-Object { $_ -cne '* text=lf' -and $_ -cne '* text eol=lf' })
    return ((@(Get-Lines $work) -join "`n") -ceq ((@('* text eol=lf') + $others) -join "`n"))
  }
  if ($rel -cmatch '^css/[^/]+\.css$' -and $null -ne $head) {
    # 末尾の改行 1 つの有無は、エディタが保存時に足すことがあるので差分に数えない。
    $want = ($head -replace $rewriteRe, '${1}fonts/') -replace '\n\z', ''
    return (($work -replace '\n\z', '') -ceq $want)
  }
  return $false
}

$statusOut = (Invoke-GitUtf8 -GitArgs @('status', '--porcelain=v1', '-z', '--untracked-files=all', '--',
  '.gitignore', '.gitattributes', 'templates', 'filled', 'css', 'sync', ':(exclude)css/fonts')).Out
$tokens = @($statusOut.Split([char]0) | Where-Object { $_ -ne '' })
$absorbed = @()
$foreign = @()
for ($i = 0; $i -lt $tokens.Count; $i++) {
  $xy = $tokens[$i].Substring(0, 2)
  $rel = $tokens[$i].Substring(3)
  # 改名・複写は元のパスが次の要素に続く(-z の書式)。どちらもパッチは作らない。
  if ($xy[0] -eq 'R' -or $xy[0] -eq 'C') { $i++ }
  if (Test-KnownShape $xy $rel) { $absorbed += $rel; continue }
  $foreign += "  $xy $rel"
}
if ($foreign.Count -gt 0) {
  $list = $foreign -join "`n"
  $traces = @(foreach ($n in 'index.lock', 'REVERT_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD') {
      if (Test-Path -LiteralPath (Join-Path $DataRoot ".git\$n")) { ".git\$n" }
    })
  if ($traces.Count -gt 0) {
    throw ("前回のパッチ(または rollback)が途中で止まった形跡があります($($traces -join ', '))。" +
      "git -C `"$DataRoot`" status で状態を確かめ、途中の操作を終えるか戻してから再実行してください。" +
      "次の未コミットの変更は、このパッチが作る形ではありません:`n$list")
  }
  throw ("手作業の変更が残っています。次の未コミットの変更は、パッチが作る形(.gitignore への必須行の追記・" +
    'CSS の ../fonts/ → fonts/ の書き換え・.gitattributes を * text eol=lf にしただけ)ではないため中止' +
    "しました。残すなら先にコミットし、要らなければ git -C `"$DataRoot`" checkout -- <ファイル> で戻して" +
    "から再実行してください:`n$list")
}

# 追跡された画像・フォント・js は、承認コミットのたびに版に残り続け、次の承認者の名前で更新される。
# ファイルは残して追跡だけ外し、同じ system コミットに含める。
$trackedFiles = @((Invoke-GitUtf8 -GitArgs @('ls-files', '-z', '--', 'css/fonts', 'images', 'js', 'assets')).Out.Split([char]0) | Where-Object { $_ -ne '' })
$untrackPlaces = @('css/fonts', 'images', 'js', 'assets' | Where-Object {
    $place = $_
    @($trackedFiles | Where-Object { $_.StartsWith("$place/") }).Count -gt 0
  })
```

`if ($pendingIgnoreOnly) { Write-Host '  (/images/ の 1 行が未コミットで追記済みです。この差分をコミットします)' }` を次に替える:

```powershell
if ($absorbed.Count -gt 0) {
  Write-Host "取り込む未コミットの変更(パッチと同じ形。同じコミットに含めます): $($absorbed.Count) 件"
  $absorbed | ForEach-Object { Write-Host "  $_" }
}
Write-Host "git の追跡から外すファイル(ファイルは残します): $($trackedFiles.Count) 件"
$trackedFiles | ForEach-Object { Write-Host "  $_" }
```

適用部の次の 8 行:

```powershell
Invoke-Git add -- .gitignore | Out-Null
$staged = Invoke-Git diff --cached --name-only -- .gitignore
if ($staged) {
  # 末尾の [fund-images] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: 画像の置き場を追加 [fund-images]' -- .gitignore | Out-Null
  Write-Host '.gitignore の変更を system 名義でコミットしました。'
}
```

を次に替える:

```powershell
if ($untrackPlaces.Count -gt 0) { Invoke-Git rm -r -q --cached -- @untrackPlaces | Out-Null }
$addPaths = @('.gitignore') + @($absorbed | Where-Object { $_ -ne '.gitignore' })
Invoke-Git add -- @addPaths | Out-Null
$staged = Invoke-Git diff --cached --name-only
if ($staged) {
  # 末尾の [fund-images] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: 画像の置き場を追加 [fund-images]' | Out-Null
  Write-Host '確定領域の変更を system 名義でコミットしました。'
}
```

冒頭のヘルプの `.DESCRIPTION` の処理順と中止条件（7〜17 行。`    3. .gitignore の変更を system 名義で 1 コミットする(件名末尾に [fund-images])` から `  その差分をコミットに含める(新版のサーバが承認時に先に追記した場合)。` まで）を次に替える:

```
    3. 追跡されている画像・フォント・js(css/fonts・images・js・assets)を git の追跡から外す
       (ファイルは残す)
    4. 確定領域の変更(.gitignore と、取り込んだ未コミットの変更)と追跡の解除を system 名義で
       1 コミットする(件名末尾に [fund-images])
  既に置かれた画像は点検して報告するだけで、動かしも消しもしない。SVG の中身の検査はサーバ
  (TypeScript 実装)が正なので、ここでは行わない。違反はサーバログの警告で確認する。
  次の場合は中止する: editor サーバが動いている、dataRoot が git リポジトリでない・履歴(HEAD)が
  無い、旧構成の assets が残っている(先に 2026-10-fonts-to-css を流す)、imagesDir が確定領域
  (templates / filled / css / sync)の内側にある、パッチが作る形でない未コミットの変更がある。
  未コミットの変更は 1 件ずつ点検し、.gitignore への必須行の追記・CSS の ../fonts/ → fonts/ の
  書き換え・.gitattributes を * text eol=lf にしただけなら取り込んで同じコミットに含める(BOM と
  改行コードの違いは除いて比べる)。templates も css も無いときは dataRoot の取り違えとみなし、
  何も変えずに終了コード 2 で終わる。git は環境変数 GIT_BIN があればそれを使う。
```

- [ ] **Step 4: 実装する — rollback.ps1**

`editor/patches/2026-10-fund-images/rollback.ps1` を次の内容で置き換える（先頭に UTF-8 BOM を保つ。改行は LF。Write は BOM を付けないので、直後の Run で付ける）:

```powershell
<#
.SYNOPSIS
  2026-10-fund-images の変更(.gitignore の /images/ と追跡の解除)を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。目印 [fund-images] を持つ移行コミット
  (Revert で始まる件名は除く)を git revert する。すでに revert 済みなら何もしない。
  移行で追跡を外したファイル(revert が戻すパス)が作業ツリーにあると git revert が上書きを拒む
  ので、revert の前に <dataRoot>\.rollback-tmp-<yyyyMMdd>\ へ退避し、revert の後に SHA256 で比べる。
  同じなら退避を消し、違えば退避に残して報告する。同じ日の退避に同じパスのファイルが既にあれば、
  何も変えずに中止する。
  git revert が失敗したときは revert --abort で元の状態へ戻し、退避したファイルも元へ戻してから
  中止し、git の出力を表示する。
  images フォルダと中の画像は消さない(別ツールが置いた git 管理外のもので、戻せないため)。
  新版のサーバは承認時に /images/ を再び追記するので、戻す意味があるのはサーバも旧版へ戻す
  場合に限る。
  git は環境変数 GIT_BIN があればそれを使う。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は apply.ps1 と同じ規則)。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
# git の場所はサーバ(gitRepo.ts)と同じく GIT_BIN を優先する(PATH に git が無い端末向け)。
$gitExe = if ($env:GIT_BIN) { $env:GIT_BIN } else { 'git' }
# -DataRoot の相対パスは PowerShell の今の場所を基準に絶対パスへ直す。Invoke-GitUtf8 が起動する git は
# PowerShell の今の場所を引き継がない(プロセスの作業フォルダは別)ため。
if ($DataRoot) { $DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Invoke-Git {
  # stderr の扱いは apply.ps1 と同じ(成功時の警告は捨て、失敗時だけ例外に載せる)。
  $ErrorActionPreference = 'Continue'
  $all = @(& $gitExe -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function ConvertTo-ProcessArgument([string]$a) {
  # .NET Framework の ProcessStartInfo は引数を 1 本の文字列で受けるので、C ランタイムの規則で囲む。
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-GitUtf8 {
  # PowerShell 5.1 はネイティブコマンドの出力をコンソールのコードページで読むので、日本語のパスが
  # 化ける。revert が戻すパスの一覧は、出力を UTF-8 として自前で読む。
  param([Parameter(Mandatory = $true)][string[]]$GitArgs)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $gitExe
  $psi.Arguments = ((@('-C', $DataRoot) + $GitArgs) | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8NoBom
  $psi.StandardErrorEncoding = $utf8NoBom
  $proc = [Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    throw "git $($GitArgs -join ' ') が失敗しました(終了コード $($proc.ExitCode))。`n$($errTask.Result)"
  }
  return $out
}

function Get-FileHashHex([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }

function Remove-EmptyDirs([string]$root) {
  # 深いフォルダから順に、空になったものだけ消す(中身の残るフォルダは消さない)。
  if (-not (Test-Path -LiteralPath $root)) { return }
  Get-ChildItem -LiteralPath $root -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
  }
  if (-not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force }
}

# ── 1. 置き場の解決(apply.ps1 と同じ規則) ──
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }
function Get-CfgPath([string]$key) {
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) { return [string]$cfgPaths.$key }
  return $null
}
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT
  if (-not $DataRoot) { $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User') }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data' }
}
$imagesDir = if ($env:IMAGES_DIR) { Resolve-EditorPath $env:IMAGES_DIR }
  elseif (Get-CfgPath 'imagesDir') { Resolve-EditorPath (Get-CfgPath 'imagesDir') }
  else { Join-Path $DataRoot 'images' }

# ── 2. 戻す対象の特定 ──
# rollback 自身の revert コミットも件名に [fund-images] を含むので、Revert で始まる件名は除く。
# すでに revert 済み(This reverts commit <sha>)なら再 revert しない。
$commit = $null
foreach ($line in (Invoke-Git log --author=system --grep '\[fund-images\]' --format='%H %s')) {
  $sha, $subject = $line -split ' ', 2
  if ($subject -like 'Revert *') { continue }
  $commit = $sha
  break
}
$alreadyReverted = [bool]($commit -and (Invoke-Git log --grep "This reverts commit $commit" --format=%H -1))

# revert が戻すパス(移行コミットで削除扱いになったもの = 追跡を外したファイル)。同じパスに作業
# ツリーのファイルがあると、git revert は .gitignore 済みの置き場では黙って上書きし(終了コード 0)、
# それ以外(js など)では上書きを拒む。どちらでも作業ツリーの内容を失わないよう、戻すパスにある
# ファイルはすべて revert の前に退避する。
$toStash = @()
if ($commit -and -not $alreadyReverted) {
  $restorePaths = @((Invoke-GitUtf8 -GitArgs @('diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--diff-filter=D', $commit)).Split([char]0) |
    Where-Object { $_ -ne '' })
  $toStash = @($restorePaths | Where-Object { Test-Path -LiteralPath (Join-Path $DataRoot ($_ -replace '/', '\')) -PathType Leaf })
}
$stashRoot = Join-Path $DataRoot ('.rollback-tmp-' + (Get-Date -Format 'yyyyMMdd'))
# 同じ日の退避に同じパスのファイルがあると、前回の rollback で残したもの(戻した版と内容が違った
# もの)を黙って上書きしてしまう。何も変えずに中止して片付けを求める。
$stashClash = @($toStash | Where-Object { Test-Path -LiteralPath (Join-Path $stashRoot ($_ -replace '/', '\')) })
if ($stashClash.Count -gt 0) {
  throw ("同じ日の退避が既にあります($stashRoot)。前回の rollback で残したファイルと見比べて片付けてから" +
    "再実行してください:`n$(($stashClash | ForEach-Object { "  $_" }) -join "`n")")
}

Write-Host "dataRoot: $DataRoot"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "revert の前に退避するファイル(追跡を戻すパスにあるもの。revert 後に同じ内容なら消します): $($toStash.Count) 件"
$toStash | ForEach-Object { Write-Host "  $_" }
Write-Host "images フォルダ($imagesDir)と中の画像は消しません。不要なら手で消してください。"
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 3. 適用 ──
$stashKept = @()
if ($commit -and -not $alreadyReverted) {
  $moved = @()
  foreach ($rel in $toStash) {
    $src = Join-Path $DataRoot ($rel -replace '/', '\')
    $dst = Join-Path $stashRoot ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Move-Item -LiteralPath $src -Destination $dst -Force
    $moved += $rel
  }
  try {
    Invoke-Git -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null
  } catch {
    # 競合したまま止まると REVERTING 状態と競合マーカーが残るので、元の状態へ戻してから中止する。
    # 退避したファイルも元の場所へ戻す(流す前の作業ツリーに揃える)。
    try { Invoke-Git revert --abort | Out-Null } catch { Write-Warning 'git revert --abort にも失敗しました。手動で確認してください。' }
    foreach ($rel in $moved) {
      $back = Join-Path $DataRoot ($rel -replace '/', '\')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $back) | Out-Null
      Move-Item -LiteralPath (Join-Path $stashRoot ($rel -replace '/', '\')) -Destination $back -Force
    }
    Remove-EmptyDirs $stashRoot
    throw
  }
  foreach ($rel in $moved) {
    $restored = Join-Path $DataRoot ($rel -replace '/', '\')
    $kept = Join-Path $stashRoot ($rel -replace '/', '\')
    if ((Test-Path -LiteralPath $restored) -and ((Get-FileHashHex $restored) -eq (Get-FileHashHex $kept))) {
      Remove-Item -LiteralPath $kept -Force
    } else { $stashKept += $kept }
  }
  Remove-EmptyDirs $stashRoot
}
if ($stashKept.Count -gt 0) {
  Write-Host '【報告】revert が戻した版と内容が違うため、退避に残しました(必要なら手で見比べてください):'
  $stashKept | ForEach-Object { Write-Host "  $_" }
}
Write-Host '元に戻しました。サーバも旧版へ戻す場合だけ意味があります(新版は承認時に /images/ を再び追記します)。'
```

rollback.ps1 に BOM を付ける（Write は BOM を付けないため）:

Run（Bash）: `p=editor/patches/2026-10-fund-images/rollback.ps1; head -c 3 "$p" | od -An -tx1 | grep -q 'ef bb bf' || { { printf '\xef\xbb\xbf'; cat "$p"; } > "$p.tmp" && mv "$p.tmp" "$p"; }`

3 ファイルの BOM と改行を確かめる:

Run: `for f in apply.ps1 rollback.ps1 apply.Tests.ps1; do head -c 3 editor/patches/2026-10-fund-images/$f | od -An -tx1; done; file editor/patches/2026-10-fund-images/*.ps1`
Expected: 3 行とも ` ef bb bf`。3 つとも `UTF-8 (with BOM) text`（CRLF の記載なし）

- [ ] **Step 5: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fund-images/apply.Tests.ps1 -EnableExit"`
Expected: PASS（全件。既存の `.gitignore に /images/ だけが…`・`/images/ 以外の行も…`・`assets が残っている…` を含む）

Run: `git grep -n "Test-OnlyImagesLineAdded\|pendingIgnoreOnly" -- editor`
Expected: 出力なし

- [ ] **Step 6: README を書き直す**

`editor/patches/2026-10-fund-images/README.md` を次の内容で置き換える:

````markdown
# 2026-10-fund-images パッチ

editor の data リポジトリに、ファンド別画像の置き場 `images` を用意する一度きりのパッチです。
`.gitignore` に `/images/` を足して画像を git の記録対象から外し、`images` フォルダを作ります。

管理者が行う作業です。`.gitignore` などの変更を承認なしで `system` 名義のコミットにします。

構築済み環境を新版へ上げるときの順番は運用手順書の 3.3 節にあります(`2026-10-fonts-to-css` →
このパッチ → `editor\scripts\init-data-repo.bat`)。

## 前提

- `2026-10-fonts-to-css` の移行が済んでいること。`<dataRoot>\assets` が残っている環境では中止し、
  先にそちらを流すよう案内します(`2026-10-fonts-to-css` は `assets` を中身にかかわらず
  `assets.migrated-<日付>` へ改名します)。`2026-10-fonts-to-css` を元に戻して `assets` が戻った環境でも
  同じく中止します(正しい挙動です)。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot が git リポジトリで、履歴(最初のコミット)があること。`git init` だけで履歴が無いときは
  中止し、`editor\scripts\init-data-repo.bat` で初回コミット(確定領域だけを記録)を作るよう案内します。
- 画像の置き場(`IMAGES_DIR` / appconfig の `paths.imagesDir`)が確定領域の内側にないこと
  (内側なら中止します。サーバも同じ条件で起動を止めます)。

## 手順

1. editor サーバを止める。
2. 新版の editor を配置する。
3. `apply.bat` を引数なしで実行し、確認モードで変更内容と点検結果を見る(何も変えません)。
4. `apply.bat -Apply` で実行する。
5. 構築済み環境の更新なら `editor\scripts\init-data-repo.bat` を流す。
6. editor を起動する。

dataRoot は `-DataRoot <path>` で指定できます。省略時はサーバと同じ順(環境変数 `DATA_ROOT`、
ユーザー環境変数、appconfig の `paths.dataRoot`、既定)で決めます。画像の置き場は
`IMAGES_DIR`、appconfig の `paths.imagesDir`、`<dataRoot>\images` の順で決め、出典を表示します。
稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。git は環境変数 `GIT_BIN` があれば
それを使います(PATH に git が無い端末向け)。

## 何をするか

- `.gitignore` に `/images/` を追記する(画像を置く前に追跡外にする)。
- `images` フォルダが無ければ作る。
- 追跡されている画像・フォント・js(`css/fonts`・`images`・`js`・`assets`)を git の追跡から外す
  (ファイルは残します)。
- `.gitignore` の変更・取り込んだ未コミットの変更・追跡の解除を、`system` 名義の 1 コミット
  (件名末尾に `[fund-images]`)にする。

すでに `/images/` がコミット済みで `images` もあれば、何も変えずに終わります(コミットも作りません)。

## 未コミットの変更

確定領域(`templates` / `filled` / `css` / `sync` / `.gitignore` / `.gitattributes`。`css\fonts` は
除く)に未コミットの変更があると、1 件ずつ点検します。次の形だけなら取り込んで、同じコミットに
含めます(BOM と改行コードの違いは除いて比べます)。

- `.gitignore` に必須の行(`/drafts/` `/reviews/` `/pending/` `/notes/` `/css/fonts/` `/images/`
  `*.tmp-*`)を足しただけ(新版のサーバが承認時に先に足した場合を含む)
- CSS(`css` 直下の `.css`)の `url(../fonts/…)` → `url(fonts/…)` の書き換えだけ
- `.gitattributes` を `* text eol=lf` にしただけ(旧い `* text=lf` を落とし、他の行は残す)
- 中身の無いフォルダの新規作成(git には見えません)

それ以外が 1 つでもあれば一覧を出して中止します(何も変えません)。前回のパッチや rollback が途中で
止まった形跡(`.git\index.lock`・`REVERT_HEAD` など)があればその旨を、無ければ「手作業の変更が
残っています」と案内します。

## 終了コード

`<dataRoot>\templates` も `<dataRoot>\css` も無いときは、dataRoot の取り違えとして警告し、何も変えずに
終了コード 2 で終わります。

## 報告だけするもの

既に置かれている画像を点検し、次を一覧で表示します。動かしも消しもしません。

- `[subfolder]` `images` 直下以外(サブフォルダ)に置かれたファイル。配信されません。
- `[extension]` 許可外の拡張子(`.svg` `.png` `.jpg` `.jpeg` 以外)。配信されません。
- `[naming]` 命名 `<fund>_<名前>.<拡張子>` に合わないファイル。配信はされますが、約束から外れます。

SVG の中身の検査はサーバが行います(パッチは行いません)。違反した SVG はどの経路でも表示されず、
サーバログに警告(ファイル名と違反の内容)が出ます。

## 画像の置き方と外部ツールへの約束

- 置き場は `<dataRoot>\images\` の直下だけ。サブフォルダは作らない。
- ファイル名は `<fund>_<画像名>.<拡張子>`(例 `510037_logo.svg`)。拡張子は `.svg` `.png` `.jpg` `.jpeg`。
- 書き込みは一時名で書いてから改名する(書きかけを読ませないため)。
- 値入り HTML の参照は確定したパス(`images/510037_logo.svg`)で書き、`{{ fund.code }}` を残さない。
- SVG には `width` と `height` を書く(無いと `<img>` で 300×150 になる)。
- Illustrator は「書き出し(SVG 1.1)」で保存する。「Illustrator の編集機能を保持」で保存した SVG は
  検査で落ちます。

## 元に戻す

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

目印 `[fund-images]` の移行コミットを `git revert` します(すでに revert 済みなら飛ばします)。
追跡を外したファイルは revert で再び追跡されます。revert の前に、戻る場所にあるファイルを
`<dataRoot>\.rollback-tmp-<日付>\` へ退避し、revert の後に同じ内容なら退避を消し、違えば(戻した版と
内容が違うもの)退避に残して報告します。同じ日の退避に同じパスのファイルが既にあれば、何も
変えずに中止します。revert が失敗したときは `git revert --abort` で戻し、退避した
ファイルも元へ戻してから中止し、git の出力を表示します。

`images` フォルダと中の画像は消しません(別ツールが置いた git 管理外のもので、戻せないため)。
不要なら手で消してください。

新版のサーバは承認時に `.gitignore` へ `/images/` を再び追記します。元に戻すことに意味があるのは、
サーバも旧版へ戻す場合だけです。
````

- [ ] **Step 7: コミット**

```bash
git add editor/patches/2026-10-fund-images/apply.ps1 editor/patches/2026-10-fund-images/rollback.ps1 editor/patches/2026-10-fund-images/apply.Tests.ps1 editor/patches/2026-10-fund-images/README.md
git commit -m "feat(editor): 画像の置き場パッチが既知の形の未コミット変更を取り込み、追跡済みの画像・js の追跡を外し、GIT_BIN と取り違えの検出に対応する"
```

---

### Task 13: 構築済み環境の更新手順を運用手順書へ足し、設計書の HTML を作り直す

対応する設計: 6.5（更新手順。手順 2 を必須として目立たせる）、6.7.4「足りないフォルダ」（`init-data-repo.bat` を手順に入れる）、6.8.3（その位置は 2 本のパッチの後）、6.3 の「文書の記述をパッチで片付ける形に改める」（運用手順書の移行の節）、6.7.6 の「文書の更新先」（設計書・運用手順書）。

**Files:**
- Modify: `docs/editor/src/デプロイ運用手順書.md`（front matter、3.1 節の「旧構成からの移行」と「既存環境への画像の置き場の追加」、3.3 節の新設）
- Modify: `docs/editor/src/設計書.md`（front matter、15.2 節）
- Modify: `README.md`（入口スクリプト一覧の 57 行）
- Modify: `docs/editor/editor_設計.html`（再生成）

- [ ] **Step 1: 運用手順書に 3.3 節を足す**

`docs/editor/src/デプロイ運用手順書.md`:

- front matter の `version: "1.6"` を `version: "1.7"` にし、`rev:` の最後の行の後に `  - 1.7 | 2026-10-02 | 生成器の起動を PATH 上の python へ（3.2 節）、旧構成の起動時検査を警告へ（設定表）、構築済み環境の更新手順（3.3 節）` を足す。
- 3.1 節の「旧構成（`assets\fonts` / `assets\js`）からの移行:」の見出し行から「元に戻すときは、サーバを止めて `rollback.bat`（確認）、`rollback.bat -Apply` の順に実行する。詳細は `editor/patches/2026-10-fonts-to-css/README.md` を見る。」の行まで（112〜121 行）を次に替える:

```
旧構成（`assets\fonts` / `assets\js`）からの移行は、3.3 節の手順 2（フォント移設パッチ）で行う。詳細と元に戻し方は `editor/patches/2026-10-fonts-to-css/README.md` を見る。
```

- 3.1 節の「既存環境への画像の置き場の追加:」の見出し行から「詳細と元に戻し方は `editor/patches/2026-10-fund-images/README.md` を見る。」の行まで（135〜143 行）を次に替える:

```
既存環境への画像の置き場の追加は、3.3 節の手順 3（画像の置き場パッチ）で行う。詳細と元に戻し方は `editor/patches/2026-10-fund-images/README.md` を見る。
```

- `# 4. SQL Server セットアップ（rest モード）` の行の直前に、次の節を挿入する:

```
## 3.3 構築済み環境を新版へ上げる

フォントの置き場の移設（`css\fonts`・`js`）と画像の置き場（`images`）より前に構築した環境は、次の順で上げる。新版のサーバは旧構成のままでも起動を止めない。**手順 2 を飛ばすと、フォントと JS が欠けた PDF が成功扱いで出る**（起動ログに `[layout]` の警告は出る）。

1. editor サーバを止め、新版を配置する。
2. **（必須）フォント移設パッチを流す。** `editor\patches\2026-10-fonts-to-css\migrate.bat` を引数なしで実行し（確認モード。何も変えない）、表示を確かめてから `migrate.bat -Apply` で実行する。次がまとめて動く。
   - `assets\fonts` → `css\fonts`、`assets\js` → `js` の移設（旧 `assets` は中身にかかわらず `assets.migrated-<日付>` へ改名して残す）、CSS の `url(../fonts/…)` → `url(fonts/…)` の書き換え、`.gitignore` への `/css/fonts/` の追記。
   - 追跡されているフォント・画像・js の追跡の解除（ファイルは残す）。
   - appconfig の片付け: `paths.assetsDir` を `paths.jsDir` へ置き換え、editor のフォルダの中を指す置き場の設定（旧例の `data/templates` など）、旧い仮の生成器を指す `python.script`、既定と同じ `python.bin` / `python.args` を外す（元は `appconfig.json.bak-<日付>`）。
   環境変数 `ASSETS_DIR` を設定していた場合は手で外す（新版は読まない。パッチは環境変数を変えない）。
3. 画像の置き場パッチを流す。`editor\patches\2026-10-fund-images\apply.bat`（確認モード）→ `apply.bat -Apply`（`.gitignore` に `/images/` を足し、`images` を作る）。
4. `editor\scripts\init-data-repo.bat` を流す（足りない置き場のフォルダだけを作る。履歴があれば git には触らない）。2 本のパッチの**後**に流す。先に流すと空の `css\fonts` が作られ、パッチの点検を誤らせる。
5. Python 3.13 が PATH で通っていることを、新しいコマンドプロンプトの `python --version` で確かめる（3.2 節）。本番の生成器の場所を `PY_GENERATE_SCRIPT`、指紋を `PY_GENERATE_SCRIPT_SHA256` に設定する。
6. 新しいコマンドプロンプトから起動し、起動ログに `[generate]`（版・指紋・偽物のまま）と `[layout]`（旧構成の残り）の警告が出ていないことを確かめる。フォントを使うテンプレートで PDF を出し、フォントと JS が効いていることを確かめる。

dataRoot を手で作り直した場合も、同じ手順で流す。2 本のパッチは結果を点検して直す。

- 未コミットの変更は、パッチが作るのと同じ形（CSS の `../fonts/` → `fonts/` の書き換え、`.gitignore` への必須行の追記、`.gitattributes` を `* text eol=lf` にしただけ、空のフォルダ）なら取り込んで同じコミットに含める。それ以外が残っていると一覧を出して中止するので、残すならコミットし、要らなければ戻してから流し直す。
- `git init` だけで履歴の無い data リポジトリは中止する。`init-data-repo.bat` で初回コミット（確定領域だけを記録）を作ってから流す。
- `templates` も `css` も無い場所を指していると、dataRoot の取り違えとして何も変えずに終了コード 2 で終わる。
- 配信されない場所のフォント（`<dataRoot>\fonts`・css 直下のフォント・`assets.migrated-*` 以外の `assets*`）と、新版が読まない旧い形式のデータ（配列でないメモ・`held` の申請・`filled` が無いこと）は報告だけする。旧い形式のデータは手で直す。

元に戻すときは、2 本のパッチの `rollback.bat`（確認）→ `rollback.bat -Apply` を、画像の置き場 → フォント移設の順に流し、旧版の editor を配置する。
```

- [ ] **Step 2: 設計書・ルート README を直す**

`docs/editor/src/設計書.md`:

- front matter の `version: "2.7"` を `version: "2.8"` にし、`rev:` の最後の行の後に `  - 2.8 | 2026-10-02 | 生成器の起動を PATH 上の python へ、旧構成の起動時検査を警告へ、旧データ向けの互換処理の撤去の反映` を足す。
- 15.2 節の段落の末尾に次の 2 文を足す:

```
構築済み環境を新版へ上げる手順（フォント移設パッチ → 画像の置き場パッチ → `init-data-repo`）も同書 3.3 節にある。旧構成のままでもサーバは起動を止めず、起動ログの `[layout]` 警告で知らせる（15.3 節）。
```

`README.md` 57 行 `| `editor/patches/2026-10-fonts-to-css/migrate.bat` | data リポジトリのフォント・js の置き場を新構成へ移す(既定は確認モード、`-Apply` で実行) |` を次に替える:

```
| `editor/patches/2026-10-fonts-to-css/migrate.bat` | data リポジトリのフォント・js の置き場を新構成へ移し、appconfig の旧構成の設定を片付ける(既定は確認モード、`-Apply` で実行) |
```

- [ ] **Step 3: 設計書の HTML を作り直す**

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `editor/editor_設計.html` を書いた旨の出力（`editor_手引き.html` も書き直されることがあるが、コミットしない）

Run: `git grep -n -E "指定が残っていると起動を中止する|py -3\.13 <スクリプト>|py ランチャか Python 3\.13 が無い|python\.args. で .-3\.13. を指定" -- "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計書.md"`
Expected: 出力なし（原稿に旧い記述が残っていない。HTML は `<` やバッククォートを変換するので、原稿で確かめる）

Run: `grep -c -e "指定が残っていると起動を中止する" -e "py -3.13 &lt;スクリプト&gt;" -e "py ランチャか Python 3.13 が無い" docs/editor/editor_設計.html`
Expected: `0`（HTML に変換後も残る形の語句で、再生成した HTML にも旧い記述が無いことを確かめる）

Run: `git grep -c "3.3 構築済み環境を新版へ上げる" -- docs/editor/editor_設計.html`
Expected: `docs/editor/editor_設計.html:1` 以上

Run: `pnpm run check:comments && pnpm run check:canon-summary`
Expected: 成功

- [ ] **Step 4: コミット**

```bash
git add "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計書.md" README.md "docs/editor/editor_設計.html"
git commit -m "docs(editor): 構築済み環境を新版へ上げる手順を運用手順書へ足し、設計書の HTML を作り直す"
```

`git status --short` で、`docs/editor/editor_手引き.html`・`docs/editor/images/*.png`・`docs/pdf-to-svg/*`・ルート `.gitignore` が未コミットのまま残っていることを確かめる（この計画では触らない）。

---

### Task 14: 全体の検証と実機確認

**Files:** なし（確認のみ。直しが出たら該当 Task のファイルを直して追加コミット）

- [ ] **Step 1: 型・テスト・検査**

Run: `pnpm typecheck:editor && pnpm run test:editor && pnpm run test:scripts && pnpm run check:comments && pnpm run check:canon-summary`
Expected: すべて成功

Run: `pnpm run ci:offline`
Expected: PASS

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1 -EnableExit; Invoke-Pester -Script editor/patches/2026-10-fund-images/apply.Tests.ps1 -EnableExit; Invoke-Pester -Script editor/scripts/init-data-repo.Tests.ps1 -EnableExit"`
Expected: 3 本とも PASS

- [ ] **Step 2: coverage と e2e**

Run: `pnpm run test:coverage`
Expected: `config.ts`・`generatorCheck.ts`・`legacyLayoutCheck.ts`・`notesFile.ts` がそれぞれ全指標 85% 以上で、全体の閾値を満たす

Run: `pnpm run build:editor && pnpm run test:e2e`
Expected: 成功（作成タブの e2e は PATH 上の `python` で偽の生成器を動かす）

- [ ] **Step 3: 削った記号の残りが無いこと**

Run: `git grep -n -E "assertNoRetiredAssetsDir|assertNoLegacyAssetsDir|explicitBin|DEFAULT_PYTHON_ARGS|Test-Python313Launcher|Get-NativeExitCode|legacyUndoStacksKeyV1|LEGACY_NOTES_KEY|LEGACY_UNDO_STACKS_KEY|UNDO_STACKS_PREFIX_V1|Test-OnlyImagesLineAdded|pendingIgnoreOnly" -- . ':!docs/superpowers'`
Expected: 出力なし

Run: `git grep -n "legacy:" -- editor`
Expected: 出力なし

Run: `git grep -n "heldBy\|holdComment\|'held'" -- editor/server/src editor/web/src editor/shared/src`
Expected: 出力なし

Run: `git grep -n -E "ASSETS_DIR|assetsDir" -- editor/server editor/web editor/shared`
Expected: `editor/server/test/config.paths.test.ts` だけ（`ASSETS_DIR` を読まないこと・`assetsDir` が不明なキーになることのテスト）

Run: `git grep -n -E "py -3\.13|py ランチャ" -- editor offline ':!*.html'`
Expected: `editor/server/test/fakeGenerator.test.ts`（6.1 で残すと決めた開発機のテスト）、`editor/README.md` 98 行（docs のビルド）、`editor/shared/test/fixtures/svg/tools/README.md`（開発用の道具）、`editor/server/src/generate/pyTemplate.ts` のコメント（py ランチャを指定した場合）だけ

Run: `git grep -n "generate_template.py" -- editor`
Expected: `editor/patches/2026-10-fonts-to-css/migrate.ps1`・`README.md`（旧い仮の生成器の検出と説明）、`editor/server/test/generatorCheck.test.ts`（偽物でない名前の例）、`fake_generate_template.py` を含む行だけ

- [ ] **Step 4: 開発用データの状態を記録する（読むだけ）**

Run（Bash）: `git -C /c/Users/caads/editor-data rev-parse HEAD; git -C /c/Users/caads/editor-data status --porcelain | md5sum`
Expected: 2 行（HEAD とハッシュ）。値を控えておき、Step 9 で同じであることを確かめる。

Run（PowerShell）: `[Environment]::GetEnvironmentVariable('PYTHON_BIN','User'); [Environment]::GetEnvironmentVariable('PYTHON_BIN','Machine'); where.exe python`
Expected: 1・2 行目は空。`where.exe python` の 1 件目が `C:\Users\caads\AppData\Local\Programs\Python\Python313\python.exe`

- [ ] **Step 5: 実機 — サーバの起動ログ（PATH 上の python と旧構成の警告）と生成**

Bash のシェル変数は呼び出しをまたいで残らないので、以下の各コマンドの先頭で `V=/c/Users/caads/AppData/Local/Temp/editor-followup-verify` を定義し直す。

一時の dataRoot を作る（旧構成の残りを置く）:

```bash
V=/c/Users/caads/AppData/Local/Temp/editor-followup-verify
rm -rf "$V" && mkdir -p "$V/data/templates" "$V/data/css" "$V/data/assets/fonts" "$V/logs"
printf '<p>元テンプレ確認</p>' > "$V/data/templates/AM01_510037_20240710_交付版.html"
printf '@font-face{src:url(../fonts/a.woff2)}' > "$V/data/css/510037.css"
printf '{}' > "$V/appconfig.json"
```

サーバを背景で起動する（Bash の `run_in_background`。`PYTHON_BIN` を外し、置き場はすべて一時の場所へ向ける。`ASSETS_DIR` はわざと設定して、読まれないことを確かめる）:

```bash
V=/c/Users/caads/AppData/Local/Temp/editor-followup-verify
cd /c/Users/caads/workspace/editor/server && env -u PYTHON_BIN -u PY_GENERATE_SCRIPT -u PY_GENERATE_SCRIPT_SHA256 APP_CONFIG="$V/appconfig.json" DATA_ROOT="$V/data" GIT_REPO_DIR="$V/data" TEMPLATES_DIR="$V/data/templates" FILLED_DIR="$V/data/filled" CSS_DIR="$V/data/css" JS_DIR="$V/data/js" IMAGES_DIR="$V/data/images" DRAFTS_DIR="$V/data/drafts" PENDING_DIR="$V/data/pending" REVIEWS_DIR="$V/data/reviews" SYNC_DIR="$V/data/sync" ASSETS_DIR="$V/whatever" LOG_DIR="$V/logs" TMP_DIR="$V/tmp" AUTH_REQUIRED=false PORT=24690 pnpm exec tsx src/index.ts
```

起動ログに次が出ることを確かめる:
- `[generate] 生成器の Python: 3.13(python)`
- `[layout] 旧構成の …editor-followup-verify…assets が残っています`
- `[layout] …css の CSS に url(../fonts/ が残っています(510037.css)`

元テンプレ指定なし:

Run: `curl -s -X POST http://localhost:24690/api/generate -H 'content-type: application/json' -d '{"companyCode":"AM01","fundCode":"510037","editionType":"交付版"}' | head -c 400`
Expected: `{"template":{"meta":{"id":"AM01_510037_<今日>_交付版"` で始まり、`html` に `ファンド: 510037` を含む

元テンプレ指定あり:

Run: `curl -s -X POST http://localhost:24690/api/generate -H 'content-type: application/json' -d '{"companyCode":"AM01","fundCode":"510037","editionType":"交付版","basedOnTemplateId":"AM01_510037_20240710_交付版"}' | head -c 400`
Expected: `html` が `<p>元テンプレ確認</p>`

サーバを止める（背景タスクを停止する）。

- [ ] **Step 6: 実機 — 構築済み環境を模した旧構成の dataRoot でパッチを流す**

PowerShell ツールで、構築済み環境の断面（`assets` にフォントと js、CSS は `url(../fonts/…)`、`.gitattributes` は BOM 付きの `* text=lf`、`images` 無し、`filled` あり）と旧例の appconfig を作る:

```powershell
$V = 'C:\Users\caads\AppData\Local\Temp\editor-followup-patches'
if (Test-Path $V) { Remove-Item -Recurse -Force $V }
function New-BuiltEnv([string]$root) {
  foreach ($d in 'assets\fonts', 'assets\js', 'css', 'templates', 'filled', 'drafts', 'pending', 'reviews', 'notes', 'sync') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
  }
  Copy-Item 'C:\Windows\Fonts\arial.ttf' (Join-Path $root 'assets\fonts\a.ttf')
  Set-Content -LiteralPath (Join-Path $root 'assets\js\w.js') -Value 'w()' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '@font-face{font-family:A;src:url(../fonts/a.ttf)}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'templates\AM01_510037_20240710_交付版.html') -Value '<p>t</p>' -NoNewline -Encoding UTF8
  [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/drafts/`n/reviews/`n/pending/`n/notes/`n*.tmp-*`n", (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllBytes((Join-Path $root '.gitattributes'), [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n")))
  git -C $root init -q
  git -C $root add -- .gitignore .gitattributes css templates
  git -C $root -c user.name=builder -c user.email=b@b commit -q -m built
}
New-BuiltEnv "$V\base"
[IO.File]::WriteAllText("$V\appconfig.json", '{"port":24680,"paths":{"templatesDir":"data/templates","cssDir":"data/css","pendingDir":"data/pending","tmpDir":".tmp","logDir":"logs","webDist":"web/dist"},"python":{"bin":"python","script":"server/scripts/generate_template.py","timeoutMs":30000}}', (New-Object Text.UTF8Encoding $false))
foreach ($n in 'DATA_ROOT', 'TEMPLATES_DIR', 'FILLED_DIR', 'CSS_DIR', 'JS_DIR', 'IMAGES_DIR', 'ASSETS_DIR', 'DRAFTS_DIR', 'PENDING_DIR', 'REVIEWS_DIR', 'SYNC_DIR', 'GIT_BIN') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
$env:APP_CONFIG = "$V\appconfig.json"
```

（以下、同じ PowerShell の呼び出しの中で続けるか、各呼び出しの先頭で `$V` と `$env:APP_CONFIG` を設定し直す。）

確認モード → 適用 → 2 回目 → 画像の置き場パッチ → init-data-repo:

```powershell
& C:\Users\caads\workspace\editor\patches\2026-10-fonts-to-css\migrate.bat -DataRoot "$V\base" -Port 24690
& C:\Users\caads\workspace\editor\patches\2026-10-fonts-to-css\migrate.bat -DataRoot "$V\base" -Port 24690 -Apply
& C:\Users\caads\workspace\editor\patches\2026-10-fonts-to-css\migrate.bat -DataRoot "$V\base" -Port 24690 -Apply
& C:\Users\caads\workspace\editor\patches\2026-10-fund-images\apply.bat -DataRoot "$V\base" -Port 24690 -Apply
& C:\Users\caads\workspace\editor\scripts\init-data-repo.bat -DataRoot "$V\base"
```

確かめること（Bash で `git -C …` を見る。日本語の件名は Bash で読む）:
- 1 回目（確認モード）: 「旧構成の置き場の設定を外す」に `paths.templatesDir` `paths.cssDir` `paths.pendingDir`、`python.bin を外します`、`python.script を外します`、`.gitattributes` は未コミットの変更が無いので取り込み 0 件、`cssDir   : …\base\css (既定(dataRoot\css))`。何も変わっていない（`git -C …/base status --porcelain` が空）。
- 2 回目（-Apply）: `css\fonts\a.ttf`・`js\w.js` があり、`assets.migrated-<今日>` に改名、`css\510037.css` が `url(fonts/a.ttf)`、`git log -1 --format='%an %s'` が `system 移行: フォント置き場の移設(assets/fonts → css/fonts) [fonts-to-css]`、appconfig は `paths` に `tmpDir` `logDir` `webDist`、`python` に `timeoutMs` だけ、`appconfig.json.bak-<今日>` が元の内容。
- 3 回目（-Apply の再実行）: HEAD が変わらない。
- 画像の置き場パッチ: `.gitignore` に `/images/`、`images` フォルダ、`[fund-images]` のコミット。
- init-data-repo: 「既に初期化済みです(スキップ)」で、HEAD が変わらない。

続けて、元に戻す（画像 → フォントの順）:

```powershell
& C:\Users\caads\workspace\editor\patches\2026-10-fund-images\rollback.bat -DataRoot "$V\base" -Apply
& C:\Users\caads\workspace\editor\patches\2026-10-fonts-to-css\rollback.bat -DataRoot "$V\base"
& C:\Users\caads\workspace\editor\patches\2026-10-fonts-to-css\rollback.bat -DataRoot "$V\base" -Apply
```

確かめること: `assets\fonts\a.ttf` が戻り、`css\fonts\a.ttf` と `js\w.js` が消え、`css\510037.css` が `url(../fonts/a.ttf)`、appconfig が元の内容（`appconfig.json.bak-<今日>` と一致）。

- [ ] **Step 7: 実機 — 手で作り直した dataRoot の変形**

同じ PowerShell で、`New-BuiltEnv` を使って次の 4 つを作り、それぞれ確認モード → `-Apply` を流す（`-Port 24690`、`-DataRoot` は各フォルダ）。appconfig は毎回 `$V\appconfig.json` を作り直してから流す（Step 6 の内容で書き直す）。

1. `hand-fonts`: `New-BuiltEnv` の後に `css\fonts\a.ttf` を `assets\fonts\a.ttf` と同じ内容で手で置く（`assets` は残す）。続けて別の dataRoot `hand-fonts-conflict` で、`css\fonts\a.ttf` を別の内容（`Set-Content … 'X'`）にし、`assets\fonts\b.ttf`・`css\fonts\b.ttf` も別内容で置く。
   Expected: `hand-fonts` は競合なしで進み、`assets.migrated-<今日>` へ改名。`hand-fonts-conflict` は 2 件を並べて中止し、何も変わらない（HEAD と `assets` がそのまま）。
2. `hand-css`: `New-BuiltEnv` の後に `css\510037.css` を `url(fonts/a.ttf)` へ手で書き換え（コミットしない）、`.gitignore` に `/css/fonts/` と `/images/` を手で足し、`.gitattributes` を `* text eol=lf`（BOM 無し・LF）に手で直す。
   Expected: 確認モードに「取り込む未コミットの変更 … 3 件」。`-Apply` の後、`git -C …/hand-css show --name-only --format= HEAD` に `.gitattributes`・`.gitignore`・`css/510037.css` があり、作者は `system`。
3. `hand-css-extra`: `hand-css` と同じ手作業に加えて、`templates\AM01_510037_20240710_交付版.html` に 1 行足す。
   Expected: 「手作業の変更が残っています」で `templates/…` を並べて中止。何も変わらない。
4. `tracked-fonts`: `New-BuiltEnv` の後に `git -C … add -f -- assets` → コミット（フォントと js を追跡した状態）。
   Expected: 確認モードに「git の追跡から外すファイル … 2 件」（`assets/fonts/a.ttf`・`assets/js/w.js`）。`-Apply` の後、`git ls-files -- css/fonts images js assets` が空で、ファイルは `assets.migrated-<今日>` と `css\fonts`・`js` に残る。続けて `rollback.bat -DataRoot "$V\tracked-fonts"`（確認モード。assets は作業ツリーに無いので「revert の前に退避するファイル … 0 件」、「戻す: …assets.migrated-<今日> -> assets」が出る）→ `rollback.bat … -Apply`。Expected: 「untracked working tree files would be overwritten」で止まらずに終わり、`git ls-files -- assets` が `assets/fonts/a.ttf`・`assets/js/w.js` の 2 件、`assets\fonts\a.ttf` があり、`assets.migrated-*` と `.rollback-tmp-*` が残っていない。`css\fonts\a.ttf` と `js\w.js` は消えている。

最後に、HEAD の無いリポジトリを確かめる: `New-Item "$V\nohead\css","$V\nohead\templates" -ItemType Directory; git -C "$V\nohead" init -q` の後に `migrate.bat -DataRoot "$V\nohead" -Port 24690` → 「履歴」と `init-data-repo.bat` の案内で中止。続けて `init-data-repo.bat -DataRoot "$V\nohead"` → 「履歴(HEAD)の無い git リポジトリへ初回コミットを作成しました」。もう一度 `migrate.bat … -Apply` → 取り違えにも履歴にも当たらず、`templates` と `css` があるので進む（変更が無ければコミットを作らない）。

また、取り違えを確かめる: `New-Item "$V\wrong\notes" -ItemType Directory; git -C "$V\wrong" init -q; git -C "$V\wrong" -c user.name=t -c user.email=t@t commit -q --allow-empty -m x` の後に `migrate.bat -DataRoot "$V\wrong" -Port 24690 -Apply; $LASTEXITCODE` → 警告と `2`。

- [ ] **Step 8: 片付け**

Run（Bash）: `rm -rf /c/Users/caads/AppData/Local/Temp/editor-followup-verify /c/Users/caads/AppData/Local/Temp/editor-followup-patches`

- [ ] **Step 9: 開発用データが変わっていないこと・結果の報告**

Run（Bash）: `git -C /c/Users/caads/editor-data rev-parse HEAD; git -C /c/Users/caads/editor-data status --porcelain | md5sum`
Expected: Step 4 で控えた 2 行と同じ

失敗した項目は出力をそのまま添えて報告し、成功扱いにしない。`git status --short` に、この計画の外のファイル（`docs/editor/editor_手引き.html`・`docs/editor/images/*.png`・`docs/pdf-to-svg/*`・ルート `.gitignore`）が未コミットのまま残っていることも確かめる。

---

## 実装後の申し送り（Task ではない）

公開済みの「パッチ適用の手順ページ」（6.3・6.5 が更新を求めているもの）は、この計画の実装が終わった後にコントローラが更新する。載せるのは運用手順書 3.3 節の手順（フォント移設パッチを必須として目立たせる、`init-data-repo.bat` は 2 本のパッチの後、`ASSETS_DIR` は手で外す、Python 3.13 を PATH に通す）と、「新版は旧構成のままでは起動しない」旨の記述を「起動は止めず `[layout]` の警告を出す」へ改めること。
