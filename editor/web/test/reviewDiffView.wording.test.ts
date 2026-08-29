// =============================================================================
// reviewDiffView.wording.test.ts — 精査画面の構成・文言ガード(事務担当者向け改修)
// =============================================================================
// 実装概念の露出(旧文言)への退行と、警告の完全性(通知バーの常在)を機械検証する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(resolve(__dirname, '..', 'src', p), 'utf8');

describe('ReviewDiffView の構成', () => {
  const view = src('features/reviews/ReviewDiffView.vue');

  it('技術語彙の警告文言を直接出さない(通知バーへ集約済み)', () => {
    expect(view).not.toContain('ファンド共通 CSS');
    expect(view).not.toContain('語句単位の着色');
  });

  it('通知バー・見た目比較・保留ボタンを組み込んでいる', () => {
    expect(view).toContain('ReviewNoticeBar');
    expect(view).toContain('ReviewVisualCompare');
    expect(view).toContain('保留する');
    expect(view).toContain('差し戻す');
  });

  it('差分行 iframe の sandbox 構成を変えていない', () => {
    expect(view).toContain('sandbox="allow-scripts"');
    expect(view).not.toContain('allow-same-origin');
  });
});

describe('ReviewVisualCompare の隔離構成', () => {
  it('PreviewPanel を使い、独自 iframe を作らない', () => {
    const cmp = src('features/reviews/ReviewVisualCompare.vue');
    expect(cmp).toContain('PreviewPanel');
    expect(cmp).not.toContain('<iframe');
  });
});
