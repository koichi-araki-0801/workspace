// =============================================================================
// partNames.test.ts — 差分行キー → パーツ業務名の突合(精査画面のラベル)
// =============================================================================
import { describe, expect, it } from 'vitest';
import { businessLabel, partIdFromBlockKey } from '@/features/reviews/services/partNames';

describe('partIdFromBlockKey', () => {
  it('data-part-id 由来のキーから id を取り出す', () => {
    expect(partIdFromBlockKey('note-fund-status#1')).toBe('note-fund-status');
  });
  it('タグ名・クラス由来のキーは null(カタログ突合の対象外)', () => {
    expect(partIdFromBlockKey('.section#2')).toBeNull();
    expect(partIdFromBlockKey('table#1')).toBeNull();
    expect(partIdFromBlockKey('div#3')).toBeNull();
  });
});

describe('businessLabel', () => {
  const names = new Map([['note-fund-status', '当ファンドの状況']]);
  it('カタログ名 + ページ番号で表示する', () => {
    expect(businessLabel('note-fund-status#1', 'ページ3・パーツ2', names)).toBe(
      '当ファンドの状況（3 ページ目）',
    );
  });
  it('突合できないキーは現行ラベルへフォールバック', () => {
    expect(businessLabel('.section#1', 'ページ1・パーツ1', names)).toBe('ページ1・パーツ1');
    expect(businessLabel('unknown-id#1', 'ページ1・パーツ2', names)).toBe('ページ1・パーツ2');
  });
  it('ページ番号が読めないラベルでも名前だけは出す', () => {
    expect(businessLabel('note-fund-status#1', 'ページ1', names)).toBe(
      '当ファンドの状況（1 ページ目）',
    );
  });
});
