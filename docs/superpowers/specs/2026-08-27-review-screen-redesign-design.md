# 精査画面の事務担当者向け全面改修 — 設計書

- 日付: 2026-08-27
- 対象: editor の確定保存承認ワークフロー（一覧 `ReviewQueueView` / 精査 `ReviewDiffView` ほか）
- 画面モック: セッション中に提示済み（一覧 / 精査 / 通知展開の 3 面。本書の記述が正）

## 1. 背景と目的

精査（承認）画面が事務担当者向けになっていない。承認者は IT リテラシーのない社員（承認 1 段・
自己承認は不可）で、申請は基準日後に一括（数十件）で届く。現画面の問題は次の 4 点。

1. 警告文言が実装概念を露出している（「ファンド共通 CSS」「語句単位の着色を省略」等）。
2. 何を確認すれば承認してよいかが画面から読み取れず、判断に迷っても承認か却下しかない。
3. 警告バナーの乱立と「ページ1・パーツ1」形式の縦長リストで、業務の認知単位と一致しない。
4. 画面の見えと最終 PDF の一致に確信が持てない。

対応方針（ユーザー確定済み）:

- 技術的警告は「業務語の 1 行通知 + 詳細折りたたみ」に集約する。完全に隠すことは設計正典
  （「承認者が見る画面の完全性は 1 つの要件」）に反するため行わない。
- 「保留」状態を追加する。
- 一覧画面も改修する（残件サマリ・変更概要の先出し）。
- 精査画面の主役を「修正前｜修正後のブラウザ内組版比較」に置き換える。実 PDF の 2 枚生成は
  待ち時間と worker 負荷のため採らない（ブラウザ内組版は PDF と同一エンジンで見た目が一致する）。
- 確認観点チェックリストは採用しない（検討の上、ユーザー判断で不採用）。

## 2. 保留状態（データモデル + API）

### shared（`shared/src/schemas.ts`）

- `ReviewStatus` を `'pending' | 'approved' | 'rejected' | 'held'` に拡張する。
- `ReviewRequestMeta` に `heldBy: string | null` / `heldAt: string | null` /
  `holdComment: string | null` を追加する。
- `ReviewRepository` 契約に `holdReview(reqId, decision): Promise<Result<ReviewRequestMeta>>` を
  追加する（decision は既存 `ReviewDecisionBody` = `{comment?}` を流用）。

### 状態遷移

- `pending → held`: 保留（approver 限定・自己申請への保留も許可）。
- `held → approved / rejected`: 承認・差し戻しは `pending | held` の両方から可能にする。
  保留解除の専用操作は作らない（「確認を再開」= 精査画面を開いて通常どおり判断する）。
- `held → held`: 保留メモの更新として許可する（上書き）。

### server

- ルート `POST /api/review-requests/:reqId/hold` を追加する
  （`requireAuth` + `requireApprover`、`withReviewLock` 直列化、監査イベント `review.hold`）。
- `routeGuards.ROUTE_POLICY` へ登録し、OpenAPI 定義（`openapi/document.ts`）へ追記する。
- `reviewRepo.approveReview` / `rejectReview` の pending 検査を `pending | held` 許可に緩める。
- 申請上限 `countPendingReviews` は pending + held の合算で数える（保留で上限を回避できない）。
- DB sproc の変更はない。申請の永続化はファイル方式（`dataRoot/reviews/<reqId>/meta.json`）が
  正典であり、監査は汎用監査 sproc にイベント名が乗るだけ。

### web

- local モード（localStorage）の `reviewRepo` にも同形の `holdReview` をミラーする。
- REST クライアントに `holdReview` を追加する。

## 3. 一覧画面（`ReviewQueueView.vue`）

- 上部に残件サマリ 4 箱（承認待ち / 保留中 / 承認済み / 差し戻し）を置く。件数は
  `listReviews()` 全件取得のクライアント集計（想定規模は数十件。API 変更なし）。
  箱のクリックが状態フィルタを兼ねる。
- 各カードに「変更 N か所（業務名…）」の概要を表示する（出所は §7 の申請時自己申告。無い
  申請では非表示）。保留中カードには保留メモ（`holdComment`）を表示する。
- ボタン文言を「精査する」→「内容を確認する」、保留中は「確認を再開する」とする。

## 4. 精査画面の再構成（`ReviewDiffView.vue`）

ルート・composable（`useReviewDiff`）・サービス層（`reviewDiffService`）の骨格は維持し、
template 層を次の構成に再設計する。

```
ヘッダ（一覧へ戻る / ファンド・版種・基準日 / 申請者・申請日時）
変更要約 1 行（「変更されたのは N か所: 『◯◯』『◯◯』」）
通知バー ReviewNoticeBar（§5）
表示切替タブ: [見た目比較（既定）] | [文字の変更一覧]
  見た目比較: PreviewPanel ×2 を左右に並べる
  文字の変更一覧: 現行のパーツ単位 前後リスト（格下げ収納）
アクションバー（コメント欄 + 保留 / 差し戻し / 承認）
```

