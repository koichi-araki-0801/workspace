// =============================================================================
// pageSize.test.ts — ページサイズ指定の許可リスト
// =============================================================================
// `size` は vivliostyle CLI がビューア用スタイルシートの `@page{size:...}` へエスケープ無しで
// 埋め込む。字面を許可リストで縛らないと、利用者が任意の CSS を差し込めてしまう。
import { describe, expect, it } from 'vitest';
import { BuildInlineRequest, BuildMergeRequest, isValidPageSize } from '../src/schemas';

describe('isValidPageSize', () => {
  // vivliostyle CLI が preset として示す 10 種(A5 A4 A3 B5 B4 JIS-B5 JIS-B4 letter legal ledger)だけ。
  it.each(['A5', 'A4', 'a4', 'A3', 'B5', 'B4', 'JIS-B5', 'jis-b4', 'letter', 'Legal', 'ledger'])(
    '用紙名 %s は通る',
    (size) => {
      expect(isValidPageSize(size)).toBe(true);
    },
  );

  it.each([
    '210mm,297mm',
    '8.5in,11in',
    '595pt,842pt',
    '21cm,29.7cm',
    '148mm,210.5mm',
    '1mm,1.5mm',
  ])('幅,高さ %s は通る', (size) => {
    expect(isValidPageSize(size)).toBe(true);
  });

  it.each([
    '',
    'A4;}body{background:url(file:///C:/x.png)}',
    'A4 landscape',
    '210mm',
    '210mm,297mm,1mm',
    '210,297',
    '-210mm,297mm',
    'A11',
    'A0',
    'A6',
    'A10',
    'B0',
    'B10',
    'JIS-B10',
    'C5',
    '0mm,0mm',
    '0.5mm,1mm',
    '01mm,297mm',
    '210mm,0297mm',
    'calc(1mm),2mm',
    `${'1'.repeat(10)}mm,1mm`,
  ])('%s は拒否する', (size) => {
    expect(isValidPageSize(size)).toBe(false);
  });
});

describe('build 契約の size', () => {
  it('inline と merge のどちらも許可リスト外の size を拒否する', () => {
    const evil = 'A4;}body{background:url(file:///C:/x.png)}';
    expect(BuildInlineRequest.safeParse({ html: '<p>x</p>', size: evil }).success).toBe(false);
    expect(
      BuildMergeRequest.safeParse({ documents: [{ html: '<p>x</p>' }], size: evil }).success,
    ).toBe(false);
  });

  it('size は省略でき、許可リスト内なら通る', () => {
    expect(BuildInlineRequest.safeParse({ html: '<p>x</p>' }).success).toBe(true);
    expect(BuildInlineRequest.safeParse({ html: '<p>x</p>', size: 'A4' }).success).toBe(true);
  });
});
