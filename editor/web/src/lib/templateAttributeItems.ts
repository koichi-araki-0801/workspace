// =============================================================================
// templateAttributeItems.ts — テンプレート属性の表示項目(上部バー・属性欄で共用。純関数)
// =============================================================================
// テンプレート(templates/。会社_ファンド_版種)は基準日を持たない。基準日の無いテンプレートを
// 開いているときは、空のチップを出さず基準日の項目ごと省く。

import type { TemplateAttributes } from '@editor/shared';

export interface TemplateAttributeItem {
  key: keyof TemplateAttributes;
  label: string;
  value: string;
}

const LABELS: ReadonlyArray<[keyof TemplateAttributes, string]> = [
  ['companyCode', '委託会社コード'],
  ['fundCode', 'ファンドコード'],
  ['baseDate', '基準日'],
  ['editionType', '版種'],
];

/** 表示する属性の項目(決まった順)。値の無い項目(テンプレートの基準日)は出さない。 */
export function templateAttributeItems(a: TemplateAttributes): TemplateAttributeItem[] {
  return LABELS.flatMap(([key, label]) => {
    const value = a[key];
    return value === undefined ? [] : [{ key, label, value }];
  });
}
