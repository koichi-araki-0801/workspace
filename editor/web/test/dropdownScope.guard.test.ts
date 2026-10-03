// =============================================================================
// dropdownScope.guard.test.ts — 各画面が SearchFilters へ渡す候補の出所の退行ガード
// =============================================================================
// `dropdownScope` は必須 prop なので渡し忘れは vue-tsc が落とすが、値の取り違え(例: 結合へ
// `edit`)は型では止まらない。取り違えると「候補に出るのに一覧が空」になるため、画面ごとの値を
// ソースから読んで固定する。比較・結合は承認済みだけを扱う画面なので `published`。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8');

/** `<SearchFilters …>` の開始タグに書かれた `dropdown-scope` の値を出現順に返す。 */
function scopesOf(rel: string): string[] {
  const tags = read(rel).match(/<SearchFilters\b[^>]*>/g) ?? [];
  return tags.map((t) => /dropdown-scope="([^"]*)"/.exec(t)?.[1] ?? '(なし)');
}

describe('SearchFilters の dropdownScope', () => {
  it.each([
    ['features/templates/EditTabView.vue', 'edit'],
    ['features/compare/CompareSideSelector.vue', 'published'],
    ['features/merge/MergeTabView.vue', 'published'],
  ])('%s は %s を渡す', (rel, scope) => {
    expect(scopesOf(rel)).toEqual([scope]);
  });
});
