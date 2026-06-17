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

## graph2

- SVG 出力は決定的。挙動保証は `npm run batch` + `out/_baseline` との **byte-diff**。
  コメント/リファクタ等は出力バイト不変が鉄則。
- `.claude/hooks/graph2-baseline.cjs`（PreToolUse: Write|Edit）が編集前に
  `out/_baseline` を自動生成する。