### 見た目比較（新規・画面の主役)

- 既存 `PreviewPanel.vue`（vivliostyle preview-host の opaque iframe クライアント）を 2 個
  並べる。文書は `reviewDiffService` が既に両方計算している完全 HTML を渡す:
  - 修正前 = `compareService.renderVersionHtml('baseline:<templateId>')`（現行公開版）
  - 修正後 = `compareService.renderTemplateBody(review.html, review.css, fundCode)`
- `origin === 'create'`（新規作成申請）は修正前が存在しないため、単面表示 +「新規作成」の
  明示とする。
- ページ送りは左右連動（`PreviewPanel` の `defineExpose` 命令 + `emit('state')` のページ数
  集約で親が同期する）。
- 「次の変更箇所へ」ボタン: 変更パーツの位置へ両面を移動する。実現は §6。
- 変更マーカー: 変更されたパーツ（`data-part-id` 単位）に黄色ハイライトを注入する。
  方式は既存の差分装飾と同じ「CSS カスケードレイヤ + CSPRNG レイヤ名 + `!important`」
  （申請者 CSS による偽装・上書きを防ぐ既存の設計を踏襲）。
  「印を消して最終の見た目で確認」トグルを付け、素の見た目も必ず確認できるようにする。
- 「PDF で確認」ボタン: 修正後 1 文書を既存 `POST /api/build`（inline）で生成して開く
  （§5 通知 2 の誘導先）。修正前後 2 枚の PDF 生成は行わない。

### 文字の変更一覧（現行機能の格下げ収納）

- 現行のパーツ行リスト（textOps 語句差分・`MAX_RENDERED_ROWS` 打ち切り・coarse 行注記）を
  タブ内へ移す。差分の正典性（textOps が確定内容の差分）は変えない。
- パーツ行ラベルは §7 の業務名（「運用実績の表（3 ページ目）」）を使い、突合できない行は
  現行の「ページN・パーツN」へフォールバックする。
- coarse（簡易表示）の注記は行内に残し、文言を「変更が大きいため、変わった文字の色付けは
  せず全文を並べています」とする。

### アクションバー

- コメント欄 1 つ + ボタン 3 つ（保留 / 差し戻し / 承認）。
- 差し戻し（=却下）はコメント必須（現行どおり）。保留はコメント任意（保留メモとして保存）。
- 「却下」の UI 文言を「差し戻す」に統一する（API・status 内部名 `rejected` は変えない）。
- 承認成功後の `staleWarning` / ペア同期 / 注記マスタ反映の結果通知はトーストのまま維持する。

## 5. 通知集約（新コンポーネント `ReviewNoticeBar`）

- 入力: `cssChanged / cssBefore / cssAfter / printOnlyCss / truncated / hiddenRowCount`。
- 表示: 「⚠ 画面だけでは確認しきれない変更が N 件あります（開いて確認）」の 1 行。
  展開すると該当項目だけが番号付きで並ぶ。文言は次のとおり。

| # | 条件 | 見出し | 本文の要点 |
|---|------|--------|-----------|
| 1 | `cssChanged` | このファンドの書式設定も変更されています | 文字の大きさ・色・配置などの決まりが変更された。他の版種の見た目にも影響しうる。左右比較に差がないか特に注意。書式の前後表示はさらに一段の折りたたみに収納 |
| 2 | `printOnlyCss` | 画面では確認できない印刷用の書式が含まれています | 一部の書式は PDF にしたときだけ反映される。右の「修正後」は PDF と同じ仕組みで表示しているが、心配な場合は「PDF を開いて確認」へ |
| 3 | `truncated` | 「文字の変更の一覧」に表示しきれなかった項目があります | 一覧には全件を表示できていないが、左右の見た目比較では全ページを確認できる |
| 4 | `hiddenRowCount > 0` | 変更箇所が多すぎるため、一覧の一部を表示できません | 左右の見た目比較で確認するか、編集者に申請を分けて出し直すよう依頼する |

- 項目 1（書式設定）だけが「見た目に出ないかもしれない変更」であるため、常に先頭・強調とする。
- 完全性要件の担保: 全項目を DOM に常在させ、折りたたみは表示状態の切替のみとする
  （条件付き `v-if` で消してよいのは「条件そのものが偽」の場合だけ）。

## 6. 変更箇所ジャンプ（preview-host 拡張）

- `shared/src/preview/hostProtocol.ts` の `PreviewCommand` に `goto-anchor`（要素 id への移動）
  を 1 種類追加し、`previewHost.ts` の BOOT_SCRIPT 側で vivliostyle core の内部リンク移動を
  呼び出す。変更パーツには文書組み立て時に一意な id を付与しておく。
