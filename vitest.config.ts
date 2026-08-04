/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// ワークスペース全体の Vitest エントリ。各パッケージの設定(environment/alias/globals)は
// 個別 config に残し、ここでは `projects` で集約して `vitest run` 一発で全プロジェクトを
// 各環境(web=jsdom / 他=node)で実行する。coverage は Vitest の仕様上ラン全体で 1 つしか
// 持てないため、従来パッケージ別だった include/閾値をここへ一本化し、閾値は全指標 85% に統一する。
// 「テスト対象のみゲート」方針(cf. editor 各 vitest.config の include 方針)は include 列挙で維持。
export default defineConfig({
  test: {
    projects: [
      'editor/shared/vitest.config.ts',
      'editor/server/vitest.config.ts',
      'editor/web/vite.config.ts',
      'pie-chart/vitest.config.ts',
      'graph-editor/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      // 各パッケージの旧 include を root 相対へ前置して結合。新規テスト追加時はここを広げる。
      include: [
        // editor/shared
        'editor/shared/src/index.ts',
        'editor/shared/src/schemas.ts',
        'editor/shared/src/result.ts',
        'editor/shared/src/errors.ts',
        'editor/shared/src/domain/template.ts',
        'editor/shared/src/domain/user.ts',
        'editor/shared/src/domain/history.ts',
        'editor/shared/src/security/cssExternalRefs.ts',
        // editor/server (vivliostyle は pure layer のみ。build.ts 等は browser+socket 依存で対象外)
        'editor/server/src/auth/password.ts',
        'editor/server/src/auth/loginRateLimit.ts',
        // セキュリティ修正で新設した層。確定書き込みの関所とテンプレ JS の不変性チェックは
        // 迂回されると他の防御が全部無意味になるため、閾値の対象へ入れる。
        'editor/server/src/security/templateScripts.ts',
        'editor/server/src/repositories/confirmedWrite.ts',
        'editor/server/src/repositories/templateMeta.ts',
        'editor/server/src/files/pendingFiles.ts',
        'editor/server/src/vivliostyle/projectConfig.ts',
        // 段階 2 の新設層。認可テーブル・資格情報の正規化・応答時間フロアは、
        // 迂回されると認証全体が骨抜きになるため閾値の対象へ入れる。
        'editor/server/src/auth/loginId.ts',
        'editor/server/src/auth/timing.ts',
        'editor/server/src/routes/routeGuards.ts',
        'editor/server/src/middleware/auth.ts',
        'editor/server/src/security/externalRefs.ts',
        'editor/server/src/git/gitRepo.ts',
        'editor/server/src/openapi/docsRoutes.ts',
        'editor/server/src/vivliostyle/previewProxy.ts',
        'editor/server/src/generate/pyTemplate.ts',
        'editor/server/src/sync/partSync.ts',
        'editor/server/src/sync/noteMasterService.ts',
        'editor/server/src/middleware/*.ts',
        'editor/server/src/vivliostyle/options.ts',
        'editor/server/src/vivliostyle/projectInput.ts',
        'editor/server/src/vivliostyle/inlineCss.ts',
        'editor/server/src/vivliostyle/mergeInput.ts',
        'editor/server/src/vivliostyle/previewManager.ts',
        'editor/server/src/vivliostyle/buildWorkerPool.ts',
        // editor/web (UI/VM/Service/Repository 層)
        'editor/web/src/workers/fallback.ts',
        'editor/web/src/lib/jinjaMask.ts',
        'editor/web/src/lib/blockKey.ts',
        'editor/web/src/lib/appError.ts',
        'editor/web/src/lib/useAsyncResult.ts',
        'editor/web/src/lib/format.ts',
        'editor/web/src/lib/labels.ts',
        'editor/web/src/features/templates/viewmodels/templateVm.ts',
        'editor/web/src/features/templates/services/templateCreationService.ts',
        'editor/web/src/features/editor/services/templateEditorService.ts',
        'editor/web/src/features/preview/services/templatePreviewService.ts',
        'editor/web/src/lib/pdfDocument.ts',
        'editor/web/src/features/merge/services/mergePdfService.ts',
        'editor/web/src/features/admin/viewmodels/userVm.ts',
        'editor/web/src/lib/templateDoc.ts',
        'editor/web/src/lib/usePagedList.ts',
        'editor/web/src/lib/nunjucksRender.ts',
        'editor/web/src/lib/sanitizeCss.ts',
        'editor/web/src/lib/sanitizeHtml.ts',
        'editor/web/src/lib/cropMarks.ts',
        'editor/web/src/lib/formatOutput.ts',
        'editor/web/src/lib/useCascadingSelect.ts',
        'editor/web/src/lib/useIframeAutoFit.ts',
        'editor/web/src/features/editor/geom.ts',
        'editor/web/src/features/editor/pageView.ts',
        'editor/web/src/features/editor/useSnapshotHistory.ts',
        'editor/web/src/features/editor/usePartEditHistory.ts',
        'editor/web/src/features/editor/usePartNote.ts',
        'editor/web/src/features/editor/partKey.ts',
        'editor/web/src/features/editor/useAutosave.ts',
        'editor/web/src/stores/editorSession.ts',
        'editor/web/src/features/compare/htmlBlockDiff.ts',
        'editor/web/src/features/compare/services/compareService.ts',
        'editor/web/src/features/reviews/services/reviewDiffService.ts',
        'editor/web/src/features/reviews/useReviewDiff.ts',
        'editor/web/src/api/local/authRepo.ts',
        'editor/web/src/api/local/templateRepo.ts',
        'editor/web/src/api/local/userRepo.ts',
        'editor/web/src/api/local/historyRepo.ts',
        'editor/web/src/api/local/partRepo.ts',
        'editor/web/src/api/local/noteRepo.ts',
        'editor/web/src/api/local/reviewRepo.ts',
        // editor/web (ui プリミティブ層。headless 一元化リファクタでテスト追加済みの分)
        'editor/web/src/components/ui/confirm.ts',
        'editor/web/src/components/ui/overlays.ts',
        'editor/web/src/components/ui/toast.ts',
        'editor/web/src/components/ui/Button.vue',
        'editor/web/src/components/ui/Input.vue',
        'editor/web/src/components/ui/Select.vue',
        'editor/web/src/components/ui/StepperInput.vue',
        'editor/web/src/components/ui/BackButton.vue',
        // pie-chart (layout.ts / label_placement.ts / svg_export/* は verify_* が担当し対象外)
        'pie-chart/src/svg_geom.ts',
        'pie-chart/src/config.ts',
        'pie-chart/src/glyph_advance.ts',
        'pie-chart/src/data.ts',
        'pie-chart/src/limits.ts',
        'pie-chart/src/svg_export/values.ts',
        // graph-editor (ui.html と共有する純粋関数のみ)
        'graph-editor/resources/web/lib/leader_geom.cjs',
        // 未信頼 SVG の許可リスト。denylist へ退行すると読み込み即実行に戻るため閾値で守る。
        'graph-editor/resources/web/js/svg-policy.js',
        // SEA 実行時のモジュール解決。上位ディレクトリ遡りが復活すると任意コード実行になる。
        'pie-chart/src/runtime/seaRuntime.ts',
        'pie-chart/src/runtime/subsetFontFs.ts',
      ],
      // 2026-08-05: `middleware/auth.ts` の exclude を解除した。viewer ロール強制と
      // `要パスワード変更` の関門がここに集約されたため、閾値の外へ置くと退行を検出できない。
      exclude: [],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
