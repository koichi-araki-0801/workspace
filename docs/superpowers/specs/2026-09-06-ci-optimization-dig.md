# CI 最適化 — dig 調査記録

- 日付: 2026-09-06
- 対象: render_hash 分割 + pie-chart 配置爆発修正 / ci・fallback 完全化 + web jsdom 分離 /
  e2e 品質 / 単体の穴 + GH Actions 小改善
- 状態: **完了**(Round 3 で全論点確定。次は brainstorming → writing-plans)

## 既存資産(前提。2026-09-06 時点の実測・実装から)

- 実機は 8 コア / 8GB。`pnpm run ci`(pre-push のフル CI)は 11〜12 分、うち集約カバレッジが
  7〜8 分。アシスタントの背景 Bash は約 10 分で切れるため、push はユーザーに依頼している。
- CI 集約 = ルート `package.json` の `ci`(`check:comments → check:claude-hooks → check:ci →
  test:scripts → typecheck → test:coverage → build → test:e2e`)。pre-push は
  `scripts/pre-push.mjs` → `scripts/ci-affected.mjs`(領域別。coverage 無し)。共有ファイル
  変更時はフル `ci` + `ci:offline` へフォールバック。
- `.github/workflows/ci.yml`(ubuntu)は `ci` と**別建て**で手書き同期。既に drift あり:
  yml は `pytest docs/_build` を回すが `ci` スクリプトは `test:docs` を含まない。逆に `ci` の
  `check:claude-hooks`・`test:scripts` は yml に無い。`concurrency` / `timeout-minutes` 無し。
- vitest はルート `vitest.config.ts` で 4 プロジェクト(shared / server / web=jsdom /
  pie-chart)を集約。`maxWorkers: 4`(資源溢れで「偽の赤」3 症状が出た経緯あり)。coverage は
  include 列挙 = テスト済みのみ、全指標 85%。
- `pie-chart/test/render_hash.test.ts`: 合成 26 ケースを **1 つの `it`** で直列レンダし
  SHA256 を 1 スナップショットに固定。単独 ~172s、CI 併走で 356〜463s、timeout 900s。
  `final_score.test.ts` も 300s、`leader_invariants` は負荷下でフレーク実績。
  ⇒ 1 ケース ~6.6s は配置計算そのものが重い(「配置爆発」)。
- editor/web のテストは 97 ファイル全部が jsdom 環境(`vite.config.ts` の `environment:
  'jsdom'`。ファイル単位の `@vitest-environment` 指定は現状ゼロ)。純関数テスト
  (`jinjaMask` / `htmlBlockDiff` / `partKey` 等)も jsdom を起動している。
- e2e は 9 spec(1364 行)、`fullyParallel`、CI では `retries: 2`。`waitForTimeout` が
  `capture_docs` 15 箇所・`comment_panel` 7・`note_bubble` 8。`capture_docs.spec.ts` は
  `docs/editor/images` を再撮影して byte 差分を作る(現状 2 枚が未コミット差分)。

## 前提・仮定の棚卸し(リスク順)

| # | 仮定 | 種別 | リスク |
|---|---|---|---|
| A1 | 配置爆発の修正は SVG バイト不変で可能(純粋な計算量削減) | 実現性 | 高 |
| A2 | 分割すれば速くなる(vitest の並列はファイル単位。1 `it` 分割では並列化しない) | アーキ | 中 |
| A3 | `ci` スクリプトと `ci.yml` は手で揃え続けられる(既に drift) | 保守 | 中 |
| A4 | jsdom が web テスト時間の主因(未計測) | 実現性 | 中 |
| A5 | 純関数テストは node 環境へ移しても壊れない(暗黙の `document` 依存なし) | 実現性 | 中 |
| A6 | e2e の `retries: 2` と固定待ちで隠れているフレークは「品質」で解消できる | ユーザ | 中 |
| A7 | 「単体の穴」は include 列挙の外 = 未テストのファイルで、追加は閾値 85% を割らない | スコープ | 低 |
| A8 | GH Actions は保険であり、ローカル pre-push が主ゲート(両方を直す意味がある) | 依存 | 低 |

## 実測の訂正(2026-09-06、この端末)

