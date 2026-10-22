import { describe, expect, it } from 'vitest';
import { isAllowedSafeMarkup, textPositions } from '../src/jinja/safeMarkup';

/** `html` の中の `@` の位置のうち、テキストの位置と判定されたものの番号(0 始まり)。 */
const marks = (html: string) => {
  const at: number[] = [];
  for (let i = 0; i < html.length; i++) if (html[i] === '@') at.push(i);
  const text = textPositions(html, at);
  return at.flatMap((p, k) => (text.has(p) ? [k] : []));
};

describe('textPositions — 描き終えた HTML の上でテキストの位置か', () => {
  it('要素の中身はテキストの位置', () => {
    expect(marks('<p>@<b>@</b></p>@<div><span>@</span></div>')).toEqual([0, 1, 2, 3]);
  });
  it.each([
    ['属性値(二重引用符)', '<p title="@">t</p>'],
    ['属性値(一重引用符)', "<p title='@'>t</p>"],
    ['属性値(引用符なし)', '<p title=@>t</p>'],
    ['属性値の前に空白', '<p title =\n"@">t</p>'],
    ['タグの中', '<p @>t</p>'],
    ['`/` で区切った属性', '<img/src=x/@>'],
    ['閉じタグの中', '<p>t</p @>'],
    ['HTML コメント', '<!-- @ -->'],
    ['bogus コメント', '<!doctype @>'],
    ['`</` の後が英字でない(bogus コメント)', '</ @>'],
    ['処理命令', '<?x @>'],
    ['raw text(title)', '<title>@</title>'],
    ['raw text(大文字の閉じを待つ)', '<STYLE>@</style>'],
    ['textarea', '<textarea>@</textarea>'],
    ['xmp', '<xmp>@</xmp>'],
    ['iframe', '<iframe>@</iframe>'],
    ['noscript', '<noscript>@</noscript>'],
    ['plaintext の後ろ全部', '<plaintext><p>@</p>'],
    ['svg の中', '<svg><text>@</text></svg>'],
    ['math の中', '<math><mi>@</mi></math>'],
    ['svg の中の CDATA', '<svg><![CDATA[ > @ ]]></svg>'],
    ['表の行の間(パーサが表の外へ移す)', '<table><tr>@<td>x</td></tr></table>'],
    ['tbody の直下', '<table><tbody>@</tbody></table>'],
    ['select の中', '<select>@</select>'],
    ['head の中', '<html><head>@</head></html>'],
  ])('%s はテキストの位置ではない', (_, html) => {
    expect(marks(html)).toEqual([]);
  });
  it('属性値の中の `>` や引用符の食い違いで閉じたと読まない', () => {
    expect(marks('<p title="a>@" data-a=\'"\' b=x"y>@</p>')).toEqual([1]);
  });
  it('コメント・raw text・svg・表の後ろはテキストに戻る', () => {
    expect(
      marks(
        '<!-- c -->@<title>t</title>@<style>x</STYLE >@<svg><g></g></svg>@' +
          '<table><tr><td>@</td></tr></table>@<!-->@<!--->@</>@',
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('raw text の中の別の閉じタグ・コメントの `--!>` 以外の途中では戻らない', () => {
    expect(marks('<title></b>@</titlex>@</title>@<!-- -- > @ --!>@')).toEqual([2, 4]);
  });
  it('名前で始まらない `<` は文字として読み、その後もテキスト', () => {
    expect(marks('a < b @ <1 @')).toEqual([0, 1]);
  });
});

describe('isAllowedSafeMarkup — 生で置いてよい形か(疑わしければ false)', () => {
  it.each([
    'a<br>b',
    'a<br/>b<br />',
    '<b>x</b><span class="r" title="a>b">y</span>',
    '<p>段落</p><ul><li>1</li></ul>',
    '<table><tr><td colspan=2>1</td></tr></table>',
    '<span style="color: red; font-weight: bold">x</span>',
    '<FONT COLOR="red">x</FONT>',
    'a -- b > c " d \' e & f',
    '',
  ])('%s は通す', (html) => {
    expect(isAllowedSafeMarkup(html)).toBe(true);
  });
  it.each([
    ['イベント属性', '<b onclick="alert(1)">x</b>'],
    ['`/` で区切ったイベント属性', '<img/src=x/onerror=alert(1)>'],
    ['許可していない要素', '<img src="x">'],
    ['URL を取る属性', '<a href="javascript:alert(1)">x</a>'],
    ['実体参照で隠した URL', '<a href="&#x6a;avascript:alert(1)">x</a>'],
    ['id', '<span id="x">x</span>'],
    ['style の外部参照', '<span style="background:url(x)">x</span>'],
    ['style のエスケープ', '<span style="background:u\\72l(x)">x</span>'],
    ['style の実体参照', '<span style="background:&#117;rl(x)">x</span>'],
    ['空白を挟まない属性', '<span class="a"title="b">x</span>'],
    ['引用符の食い違い', '<span class="a>x</span>'],
    ['引用符なしの値に記号', '<span class=a"b>x</span>'],
    ['属性名の改行・タブ以外の区切り', '<span\u000bclass="a">x</span>'],
    ['閉じタグの余り', 'x</span>'],
    ['外側を閉じる', '</p><p>'],
    ['閉じていない', '<b>x'],
    ['入れ子の食い違い', '<b><i>x</b></i>'],
    ['`<span/>` も HTML では開く', '<span/>'],
    ['空要素の閉じタグ', '<br></br>'],
    ['コメント', 'a<!--b-->'],
    ['空のコメント', '<!-->'],
    ['CDATA', '<![CDATA[x]]>'],
    ['bogus コメント', '<!doctype html>'],
    ['処理命令', '<?x?>'],
    ['名前で始まらない `<`', 'a < b'],
    ['raw text の要素', '<textarea></textarea>'],
    ['script', '<script>1</script>'],
    ['大文字の script', '<SCRIPT>1</SCRIPT>'],
    ['外来要素', '<svg><script>1</script></svg>'],
    ['文書の骨組み', '<body onload="x"></body>'],
    ['往復用のチップ', '<span class="jinja-chip jinja-var" data-jinja="e3sgeCB9fQ==">x</span>'],
    ['固めた要素の印', '<div data-opaque="eA==" data-opaque-kind="body">x</div>'],
  ])('%s: %s は通さない', (_, html) => {
    expect(isAllowedSafeMarkup(html)).toBe(false);
  });
});
