// =============================================================================
// partMarks.dom.test.ts — パーツ名を実パーサ(jsdom の DOMParser)で読んだときの形
// =============================================================================

import { PART_NAME_MAX_CHARS, partNameOfHtml } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { defaultHtmlParser } from '@/lib/htmlParser';

const name = (html: string) => partNameOfHtml(html, defaultHtmlParser);

describe('partNameOfHtml(実 DOM)', () => {
  it('表は最初のセルの文字になる', () => {
    expect(name('<table><tr><th>基準価額</th><td>1,000円</td></tr></table>')).toBe('基準価額');
  });
  it('赤入れの旧文言(data-redline)を読み飛ばす', () => {
    expect(name('<p><del data-redline>みなさま</del>皆様へ</p>')).toBe('皆様へ');
  });
  it('空白だけのテキストを飛ばす', () => {
    expect(name('<div>\n  <p>  </p>\n  <p>本文</p></div>')).toBe('本文');
  });
  it('要素をまたぐときは最初の空でないテキストノードだけ(あ)', () => {
    expect(name('<p><span>あ</span>い</p>')).toBe('あ');
  });
  it('20 文字を超えたら … で切る', () => {
    expect(name(`<p>${'あ'.repeat(PART_NAME_MAX_CHARS + 1)}</p>`)).toBe(
      `${'あ'.repeat(PART_NAME_MAX_CHARS)}…`,
    );
  });
  it('文字が無ければ空', () => {
    expect(name('<p> <br></p>')).toBe('');
  });
});
