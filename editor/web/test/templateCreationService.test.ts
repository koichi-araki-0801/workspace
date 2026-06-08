import { isErr, isOk, ok, type TemplateMeta, type TemplateRepository } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createTemplateCreationService,
  SELECT_ALL_MSG,
} from '@/features/templates/services/templateCreationService';

const meta: TemplateMeta = {
  id: 'AM01_510037_20240710_kr',
  attributes: { companyCode: 'AM01', fundCode: '510037', baseDate: '20240710', editionType: 'kr' },
  fileName: 'AM01_510037_20240710_kr.html',
  status: 'draft',
  updatedAt: null,
  updatedBy: null,
};

function repoWithGenerate() {
  const generate = vi.fn(async () => ok({ template: { meta, html: '', css: '' } }));
  return { generate } as unknown as TemplateRepository & { generate: typeof generate };
}

describe('TemplateCreationService.create', () => {
  it('rejects incomplete attributes without calling the repository', async () => {
    const repo = repoWithGenerate();
    const svc = createTemplateCreationService(repo);
    const res = await svc.create({ companyCode: 'AM01', fundCode: '', editionType: 'kr' });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe('validation');
      expect(res.error.message).toBe(SELECT_ALL_MSG);
    }
    expect(repo.generate).not.toHaveBeenCalled();
  });

  it('generates and returns the new meta when attributes are complete', async () => {
    const repo = repoWithGenerate();
    const svc = createTemplateCreationService(repo);
    const res = await svc.create({ companyCode: 'AM01', fundCode: '510037', editionType: 'kr' });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.id).toBe(meta.id);
    expect(repo.generate).toHaveBeenCalledOnce();
  });
});
