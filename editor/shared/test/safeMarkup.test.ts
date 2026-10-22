import { describe, expect, it } from 'vitest';
import { lexJinja } from '../src/jinja/jinjaLex';
import { isSelfContainedMarkup, jinjaTextTokenStarts } from '../src/jinja/safeMarkup';

/** テキストの位置にあるトークンの本体を、原文の順に返す。 */
const inText = (src: string) => {
  const lexed = lexJinja(src);
  if (!lexed.ok) throw new Error('lex');
  const starts = jinjaTextTokenStarts(src);
  return lexed.tokens.filter((t) => starts.has(t.start)).map((t) => t.body);
};

describe('jinjaTextTokenStarts — safe の値を生で置ける位置', () => {
  it('要素の中身はテキストの位置', () => {
    expect(inText('<p>{{ a }}<b>{{ b }}</b></p>{{ c }}')).toEqual(['a', 'b', 'c']);
  });
  it.each([
    ['属性値(二重引用符)', '<p title="{{ x }}">t</p>'],
    ['属性値(一重引用符)', "<p title='{{ x }}'>t</p>"],
    ['属性値(引用符なし)', '<p title={{ x }}>t</p>'],
    ['タグの中', '<p {{ x }}>t</p>'],
    ['閉じタグの中', '<p>t</p {{ x }}>'],
    ['HTML コメント', '<!-- {{ x }} -->'],
    ['bogus コメント', '<!doctype {{ x }}>'],
    ['raw text(title)', '<title>{{ x }}</title>'],
    ['raw text(style)', '<style>p{color:{{ x }}}</style>'],
    ['raw text(script)', '<script>var a = "{{ x }}";</script>'],
    ['textarea', '<textarea>{{ x }}</textarea>'],
    ['`<` の直後(値しだいでタグになる)', '<{{ x }} class="a">'],
    ['`</` の直後', '</{{ x }}>'],
  ])('%s はテキストの位置ではない', (_, src) => {
    expect(inText(src)).toEqual([]);
  });
  it('属性値の中の `>` や Jinja で閉じたと読まない', () => {
    expect(inText('<p title="a>{{ x }}" data-a="{{ y }}">{{ z }}</p>')).toEqual(['z']);
  });
  it('コメント・raw text の後ろはテキストに戻る', () => {
    expect(inText('<!-- c -->{{ a }}<title>t</title>{{ b }}<style>x</STYLE >{{ c }}')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('raw text の中の別の閉じタグでは戻らない', () => {
    expect(inText('<title></b>{{ x }}</titlex>{{ y }}</title>{{ z }}')).toEqual(['z']);
  });
  it('字句として読めなければどこもテキストの位置と見なさない', () => {
    expect(jinjaTextTokenStarts('<p>{{ a </p>').size).toBe(0);
  });
});

describe('isSelfContainedMarkup — それだけで閉じた断片か', () => {
  it.each([
    'a<br>b',
    'a<br/>b<br />',
    '<b>x</b><span class="r" title="a>b">y</span>',
    '<p>段落</p><ul><li>1</li></ul>',
    '<table><tr><td>1</td></tr></table>',
    '<img src="x" onerror="alert(1)">', // 危険な属性は canvas の刈り取りと server の関所が落とす
    'a -- b > c " d \' e',
    '',
  ])('%s は閉じている', (html) => {
    expect(isSelfContainedMarkup(html)).toBe(true);
  });
  it.each([
    ['閉じタグの余り', 'x</span>'],
    ['外側を閉じる', '</p><p>'],
    ['閉じていない', '<b>x'],
    ['入れ子の食い違い', '<b><i>x</b></i>'],
    ['`<span/>` も HTML では開く', '<span/>'],
    ['空要素の閉じタグ', '<br></br>'],
    ['コメントの開き', 'a<!--b'],
    ['コメントの閉じ(往復用の印を作る)', '--><!--jinja-rt:c:1:-->'],
    ['bogus コメント', '<!doctype html>'],
    ['処理命令', '<?x?>'],
    ['名前で始まらない `<`', 'a < b'],
    ['閉じない開始タグ', '<b title="x'],
    ['raw text の要素', '<style>p{}</style>'],
    ['script', '<script>1</script>'],
    ['外来要素', '<svg><text>1</text></svg>'],
    ['文書の骨組み', '<body onload="x"></body>'],
    ['template', '<template>x</template>'],
    ['往復用のチップ', '<span class="jinja-chip jinja-var" data-jinja="e3sgeCB9fQ==">x</span>'],
    ['固めた要素の印', '<div data-opaque="eA==" data-opaque-kind="body">x</div>'],
  ])('%s: %s は閉じていない', (_, html) => {
    expect(isSelfContainedMarkup(html)).toBe(false);
  });
});