- coverage 込みフル vitest は **276s**(「7〜8 分」は旧値)。内訳: test:editor 104s
  (jsdom 起動の積算 173s。web 97 ファイル中 DOM を触るのは **16**)、e2e 72s、build 13s、
  typecheck 11s。
- render_hash は coverage 込み 242s / 単独 128s。**`gen_long_12` と `gen_long_14_other` の
  2 ケースで約 130s**(long10 は 6s、long9 は 3.6s = スライス数に対して超線形)。
- CPU プロファイル: `pickUpperEscapeCount → upperEscapeScore` 系が inclusive 117s、
  `repairResidualLeaderDefects → tryRebendInvolved` 80s、`placementBox →
  scaledLabelWidthUnits → visualMaxEm` が self 42s(メモ化済みでも呼出回数が爆発)。
- `waitForTimeout` は 40 箇所(note_bubble 17 / capture_docs 15 / comment_panel 7 / smoke 1)。
- coverage include 内の `web/src/api/rest/reviewRepo.ts` は **9%**(閾値は集約値のみで
  perFile 無し → 個別ファイルの穴は閾値に掛からない)。rest e2e は現状 **存在しない**。
- `ci` と fallback には `test:docs` と `pie-chart:batch(:diff)` が無い。
- `.gitattributes` は Biome の eol=lf 強制に直結(変更すると `biome ci` の結果が変わりうる)。

## Round 1 決定

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 到達目標 | **フル CI 10 分未満**(背景 Bash 窓に収める) | push 完走の痛点を直接消す | 276s の vitest だけでは足りず、pie-chart 改修が必須 |
| 配置爆発 | **バイト不変必須**(メモ化・重複計算除去・早期打ち切りのみ)。効果不足なら出力変更を許す B 案を**別計画**で | 鉄則(`out/_baseline` + render_hash スナップショット双方不変が受入条件) | 候補列挙そのものが原因なら効果限定 |
| render_hash 分割 | **ファイル分割 + ケース単位 `it`**。`.snap` は既存ハッシュから機械移行、`-u` 禁止 | 並列化と失敗箇所の粒度を両取り | `maxWorkers:4` の枠を食う。long_12/14 を同一ファイルに置くと分割の意味が薄い |

