# プロジェクトルール

## Git / ブランチ運用

### 常設ブランチと squash 分岐

- `chore/deps-latest-offline-bundle` は **常設の作業ブランチ**で、`main` より先行している。
- このブランチの PR は **squash マージ**で `main` に取り込む。そのため `main` には
  ブランチの実体（非 squash 履歴）を 1 コミットに圧縮した squash コミットだけが乗る。
  結果として `main` は常に「ブランチ作業の squash 済み旧版」になる。

### squash 分岐による PR コンフリクトの解消（必須手順）

このブランチから `main` への PR が **CONFLICTING**（`mergeStateStatus: DIRTY`）になった場合、
ほぼ常に上記の squash 分岐が原因。次の手順で解消する:

1. `git fetch origin` 後、`git log --oneline HEAD..origin/main` で **ブランチに無い
   `main` 側コミット**を列挙する。
2. それらが**本ブランチ由来の過去 PR の squash コミット**（例: `Chore/deps latest
   offline bundle (#NN)`）であることを確認する。＝実体はブランチに既存。
3. 確認できたら `git merge -s ours origin/main` で取り込む（ブランチ側を保持し、
   squash 版の重複変更は捨てる）。
4. push する。PR は `MERGEABLE` / `CLEAN` になる。

> ⚠️ `merge -s ours` は `main` 側の変更を**意図的に捨てる**。手順 2 を飛ばさないこと。
> もし `main` 側にブランチ由来でない独立コミットがあれば ours では消えるため、その場合は
> 通常マージ＋コンフリクト解消に切り替える。

### PR マージ

- マージ方式は **squash**（`gh pr merge <N> --squash`）。
- 常設ブランチは**削除しない**（`--delete-branch=false`）。
- マージ前に CI（`verify` チェック）の通過を待つ。

### コミット / push フック（既存・参考）

- **pre-commit**: `lint-staged` が `editor/**` に `biome check --write` を実行。
  未修正の biome エラーがあるとステージが入れ替わる事故があるため、editor 配下を
  変更したコミット前は `pnpm exec biome check --write editor/<対象>` を**先行実行**して
  状態を確定させる（対象は変更ファイルに限定し、無関係な再整形を広げない）。
- **post-commit**: `offline/publish-offline-bundle.ps1` がローリングタグ
  `offline-bundle-v1` を HEAD へ移動し、重量物バンドルは content key 差分時のみ再生成。
  ベストエフォート（コミットはブロックしない）。無効化は `OFFLINE_PUBLISH_SKIP=1`。
- **auto-push**（`.claude/hooks/auto-push.cjs`）: commit 後に現ブランチを origin へ push。
  履歴を amend した場合はリモートが古い同内容コミットのまま分岐するため、ツリー一致を
  確認のうえ `git push --force-with-lease` で揃える。

## PowerShell スクリプト（.ps1）

- `.ps1` を新規追加する場合は、**必ず同階層に同名の `.bat` ランチャを併せて作成**する。
  `.bat` が無い `.ps1` は不可。既存で `.bat` が欠けているものは改修して揃える。
- `.bat` は **実行ポリシー Bypass** で `.ps1` を起動する。引数はそのまま転送する。
  雛形は次のとおり（`<name>.ps1` を実際のファイル名に置換）:

  ```bat
  @echo off
  chcp 65001 >nul
  rem 同梱の <name>.ps1 を実行ポリシー Bypass で実行（引数はそのまま転送）。
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0<name>.ps1" %*
  exit /b %ERRORLEVEL%
  ```

  - `-NoProfile -ExecutionPolicy Bypass -File "%~dp0<name>.ps1" %*` は固定。`%~dp0` で
    `.bat` 自身の場所を基準に解決し、どこから起動しても同じ `.ps1` を指す。
  - `exit /b %ERRORLEVEL%` で `.ps1` の終了コードをそのまま返す。
- 文字コードの扱いは [[offline-bundle-distribution]] と同様: 日本語を含む `.ps1` は
  **UTF-8 BOM 必須**（cp932 環境での文字化け回避）。`.bat` は cmd の JP コードページで
  壊れない範囲に留め、非ASCII を使う場合は冒頭で `chcp 65001 >nul` を入れる。
  非ASCII を避けたい `.bat`（例: `offline/setup-offline-local.bat`）は ASCII のみで書く。

## コメント規約（全体）

- すべてのコードのコメントは **graph2 の「コメント規約」**(`graph2/README.md` の
  「コメント規約」節）に準拠する。要点:
  - **言語**: 日本語の散文 + 英語ドメイン用語を併用（ドメイン用語を無理に和訳しない）。
  - **識別子はバッククォート**: 関数名・型名・定数・変数名・ファイル名は `` `name` `` で囲む。
  - **クロスファイル参照**: 「他ファイルの定義を見よ」は `` `<basename>.ts` の `<symbol>` `` 形に統一。
  - **重複は集約**: 正典を 1 つ決め、他所はそこへの相互参照に短縮する。
  - **体裁**: ファイル先頭は装飾ボックスヘッダ、節区切りは `// ── N. ラベル ──`。コメント行は
    おおむね 100 桁以内、括弧は ASCII `()`。
  - 「なぜ」「非自明なロジック」を説明する（自明な what は書かない）。
- graph2 配下は上記に加えて、コメントのみの変更でも `out/_baseline` との **byte-diff 不変**が鉄則
  （詳細は下記 graph2 節）。

## Word ドキュメント（.docx）

- Word(.docx) を生成・編集する際のフォントは **Meiryo UI** に統一する。本文・見出し・表など
  すべてのランで、ASCII(`w:ascii`/`w:hAnsi`)・東アジア(`w:eastAsia`)の双方に `Meiryo UI` を設定する。
  - python-docx の場合: `run.font.name = "Meiryo UI"` に加え、
    `run._element.rPr.rFonts.set(qn("w:eastAsia"), "Meiryo UI")` を必ず併設する
    （`eastAsia` を設定しないと日本語グリフが既定フォントに落ちる）。
  - 等幅が必要な箇所のみ別途等幅フォントを使ってよいが、本文系は Meiryo UI を既定とする。
- 生成スクリプト（例: `docs/pdf-to-svg/_build/gen_docs.py`）の既定フォント定数もこの規約に合わせる。

## graph2

- SVG 出力は決定的。挙動保証は `npm run batch` + `out/_baseline` との **byte-diff**。
  コメント/リファクタ等は出力バイト不変が鉄則。
- `.claude/hooks/graph2-baseline.cjs`（PreToolUse: Write|Edit）が編集前に
  `out/_baseline` を自動生成する。
