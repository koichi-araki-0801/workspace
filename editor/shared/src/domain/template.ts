// =============================================================================
// template.ts — テンプレート identity の値オブジェクトとファイル名規約の純関数
// =============================================================================
// ファイル名規約は `company_fund_date_edition.html`。純粋・依存なしなので `web` と
// `server` の双方で再利用できる。

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