着手範囲(ユーザー選択済み・全塊): (1) render_hash 分割 + 配置爆発の byte 不変修正
(2) ci/fallback 完全化 + web jsdom 分離 (3) e2e 品質(waitForTimeout 撤去・/merge・承認クリック・
作成フローの挙動 spec・capture_docs 分離・rest e2e は opt-in project)(4) api/rest/* 直接テスト +
include 見直し + GH Actions(concurrency / timeout / cache / 順序)。

## Round 2 決定

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| `capture_docs` | **playwright project `docs` へ分離**。`ci:affected` の editor 領域では走らせ、GH と `ci` からは外す | editor 変更の push ごとに画像が追随する現運用の意図を保ちつつ、GH と手動フル CI から docs 書換の副作用を除く | pre-push 中に working tree が変わる副作用は残る(再撮影差分は従来どおり「再撮影」コミット) |
| rest e2e | **両建て**: DB フェイク opt-in(playwright project `rest`)を既定、LocalDB 実 DB は手動確認用スクリプト | GH でも動く退行網と実機確認の分離 | 保守対象 2 系統。フェイクの差し込み方は Round 3 |
| GH `retries` | **0** | フレークを隠さない(`waitForTimeout` 撤去とセット) | 撤去が不十分だと GH が赤くなる。順序は撤去 → retries 0 |
| GH `concurrency` | **PR は cancel-in-progress、`main` は cancel しない** | main の検証結果を必ず残す | — |
| coverage include | **`perFile: true` + `api/rest/*` 8 ファイルの直接テスト + `server/src/routes/*.ts` を include へ**(fastify `inject`) | 「include に居るのに 9%」の穴を構造的に閉じる | 現時点で 85% 未満が 7 ファイル。移行手順は Round 3 |
| BENIGN 拡張 | **ファイル名の完全一致リスト**(`README.md`・`*/README.md`・`LICENSE` 等)。プレフィクスは増やさない。**`.gitattributes` はフル CI のまま** | `.gitattributes` は Biome eol 前提を変える。範囲が読める列挙にする | 追加のたびに列挙が要る(許容) |
| web jsdom 分離 | **project 分割 `web-dom` / `web-node`**、`*.dom.test.ts` 命名で振り分け(DOM を触る 16 ファイルをリネーム) | 命名で環境が見え、純関数だけを `--project web-node` で回せる | coverage include・`test:editor` の列挙への波及は Round 3 |

## Round 3 決定(最終ラウンド)

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 配置爆発の受入条件 | **`render_hash` 単独 ≤30s、`gen_long_12` / `gen_long_14_other` 各 ≤5s**。加えて `out/_baseline` byte 一致 + `render_hash` / `final_score` / `mark_flags` の `.snap` 不変 | 「効果不足 → 出力変更案(別計画)」の判断基準を数値で持つ | 未達なら計画途中で別計画へ切り替える判断が要る |
| メモ化の対象と順序 | **B → 計測 → A**: まず `visualMaxEm` / `scaledLabelWidthUnits` の「文字列 → 幅」を render 呼出ごとにキャッシュ(鍵 = 文字列 + weight)、計測してから `pickUpperEscapeCount` 内の `layoutLabels(rotate, count)` と `upperEscapeScore(layout)` を per-render Map でメモ(layout は参照同一性)。**打ち切り(early exit)は不採用** | 安全側(純関数キャッシュ)から積み、A の要否を実測で決める。early exit は best 相対の単調改善を崩し選択結果が変わりうる | A では `layoutLabels` の戻り値を後段が破壊的に触っていないかの確認が要る(`structuredClone` の有無を切り分ける) |
| rest e2e のフェイク差し込み | **`buildApp({ sproc })` の注入点**(既定 = 実 `callSproc`)。専用エントリ `server/scripts/e2e-rest-server.ts` からフェイクを渡す。`callSproc` を直 import している箇所は**全部注入経由へ改める**(一覧は下の「計画へ渡す前提」) | 型で見え、単体テストの `vi.mock` も置き換えられる。本番コードに分岐は入らない | 変更範囲が広い(7 ファイル・21 呼出)。`session.ts` は `middleware/auth.ts` からも使われるため注入の伝播経路を先に決める |
| perFile 移行 | **85% 未満の 7 ファイルのテストを書き切ってから `perFile: true` を入れる** | 一時的な閾値エントリや include 外しを作らない | perFile 導入が計画 (4) の末尾になる。導入までに新たな穴ができても止まらない |
| web 2 project の波及 | **`editor/web/vitest.config.ts` を新設**して `vite.config.ts` の `test` ブロックを移し、そこで `web-dom` / `web-node` を定義。`test:editor` の `--project` 列挙、`editor/README.md` のカバレッジ正典、`ci-affected.mjs` の説明を同時更新 | 環境設定はパッケージ側に置く慣習に揃える | 変更ファイルが多い(1 コミットで揃える) |

## まとめ(完了)

### 決定事項(確定)

| 項目 | 決定 |
|---|---|
| 到達目標 | フル `pnpm run ci` を **10 分未満**(背景 Bash 窓) |
| 配置爆発 | **SVG バイト不変**の高速化のみ。受入 = `render_hash` 単独 ≤30s(`gen_long_12` / `gen_long_14_other` 各 ≤5s)+ `out/_baseline` byte 一致 + `render_hash` / `final_score` / `mark_flags` の `.snap` 不変。手順は「文字列→幅キャッシュ → 計測 → `pickUpperEscapeCount` の per-render メモ」。early exit は不採用。未達なら出力変更案を別計画 |
| render_hash | ファイル分割 + ケース単位 `it`。`.snap` は既存ハッシュから機械移行(**`-u` 禁止**)。`gen_long_12` と `gen_long_14_other` は**別ファイル**に置く |
| ci / fallback | `ci` と `runFullCi` に `test:docs`・`pie-chart:batch`・`pie-chart:batch:diff` を追加し、`ci.yml` と段構成を揃える。BENIGN はファイル名完全一致リスト、`.gitattributes` はフル CI |
| web テスト環境 | `editor/web/vitest.config.ts` 新設。project `web-dom`(jsdom、`*.dom.test.ts` 16 ファイル)/ `web-node`(node、残り 81)。`test:editor` 列挙・README・`ci-affected.mjs` 説明を同時更新 |
| e2e | `capture_docs` は project `docs`(editor 領域の affected のみ、GH と `ci` からは外す)。rest e2e は project `rest`(`buildApp({ sproc })` にフェイク注入、opt-in)+ LocalDB 実 DB は手動確認。`waitForTimeout` 40 箇所を要素待ち・`expect.poll` へ。挙動 spec 追加: `/merge`・承認クリック・作成フロー。GH `retries: 0`(撤去の後) |
| 単体 | `api/rest/*` 8 ファイル直接テスト + `server/src/routes/*.ts` を include へ(fastify `inject`)。85% 未満 7 ファイルを書き切ってから `perFile: true` |
| GH Actions | `concurrency`(PR は cancel、main は非 cancel)、`timeout-minutes`、Playwright ブラウザキャッシュ、段の順序を `ci` と一致 |

### 未決事項

- なし(Round 3 で全論点確定)。

### 計画へ渡す前提(writing-plans が守ること)

- **順序**: (1) pie-chart は「計測 → 文字列→幅キャッシュ → 計測 → per-render メモ → byte 検証」を
  1 パスずつコミット(各コミットで `batch:diff` byte 一致を確認)。(2) e2e は「`waitForTimeout`
  撤去 → 安定確認 → `retries: 0`」の順(逆だと GH が赤くなる)。(3) 単体は「7 ファイルのテスト →
  `perFile: true`」。(4) `callSproc` の注入化は rest e2e より先(注入点が無いとフェイクを渡せない)。
- **触る前チェック**: pie-chart は設計正典のチェックリスト 1〜2(座標・leader に影響しない変更として
  byte 一致を確認)。`EMIT_REPAIR_PASSES` の順序は触らない。メモ化はモジュールグローバルに置かず
  render 呼出ごとの Map(決定性・並列安全)。
- **設定ファイルの同期対象**: `package.json` の `ci` / `ci-affected.mjs` の `runFullCi` /
  `ci.yml` の 3 か所は**同じ段構成**を持つ。ずれの検出は `scripts/ci-affected.test.mjs` へ
  「`ci` スクリプトの段 ⊇ `ci.yml` の run 段」の機械検査を足す(手同期に戻さない)。
- **`callSproc` 直 import 箇所の一覧**(13-B の作業量見積り用。`db/sproc.ts` 自身を除く
  7 ファイル・21 呼出。すべて `buildApp({ sproc })` から到達できる形へ改める):

  | ファイル | 呼出数 | 備考 |
  |---|---|---|
  | `server/src/auth/session.ts` | 5 | `index.ts`・`middleware/auth.ts`・`repositories/authRepo.ts`・`routes/auth.routes.ts` が利用。認証の関所なので注入の伝播経路を最初に決める |
  | `server/src/db/audit.ts` | 1 | `logger.ts` から利用(監査ログの DB 書込)。logger はグローバルなので注入の形が他と異なる |
  | `server/src/repositories/authRepo.ts` | 3 | 単体は `vi.mock('../src/db/sproc.js')`(`authRepo.test.ts`)→ 注入へ置換 |
  | `server/src/repositories/partRepo.ts` | 2 | — |
  | `server/src/repositories/templateRepo.ts` | 4 | 複数行 import(`callSproc,` 単独行) |
  | `server/src/repositories/userRepo.ts` | 4 | — |
  | `server/src/sync/noteMasterService.ts` | 2 | 単体は `vi.mock`(`noteMasterService.test.ts`・`generate.routes.test.ts`)→ 注入へ置換 |

  `buildApp()` は現状引数なし(`server/src/app.ts:85`)。`routes/*.ts` は `callSproc` を直接
  呼ばず repo / session 経由なので、注入は repo 生成時に渡す形(routes は無改修)を第一候補にする。
- **命名・列挙の波及**: `*.dom.test.ts` リネームに伴い `test:editor` の `--project` 列挙、
  coverage include(パスは src 側なので不変)、`editor/README.md` のカバレッジ正典を更新する。
- **capture_docs の運用**: 再撮影差分は従来どおり「再撮影」としてコミット、`build_all --project
  editor` の再実行が要る旨は設計正典 4 項のまま。
- **やらないこと**: 打ち切り(early exit)による候補削減(選択結果が変わりうる)/
  `maxWorkers: 4` の緩和 / `pool.ts` に検証専用の env 分岐 / `.gitattributes` の BENIGN 化 /
  perFile 導入時の一時的な低閾値エントリ・include 外し。
