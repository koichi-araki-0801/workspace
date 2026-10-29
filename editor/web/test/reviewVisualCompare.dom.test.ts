// =============================================================================
// reviewVisualCompare.dom.test.ts — 承認タブの左右の紙面(組み直しの範囲と紙面からの値の照合)
// =============================================================================
// PreviewPanel はスタブにし、渡した文書・目印と、送った命令だけを見る。組み直しは「却下と
// 却下の取り消し(右面)」「紙面に変更を描くの切り替え(両面)」だけで、承認は目印だけ変わる
// こと、紙面から届く番号とページは親の集合と物理ページ数で照合することを固定する。
import {
  type ChangedPart,
  type HtmlDiff,
  numberChangedParts,
  type PreviewMarks,
  type ReviewPartDecision,
} from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { buildHtmlDiff } from '@/features/compare/htmlBlockDiff';
import ReviewVisualCompare from '@/features/reviews/ReviewVisualCompare.vue';

interface StubPanel {
  props: { html: string; marks?: PreviewMarks; companyCode?: string | null };
  emit: (event: string, ...args: unknown[]) => void;
  api: Record<
    'prevPage' | 'nextPage' | 'goToPage' | 'gotoAnchor' | 'gotoPart',
    ReturnType<typeof vi.fn>
  >;
}
const panels: StubPanel[] = [];

vi.mock('@/features/preview/PreviewPanel.vue', () => ({
  default: defineComponent({
    name: 'PreviewPanel',
    props: { html: String, marks: Object, companyCode: String },
    emits: ['state', 'part-click', 'part-pages'],
    setup(props, { emit, expose }) {
      const api = {
        prevPage: vi.fn(),
        nextPage: vi.fn(),
        goToPage: vi.fn(),
        gotoAnchor: vi.fn(),
        gotoPart: vi.fn(),
      };
      panels.push({ props: props as StubPanel['props'], emit: emit as StubPanel['emit'], api });
      expose(api);
      return () => h('div', { 'data-stub-panel': '' });
    },
  }),
}));

const pb = '<div class="pagebreak"></div>';
const BEFORE = `<p class="a">古い文</p>${pb}<p class="b">B</p>`;
const AFTER = `<p class="a">新しい文</p>${pb}<p class="b">B</p><p class="c">追加</p>`;

function fixture(): { diff: HtmlDiff; changes: ChangedPart[] } {
  const diff = buildHtmlDiff(BEFORE, AFTER);
  return { diff, changes: numberChangedParts(diff) };
}

const dec = (partKey: string, status: 'approved' | 'rejected' | 'pending'): ReviewPartDecision =>
  ({ partKey, status }) as ReviewPartDecision;

