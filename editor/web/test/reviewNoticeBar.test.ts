// =============================================================================
// reviewNoticeBar.test.ts — 精査画面の通知集約(業務語 1 行 + 詳細折りたたみ)
// =============================================================================
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ReviewNoticeBar from '@/features/reviews/ReviewNoticeBar.vue';

const noneProps = {
  cssChanged: false,
  cssBefore: '',
  cssAfter: '',
  printOnlyCss: false,
  truncated: false,
  hiddenRowCount: 0,
};

describe('ReviewNoticeBar', () => {
  it('該当 0 件なら何も描画しない', () => {
    const w = mount(ReviewNoticeBar, { props: noneProps });
    expect(w.find('details').exists()).toBe(false);
  });

  it('件数を集約した 1 行見出しを出す', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, cssChanged: true, cssBefore: 'a{}', cssAfter: 'b{}', truncated: true },
    });
    expect(w.find('summary').text()).toContain('2 件');
  });

  it('書式設定の変更は常に先頭で、CSS 前後がさらに折りたたみで DOM に常在する', () => {
    const w = mount(ReviewNoticeBar, {
      props: {
        ...noneProps,
        cssChanged: true,
        cssBefore: '.old{}',
        cssAfter: '.new{}',
        printOnlyCss: true,
      },
    });
    const items = w.findAll('[data-notice-item]');
    expect(items[0].text()).toContain('書式設定');
    // 折りたたみでも中身は DOM に居る(完全性要件: 隠しても消さない)
    expect(w.text()).toContain('.old{}');
    expect(w.text()).toContain('.new{}');
  });

  it('印刷用書式の項目は PDF 確認の導線(openPdf)を出す', async () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, printOnlyCss: true } });
    await w.find('[data-open-pdf]').trigger('click');
    expect(w.emitted('openPdf')).toHaveLength(1);
  });

  it('一覧打ち切り(hiddenRowCount)は分割再申請の依頼文で出す', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, hiddenRowCount: 5 } });
    expect(w.text()).toContain('分けて出し直す');
  });
});
