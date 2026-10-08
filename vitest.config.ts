/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// ワークスペース全体の Vitest エントリ。各パッケージの設定(environment/alias/globals)は
// 個別 config に残し、ここでは `projects` で集約して `vitest run` 一発で全プロジェクトを
// 各環境(web-dom=jsdom / 他=node)で実行する。coverage は Vitest の仕様上ラン全体で 1 つしか
// 持てないため、include/閾値はパッケージ別でなくここへ一本化し、閾値は全指標 85% に統一する。
// 「テスト対象のみゲート」方針(cf. editor 各 vitest.config の include 方針)は include 列挙で維持。
export default defineConfig({
  test: {
    projects: [
      'editor/shared/vitest.config.ts',
      'editor/server/vitest.config.ts',
      // web は dom(jsdom)/ node の 2 leaf を**直接**列挙する。`editor/web/vitest.config.ts`(薄い
      // root。`pnpm --filter web test` 用)を列挙すると、参照 config 内の `test.projects` は無視されて
      // 全ファイルが node で走る。分割の理由は `vitest.dom.config.ts` のコメントを参照。
      'editor/web/vitest.dom.config.ts',
      'editor/web/vitest.node.config.ts',
      'pie-chart/vitest.config.ts',
    ],
    // 集約実行の並列度を明示的に絞る。既定はコア数ぶんの fork を**プロジェクトごとに**
    // 立てるため、4 プロジェクト × カバレッジ計装が 8GB 級の実機を食い潰し、次の 3 つが同時に起きた:
    //   1. `Error: Worker exited unexpectedly` — 全テスト通過後に fork が落ち、終了コードだけ 1 になる
    //   2. `SyntaxError: Unexpected end of JSON input` — 落ちた fork のカバレッジ断片を読んで収集が失敗
    //   3. 個々のテストの実測が 2〜3 倍へ伸び、既定 5s / 300s の上限を超える
    // どれも「テストは正しいのに CI が赤い」形なので、本物の失敗と区別できなくなるのが実害。
    // 速度より完走性を採る — pre-push が唯一の CI ゲートで、落ちると push そのものが止まるため。
    maxWorkers: 4,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      // 各パッケージの include を root 相対へ前置して結合。新規テスト追加時はここを広げる。
      include: [
        // editor/shared
        'editor/shared/src/index.ts',
        'editor/shared/src/schemas.ts',
        'editor/shared/src/result.ts',
        'editor/shared/src/errors.ts',
        'editor/shared/src/domain/template.ts',
        // サンプルデータの合成と属性の被せ方。退行は「基準日が黙って空」の無言の形で
        // 出るため(実際に起きた)、被覆を切らさない。
        'editor/shared/src/domain/sampleData.ts',
        'editor/shared/src/domain/sampleCommon.ts',
        'editor/shared/src/domain/user.ts',
        'editor/shared/src/domain/history.ts',
        'editor/shared/src/domain/messages.ts',
        'editor/shared/src/security/cssExternalRefs.ts',
        'editor/shared/src/security/htmlExternalRefs.ts',
        'editor/shared/src/security/htmlEntities.ts',
        'editor/shared/src/security/urlNormalize.ts',
        'editor/shared/src/security/cssRebase.ts',
        'editor/shared/src/security/svgInspect.ts',
        'editor/shared/src/security/rawTextClose.ts',
        // 往復用の印の定義と、その検出が使う字句解析。関所・検出スクリプト・`toTemplate` の
        // 事後検査が共用するので、見落としは確定テンプレートへの印の焼き付きとして無言で出る。
        'editor/shared/src/security/editingMarkers.ts',
        'editor/shared/src/jinja/jinjaLex.ts',
        'editor/shared/src/html/htmlLex.ts',
        'editor/shared/src/html/rawText.ts',
        'editor/shared/src/css/cssRules.ts',
        // editor/server (vivliostyle は pure layer のみ。build.ts 等は browser+socket 依存で対象外)
        'editor/server/src/auth/password.ts',
        'editor/server/src/auth/loginRateLimit.ts',
        'editor/server/src/vivliostyle/requestCss.ts',
        // セキュリティ修正で新設した層。確定書き込みの関所とテンプレ JS の不変性チェックは
        // 迂回されると他の防御が全部無意味になるため、閾値の対象へ入れる。
        'editor/server/src/security/templateScripts.ts',
        'editor/server/src/repositories/confirmedWrite.ts',
        'editor/server/src/repositories/editingMarkerGate.ts',
        'editor/server/src/repositories/templateMeta.ts',
        // テンプレート集約の中心。一覧/取得の探索順(filled→templates→pending)と
        // 下書き入出力が承認・編集画面の到達可能性を左右するため、被覆を切らさない。
        'editor/server/src/repositories/templateRepo.ts',
        'editor/server/src/files/pendingFiles.ts',
        'editor/server/src/files/syncFiles.ts',
        // テンプレ実体のパス解決と下書きの入出力。`assertTemplateId` / `assertTemplateAttributeToken` を
        // 連結の唯一の場所で強制する層なので、被覆を切らすと関所の退行を検出できない。
        'editor/server/src/files/draftFiles.ts',
        'editor/server/src/files/inProgress.ts',
        'editor/server/src/files/templateFiles.ts',
        // 設定の一元解決。危険な既定値での起動拒否と DATA_ROOT 起点の派生がここに集約されている。
        'editor/server/src/config.ts',
        'editor/server/src/vivliostyle/projectConfig.ts',
        // 認証・認可の層。認可テーブル・資格情報の正規化・応答時間フロアは、
        // 迂回されると認証全体が骨抜きになるため閾値の対象へ入れる。
        'editor/server/src/auth/loginId.ts',
        'editor/server/src/auth/timing.ts',
        'editor/server/src/routes/routeGuards.ts',
        // ルート層。ハンドラ本体は inject テストで通す(templates / parts / users を含む)。
        'editor/server/src/routes/*.ts',
        'editor/server/src/middleware/auth.ts',
        'editor/server/src/security/externalRefs.ts',
        // 隔離の完結で新設。配信ルートへ写す許可リストと egress 遮断の実体で、
        // どちらも「サニタイズを外した代わりの守り」なので閾値の対象へ入れる。
        'editor/server/src/vivliostyle/docAssets.ts',
        'editor/server/src/vivliostyle/docRefs.ts',
        'editor/server/src/vivliostyle/egressGuard.ts',
        'editor/server/src/git/gitRepo.ts',
        'editor/server/src/git/committedAreas.ts',
        'editor/server/src/openapi/docsRoutes.ts',
        'editor/server/src/vivliostyle/previewProxy.ts',
        'editor/server/src/generate/pyTemplate.ts',
        'editor/server/src/generate/generatorCheck.ts',
        'editor/server/src/files/legacyLayoutCheck.ts',
        'editor/server/src/sync/partSync.ts',
        'editor/server/src/sync/cssSync.ts',
        'editor/server/src/sync/noteMasterService.ts',
        'editor/server/src/middleware/*.ts',
        'editor/server/src/vivliostyle/options.ts',
        'editor/server/src/vivliostyle/projectInput.ts',
        'editor/server/src/vivliostyle/inlineCss.ts',
        'editor/server/src/vivliostyle/mergeInput.ts',
        // プレビュー隔離 iframe(opaque オリジン)の配信面と PDF 側の script 対称化。
        // 経路専用 CSP と資産解決は迂回されるとテンプレ資産が未認証露出するため対象へ入れる。
        'editor/server/src/vivliostyle/previewHost.ts',
        'editor/server/src/vivliostyle/inlineDocScripts.ts',
        'editor/server/src/vivliostyle/previewManager.ts',
        'editor/server/src/vivliostyle/buildWorkerPool.ts',
        // プール非経由(`poolSize <= 0`)のフォールバックにも同じ受付制御を効かせる層。
        'editor/server/src/vivliostyle/buildAdmission.ts',
        // 資源上限の層。上限そのものと、上限を守るための
        // 直列化・適用範囲の限定は、迂回されると単一プロセスが 1 リクエストで止まる。
        'editor/server/src/files/atomic.ts',
        'editor/server/src/files/fileLock.ts',
        'editor/server/src/files/fsHelpers.ts',
        'editor/server/src/files/idPairStore.ts',
        'editor/server/src/files/confirmedHtml.ts',
        'editor/server/src/util/mapLimit.ts',
        'editor/server/src/util/inlineBundle.ts',
        'editor/server/src/vivliostyle/workDir.ts',
        'editor/server/src/files/historyFiles.ts',
        'editor/server/src/files/notesFile.ts',
        'editor/server/src/repositories/noteRepo.ts',
        'editor/server/src/routes/zipBodyParser.ts',
        // editor/web (UI/VM/Service/Repository 層)
        'editor/web/src/workers/fallback.ts',
        'editor/web/src/workers/htmlApi.ts',
        'editor/web/src/lib/jinjaMask.ts',
        // 値差込の許可リスト評価器と、その唯一の利用者。全域 CSP から `'unsafe-eval'` を
        // 落とせているのはこの 2 つが `new Function` を使わないからで、退行は「値が空に
        // なるだけ」という無言の形で出るため、被覆を切らさない。
        'editor/web/src/lib/jinjaExpr.ts',
        'editor/web/src/lib/fillJinja.ts',
        // 作成タブの往復の判断の土台(字句解析のブロック木・HTML 構造の走査・固める要素の決定・
        // 表示用の描画)。
        'editor/web/src/lib/jinjaLex.ts',
        'editor/web/src/lib/htmlScan.ts',
        'editor/web/src/lib/fillAnalysis.ts',
        'editor/web/src/lib/fillRender.ts',
        'editor/web/src/lib/blockKey.ts',
        'editor/web/src/lib/newId.ts',
        'editor/web/src/lib/dom.ts',
        // 改ページの位置の判定。canvas・承認・比較・ページ線・警告が共有し、ずれるとページ数と
        // パーツのキーが画面ごとに食い違う。
        'editor/web/src/lib/pageBreaks.ts',
        // 入れ子の @font-face を GrapesJS に通さず運ぶ取り出し。崩れると確定 CSS に壊れた形が書かれる。
        'editor/web/src/lib/cssCarry.ts',
        'editor/web/src/lib/appError.ts',
        'editor/web/src/lib/globalErrors.ts',
        'editor/web/src/lib/useAsyncResult.ts',
        'editor/web/src/lib/format.ts',
        'editor/web/src/lib/labels.ts',
        // 編集経路 / 作成経路の出し分け。`created` query を出す唯一の場所で、退行は
        // 「pending だけのテンプレートを編集経路で開いて申請が拒否される」形で出る。
        'editor/web/src/features/templates/editorRoute.ts',
        'editor/web/src/features/templates/viewmodels/templateVm.ts',
        'editor/web/src/features/templates/components/searchGuard.ts',
        'editor/web/src/features/templates/services/templateCreationService.ts',
        'editor/web/src/features/editor/services/templateEditorService.ts',
        'editor/web/src/features/editor/services/legacyDraft.ts',
        'editor/web/src/features/preview/services/templatePreviewService.ts',
        'editor/web/src/lib/pdfDocument.ts',
        'editor/web/src/features/merge/services/mergePdfService.ts',
        'editor/web/src/features/admin/viewmodels/userVm.ts',
        'editor/web/src/lib/templateDoc.ts',
        'editor/web/src/lib/usePagedList.ts',
        'editor/web/src/lib/nunjucksRender.ts',
        'editor/web/src/lib/sanitizeCss.ts',
        'editor/web/src/lib/sanitizeHtml.ts',
        // プレビュー文書の自己完結化(子の要求ゼロ化)と postMessage クライアント。
        'editor/web/src/lib/previewSelfContain.ts',
        'editor/web/src/lib/fundImages.ts',
        'editor/web/src/lib/assetWarnings.ts',
        'editor/web/src/features/preview/PreviewPanel.vue',
        // Jinja コンパイルを opaque オリジンへ追い出す親側クライアント。
        // 発信元検証・保留・id 対応付けのどれが欠けても隔離が骨抜きになるため対象へ入れる。
        'editor/web/src/lib/renderHostClient.ts',
        'editor/web/src/lib/cropMarks.ts',
        'editor/web/src/lib/formatOutput.ts',
        'editor/web/src/lib/useCascadingSelect.ts',
        // 後着の旧世代応答を捨てる世代ガードと、その利用側が読むクエリ正規化・
        // セッション期限判定。いずれも退行が「たまに古い値が出る」無言の形になる。
        'editor/web/src/lib/useLatest.ts',
        'editor/web/src/lib/routeQuery.ts',
        'editor/web/src/lib/templateAttributeItems.ts',
        'editor/web/src/lib/companyLabel.ts',
        'editor/web/src/lib/useRep1Names.ts',
        'editor/web/src/components/CompanyCodeLabel.vue',
        'editor/web/src/components/FundCodeName.vue',
        'editor/web/src/lib/sessionExpiry.ts',
        'editor/web/src/lib/useIframeAutoFit.ts',
        'editor/web/src/features/editor/geom.ts',
        'editor/web/src/lib/pairSyncText.ts',
        // 編集画面を開くときの読み込み順と、確定版の正規形・CSS の baseline を測る時点。
        'editor/web/src/features/editor/openCanvas.ts',
        'editor/web/src/features/editor/pageView.ts',
        // 編集画面のファンド別画像。属性を書き換えず CSS で差す設計の純粋部分と GrapesJS 配線。
        'editor/web/src/features/editor/fundImages.ts',
        'editor/web/src/features/editor/fundImageLayer.ts',
        'editor/web/src/features/editor/canvasCssAssets.ts',
        // 区切りの帯・Inspector の改ページの操作・ページの警告・ページ線。
        'editor/web/src/features/editor/pagebreakCanvas.ts',
        'editor/web/src/features/editor/partBreak.ts',
        // パーツの挿入先と、固めた範囲の包みの中の区切りでの挿入不可の判定。
        'editor/web/src/features/editor/insertTarget.ts',
        // パーツの追加で Undo・修正履歴・プレビュー選択を積むかの分岐。
        'editor/web/src/features/editor/partInsert.ts',
        // 保留した Undo を、変化の有無で確定か破棄かに分ける 1 手の包み。
        'editor/web/src/features/editor/undoStep.ts',
        // 同じ処理の連続予約を次の描画フレーム 1 回へ集約する。
        'editor/web/src/lib/rafOnce.ts',
        // canvas の根要素の取得と、幾何の計測失敗を overlay の消去に落とす補助。
        'editor/web/src/features/editor/canvasGeometry.ts',
        // UI 状態の変更をセッションへ写して永続する。
        'editor/web/src/features/editor/syncUi.ts',
        'editor/web/src/features/editor/textEditFinish.ts',
        'editor/web/src/features/editor/pageWarnings.ts',
        'editor/web/src/features/editor/usePageGuides.ts',
        'editor/web/src/features/editor/bodyStyle.ts',
        'editor/web/src/features/editor/useSnapshotHistory.ts',
        'editor/web/src/features/editor/usePartEditHistory.ts',
        'editor/web/src/features/editor/useComments.ts',
        'editor/web/src/features/editor/comments/commentFilter.ts',
        'editor/web/src/features/editor/comments/useThreadActions.ts',
        'editor/web/src/features/editor/comments/CommentPanel.vue',
        'editor/web/src/features/editor/partKey.ts',
        // 編集キャンバスの赤入れ（旧文言の取り消し線）。装飾が draft に混入しないことは
        // 「モデルに載せない」設計で担保しており、この 4 ファイルの純粋部分を被覆に入れる。
        'editor/web/src/features/editor/redline/redlineTree.ts',
        'editor/web/src/features/editor/redline/redlineDiff.ts',
        'editor/web/src/features/editor/redline/redlineApply.ts',
        'editor/web/src/features/editor/redline/redlineCss.ts',
        'editor/web/src/features/editor/noteBubbleLayout.ts',
        'editor/web/src/features/editor/partPreviewDoc.ts',
        'editor/web/src/features/editor/useAutosave.ts',
        'editor/web/src/features/editor/leaveGuard.ts',
        'editor/web/src/stores/editorSession.ts',
        'editor/web/src/stores/pendingReviews.ts',
        // 認証セッション。退行は「前の利用者の痕跡が次の利用者へ残る / 再起動の切断理由が
        // 出ない」という共有端末での無言の形で出るため被覆に入れる。
        'editor/web/src/stores/auth.ts',
        // 編集・プレビュー画面のタブ内展開。タブ点灯の写像と直前画面の記憶は、退行が
        // 「別のタブが点く / 一覧へ落ちる」という UI 上の無言の形で出るため被覆に入れる。
        'editor/web/src/features/layout/tabOf.ts',
        'editor/web/src/stores/tabMemory.ts',
        // 下書きの所属判定。退行は「閉じたはずの下書きが黙って復元される」形で出る。
        'editor/web/src/lib/draftOwner.ts',
        'editor/web/src/features/compare/htmlBlockDiff.ts',
        'editor/web/src/features/compare/framedDiffDoc.ts',
        'editor/web/src/features/compare/services/compareService.ts',
        // ページ対応の直接指定。退行は「番号を打っても飛ばない / 対応なしへ落ちる」形で出る。
        'editor/web/src/features/compare/pageMatch.ts',
        'editor/web/src/features/compare/PageMatchInput.vue',
        // 後着の古い応答の破棄。退行は「絞り込みを変えた直後に選択が消える」形で出る。
        'editor/web/src/features/compare/CompareSideSelector.vue',
        'editor/web/src/features/templates/components/CreateFundSelect.vue',
        'editor/web/src/features/reviews/services/reviewDiffService.ts',
        'editor/web/src/features/reviews/services/reviewCompareDocs.ts',
        'editor/web/src/features/reviews/reviewPartMaps.ts',
        'editor/web/src/features/reviews/services/partNames.ts',
        'editor/web/src/features/reviews/services/changedSummary.ts',
        'editor/web/src/features/reviews/resolveReviewTarget.ts',
        'editor/web/src/features/reviews/reviewAccordion.ts',
        'editor/web/src/features/reviews/ReviewTabView.vue',
        'editor/web/src/features/reviews/useReviewDiff.ts',
        'editor/web/src/features/reviews/ReviewNoticeBar.vue',
        'editor/web/src/api/local/authRepo.ts',
        'editor/web/src/api/local/templateRepo.ts',
        'editor/web/src/api/local/userRepo.ts',
        'editor/web/src/api/local/historyRepo.ts',
        'editor/web/src/api/local/partRepo.ts',
        'editor/web/src/api/local/noteRepo.ts',
        'editor/web/src/api/local/reviewRepo.ts',
        'editor/web/src/api/local/fundAssetRepo.ts',
        // rest トランスポートと 7 リポジトリ、DI 合成ルート。local と同じ契約で差し替わることを
        // 直接テストで固定する(rest e2e は挙動の一部しか通らない)。
        'editor/web/src/api/rest/*.ts',
        'editor/web/src/api/repositories.ts',
        // editor/web (ui プリミティブ層。headless 一元化リファクタでテスト追加済みの分)
        'editor/web/src/components/ui/comboboxFilter.ts',
        'editor/web/src/components/ui/options.ts',
        'editor/web/src/components/ui/confirm.ts',
        'editor/web/src/components/ui/overlays.ts',
        'editor/web/src/components/ui/toast.ts',
        'editor/web/src/components/ui/Button.vue',
        'editor/web/src/components/ui/Input.vue',
        'editor/web/src/components/ui/Select.vue',
        'editor/web/src/components/ui/StepperInput.vue',
        'editor/web/src/components/ui/BackButton.vue',
        // pie-chart (layout.ts / label_placement.ts / svg_export/* は verify_* が担当し対象外)
        'pie-chart/src/config.ts',
        // 旧 `svg_geom.ts` / `data.ts` / `glyph_advance.ts` の後継。純粋幾何と入力の正規化で、
        // 上限・数値解釈の退行はどちらも「例外なく壊れた SVG が出る」形になる。
        'pie-chart/src/layout/geometry.ts',
        'pie-chart/src/input/load.ts',
        'pie-chart/src/input/dbStage.ts',
        'pie-chart/src/input/sprocArgs.ts',
        'pie-chart/src/input/db.ts',
        'pie-chart/src/limits.ts',
        'pie-chart/src/svg_export/values.ts',
        // SEA 実行時のモジュール解決。上位ディレクトリ遡りが復活すると任意コード実行になる。
        'pie-chart/src/runtime/seaRuntime.ts',
        'pie-chart/src/runtime/subsetFontFs.ts',
      ],
      // `middleware/auth.ts` を exclude しないこと。viewer ロール強制と
      // `要パスワード変更` の関門がここに集約されており、閾値の外へ置くと退行を検出できない。
      exclude: [],
      thresholds: {
        // ファイル単位で 4 指標とも 85%。全体平均だと薄いファイルが厚いファイルに隠れる。
        perFile: true,
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
