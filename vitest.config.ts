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
        'editor/shared/src/result.ts',
        'editor/shared/src/errors.ts',
        'editor/shared/src/domain/template.ts',
        'editor/shared/src/domain/user.ts',
        'editor/shared/src/domain/history.ts',
        // editor/server (vivliostyle は pure layer のみ。build.ts 等は browser+socket 依存で対象外)
        'editor/server/src/generate/pyTemplate.ts',
        'editor/server/src/middleware/*.ts',
        'editor/server/src/vivliostyle/options.ts',
        'editor/server/src/vivliostyle/projectInput.ts',
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
        'editor/web/src/features/admin/viewmodels/userVm.ts',
        'editor/web/src/lib/templateDoc.ts',
        'editor/web/src/lib/usePagedList.ts',
        'editor/web/src/lib/nunjucksRender.ts',
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
        // pie-chart (layout.ts / label_placement.ts / svg_export/* は verify_* が担当し対象外)
        'pie-chart/src/svg_geom.ts',
        'pie-chart/src/config.ts',
        'pie-chart/src/glyph_advance.ts',
        'pie-chart/src/data.ts',
        // graph-editor (ui.html と共有する純粋関数のみ)
        'graph-editor/resources/web/lib/leader_geom.cjs',
      ],
      // auth.ts はフェーズ2(DBセッション/SQL Server依存)で未テスト・未デプロイのため対象外。
      exclude: ['editor/server/src/middleware/auth.ts'],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
