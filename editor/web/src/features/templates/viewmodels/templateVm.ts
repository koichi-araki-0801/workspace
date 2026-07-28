// =============================================================================
// templateVm.ts — テンプレ一覧行の view-model (status をラベル+badge variant へ変換)
// =============================================================================
import type { TemplateAttributes, TemplateMeta, TemplateStatus } from '@editor/shared';

/** テンプレ一覧行の表示形。`status` をラベルと badge variant に展開して持つ。 */
interface TemplateMetaVm {
  id: string;
  attributes: TemplateAttributes;
  fileName: string;
  statusLabel: string;
  statusVariant: 'success' | 'secondary';
  /** 元エンティティ。full meta を必要とする action ハンドラ向け。 */
  raw: TemplateMeta;
}

const STATUS_LABEL: Record<TemplateStatus, string> = {
  published: '公開',
  draft: '下書き',
};

export function toTemplateMetaVm(m: TemplateMeta): TemplateMetaVm {
  return {
    id: m.id,
    attributes: m.attributes,
    fileName: m.fileName,
    statusLabel: STATUS_LABEL[m.status],
    statusVariant: m.status === 'published' ? 'success' : 'secondary',
    raw: m,
  };
}
