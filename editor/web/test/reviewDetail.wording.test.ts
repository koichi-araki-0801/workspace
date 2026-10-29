// =============================================================================
// reviewDetail.wording.test.ts — 精査画面の構成・文言ガード(事務担当者向け改修)
// =============================================================================
// 実装概念の露出(旧文言)への退行と、警告の完全性(通知バーの常在)を機械検証する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(resolve(__dirname, '..', 'src', p), 'utf8');

describe('ReviewDetail の構成', () => {
  const view = src('features/reviews/ReviewDetail.vue');

  it('技術語彙の警告文言を直接出さない(通知バーへ集約済み)', () => {
    expect(view).not.toContain('ファンド共通 CSS');
    expect(view).not.toContain('語句単位の着色');
  });

  it('stale 警告は、他の基準日の承認で CSS が変わった場合を含むと分かる文言にする', () => {
    expect(view).toContain('同じテンプレの他の基準日の承認で CSS が変わった場合');
  });

  it('通知バー・紙面・右欄・判定バー・申請ごと却下を組み込み、保留を持たない', () => {
    expect(view).toContain('ReviewNoticeBar');
    expect(view).toContain('ReviewVisualCompare');
    expect(view).toContain('ReviewDecisionList');
    expect(view).toContain('ReviewDecisionBar');
    expect(view).toContain(`:shared-across-base-dates="review?.origin === 'edit'"`);
    expect(view).toContain('申請を却下する');
    expect(view).not.toContain('保留');
    expect(view).not.toContain('held');
  });

  it('画面遷移を持たない(承認タブが遷移を決める)', () => {
    expect(view).not.toContain('useRouter');
    expect(view).not.toContain('router.push');
  });

  it('独自の iframe を作らない(紙面は ReviewVisualCompare の PreviewPanel が持つ)', () => {
    expect(view).not.toContain('<iframe');
    expect(view).not.toContain('allow-same-origin');
  });

  it('モックの用語を使う', () => {
    const cmp = src('features/reviews/ReviewVisualCompare.vue');
    expect(cmp).toContain('変更前（現行版）');
    expect(cmp).toContain('変更後（申請版）');
    expect(view).toContain('却下済み');
  });

  it('旧画面の文言・D1 に反する文言・「差し戻し」系を使わない', () => {
    for (const word of [
      '修正前',
      '修正後',
      '判定メモ',
      '承認へ変更',
      '却下へ変更',
      '未判定を一括承認',
      'コメントとしても投稿',
      '差し戻',
      '見た目で比較',
      '文字の変更を一覧で見る',
    ]) {
      expect(view, word).not.toContain(word);
    }
  });
});

describe('ReviewVisualCompare の隔離構成', () => {
  it('PreviewPanel を使い、独自 iframe を作らない', () => {
    const cmp = src('features/reviews/ReviewVisualCompare.vue');
    expect(cmp).toContain('PreviewPanel');
    expect(cmp).not.toContain('<iframe');
  });
});