function state(over: Record<string, unknown> = {}) {
  return {
    currentPage: 1,
    pageCount: 2,
    atFirst: true,
    atLast: false,
    zoom: 1,
    vivlioReady: true,
    ready: true,
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  const { diff, changes } = fixture();
  const wrapper = mount(ReviewVisualCompare, {
    props: {
      diff,
      changes,
      decisions: [],
      cssBefore: '.a{color:black}',
      cssAfter: '.a{color:black}',
      isCreate: false,
      companyCode: 'XX01',
      selectedNo: null,
      ...over,
    },
  });
  const isCreate = over.isCreate === true;
  const before = isCreate ? undefined : panels[0];
  const after = isCreate ? panels[0] : panels[1];
  return { wrapper, changes, before, after: after as StubPanel };
}

async function readyAll(...ps: (StubPanel | undefined)[]) {
  for (const p of ps) p?.emit('state', state());
  await flushPromises();
}

beforeEach(() => {
  panels.length = 0;
});

describe('ReviewVisualCompare', () => {
  it('承認では文書を作り直さず marks だけ変わる', async () => {
    const { wrapper, changes, before, after } = setup();
    const beforeHtml = before?.props.html;
    const afterHtml = after.props.html;
    const firstMarks = after.props.marks;
    expect(firstMarks).toEqual({
      states: { '1': 'pending', '2': 'pending' },
      selected: null,
      visible: true,
    });

    await wrapper.setProps({ decisions: [dec(changes[0].partKey, 'approved')] });
    expect(after.props.html).toBe(afterHtml);
    expect(before?.props.html).toBe(beforeHtml);
    expect(after.props.marks).not.toBe(firstMarks);
    expect(after.props.marks?.states['1']).toBe('approved');
    expect(before?.props.marks?.states['1']).toBe('approved');

    await wrapper.setProps({ selectedNo: 2 });
    expect(after.props.html).toBe(afterHtml);
    expect(after.props.marks?.selected).toBe('2');
  });

  it('却下で右面の文書だけ作り直す', async () => {
    const { wrapper, changes, before, after } = setup();
    const beforeHtml = before?.props.html;
    const afterHtml = after.props.html;
    expect(afterHtml).not.toContain('古い文');

    await wrapper.setProps({ decisions: [dec(changes[0].partKey, 'rejected')] });
    expect(before?.props.html).toBe(beforeHtml);
    expect(after.props.html).not.toBe(afterHtml);
    expect(after.props.html).toContain('data-review-keep');
    expect(after.props.html).toContain('古い文');

    // 却下の取り消しでも右面だけ組み直す。
    const rejectedHtml = after.props.html;
    await wrapper.setProps({ decisions: [dec(changes[0].partKey, 'pending')] });
    expect(after.props.html).not.toBe(rejectedHtml);
    expect(before?.props.html).toBe(beforeHtml);
  });

  it('右面を組み直したあと、選択中のパーツへ移り直す', async () => {
    const { wrapper, changes, before, after } = setup({ selectedNo: 1 });
    // 開いた直後は両面の組版を待ってから移る。
    expect(after.api.gotoPart).not.toHaveBeenCalled();
    await readyAll(before, after);
    expect(after.api.gotoPart).toHaveBeenCalledWith('1');
    expect(before?.api.gotoPart).toHaveBeenCalledWith('1');
    after.api.gotoPart.mockClear();
    before?.api.gotoPart.mockClear();

    await wrapper.setProps({ decisions: [dec(changes[0].partKey, 'rejected')] });
    // 前の状態通知が ready のままでも、新しい文書の組版が終わるまでは送らない。
    before?.emit('state', state());
    await flushPromises();
    expect(after.api.gotoPart).not.toHaveBeenCalled();
    after.emit('state', state({ ready: false }));
    after.emit('state', state());
    await flushPromises();
    expect(after.api.gotoPart).toHaveBeenCalledWith('1');
    expect(before?.api.gotoPart).toHaveBeenCalledWith('1');
  });

  it('知らない番号の part-click は無視する', async () => {
    const { wrapper, before, after } = setup();
    after.emit('part-click', '99');
    before?.emit('part-click', '0');
    expect(wrapper.emitted('select')).toBeUndefined();
    after.emit('part-click', '2');
    before?.emit('part-click', '1');
    expect(wrapper.emitted('select')).toEqual([[2], [1]]);
  });

  it('part-pages の知らない番号・ページ数以上の値は捨てる', async () => {
    const { wrapper, before, after } = setup();
    await readyAll(before, after);
    after.emit('part-pages', { '1': 5, '2': 1, '99': 0 });
    await flushPromises();
    expect(wrapper.get('[data-changed-pages]').text()).toBe('変更のあるページ: 2');
    expect(wrapper.find('[data-changed-page="1"]').exists()).toBe(false);
    expect(wrapper.find('[data-changed-page="6"]').exists()).toBe(false);
  });

  it('変更のあるページは part-pages の物理ページで出し、押すとそのページへ送る', async () => {
    const { wrapper, changes, before, after } = setup();
    // 返る前は出さない。
    await readyAll(before, after);
    expect(wrapper.find('[data-changed-pages]').exists()).toBe(false);
    // 物理ページ数は飾りのあとの状態通知で届く(part-pages が先に来る)。
    after.emit('part-pages', { '1': 0, '2': 2 });
    after.emit('state', state({ pageCount: 3 }));
    await flushPromises();
    expect(wrapper.get('[data-changed-pages]').text().replace(/\s+/g, '')).toBe(
      '変更のあるページ:1・3',
    );
    await wrapper.get('[data-changed-page="3"]').trigger('click');
    expect(before?.api.goToPage).toHaveBeenCalledWith(3);
    expect(after.api.goToPage).toHaveBeenCalledWith(3);

    // 組み直しの最中は出さない。
    await wrapper.setProps({ decisions: [dec(changes[0].partKey, 'rejected')] });
    expect(wrapper.find('[data-changed-pages]').exists()).toBe(false);
  });

  it('チェックを外すと両面を highlight=false で作り直し、marks.visible=false', async () => {
    const { wrapper, before, after } = setup();
    const beforeHtml = before?.props.html;
    const afterHtml = after.props.html;
    expect(afterHtml).toContain('cmp-ins');
    await wrapper.get('[data-highlight-toggle]').trigger('click');
    await flushPromises();
    expect(before?.props.html).not.toBe(beforeHtml);
    expect(after.props.html).not.toBe(afterHtml);
    expect(after.props.html).not.toContain('cmp-ins');
    expect(before?.props.html).not.toContain('cmp-del');
    expect(after.props.marks?.visible).toBe(false);
    expect(before?.props.marks?.visible).toBe(false);
  });

  it('ページ送りは左右へ同時に送る', async () => {
    const { wrapper, before, after } = setup();
    after.emit('state', state({ currentPage: 2, atFirst: false, atLast: false }));
    await flushPromises();
    expect(wrapper.get('[data-page-indicator]').text()).toBe('2 / 2 ページ');
    await wrapper.get('[data-page-prev]').trigger('click');
    await wrapper.get('[data-page-next]').trigger('click');
    expect(before?.api.prevPage).toHaveBeenCalledTimes(1);
    expect(after.api.prevPage).toHaveBeenCalledTimes(1);
    expect(before?.api.nextPage).toHaveBeenCalledTimes(1);
    expect(after.api.nextPage).toHaveBeenCalledTimes(1);
  });

  it('gotoPart は知らない番号を送らず、組版の前は待ってから送る', async () => {
    const { wrapper, before, after } = setup();
    const vm = wrapper.vm as unknown as { gotoPart: (no: number) => void };
    vm.gotoPart(2);
    expect(after.api.gotoPart).not.toHaveBeenCalled();
    await readyAll(before, after);
    expect(after.api.gotoPart).toHaveBeenCalledWith('2');
    vm.gotoPart(99);
    vm.gotoPart(1);
    expect(after.api.gotoPart.mock.calls).toEqual([['2'], ['1']]);
    expect(before?.api.gotoPart.mock.calls).toEqual([['2'], ['1']]);
  });

  it('gotoPage は各面のページの先頭のアンカーへ送り、組版の前は待つ', async () => {
    const { wrapper, before, after } = setup();
    const vm = wrapper.vm as unknown as { gotoPage: (index: number) => void };
    vm.gotoPage(1);
    expect(after.api.gotoAnchor).not.toHaveBeenCalled();
    await readyAll(before, after);
    expect(before?.api.gotoAnchor).toHaveBeenCalledWith('review-anchor-2');
    expect(after.api.gotoAnchor).toHaveBeenCalledWith('review-anchor-2');
    vm.gotoPage(9);
    expect(after.api.gotoAnchor).toHaveBeenCalledTimes(1);
  });

  it('作成経路は申請内容の 1 面だけで、右面の組版だけを待つ', async () => {
    const { wrapper, after } = setup({ isCreate: true, selectedNo: 2 });
    expect(panels).toHaveLength(1);
    expect(wrapper.text()).toContain('申請内容');
    expect(wrapper.text()).not.toContain('変更前（現行版）');
    await readyAll(after);
    expect(after.api.gotoPart).toHaveBeenCalledWith('2');
  });

  it('見出しは変更前（現行版）と変更後（申請版）', () => {
    const { wrapper } = setup();
    expect(wrapper.text()).toContain('変更前（現行版）');
    expect(wrapper.text()).toContain('変更後（申請版）');
    expect(wrapper.text()).toContain('申請された内容。却下したパーツだけ現行版に戻して表示');
    expect(wrapper.text()).toContain('紙面に変更を描く（番号と文字の差分）');
    expect(wrapper.text()).not.toContain('次の変更箇所へ');
  });
});
