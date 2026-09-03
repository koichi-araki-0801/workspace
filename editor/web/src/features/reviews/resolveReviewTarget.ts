// =============================================================================
// resolveReviewTarget.ts — 承認タブが対象にするテンプレート id の解決(純関数)
// =============================================================================
// 役割: 承認タブは「編集タブで開いているテンプレート 1 件」の申請を扱う。対象は
// ①`?template=<id>`(承認待ちバッジ・上部バーからの遷移が渡す)、②編集タブの直前画面
// (`stores/tabMemory.ts` が覚える fullPath)が `/edit/:id` か `/preview/:id` ならその id、
// の順で決める。作成経路(`?created=1`)は対象にしない — 作成中のテンプレートに申請は無く、
// 2 系統の判定(`route.query.created === '1'`)をここでも同じ規則で読む。

import type { LocationQuery } from 'vue-router';

const EDIT_PATH = /^\/(?:edit|preview)\/([^/?#]+)(?:\?([^#]*))?/;
/** テンプレート id の字面(`assertTemplateId` と同じ意図。`/` `\` `..` を含まない)。 */
const SAFE_ID = /^[^/\\]+$/;

function safeId(raw: string | null | undefined): string | null {
  if (!raw || raw.includes('..') || !SAFE_ID.test(raw)) return null;
  return raw;
}

export function resolveReviewTarget(
  query: LocationQuery,
  editTabPath: string | undefined,
): string | null {
  const q = query.template;
  if (typeof q === 'string') return safeId(q);
  if (q !== undefined) return null;
  if (!editTabPath) return null;
  const m = EDIT_PATH.exec(editTabPath);
  if (!m) return null;
  const search = new URLSearchParams(m[2] ?? '');
  if (search.get('created') === '1') return null;
  try {
    return safeId(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}
