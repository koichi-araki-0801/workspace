// =============================================================================
// templateRepo.options.empty.test.ts — filled/ と pending/ が無い環境でも候補は空で返る
// =============================================================================
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const missing = path.join(os.tmpdir(), `editor-template-repo-options-missing-${process.pid}`);
process.env.DATA_ROOT = missing;
process.env.TEMPLATES_DIR = path.join(missing, 'templates');
process.env.FILLED_DIR = path.join(missing, 'filled');
process.env.CSS_DIR = path.join(missing, 'css');
process.env.PENDING_DIR = path.join(missing, 'pending');
process.env.DRAFTS_DIR = path.join(missing, 'drafts');

describe('置き場が無い環境', () => {
  it('edit / published とも空の候補を返す(500 にしない)', async () => {
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    const repo = createTemplateRepo(createOfflineSproc());
    const none = { companyCodes: [], fundCodes: [], baseDates: [], editionTypes: [] };
    expect(await repo.getDropdownOptions({}, 'edit')).toEqual(none);
    expect(await repo.getDropdownOptions({}, 'published')).toEqual(none);
  });
});
