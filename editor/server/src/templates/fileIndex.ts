import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type DropdownOptions,
  type DropdownQuery,
  parseTemplateFileName,
  type TemplateMeta,
  templateIdFromFileName,
} from '@editor/shared';
import { config } from '../config.js';

/**
 * Scan the templates directory and parse the filename convention
 * `委託会社_ファンド_基準日_版種.html` into template metadata. The fixed-schema
 * SQL Server registry (phase 2) can replace this with a DB query exposing the
 * same shape.
 */
export async function indexTemplates(dir: string = config.templatesDir): Promise<TemplateMeta[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas: TemplateMeta[] = [];
  for (const fileName of files) {
    if (!fileName.endsWith('.html')) continue;
    const attrs = parseTemplateFileName(fileName);
    if (!attrs) continue;
    const stat = await fs.stat(path.join(dir, fileName));
    metas.push({
      id: templateIdFromFileName(fileName),
      attributes: attrs,
      fileName,
      status: 'published',
      updatedAt: stat.mtime.toISOString(),
      updatedBy: null,
    });
  }
  return metas;
}

export function filterTemplates(metas: TemplateMeta[], q: DropdownQuery): TemplateMeta[] {
  return metas.filter(
    (m) =>
      (!q.companyCode || m.attributes.companyCode === q.companyCode) &&
      (!q.fundCode || m.attributes.fundCode === q.fundCode) &&
      (!q.baseDate || m.attributes.baseDate === q.baseDate) &&
      (!q.editionType || m.attributes.editionType === q.editionType),
  );
}

export function dropdownOptions(metas: TemplateMeta[], q: DropdownQuery): DropdownOptions {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const scoped = metas.filter((m) => !q.companyCode || m.attributes.companyCode === q.companyCode);
  const full = filterTemplates(metas, q);
  return {
    companyCodes: uniq(metas.map((m) => m.attributes.companyCode)),
    fundCodes: uniq(scoped.map((m) => m.attributes.fundCode)),
    baseDates: uniq(full.map((m) => m.attributes.baseDate)),
    editionTypes: uniq(full.map((m) => m.attributes.editionType)),
  };
}
