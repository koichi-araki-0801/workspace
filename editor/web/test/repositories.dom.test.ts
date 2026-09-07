// =============================================================================
// repositories.dom.test.ts — DI 合成ルートの inject と rest 配線の差し替え可能性
// =============================================================================

import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import {
  localRepositories,
  REPOS_KEY,
  restRepositories,
  useAuthRepo,
  useHistoryRepo,
  useNoteRepo,
  usePartRepo,
  useReviewRepo,
  useTemplateRepo,
  useUserRepo,
} from '@/api/repositories';

/** setup の中で `fn` を呼び、戻り値を取り出す(provide の有無を切り替えられる)。 */
function inSetup<T>(fn: () => T, provide: boolean): T {
  let out!: T;
  let caught: unknown;
  const Comp = defineComponent({
    setup() {
      try {
        out = fn();
      } catch (e) {
        caught = e;
      }
      return () => h('div');
    },
  });
  const app = createApp(Comp);
  if (provide) app.provide(REPOS_KEY, restRepositories);
  app.config.errorHandler = () => {};
  app.mount(document.createElement('div'));
  if (caught) throw caught;
  return out;
}

describe('use*Repo', () => {
  it('provide 済みなら合成ルートの対応する面を返す(rest 配線も同じ形で差し替わる)', () => {
    expect(inSetup(useAuthRepo, true)).toBe(restRepositories.auth);
    expect(inSetup(useTemplateRepo, true)).toBe(restRepositories.templates);
    expect(inSetup(usePartRepo, true)).toBe(restRepositories.parts);
    expect(inSetup(useHistoryRepo, true)).toBe(restRepositories.history);
    expect(inSetup(useNoteRepo, true)).toBe(restRepositories.notes);
    expect(inSetup(useReviewRepo, true)).toBe(restRepositories.reviews);
    expect(inSetup(useUserRepo, true)).toBe(restRepositories.users);
  });
  it('local と rest は同じキー集合を持つ(差し替えで画面側が無改修で済む前提)', () => {
    expect(Object.keys(restRepositories).sort()).toEqual(Object.keys(localRepositories).sort());
  });
  it('provide されていなければ main.ts を指す例外で落ちる(黙って undefined を返さない)', () => {
    expect(() => inSetup(useAuthRepo, false)).toThrow(/provide/);
  });
});
