// =============================================================================
// compareResultView.align.dom.test.ts — 比較画面のずらしが両側の全ページを行に載せる回帰
// =============================================================================
// 比較先を連動で 1 つ前へずらすと末尾ページが行からあふれて見えなくなっていた。ずらしの
// たびに行を組み直し、足した行が worker へ渡る pairs に載ること、出ないページ・二重のページを
// 操作帯の中の 1 行で警告し、リセットで消えることを固定する。
import { mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import CompareResultView from '@/features/compare/CompareResultView.vue';
import type { HtmlDiff, PagePair } from '@/features/compare/htmlBlockDiff';

const calls: PagePair[][] = [];
vi.mock('@/workers', () => ({
  htmlWorker: {
    buildHtmlDiffAligned: async (
      _b: string,
      _a: string,
      _cb: string,
      _ca: string,
      pairs: PagePair[],
    ) => {
      calls.push(pairs);
      return diffOf(pairs.length);
    },
  },
}));

const COUNT = 5;

function diffOf(rows: number): HtmlDiff {
  return {
    pages: Array.from({ length: rows }, (_, index) => ({
      index,
      changed: index === 2,
      changedBlockCount: index === 2 ? 1 : 0,
      blocks: [],
      coarse: false,
      beforeHtml: '',
      afterHtml: '',
    })),
    changedPageCount: 1,
    beforePageCount: COUNT,
    afterPageCount: COUNT,
    coarse: false,
    truncated: false,
  };
}

const meta = { timestamp: '2026-01-01T00:00:00.000Z', user: 'u' } as never;

const mountView = () =>
  mount(
    defineComponent({
      setup: () => () =>
        h(TooltipProvider, null, () =>
          h(CompareResultView, {
            before: meta,
            after: meta,
            beforeFile: 'a.html',
            afterFile: 'b.html',
            diff: diffOf(COUNT),
            cssBefore: '',
            cssAfter: '',
            beforeHtml: '',
            afterHtml: '',
          }),
        ),
    }),
    { attachTo: document.body },
  );

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const buttonByText = (w: ReturnType<typeof mountView>, text: string) => {
  const b = w.findAll('button').filter((x) => x.text().includes(text));
  return b;
};

describe('CompareResultView のページずらし', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('ずらしていない初期表示に警告は無い', () => {
    const w = mountView();
    expect(w.find('[data-testid="page-align-warning"]').exists()).toBe(false);
    w.unmount();
  });

  it('比較先を連動で 1 つ前へずらすと、あふれたページの行が pairs に足され二重を警告し、リセットで戻る', async () => {
    const w = mountView();
    // 比較先の「1つ前へ」は 2 つ目の同名ボタン。最初の変更ありページ(3 ページ目)が現在行。
    await buttonByText(w, '1つ前へ')[1].trigger('click');
    await flush();
    const last = calls[calls.length - 1];
    expect(last).toHaveLength(6);
    expect(last[5]).toEqual({ before: null, after: 4 });
    expect(w.get('[data-testid="page-align-warning"]').text()).toBe(
      '2 つ以上の行に表示されているページがあります: 比較先 2',
    );

    await buttonByText(w, 'リセット')[0].trigger('click');
    await flush();
    expect(calls[calls.length - 1]).toHaveLength(5);
    expect(w.find('[data-testid="page-align-warning"]').exists()).toBe(false);
    w.unmount();
  });
});
