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

  it('打ち切りは新しい文言で出し、タブ前提の語を含まない', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, truncated: true } });
    expect(w.text()).toContain('変更が多すぎるため、文字の変更をすべては照合できませんでした');
    expect(w.text()).toContain('この申請は最終確定できません。申請を分けてもらってください。');
    expect(w.text()).not.toContain('文字の変更の一覧');
    expect(w.text()).not.toContain('見た目比較');
  });

  it('注意書きは 3 種までで、CSS の差分を見る導線は出さない', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, cssChanged: true, printOnlyCss: true, truncated: true },
    });
    expect(w.findAll('[data-notice-item]')).toHaveLength(3);
    expect(w.find('summary').text()).toContain('3 件');
    expect(w.text()).not.toContain('CSS の差分を見る');
    expect(w.text()).not.toContain('見た目比較');
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

  // ── 作成経路の描画の注意(サーバが受付で全部の枝を描いた本文) ──

  it('値を計算できない差し込みの件数を 1 項目として数え、原文の文字のまま表示していることを出す', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, unrendered: 3 } });
    expect(w.find('summary').text()).toContain('1 件');
    expect(w.find('[data-notice-unrendered]').text()).toContain(
      '承認画面で値を計算できない差し込みが 3 件あり、原文の文字のまま表示しています',
    );
  });

  it('HTML として出す差し込み(|safe)を文字のまま表示したことを出す', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, escapedSafe: 2 } });
    expect(w.find('[data-notice-escaped-safe]').text()).toContain(
      'HTML として出す差し込み（|safe）の一部を、文字のまま表示しています',
    );
    expect(w.find('[data-notice-escaped-safe]').text()).toContain(
      'HTML として出す差し込みは、本番の値で中身が変わります',
    );
    expect(w.find('summary').text()).toContain('1 件');
  });

  it('全部の枝を描いたことは、ほかの注意が無くても常に 1 文で出す(件数には数えない)', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, allBranches: true } });
    expect(w.find('details').exists()).toBe(true);
    expect(w.find('[data-notice-branches]').text()).toContain(
      '分岐（{% if %}）はすべての枝を表示しています',
    );
    expect(w.find('summary').text()).not.toContain('件');
  });

  it('全部の枝の 1 文は、ほかの注意と同じ 1 行の集約に並ぶ', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, allBranches: true, unrendered: 1, escapedSafe: 1, cssChanged: true },
    });
    expect(w.findAll('details')[0]?.find('[data-notice-branches]').exists()).toBe(true);
    expect(w.find('summary').text()).toContain('3 件');
  });

  it('申請者の CSS が文字を生むときは、右欄に出ないことを 1 項目として出す', () => {
    const w = mount(ReviewNoticeBar, { props: { ...noneProps, cssGeneratedText: true } });
    expect(w.find('summary').text()).toContain('1 件');
    expect(w.find('[data-notice-css-text]').text()).toContain(
      'CSS が文字を生んでいます（content・quotes・list-style など）。右欄の文字の差分には出ません',
    );
  });

  it('件数が 0 なら描画の注意の項目は出さない', () => {
    const w = mount(ReviewNoticeBar, {
      props: { ...noneProps, allBranches: true, unrendered: 0, escapedSafe: 0 },
    });
    expect(w.find('[data-notice-unrendered]').exists()).toBe(false);
    expect(w.find('[data-notice-escaped-safe]').exists()).toBe(false);
  });
});
