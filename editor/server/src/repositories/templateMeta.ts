// =============================================================================
// templateMeta.ts — ファイル名規約から `TemplateMeta` を組む(台帳を引かない)
// =============================================================================
// `templateRepo.ts` と `confirmedWrite.ts` の双方が使うため、循環 import を避けて
// ここへ切り出す。台帳(DB)は引かず、名前と mtime だけからメタを作る。

import { parseTemplateFileName, type TemplateMeta, templateIdFromFileName } from '@editor/shared';
import { templateMtime } from '../files/templateFiles.js';

/** ファイル名 + 更新時刻から `TemplateMeta` を組む(台帳は引かない)。 */
export async function fileToMeta(fileName: string): Promise<TemplateMeta | null> {
  const attrs = parseTemplateFileName(fileName);
  if (!attrs) return null;
  return {
    id: templateIdFromFileName(fileName),
    attributes: attrs,
    fileName,
    // 確定状態は今後 git コミット有無で表す(phase 3)。本体ファイルが在る分は published 扱い。
    status: 'published',
    updatedAt: await templateMtime(fileName),
    updatedBy: null,
  };
}
