// =============================================================================
// templateMeta.ts — ファイル名規約から `TemplateMeta` を組む(台帳を引かない)
// =============================================================================
// `templateRepo.ts` と `confirmedWrite.ts` の双方が使うため、循環 import を避けて
// ここへ切り出す。台帳(DB)は引かず、名前と mtime だけからメタを作る。

import { parseTemplateFileName, type TemplateMeta, templateIdFromFileName } from '@editor/shared';
import { filledMtime, templateMtime } from '../files/templateFiles.js';

/**
 * ファイル名 + 更新時刻から `TemplateMeta` を組む(台帳は引かない)。`source` は更新時刻を
 * どちらの実体から取るか。編集タブの一覧は値入り HTML(`filled`)の時刻を出す。
 */
export async function fileToMeta(
  fileName: string,
  source: 'template' | 'filled' = 'template',
): Promise<TemplateMeta | null> {
  const attrs = parseTemplateFileName(fileName);
  if (!attrs) return null;
  return {
    id: templateIdFromFileName(fileName),
    attributes: attrs,
    fileName,
    // 本体ファイルが在る分は published 扱い(確定状態は git コミット有無で表す予定)。
    status: 'published',
    updatedAt: source === 'filled' ? await filledMtime(fileName) : await templateMtime(fileName),
    updatedBy: null,
  };
}
