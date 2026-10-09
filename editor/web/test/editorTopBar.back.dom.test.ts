// =============================================================================
// editorTopBar.back.dom.test.ts — 上部バーの「一覧へ戻る」がブラウザ履歴を辿らないこと
// =============================================================================
// 他タブやプレビューを経由すると履歴の直前は一覧でなくなり、「編集」タブは編集中の画面へ戻すので、
// 履歴を辿る戻るでは一覧へ行けなくなる。上部バーは遷移先を決めず `back` を emit し、
// `EditorView` が経路(編集 / 作成)の一覧へ送る。
import { ok } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import EditorTopBar from '@/features/editor/EditorTopBar.vue';

const props = {
  fundName: 'AM01_510037_20240710_交付版',
  dirty: false,
  saveState: 'idle',
  statusText: '',
  zoom: 1,
  canUndo: false,
  canRedo: false,
  showPageGuides: false,
  showRedline: false,
  redlineAvailable: false,
  currentPage: 1,
  pageCount: 1,
  singlePageMode: false,
  allowEdit: false,
};
const templates = { listCompanies: async () => ok([]), listFunds: async () => ok([]) };

describe('EditorTopBar の「一覧へ戻る」', () => {
  it('押すと back を emit し、履歴は辿らない', async () => {
    const back = window.history.back;
    let historyBack = 0;
    window.history.back = () => {
      historyBack += 1;
    };
    try {
      const w = mount(EditorTopBar, {
        props: props as never,
        global: {
          provide: { [REPOS_KEY as symbol]: { templates } },
          stubs: { PageNav: true, Tooltip: { template: '<span><slot /></span>' } },
        },
      });
      await w.find('button[aria-label="一覧へ戻る"]').trigger('click');
      expect(w.emitted('back')).toHaveLength(1);
      expect(historyBack).toBe(0);
    } finally {
      window.history.back = back;
    }
  });
});
