import type { TemplateAttributes, TemplateMeta, TemplateStatus } from '@editor/shared';

/** Display shape for a template row: status rendered as label + badge variant. */
export interface TemplateMetaVm {
  id: string;
  attributes: TemplateAttributes;
  fileName: string;
  statusLabel: string;
  statusVariant: 'default' | 'secondary';
  /** The source entity, for action handlers that need the full meta. */
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
    statusVariant: m.status === 'published' ? 'default' : 'secondary',
    raw: m,
  };
}
