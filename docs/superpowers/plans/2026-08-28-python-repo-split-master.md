# Python リポ分離 マスター計画(フェーズ索引)

> **For agentic workers:** 本ファイルは索引。実行対象は各フェーズの計画ファイル。
> 各フェーズ計画は superpowers:subagent-driven-development または
> superpowers:executing-plans で実行する。

**Goal:** pdf-to-svg + graph-editor を monorepo から Node.js 非依存の独立リポジトリへ
完全移動する(spec v3.5 の全段取りの実行)。

**Spec:** `docs/superpowers/specs/2026-08-27-python-repo-split-design.md`(v3.5)

**方式:** spec §9 の段取り 0〜8 を 5 フェーズに分割し、各フェーズを独立の計画ファイルで
実行する。後段フェーズの詳細は前段の実測(固定版数・ハーネス設計・カバレッジ実測値)に
依存するため、**各フェーズの計画はそのフェーズ開始時に書く**(本ファイルで予約)。

| フェーズ | spec 段取り | 計画ファイル | 状態 |
|---|---|---|---|
| 1. 環境準備(3.13 化・依存固定・スパイク) | step 0 | `2026-08-28-phase1-env-python313.md` | **完了(2026-08-28)** |
| 2. pdf-to-svg テスト移植(単体 34 + E2E 4。ハーネス基盤の確立) | step 1-2 の一部 | `2026-08-28-phase2-pdf-to-svg-tests.md` | **完了(2026-08-28)** |
| 3. graph-editor テスト移植(単体 75 + E2E 34 + capture 5 + CDP カバレッジゲート) | step 1-2 の残り | `2026-08-28-phase3-graph-editor-tests.md` | **完了(2026-08-29)** |
| 4. 新リポ作成 + 基盤(snapshot・setup_dev・hooks・check-comments.py・offline Python 版・署名鍵) | step 3-4 | `2026-08-29-phase4-new-repo.md` | **完了(2026-08-29)** |
| 5. monorepo 除去 + Node 依存更新 + 履歴初期化 + 後始末 | step 5-8 | (フェーズ 5 開始時に作成) | 未 |

**フェーズ完了ゲート(各フェーズの exit 条件):**

- フェーズ 1: spec §9 step0 の判定(フェーズ 1 計画 **Task 8 Step 5 + Task 4 Step 3
  〈Edge スパイク実測〉**に具体化済み)。
  補足: step1 に属する「dev-requirements 追加 + 直後の明示 publish」はフェーズ 1 へ
  前倒しで内包済み(フェーズ 2 計画で publish を二重に計画しないこと)。
- フェーズ 2: pdf-to-svg 分の 1:1 対応表(単体 34 + E2E 4)が全行「移植済み」/
  `py -3.13 -m pytest pdf-to-svg`(新テスト込み)単独緑 / **旧側も green を維持**
  (`pnpm run test:pdf-to-svg:js` + `pnpm run e2e:pdf-to-svg` — pdf-to-svg 分の
  両輪をこの時点で確認)/ page.evaluate ハーネスと pytest fixture サーバが
  graph-editor へ流用可能な形で確立。
- フェーズ 3: **両輪 green の合成コマンド**(spec §9 step2):
  `pnpm run ci` 全緑(フェーズ 2/3 で `e2e:pdf-to-svg` `e2e:graph-editor` の旧 TS E2E
  両方を `ci` チェーンへ組込済み。ここで明示実行するのは `ci:affected` の領域別発火の
  裏取りを兼ねる)**かつ** `pnpm run e2e:graph-editor` **かつ** `pnpm run e2e:pdf-to-svg` +
  CDP カバレッジゲートの実測 → 閾値固定の完了。旧(Node)と新(Python)の両輪が
  揃って green であることがフェーズ 4 進入条件。
- フェーズ 4: 新リポ clone + setup-dev だけの環境で全緑 / drift 検査が
  PASSED(非 SKIP) / 両 exe ビルド完走 / setup-offline 新リポ版が pin 検証込みで
  完走(spec §9 step3) → 完了と同時に**凍結開始**(step4)。
- フェーズ 5: spec §9 step5〜8 の各判定(除去後 ci 全緑・bundle 検証・初期化後の
  明示 publish + setup 完走・対象表全行完了)。

**フェーズ間の前提受け渡し:**

- フェーズ 1 → 2: 固定済み requirements / dev-requirements、3.13 のみの端末、
  Edge スパイクの合否(否ならフェーズ 2 の E2E 方式を再設計。合の場合も
  「物理 PC 系端末に限る実測」として扱い VDI へ一般化しない)。
- フェーズ 2 → 3: page.evaluate ハーネスと pytest fixture サーバの実装
  (graph-editor 側はこれを流用して量産)。
- フェーズ 3 → 4: 上記フェーズ 3 ゲートの通過(両輪 green + カバレッジ閾値)。
- フェーズ 4 → 5: 新リポ単独全緑 + 凍結開始(spec §9 step4)。
