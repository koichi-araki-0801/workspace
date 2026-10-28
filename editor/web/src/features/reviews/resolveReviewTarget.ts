// =============================================================================
// resolveReviewTarget.ts — 承認タブが対象にするテンプレート id の解決(純関数)
// =============================================================================
// 役割: 承認タブの対象は `?template=<id>` だけで決める。渡すのは承認待ちバッジ(編集画面の
// 上部バー・編集タブの一覧)と、全申請の一覧の申請行からの遷移。`?template` が無ければ対象なし
// (`null`)で、承認タブは全申請の一覧を出す(`ReviewTabView.vue` の `isOverview`)。編集タブで
// 開いているテンプレートからは推定しない。

import type { LocationQuery } from 'vue-router';

/** テンプレート id の字面(`assertTemplateId` と同じ意図。`/` `\` `..` を含まない)。 */
const SAFE_ID = /^[^/\\]+$/;

function safeId(raw: string | null | undefined): string | null {
  if (!raw || raw.includes('..') || !SAFE_ID.test(raw)) return null;
  return raw;
}

export function resolveReviewTarget(query: LocationQuery): string | null {
  const q = query.template;
  return typeof q === 'string' ? safeId(q) : null;
}
