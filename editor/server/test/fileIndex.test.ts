import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TemplateMeta } from '@editor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropdownOptions, filterTemplates, indexTemplates } from '../src/templates/fileIndex.js';

// --- fixtures for the pure (fs-free) functions ------------------------------

function meta(
  companyCode: string,
  fundCode: string,
  baseDate: string,
  editionType: string,
): TemplateMeta {
  return {
    id: `${companyCode}_${fundCode}_${baseDate}_${editionType}`,
    attributes: { companyCode, fundCode, baseDate, editionType },
    fileName: `${companyCode}_${fundCode}_${baseDate}_${editionType}.html`,
    status: 'published',
    updatedAt: null,
    updatedBy: null,
  };
}

const METAS: TemplateMeta[] = [
  meta('AM01', '510037', '20240710', 'kr'),
  meta('AM01', '510037', '20240711', 'un'),
  meta('AM01', '999999', '20240710', 'kr'),
  meta('AM02', '111111', '20240101', 'kr'),
];

describe('filterTemplates', () => {
  it('returns every template when the query is empty', () => {
    expect(filterTemplates(METAS, {})).toHaveLength(METAS.length);
  });

  it('filters by companyCode', () => {
    const out = filterTemplates(METAS, { companyCode: 'AM02' });
    expect(out).toHaveLength(1);
    expect(out[0].attributes.fundCode).toBe('111111');
  });

  it('combines multiple attribute filters (AND)', () => {
    const out = filterTemplates(METAS, {
      companyCode: 'AM01',
      fundCode: '510037',
      editionType: 'kr',
    });
    expect(out).toHaveLength(1);
    expect(out[0].attributes.baseDate).toBe('20240710');
  });

  it('returns nothing when no template matches', () => {
    expect(filterTemplates(METAS, { companyCode: 'NOPE' })).toHaveLength(0);
  });
});

describe('dropdownOptions', () => {
  it('lists all company codes, sorted and de-duplicated', () => {
    expect(dropdownOptions(METAS, {}).companyCodes).toEqual(['AM01', 'AM02']);
  });

  it('scopes fundCodes to the selected company', () => {
    const opts = dropdownOptions(METAS, { companyCode: 'AM01' });
    expect(opts.fundCodes).toEqual(['510037', '999999']);
  });

  it('narrows baseDates/editionTypes by the full query', () => {
    const opts = dropdownOptions(METAS, { companyCode: 'AM01', fundCode: '510037' });
    expect(opts.baseDates).toEqual(['20240710', '20240711']);
    expect(opts.editionTypes).toEqual(['kr', 'un']);
  });
});

// --- indexTemplates: reads a directory, parses the filename convention -------

describe('indexTemplates', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpl-test-'));
    fs.writeFileSync(path.join(dir, 'AM01_510037_20240710_kr.html'), '<p>{{ x }}</p>');
    fs.writeFileSync(path.join(dir, 'AM02_111111_20240101_un.html'), '<p>{{ y }}</p>');
    fs.writeFileSync(path.join(dir, 'not-a-template.txt'), 'ignored');
    fs.writeFileSync(path.join(dir, 'bad_name.html'), 'ignored'); // too few segments
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes only valid .html templates and parses their attributes', async () => {
    const metas = await indexTemplates(dir);
    expect(metas).toHaveLength(2);
    const ids = metas.map((m) => m.id).sort();
    expect(ids).toEqual(['AM01_510037_20240710_kr', 'AM02_111111_20240101_un']);
    const am01 = metas.find((m) => m.id === 'AM01_510037_20240710_kr');
    expect(am01?.attributes.fundCode).toBe('510037');
    expect(am01?.status).toBe('published');
    expect(typeof am01?.updatedAt).toBe('string');
  });

  it('returns an empty array when the directory does not exist', async () => {
    const metas = await indexTemplates(path.join(dir, 'does-not-exist'));
    expect(metas).toEqual([]);
  });
});