- コマンド送出は COMPLETE 後に限る（BOOT_SCRIPT 正典コメントの既存制約に従う）。
- フォールバック: core の移動 API が期待どおり動かない場合、この機能は「変更マーカー +
  手動ページ送り」に退避する（マーカーだけでも変更ページは目視で見つけられる）。設計上の
  必須要件とはしない。

## 7. パーツの業務名ラベル

- 差分行のキーは `blockKey.ts` が `data-part-id` を最優先で採るため、`data-part-id` 付き
  パーツはパーツカタログの `id` と一致する。`listParts({})` でカタログを取得し
  `id → name`（名称・利用者向け）を突合して表示する（`reviewDiffService` 内で実施）。
- 突合できない行（カタログ外パーツ・カタログ取得失敗）は現行の「ページN・パーツN」へ
  フォールバックする。カタログ取得失敗で精査を止めない（ベストエフォート）。

### 一覧の「変更 N か所」概要（申請時自己申告・参考扱い）

- 申請時に申請者のブラウザが差分を計算済みであることを利用し、`SubmitReviewBody` /
  `ReviewRequestMeta` に `changedSummary: { count: number, names: string[] } | null` を追加、
  申請時に保存する。一覧・精査ヘッダの要約表示に使う。
- これは申請者由来の自己申告であり**参考表示**とする。承認判断は精査画面がその場で計算する
  実差分に基づく（精査画面を開かずに承認へ到達できない構造は変えない）。精査画面の変更要約
  1 行は実差分から表示し、自己申告とは独立させる。
- 旧形式の申請（`changedSummary` なし）は概要非表示で正常動作する。

## 8. 用語の対訳（UI 文言）

| 現行 | 改修後 |
|------|--------|
| 却下 | 差し戻し |
| 精査する | 内容を確認する |
| ファンド共通 CSS が変更されています | このファンドの書式設定も変更されています |
| 印刷時にだけ適用される規則 | 画面では確認できない印刷用の書式 |
| 語句単位の着色を省略 | 変わった文字の色付けはせず全文を並べています |
| ページN・パーツN | パーツ業務名（3 ページ目）※フォールバックで現行表記 |

内部名（`rejected` 等の status 値・API パス・監査イベント名）は変更しない。

## 9. セキュリティ・設計正典との整合

- 見た目比較は既存 `PreviewPanel`（`sandbox="allow-scripts"` の opaque iframe +
  postMessage 契約 + `selfContainPreviewDoc`）をそのまま使う。新たな iframe 経路・
  sandbox 緩和は作らない。
- 変更マーカーは CSS カスケードレイヤ + CSPRNG レイヤ名方式（既存差分装飾と同一の防御）。
  `display` は上書きしない。
- 通知の完全性: 警告は集約・折りたたみするが消さない（DOM 常在）。
- テンプレ JS は動かして見せる方針を維持する（PreviewPanel 経路は既にこれを満たす）。
- Jinja のコンパイルは `renderJinjaIsolated`（隔離レンダーホスト）経由のみ（既存経路を流用、
  新規のコンパイル経路は作らない）。

## 10. テスト計画

- shared: `held` を含むスキーマ検証・`toReviewMeta` の新フィールド。
- server: hold ルートの結合テスト（権限・遷移・監査・`withReviewLock`）、pending+held 合算
  上限、`routeGuards` 宣言整合（起動時検査が通ること）、held からの承認/差し戻し。
- web:
  - `ReviewNoticeBar` の表示条件（各フラグ単独・複合・0 件時の非表示）。
  - 業務名突合（一致・カタログ外フォールバック・取得失敗 degrade）。
  - 一覧のサマリ集計・フィルタ・`changedSummary` 有無の両対応。
  - 変更マーカーのレイヤ方式ガード（レイヤ名がリテラルでないこと・`display` 不使用）。
  - 既存ガード網の維持: `iframeSandbox.guard.test.ts` / `xssGuards.test.ts` /
    `noPostSanitizeSurgery.guard.test.ts` / `twoSystems.guard.test.ts` を全て green のまま。
- e2e: 申請 → 一覧 → 精査（見た目比較表示）→ 保留 → 承認の導線 smoke。
  `capture_docs.spec.ts` のスクリーンショット再撮影と `build_all --project editor` の再実行。

## 11. ドキュメント更新

- 操作手順書 第 7 章（申請を承認する）を新画面の手順へ書き替える。
- 設計書 6 章（承認ワークフロー）へ保留状態・画面再構成を追記する。
- 冊子 HTML の再生成（`python docs/_build/build_all.py --project editor`）。

## 12. スコープ外（今回やらないこと）

- 確認観点チェックリスト（検討の上、不採用と決定）。
- 二段承認ワークフロー（承認は 1 段のまま）。
- 実 PDF 2 枚生成による前後比較。
- 承認一括操作（複数申請をまとめて承認する UI）。
- チェック状態・確認履歴の監査ログ拡張。
