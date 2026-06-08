import {
  err,
  isErr,
  isOk,
  notFound,
  ok,
  type PartRepository,
  type Template,
  type TemplateDraft,
  type TemplateRepository,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTemplateEditorService } from '@/features/editor/services/templateEditorService';

const tpl: Template = {
  meta: {
    id: 't1',
    attributes: { companyCode: 'A', fundCode: 'F', baseDate: '20240101', editionType: 'kr' },
    fileName: 't1.html',
    status: 'draft',
    updatedAt: null,
    updatedBy: null,
  },
  html: '<html><body><p>{{ x }}</p></body></html>',
  css: '.from-file{}',
};

function repos(opts: { draft?: TemplateDraft | null; templateErr?: boolean }) {
  const templates = {
    getTemplate: vi.fn(async () => (opts.templateErr ? err(notFound('no')) : ok(tpl))),
    listParts: vi.fn(async () => ok([])),
    getDraft: vi.fn(async () => ok(opts.draft ?? null)),
  } as unknown as TemplateRepository;
  const parts = {
    listParts: vi.fn(async () => ok([])),
    getPartHistory: vi.fn(async () => ok([])),
  } as unknown as PartRepository;
  return { templates, parts };
}

describe('TemplateEditorService.loadForEdit', () => {
  it('masks the source file when there is no draft', async () => {
    const { templates, parts } = repos({ draft: null });
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.loadForEdit('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.css).toBe('.from-file{}');
      // body masked to editable form (Jinja preserved as a locked chip)
      expect(res.value.editableBody).toContain('jinja');
    }
  });

  it('prefers the autosaved draft over the file', async () => {
    const draft: TemplateDraft = {
      templateId: 't1',
      html: '<p>draft body</p>',
      css: '.from-draft{}',
      savedAt: '',
      savedBy: '',
    };
    const { templates, parts } = repos({ draft });
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.loadForEdit('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.editableBody).toBe('<p>draft body</p>');
      expect(res.value.css).toBe('.from-draft{}');
    }
  });

  it('propagates a not_found error from getTemplate', async () => {
    const { templates, parts } = repos({ templateErr: true });
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.loadForEdit('t1');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('not_found');
  });
});
