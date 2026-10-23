// =============================================================================
// reviewNoticeBar.test.ts — 精査画面の通知集約(業務語 1 行 + 詳細折りたたみ)
// =============================================================================
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ReviewNoticeBar from '@/features/reviews/ReviewNoticeBar.vue';

const noneProps = {
  cssChanged: false,
  sharedAcrossBaseDates: false,
  cssBefore: '',
  cssAfter: '',
  printOnlyCss: false,
  truncated: false,
  hiddenRowCount: 0,
  pdfGenerating: false,
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

  it('PDF 生成中は導線ボタンを disabled にする', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, printOnlyCss: true, pdfGenerating: true },
    });
    const btn = w.find('[data-open-pdf]');
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('一覧打ち切り(hiddenRowCount)は分割再申請の依頼文で出す', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, hiddenRowCount: 5 } });
    expect(w.text()).toContain('分けて出し直す');
  });

  it('値入り HTML の申請で書式が変わったら、他の基準日にも効くことを書式の項目の中に出す', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, cssChanged: true, sharedAcrossBaseDates: true },
    });
    const items = w.findAll('[data-notice-item]');
    expect(items[0].find('[data-shared-base-dates]').text()).toBe(
      'この CSS は同じテンプレの他の基準日にも効きます',
    );
  });

  it('書式の項目は、ペアの版種へも写ることを添える', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, cssChanged: true } });
    expect(w.findAll('[data-notice-item]')[0].text()).toContain(
      'ペアの版種（交付版⇔全体版）にも、ペア側で個別に直していない書式は承認のときに写ります',
    );
  });

  it('作成タブ(テンプレ)の申請では基準日の注意を出さない', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, cssChanged: true, sharedAcrossBaseDates: false },
    });
    expect(w.find('[data-shared-base-dates]').exists()).toBe(false);
  });

  it('書式が変わっていなければ基準日の注意も出さない', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, sharedAcrossBaseDates: true } });
    expect(w.find('[data-shared-base-dates]').exists()).toBe(false);
  });

  it('書式の項目はファンド単位の言い方をしない(CSS はテンプレ単位)', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, cssChanged: true } });
    expect(w.text()).toContain('このテンプレートの書式設定も変更されています');
    expect(w.text()).not.toContain('このファンドの');
  });
});
