// =============================================================================
// reviewDecisionBar.dom.test.ts — 承認タブの判定バー
// =============================================================================
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ReviewDecisionBar from '@/features/reviews/ReviewDecisionBar.vue';

const base = {
  counts: { total: 4, approved: 1, rejected: 1, pending: 2 },
  nextNo: 3 as number | null,
  blockedReasons: [] as string[],
  canFinalize: true,
  busy: false,
};
const finalizeBtn = (w: ReturnType<typeof mount>) => w.find('[data-finalize]');

describe('ReviewDecisionBar', () => {
  it('未判定が残る間は最終確定を押せず、理由を出す', () => {
    const w = mount(ReviewDecisionBar, { props: base });
    expect(finalizeBtn(w).attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('未判定が 2 件あります。すべて判定すると押せます');
    expect(w.text()).toContain('判定 2 / 4');
    expect(w.text()).toContain('承認 1・却下 1・未判定 2');
    expect(w.find('[data-step="judge"]').attributes('data-done')).toBe('false');
    expect(w.find('[data-step="judge"]').text()).not.toContain('✓');
  });

  it('全判定なら押せて、反映内容を出し、1 段目に ✓ が付く', async () => {
    const w = mount(ReviewDecisionBar, {
      props: { ...base, counts: { total: 4, approved: 3, rejected: 1, pending: 0 }, nextNo: null },
    });
    expect(w.text()).toContain('承認 3 件を反映し、却下 1 件は現行版のまま残します');
    expect(w.find('[data-next-pending]').exists()).toBe(false);
    expect(w.find('[data-step="judge"]').text()).toContain('✓');
    expect(finalizeBtn(w).attributes('disabled')).toBeUndefined();
    await finalizeBtn(w).trigger('click');
    expect(w.emitted('finalize')).toHaveLength(1);
  });

  it('blockedReasons があれば押せず、赤字の行が並ぶ', () => {
    const w = mount(ReviewDecisionBar, {
      props: {
        ...base,
        counts: { total: 2, approved: 2, rejected: 0, pending: 0 },
        blockedReasons: ['理由A', '理由B'],
      },
    });
    expect(finalizeBtn(w).attributes('disabled')).toBeDefined();
    const rows = w.findAll('[data-finalization-issue]');
    expect(rows.map((r) => r.text())).toEqual(['理由A', '理由B']);
  });

  it('canFinalize が false なら押せない', () => {
    const w = mount(ReviewDecisionBar, {
      props: {
        ...base,
        counts: { total: 1, approved: 1, rejected: 0, pending: 0 },
        canFinalize: false,
      },
    });
    expect(finalizeBtn(w).attributes('disabled')).toBeDefined();
  });

  it('次の未判定ボタンで next を出す', async () => {
    const w = mount(ReviewDecisionBar, { props: base });
    const b = w.find('[data-next-pending]');
    expect(b.text()).toBe('次の未判定 3 へ');
    await b.trigger('click');
    expect(w.emitted('next')).toHaveLength(1);
  });

  it('busy の間は全判定でも押せず、クリックしても finalize を出さない', async () => {
    const w = mount(ReviewDecisionBar, {
      props: {
        ...base,
        counts: { total: 1, approved: 1, rejected: 0, pending: 0 },
        busy: true,
      },
    });
    expect(finalizeBtn(w).attributes('disabled')).toBeDefined();
    await finalizeBtn(w).trigger('click');
    expect(w.emitted('finalize')).toBeUndefined();
  });

  it('段階は未判定が残る間は 1 段目を太字で示し、済めば緑の枠と ✓ に変わる', async () => {
    const w = mount(ReviewDecisionBar, { props: base });
    const judge = () => w.find('[data-step="judge"]');
    expect(judge().classes()).toContain('font-bold');
    expect(judge().classes()).not.toContain('border-green-600');
    await w.setProps({ counts: { total: 4, approved: 3, rejected: 1, pending: 0 } });
    expect(judge().attributes('data-done')).toBe('true');
    expect(judge().classes()).toContain('border-green-600');
    expect(judge().classes()).not.toContain('font-bold');
    // 2 段目は判定の状態に依らず同じ見た目。
    expect(w.find('[data-step="finalize"]').text()).toBe('② 最終確定する');
  });

  it('棒の幅は承認・却下の件数の全件に対する割合(承認=緑・却下=赤の順)', async () => {
    const w = mount(ReviewDecisionBar, { props: base });
    const widths = () =>
      w
        .findAll('[data-decision-progress] [aria-hidden="true"] > div')
        .map((d) => [
          d.classes().find((c) => c.startsWith('bg-')),
          (d.element as HTMLElement).style.width,
        ]);
    expect(widths()).toEqual([
      ['bg-green-600', '25%'],
      ['bg-red-600', '25%'],
    ]);
    await w.setProps({ counts: { total: 3, approved: 3, rejected: 0, pending: 0 } });
    expect(widths()).toEqual([
      ['bg-green-600', '100%'],
      ['bg-red-600', '0%'],
    ]);
  });

  it('同じ文言の理由が 2 つあっても両方並ぶ(行の key が重ならない)', () => {
    const w = mount(ReviewDecisionBar, {
      props: { ...base, blockedReasons: ['同じ理由', '同じ理由'] },
    });
    expect(w.findAll('[data-finalization-issue]').map((r) => r.text())).toEqual([
      '同じ理由',
      '同じ理由',
    ]);
  });

  it('判定 0 件(total 0)でも棒の幅が NaN にならない', () => {
    const w = mount(ReviewDecisionBar, {
      props: { ...base, counts: { total: 0, approved: 0, rejected: 0, pending: 0 }, nextNo: null },
    });
    expect(w.html()).not.toContain('NaN');
  });
});
