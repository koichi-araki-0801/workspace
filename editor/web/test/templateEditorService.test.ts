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

  it('uses the sample fund name for the title when available', async () => {
    const templates = {
      getTemplate: vi.fn(async () => ok(tpl)),
      getDraft: vi.fn(async () => ok(null)),
      getSampleData: vi.fn(async () => ok({ fund: { name: 'グローバル株式ファンド' } })),
    } as unknown as TemplateRepository;
    const parts = { listParts: vi.fn(async () => ok([])) } as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.loadForEdit('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.fundName).toBe('グローバル株式ファンド');
  });

  it('falls back to the file name when the sample fetch fails', async () => {
    const templates = {
      getTemplate: vi.fn(async () => ok(tpl)),
      getDraft: vi.fn(async () => ok(null)),
      getSampleData: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as TemplateRepository;
    const parts = { listParts: vi.fn(async () => ok([])) } as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.loadForEdit('t1');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.fundName).toBe('t1');
  });
});

describe('TemplateEditorService.saveDraft / getPartHistory', () => {
  it('delegates saveDraft to the template repository', async () => {
    const saveDraft = vi.fn(async () => ok(undefined));
    const templates = { saveDraft } as unknown as TemplateRepository;
    const parts = {} as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.saveDraft('t1', '<p>x</p>', '.c{}');
    expect(isOk(res)).toBe(true);
    expect(saveDraft).toHaveBeenCalledWith({ templateId: 't1', html: '<p>x</p>', css: '.c{}' });
  });

  it('delegates getPartHistory to the part repository', async () => {
    const getPartHistory = vi.fn(async () => ok([]));
    const templates = {} as unknown as TemplateRepository;
    const parts = { getPartHistory } as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.getPartHistory('t1', 'p1');
    expect(isOk(res)).toBe(true);
    expect(getPartHistory).toHaveBeenCalledWith('t1', 'p1');
  });
});
