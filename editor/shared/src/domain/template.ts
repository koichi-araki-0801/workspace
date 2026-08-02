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

// ── 交付版⇄全体版 ペア解決 ──
// 同一の会社/ファンド/基準日で版種だけが異なる 2 テンプレートを「ペア」と呼び、確定保存の
// 承認直後にパーツ単位の自動同期(server の `sync/partSync.ts`)を掛ける。版種は自由文字列の
// ままだが(旧 `kr`/`zr` 等の残存資産を壊さない)、ペアとして扱うのは下表の 2 値に限る。

/** 自動同期のペアとみなす版種の相互対応。ここに無い版種はペア無し(同期対象外)。 */
export const EDITION_SYNC_PAIRS: Readonly<Record<string, string>> = {
  交付版: '全体版',
  全体版: '交付版',
};

/**
 * テンプレート ID から同期ペアの ID を導く。版種がペア対象外・ID が規約外なら null。
 * ペア実体(ファイル)の存在確認は呼び出し側の責務(ここは純粋な名前変換のみ)。
 */
export function pairedTemplateId(templateId: string): string | null {
  const attrs = parseTemplateFileName(`${templateId}.html`);
  if (!attrs) return null;
  const paired = EDITION_SYNC_PAIRS[attrs.editionType];
  if (!paired) return null;
  return templateIdFromFileName(templateFileName({ ...attrs, editionType: paired }));
}

/** ペア単位の識別子(版種を除いた 3 属性)。同期状態ファイル `sync/<pairKey>.json` の名に使う。 */
export function templatePairKey(a: TemplateAttributes): string {
  return `${a.companyCode}_${a.fundCode}_${a.baseDate}`;
}
