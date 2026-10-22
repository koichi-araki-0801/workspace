import { describe, expect, it } from 'vitest';
import { normalizePartHtml, samePartHtml } from '../src/html/partHtmlCompare';

const same = (a: string, b: string) => expect(samePartHtml(a, b)).toBe(true);
const differ = (a: string, b: string) =>
  expect(normalizePartHtml(a)).not.toBe(normalizePartHtml(b));

describe('normalizePartHtml — DOM 上で同じになる書き方を寄せる', () => {
  it.each([
    ['void 要素の `/`', '<p>a<br>b<hr></p>', '<p>a<br/>b<hr /></p>'],
    ['テキストの実体参照', '<p>it&#39;s &quot;q&quot; &#x41;</p>', `<p>it's "q" A</p>`],
    ['&nbsp; と U+00A0', '<p>a&nbsp;b</p>', '<p>a b</p>'],
    ['&amp; の書き方', '<p>a&amp;b &lt;c&gt;</p>', '<p>a&amp;b &lt;c&gt;</p>'],
    [
      'style の書き方',
      '<p style="color: red; font-weight:bold">x</p>',
      '<p style="color:red;font-weight:bold;">x</p>',
    ],
    [
      'style の空白と大文字のプロパティ',
      '<p style=" margin : 0  auto ">x</p>',
      '<p style="MARGIN:0 auto;">x</p>',
    ],
    [
      '属性の順序',
      '<p title="t" class="a" lang="ja">x</p>',
      '<p lang="ja" title="t" class="a">x</p>',
    ],
    ['属性値の引用符と実体参照', `<p title='a"b'>x</p>`, '<p title="a&quot;b">x</p>'],
    [
      'data-part-id の有無と位置',
      '<section class="p"><p>x</p></section>',
      '<section data-part-id="N" class="p"><p>x</p></section>',
    ],
    ['タグの間の空白・連続空白', '<div>\n  <p>a   b</p>\n</div>', '<div><p>a b</p></div>'],
    [
      '表の行を包む tbody',
      '<table><tr><td>1</td></tr></table>',
      '<table><tbody><tr><td>1</td></tr></tbody></table>',
    ],
    [
      'SVG の空要素',
      '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
      '<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>',
    ],
    ['タグ名・属性名の大文字', '<P CLASS="a">x</P>', '<p class="a">x</p>'],
    ['class の空白', '<p class=" a  b ">x</p>', '<p class="a b">x</p>'],
    ['空の class / style', '<p class="" style="">x</p>', '<p>x</p>'],
    ['値の無い属性', '<p hidden>x</p>', '<p hidden="">x</p>'],
    ['空要素でない HTML の要素の `/`(ブラウザは読み捨てる)', '<div/>x</div>', '<div>x</div>'],
  ])('%s は同じ形にする', (_, a, b) => same(a, b));

  it.each([
    ['テキストの 1 文字', '<p>交付ファンド</p>', '<p>交付ファンド(改)</p>'],
    ['実体参照で書いた別の文字', '<p>&lt;b&gt;</p>', '<p><b></b></p>'],
    ['二重にエスケープした文字', '<p>&amp;lt;</p>', '<p>&lt;</p>'],
    ['NBSP と空白', '<p>a&nbsp;b</p>', '<p>a b</p>'],
    ['属性値', '<p title="a">x</p>', '<p title="b">x</p>'],
    ['属性の有無', '<p>x</p>', '<p title="">x</p>'],
    ['class の順序', '<p class="a b">x</p>', '<p class="b a">x</p>'],
    ['style の値', '<p style="color:red">x</p>', '<p style="color:blue">x</p>'],
    ['style の順序', '<p style="color:red;margin:0">x</p>', '<p style="margin:0;color:red">x</p>'],
    ['要素', '<p>x</p>', '<div>x</div>'],
    ['入れ子', '<p><b>x</b></p>', '<p><b>x</b><b></b></p>'],
    ['コメント', '<p>x<!-- a --></p>', '<p>x<!-- b --></p>'],
  ])('%s が違えば一致しない', (_, a, b) => differ(a, b));

  // DOM は同じでも、寄せない書き方は「直した」に倒す(写すだけで失うものが無い)。
  it.each([
    ['セミコロンの無い実体参照', '<p>&lt</p>', '<p>&lt;</p>'],
    ['知らない名前の実体参照', '<p>&copy;</p>', '<p>©</p>'],
  ])('%s は寄せない', (_, a, b) => differ(a, b));

  it('raw text の中身は実体参照を解かずに残す', () => {
    differ('<script>a&amp;b</script>', '<script>a&b</script>');
    same('<SCRIPT>if (a < b) x()</script >', '<script>if (a < b) x()</script>');
  });

  it('doctype・処理命令・名前で始まらない `<` を読み飛ばさない', () => {
    differ('<!doctype a><p>x</p>', '<!doctype b><p>x</p>');
    same('<p>a < b</p>', '<p>a &lt; b</p>');
    differ('<p>a <? x ?></p>', '<p>a <? y ?></p>');
  });

  it('同じ名前の属性は最初の 1 つを採る(ブラウザと同じ)', () => {
    same('<p title="a" title="b">x</p>', '<p title="a">x</p>');
  });

  it('外来要素の中は void 要素の規則を使わず、閉じた svg の後ろは HTML に戻る', () => {
    differ('<svg><br/></svg>', '<svg><br></svg>');
    same('<svg><g/></svg><br/>', '<svg><g></g></svg><br>');
  });

  it('閉じないコメント・タグ・raw text は末尾までで打ち切る', () => {
    expect(normalizePartHtml('<p>x<!-- a')).toBe('<p>x<!-- a');
    expect(normalizePartHtml('<p title="a')).toBe('<p title="a">');
    expect(normalizePartHtml('<style>a{}')).toBe('<style>a{}');
  });

  it('壊れた数値参照(0・サロゲート・範囲外)は解かない', () => {
    differ('<p>&#0;</p>', '<p>\u0000</p>');
    expect(normalizePartHtml('<p>&#xD800;&#1114112;</p>')).toBe(
      '<p>&amp;#xD800;&amp;#1114112;</p>',
    );
  });

  it('引用符・コメントを含む style は区切らずに空白だけ寄せる', () => {
    expect(normalizePartHtml(`<p style='font-family: "A B"'>x</p>`)).toBe(
      '<p style="font-family: &quot;A B&quot;">x</p>',
    );
    same('<p style="background:url(data:a;b)">x</p>', '<p style="background:url(data:a;b);">x</p>');
    same('<p style="color:red;;bogus">x</p>', '<p style="color:red;bogus;">x</p>');
  });

  describe('病的な入力でも線形の時間で終わり、比べられないものは一致させない', () => {
    it('閉じない開始タグ 5 万個 + 相手の無い終了タグ 5 万個', () => {
      const t0 = performance.now();
      const deep = '<span>'.repeat(50_000) + '</nope>'.repeat(50_000);
      expect(normalizePartHtml(deep)).toBeNull();
      expect(samePartHtml(deep, deep)).toBe(false);
      expect(performance.now() - t0).toBeLessThan(1000);
    });

    it('開いた要素が上限の内なら、相手の無い終了タグを何個読んでも結果は変わらず線形', () => {
      const open = '<b>'.repeat(4000);
      const html = open + '</x>'.repeat(50_000);
      const t0 = performance.now();
      const out = normalizePartHtml(html);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(out?.startsWith('<b><b>')).toBe(true);
    });

    it('長さの上限を超えた入力は比べない', () => {
      const big = `<p>${'a'.repeat(10_000_001)}</p>`;
      expect(normalizePartHtml(big)).toBeNull();
      expect(samePartHtml(big, big)).toBe(false);
    });
  });
});
