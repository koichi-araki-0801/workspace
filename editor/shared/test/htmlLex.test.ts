import { describe, expect, it } from 'vitest';
import {
  commentEnd,
  isAsciiAlpha,
  isHtmlSpace,
  isTagNameEnd,
  newCommentEndMemo,
  readAttr,
} from '../src/html/htmlLex';
import { asciiLower, findRawTextEnd, RAW_TEXT_ELEMENTS } from '../src/html/rawText';

describe('文字の分類', () => {
  it('HTML の空白は TAB / LF / FF / CR / SP だけ(NBSP や VT は含めない)', () => {
    for (const c of ['\t', '\n', '\f', '\r', ' ']) expect(isHtmlSpace(c)).toBe(true);
    for (const c of [' ', '\v', 'a', '', undefined]) expect(isHtmlSpace(c)).toBe(false);
  });

  it('英字は ASCII の A-Z / a-z だけ', () => {
    for (const c of ['a', 'z', 'A', 'Z']) expect(isAsciiAlpha(c)).toBe(true);
    for (const c of ['0', '@', '[', '`', '{', 'é', '', undefined])
      expect(isAsciiAlpha(c)).toBe(false);
  });

  it('タグ名は空白・`/`・`>` で終わり、`=` では終わらない', () => {
    for (const c of [' ', '\t', '/', '>']) expect(isTagNameEnd(c)).toBe(true);
    for (const c of ['=', 'a', '"', undefined]) expect(isTagNameEnd(c)).toBe(false);
  });
});

describe('commentEnd', () => {
  // `from` は `<!--` の直後。
  const end = (src: string) => commentEnd(src, src.indexOf('<!--') + 4, newCommentEndMemo());

  it('`-->` と `--!>` のうち先に現れる方で閉じる', () => {
    expect(end('<!-- a -->b')).toBe(10);
    expect(end('<!-- a --!>b')).toBe(11);
    expect(end('<!-- a --!> b -->')).toBe(11);
    expect(end('<!-- a --> b --!>')).toBe(10);
  });

  it('`<!-->` と `<!--->` はその場で閉じる', () => {
    expect(end('<!-->x')).toBe(5);
    expect(end('<!--->x')).toBe(6);
  });

  it('閉じなければ -1', () => {
    expect(end('<!-- a')).toBe(-1);
    expect(end('<!--')).toBe(-1);
  });

  it('同じ memo で後ろのコメントを読んでも結果は変わらない(-1 は以後も -1)', () => {
    const src = '<!-- a --><!-- b --!><!-- c -->';
    const memo = newCommentEndMemo();
    expect(commentEnd(src, 4, memo)).toBe(10);
    expect(commentEnd(src, 14, memo)).toBe(21);
    expect(commentEnd(src, 25, memo)).toBe(31);
    // `--!>` はもう後ろに無いと覚えている。
    expect(memo.bang).toBe(-1);
    expect(commentEnd('<!-- x', 4, { dash: -1, bang: -1 })).toBe(-1);
  });
});

describe('readAttr', () => {
  const at = (src: string, i: number) => readAttr(src, i, src.length);

  it('名前・値・次の位置を返し、名前は小文字にする', () => {
    expect(at('<a HREF="x" b>', 3)).toEqual({ name: 'href', value: 'x', next: 11 });
    expect(at("<a t='y'>", 3)).toEqual({ name: 't', value: 'y', next: 8 });
    expect(at('<a t = z>', 3)).toEqual({ name: 't', value: 'z', next: 8 });
  });

  it('`=` が無ければ値は null、名前の後の空白は読み飛ばす', () => {
    expect(at('<a b  c>', 3)).toEqual({ name: 'b', value: null, next: 6 });
    expect(at('<a b/>', 3)).toEqual({ name: 'b', value: null, next: 4 });
  });

  it('引用符は `=` の直後だけ値の区切りで、名前の途中の引用符は名前の一部', () => {
    expect(at('<a x"y=1>', 3)).toEqual({ name: 'x"y', value: '1', next: 8 });
    expect(at('<a b=c"d>', 3)).toEqual({ name: 'b', value: 'c"d', next: 8 });
  });

  it('先頭の `=` も名前に含め、必ず 1 文字以上進む', () => {
    expect(at('<a =x>', 3)).toEqual({ name: '=x', value: null, next: 5 });
    expect(at('<a "', 3)).toEqual({ name: '"', value: null, next: 4 });
  });

  it('閉じない引用符は `end` まで読む', () => {
    expect(at('<a t="abc', 3)).toEqual({ name: 't', value: 'abc', next: 9 });
    // `end` の先にある閉じ引用符は使わない。
    expect(readAttr('<a t="ab"c', 3, 7)).toEqual({ name: 't', value: 'a', next: 7 });
  });

  it('裸の値は空白か `>` で終わり、`=` の後が尽きれば空文字', () => {
    expect(at('<a t=a/b>', 3)).toEqual({ name: 't', value: 'a/b', next: 8 });
    expect(at('<a t=', 3)).toEqual({ name: 't', value: '', next: 5 });
  });
});

describe('findRawTextEnd', () => {
  it('asciiLower は ASCII だけを小文字にし、長さを変えない(`İ` は伸ばさない)', () => {
    expect(asciiLower('AbC-İ-Kelvin\u212a')).toBe('abc-İ-kelvin\u212a');
    const s = 'İİ<STYLE>';
    expect(asciiLower(s)).toHaveLength(s.length);
    expect('İ'.toLowerCase()).toHaveLength(2);
  });

  const find = (html: string, name: string, from = 0) =>
    findRawTextEnd(asciiLower(html), name, from);

  it('`</name` の直後が空白・`/`・`>`・終端のときだけ閉じタグと見る', () => {
    expect(find('a</script>', 'script')).toEqual({ at: 1, scanned: 9 });
    expect(find('a</script x>', 'script').at).toBe(1);
    expect(find('a</script/>', 'script').at).toBe(1);
    expect(find('a</script', 'script').at).toBe(1);
    expect(find('a</SCRIPT>', 'script').at).toBe(1);
  });

  it('名前の前方一致では閉じない(`</scriptx>` は本文)', () => {
    expect(find('init()</scriptx>/;evil()</script>', 'script')).toEqual({ at: 24, scanned: 32 });
    expect(find('a{}</stylex>b{}</style>', 'style').at).toBe(15);
  });

  it('見つからなければ -1 で、`scanned` は `from` から末尾までの長さ', () => {
    expect(find('abc</scriptx>', 'script', 1)).toEqual({ at: -1, scanned: 12 });
    expect(find('abc', 'script', 5)).toEqual({ at: -1, scanned: 0 });
  });

  it('`from` より前の閉じタグは見ない', () => {
    expect(find('</title><p></title>', 'title', 1).at).toBe(11);
  });

  it('共有の raw text 要素は script / style / textarea / title', () => {
    expect([...RAW_TEXT_ELEMENTS].sort()).toEqual(['script', 'style', 'textarea', 'title']);
  });
});
