// =============================================================================
// mergePdfService.ts — 複数テンプレートを 1 つの結合 PDF にレンダリングするサービス
// =============================================================================
// 結合PDF タブの裏方。選択テンプレを配列順に値埋めし(値埋めは `renderPdfDocument` 経由で
// 隔離 iframe が行う。`lib/renderHostClient.ts`)、レンダ済み
// 文書群を `POST /api/build/merge` へ送って通しページ番号付きの 1 PDF を得る。draft は
// 適用しない — 結合対象は「台帳の登録済み(確定)内容」であり、編集途中の作業コピーが
// 出力へ紛れると成果物の正が揺らぐ(プレビューの `loadForPreview` とはここが違う)。

import {
  apiPaths,
  applyEdition,
  conflict,
  err,
  type HistoryRepository,
  isErr,
  ok,
  type Result,
  type TemplateRepository,
} from '@editor/shared';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { apiUrl } from '@/api/rest/http';
import { logError } from '@/lib/appError';
import { formatCss } from '@/lib/formatOutput';
import { PDF_ERROR_MSG, renderPdfDocument } from '@/lib/pdfDocument';

interface MergePdfService {
  /**
   * 選択テンプレ(配列順 = ページ順)を値埋めして結合 PDF blob を得る。`onProgress` は
   * 文書ごとのレンダ完了時に (完了数, 総数) で呼ばれる(fetch 待ちは含まない)。
   */
  renderMergedPdf(
    ids: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Result<Blob>>;
}

export function createMergePdfService(
  templates: TemplateRepository,
  history: HistoryRepository,
): MergePdfService {
  return {
    async renderMergedPdf(ids, onProgress) {
      try {
        // 逐次レンダリング: worker は単一なので並列化の益が薄く、逐次なら進捗が単調に進む。
        const documents: { html: string; css: string }[] = [];
        for (const [i, id] of ids.entries()) {
          const doc = await renderOne(templates, id, i);
          if (isErr(doc)) return doc;
          documents.push(doc.value);
          onProgress?.(i + 1, ids.length);
        }

        const res = await fetch(apiUrl(apiPaths.buildMerge), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documents }),
        });
        if (!res.ok) return err(conflict(PDF_ERROR_MSG, { cause: `HTTP ${res.status}` }));
        const blob = await res.blob();

        // PDF 出力履歴は単体出力(プレビュー画面)と揃えて各テンプレへ記録する。履歴は
        // 成果物ではないためベストエフォート — 失敗してもダウンロードは成立させる。
        await Promise.all(
          ids.map(async (id) => {
            const rec = await history.recordPdfExport(id);
            if (isErr(rec)) logError(rec.error);
          }),
        );
        return ok(blob);
      } catch (e) {
        return err(conflict(PDF_ERROR_MSG, { cause: e }));
      }
    },
  };
}

/** 1 テンプレを取得 → サンプル値適用 → PDF 入力文書へ変換する。失敗時は何件目かを文言に含める。 */
async function renderOne(
  templates: TemplateRepository,
  id: string,
  index: number,
): Promise<Result<{ html: string; css: string }>> {
  const nth = `(${index + 1}件目)`;
  const tplRes = await templates.getTemplate(id);
  if (isErr(tplRes)) {
    return err(conflict(`テンプレート${nth}の取得に失敗しました。`, { cause: tplRes.error }));
  }
  const tpl = tplRes.value;

  const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
  if (isErr(sampleRes)) {
    return err(conflict(`サンプルデータ${nth}の取得に失敗しました。`, { cause: sampleRes.error }));
  }
  // 版種(ファイル名由来)を被せる。getSampleData はファンド単位で版種を持たない
  // (`loadForPreview` と同じ被せ方)。
  const sample = applyEdition(sampleRes.value, tpl.meta.attributes.editionType);

  const doc = await renderPdfDocument(tpl.html, formatCss(tpl.css), sample, { cropMarks: false });
  if (isErr(doc)) {
    return err(conflict(`テンプレート${nth}のレンダリングに失敗しました。`, { cause: doc.error }));
  }
  return doc;
}

export const useMergePdfService = (): MergePdfService =>
  createMergePdfService(useTemplateRepo(), useHistoryRepo());
