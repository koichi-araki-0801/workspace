/**
 * Template identity — the value object behind a template and the pure functions
 * over its filename convention (`company_fund_date_edition.html`).
 *
 * Pure and dependency-free so both `web` and `server` can reuse them.
 */

import type { TemplateAttributes } from '../index.js';

export const TEMPLATE_FILENAME_RE =
  /^(?<companyCode>[^_]+)_(?<fundCode>[^_]+)_(?<baseDate>[^_]+)_(?<editionType>[^_]+)\.html$/;

export function parseTemplateFileName(fileName: string): TemplateAttributes | null {
  const m = TEMPLATE_FILENAME_RE.exec(fileName);
  if (!m?.groups) return null;
  const { companyCode, fundCode, baseDate, editionType } = m.groups;
  return { companyCode, fundCode, baseDate, editionType };
}

export function templateFileName(a: TemplateAttributes): string {
  return `${a.companyCode}_${a.fundCode}_${a.baseDate}_${a.editionType}.html`;
}

export function templateIdFromFileName(fileName: string): string {
  return fileName.replace(/\.html$/, '');
}
