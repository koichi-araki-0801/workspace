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
    listPartHistory: vi.fn(async () => ok([])),
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
      expect(res.value.hasDraft).toBe(false); // draft 無し → dirty 初期値 false
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
      expect(res.value.hasDraft).toBe(true); // draft 有り → 最初から dirty 扱い
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

describe('TemplateEditorService.loadForEdit — CSS 外部参照の入口ガード', () => {
  // canvas iframe は `about:blank` でアプリのオリジンを継承するため、`@import` や
  // `url(https://…)` が生き残ると承認者のオリジンから外向き GET が出る。
  function svcFor(opts: { tplCss?: string; draftCss?: string }) {
    const draft: TemplateDraft | null =
      opts.draftCss === undefined
        ? null
        : {
            templateId: 't1',
            html: '<p>draft body</p>',
            css: opts.draftCss,
            savedAt: '',
            savedBy: '',
          };
    const templates = {
      getTemplate: vi.fn(async () => ok({ ...tpl, css: opts.tplCss ?? '.from-file{}' })),
      getDraft: vi.fn(async () => ok(draft)),
    } as unknown as TemplateRepository;
    const parts = { listParts: vi.fn(async () => ok([])) } as unknown as PartRepository;
    return createTemplateEditorService(templates, parts);
  }

  it('draft の CSS に @import があると開けない(下書き破棄の案内付き)', async () => {
    const res = await svcFor({ draftCss: '@import "http://evil.example/x.css";' }).loadForEdit(
      't1',
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe('validation');
      expect(res.error.message).toContain('@import');
      expect(res.error.message).toContain('下書きを破棄');
    }
  });

  it('テンプレ CSS の絶対 URL url() で開けない(draft 由来ではないので案内は付かない)', async () => {
    const res = await svcFor({
      tplCss: '.a{background:url(https://evil.example/leak.png)}',
    }).loadForEdit('t1');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe('validation');
      expect(res.error.message).toContain('https://evil.example/leak.png');
      expect(res.error.message).not.toContain('下書きを破棄');
    }
  });

  it('エスケープ表記 url(\\68ttp://…) も拒否される(共有トークナイザ経由)', async () => {
    const res = await svcFor({
      tplCss: '.a{background:url(\\68ttp://evil.example/x)}',
    }).loadForEdit('t1');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('validation');
  });

  it('外部参照の無い CSS は従来どおり開ける', async () => {
    const res = await svcFor({
      tplCss: '@media print{.a{background:url(data:image/png;base64,AAAA)}}',
    }).loadForEdit('t1');
    expect(isOk(res)).toBe(true);
  });
});

describe('TemplateEditorService.saveDraft / listPartHistory', () => {
  it('delegates saveDraft to the template repository', async () => {
    const saveDraft = vi.fn(async () => ok(undefined));
    const templates = { saveDraft } as unknown as TemplateRepository;
    const parts = {} as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.saveDraft('t1', '<p>x</p>', '.c{}');
    expect(isOk(res)).toBe(true);
    expect(saveDraft).toHaveBeenCalledWith({ templateId: 't1', html: '<p>x</p>', css: '.c{}' });
  });

  it('delegates discardDraft to the template repository', async () => {
    const discardDraft = vi.fn(async () => ok(undefined));
    const templates = { discardDraft } as unknown as TemplateRepository;
    const parts = {} as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.discardDraft('t1');
    expect(isOk(res)).toBe(true);
    expect(discardDraft).toHaveBeenCalledWith('t1');
  });

  it('delegates listPartHistory to the part repository', async () => {
    const listPartHistory = vi.fn(async () => ok([]));
    const templates = {} as unknown as TemplateRepository;
    const parts = { listPartHistory } as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.listPartHistory('t1');
    expect(isOk(res)).toBe(true);
    expect(listPartHistory).toHaveBeenCalledWith('t1');
  });

  it('delegates getSyncStatus to the template repository', async () => {
    const getSyncStatus = vi.fn(async () =>
      ok({ pairTemplateId: null, pairExists: false, conflicts: [] }),
    );
    const templates = { getSyncStatus } as unknown as TemplateRepository;
    const parts = {} as unknown as PartRepository;
    const svc = createTemplateEditorService(templates, parts);
    const res = await svc.getSyncStatus('t1');
    expect(isOk(res)).toBe(true);
    expect(getSyncStatus).toHaveBeenCalledWith('t1');
  });
});
