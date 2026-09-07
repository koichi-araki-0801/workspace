// =============================================================================
// useServices.dom.test.ts — `use*Service` は inject 済みの repo から service を組み立てる
// =============================================================================
// 各 `use*Service` は setup 時にしか呼べない `use*Repo`(Vue の `inject`)を内部で呼ぶため、
// `repositories.dom.test.ts` と同じ形(`inSetup`)で setup の中から呼び出す。ここで主張したいのは
// 「provide 済みの repo から例外なく組み立てられ、契約どおりの関数を持つ」ことだけで、各 service
// の振る舞い(失敗経路・委譲)はそれぞれの service 単体テストが持つ。
import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { localRepositories, REPOS_KEY } from '@/api/repositories';
import { useTemplateEditorService } from '@/features/editor/services/templateEditorService';
import { useMergePdfService } from '@/features/merge/services/mergePdfService';
import { useTemplatePreviewService } from '@/features/preview/services/templatePreviewService';
import { useChangedSummaryService } from '@/features/reviews/services/changedSummary';
import { useReviewDiffService } from '@/features/reviews/services/reviewDiffService';
import { useTemplateCreationService } from '@/features/templates/services/templateCreationService';

/** setup の中で `fn` を呼び、戻り値を取り出す(`repositories.dom.test.ts` の `inSetup` と同形)。 */
function inSetup<T>(fn: () => T): T {
  let out!: T;
  const Comp = defineComponent({
    setup() {
      out = fn();
      return () => h('div');
    },
  });
  const app = createApp(Comp);
  app.provide(REPOS_KEY, localRepositories);
  app.mount(document.createElement('div'));
  return out;
}

describe('use*Service', () => {
  it('provide 済みの repo から service を組み立てる', () => {
    expect(typeof inSetup(useTemplateEditorService).loadForEdit).toBe('function');
    expect(typeof inSetup(useMergePdfService).renderMergedPdf).toBe('function');
    expect(typeof inSetup(useTemplatePreviewService).loadForPreview).toBe('function');
    expect(typeof inSetup(useChangedSummaryService).computeChangedSummary).toBe('function');
    expect(typeof inSetup(useReviewDiffService).buildDiff).toBe('function');
    expect(typeof inSetup(useTemplateCreationService).create).toBe('function');
  });
});
