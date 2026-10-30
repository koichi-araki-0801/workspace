// =============================================================================
// cssGeneratedText.test.ts — 申請者の CSS が文字を生むか(content・quotes・list-style など)
// =============================================================================
import { describe, expect, it } from 'vitest';
import { cssMakesText } from '@/features/reviews/services/cssGeneratedText';

describe('cssMakesText', () => {
  it.each([
    ['content', 'p::after{content:"本番だけ"}'],
    ['quotes', "q{quotes:'「' '」'}"],
    ['list-style', 'li{list-style-type:"★"}'],
    ['単引用符', "p::before{content:'x'}"],
    ['エスケープした引用符', 'p::after{content:"a\\"b"}'],
    ['@media の中', '@media print{p::after{content:"x"}}'],
    ['style 属性の形(宣言だけ)', 'color:red;--x:"x"'],
    ['content の attr()', 'p::after{content:attr(title)}'],
    ['content の counter()', 'p{font:12px a} p::after{content:counter(c)}'],
    [
      '@counter-style の識別子の symbols',
      '@counter-style x{system:cyclic;symbols:本番だけ}li{list-style:x}',
    ],
    ['list-style の識別子', 'li{list-style:x}'],
    ['list-style-type の識別子', 'li{list-style-type:decimal}'],
    ['quotes の auto', 'q{quotes:auto}'],
    ['text-overflow', 'p{text-overflow:ellipsis}'],
    ['hyphenate-character', 'p{hyphenate-character:auto}'],
    ['大文字のプロパティ', 'P::AFTER{CONTENT:none}'],
    ['style 属性の content', 'content:attr(x)'],
  ])('%s の文字列は文字を生む', (_label, css) => {
    expect(cssMakesText(css)).toBe(true);
  });

  it.each([
    ['font-family', "body{font-family:'Hiragino Mincho ProN','Yu Mincho',serif}"],
    ['url() の中', 'p{background:url("a.png")}'],
    ['url() の中(引用符なし)', 'p{background:url(a.png)}'],
    ['@font-face', '@font-face{font-family:"X";src:url("x.woff2") format("woff2")}'],
    ['@import', '@import "a.css";p{color:red}'],
    ['@charset', '@charset "utf-8";'],
    ['コメントの中', '/* content:"x" */p{color:red}'],
    ['文字列なし', 'p{color:red}'],
    ['style 属性の font-family', "font-family:'X',serif"],
  ])('%s は文字を生まない', (_label, css) => {
    expect(cssMakesText(css)).toBe(false);
  });
});
