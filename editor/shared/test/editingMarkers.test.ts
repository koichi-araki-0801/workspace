import { describe, expect, it } from 'vitest';
import { editingMarkerMessage, findEditingMarkers } from '../src/security/editingMarkers';

const kinds = (html: string) => findEditingMarkers(html).map((h) => h.marker);

describe('findEditingMarkers', () => {
  it('正当なテンプレートでは 0 件', () => {
    const tpl =
      '<!doctype html><html><head><title>{{ fund.name }}</title></head><body>' +
      '<!-- 通常のコメント --><p class="chip-like">data-jinja という語は地の文</p>' +
      '<table><tbody>{% for r in rows %}<tr data-x="{{ r.a }}"><td>{{ r.b }}</td></tr>{% endfor %}</tbody></table>' +
      '<script>var a = "data-opaque";</script></body></html>';
    expect(findEditingMarkers(tpl)).toEqual([]);
  });

  it('範囲の印のコメント', () => {
    expect(kinds('<p><!--jinja-rt:o:1:e3sgaWYgYSAlfQ==-->x</p>')).toEqual(['comment:jinja-rt']);
    expect(kinds('<p><!-- jinja-rt:x:1 --></p>')).toEqual(['comment:jinja-rt']);
  });

  it('チップ・伏せの属性(値の有無・大文字・引用符の種類を問わない)', () => {
    expect(kinds('<span data-jinja="e3t9fQ==">x</span>')).toEqual(['attr:data-jinja']);
    expect(kinds('<tr DATA-JINJA-LOOP-CLONE><td>x</td></tr>')).toEqual([
      'attr:data-jinja-loop-clone',
    ]);
    expect(kinds('<div data-opaque=\'YQ==\' data-opaque-kind="frozen"></div>')).toEqual([
      'attr:data-opaque',
      'attr:data-opaque-kind',
    ]);
    expect(kinds('<tr data-jinja-loop-row></tr>')).toEqual(['attr:data-jinja-loop-row']);
  });

  it('チップの型と class', () => {
    expect(kinds('<span data-gjs-type="jinja-var">1</span>')).toEqual(['gjs-type:jinja']);
    expect(kinds('<span class="a jinja-chip b">1</span>')).toEqual(['class:jinja-chip']);
    expect(kinds('<div class="jinja-frozen-body"></div>')).toEqual(['class:jinja-frozen-body']);
  });

  it('class はブラウザと同じく ASCII 空白だけで区切る', () => {
    expect(kinds('<span class="jinja-chip">1</span>')).toEqual(['class:jinja-chip']);
    expect(kinds('<span class="jinja-chip foo">1</span>')).toEqual(['class:jinja-chip']);
    expect(kinds('<span class="foo jinja-chip">1</span>')).toEqual(['class:jinja-chip']);
    expect(kinds('<span class="s\tjinja-chip\nss\f\rx">1</span>')).toEqual(['class:jinja-chip']);
    // 語の一部や、`s` を含む別の class には当たらない。
    expect(kinds('<span class="sjinja-chips">1</span>')).toEqual([]);
    expect(kinds('<span class="s jinja-chips sjinja-chip">1</span>')).toEqual([]);
    // NBSP は HTML の区切りではない(1 個の class `jinja-chip foo` になる)。
    expect(kinds('<span class="jinja-chip foo">1</span>')).toEqual([]);
  });

  it('復元の placeholder 文字', () => {
    expect(kinds('<p>\u{e000}YQ==\u{e001}</p>')).toEqual(['placeholder', 'placeholder']);
  });

  it('属性値の中の Jinja や地の文の語には当たらない', () => {
    expect(findEditingMarkers('<a title="data-jinja=1">data-opaque</a>')).toEqual([]);
  });

  it('引用符はブラウザと同じく `=` の直後だけを値の区切りとして読む', () => {
    // 属性名の途中の `'` を引用符と読むと、ブラウザが属性と読む data-jinja を見落とす。
    expect(kinds("<a b'c data-jinja d'>x</a>")).toEqual(['attr:data-jinja']);
    expect(kinds('<a title=\'x" data-jinja="y\'>x</a>')).toEqual([]);
    expect(kinds('<a title=x data-jinja>y</a>')).toEqual(['attr:data-jinja']);
  });

  it('raw text 要素の中は読まず、閉じタグの無い raw text は読み続ける', () => {
    expect(kinds('<SCRIPT>a("<span data-jinja>")</script ><p data-opaque></p>')).toEqual([
      'attr:data-opaque',
    ]);
    expect(kinds('<script>"</scriptx><b data-jinja>"</script>')).toEqual([]);
    expect(kinds('<script>x<span data-jinja></span>')).toEqual(['attr:data-jinja']);
  });

  it('Jinja が作る・隠す `<!--` の内側のタグも見落とさない(作成経路の本文は Jinja 原文)', () => {
    // エディタは Jinja を伏せてから読むので、これらの span は生きた要素として扱われる。
    expect(kinds('{# <!-- #}<span data-jinja="X">1</span>{# --> #}')).toEqual(['attr:data-jinja']);
    expect(kinds('{{ "<!--" }}<span data-jinja="X">1</span><!-- -->')).toEqual(['attr:data-jinja']);
    expect(kinds('{% if false %}<!--{% endif %}<span data-opaque="X"></span><!-- -->')).toEqual([
      'attr:data-opaque',
    ]);
  });

  it('Jinja の中の `<` や引用符に、後ろの本物のタグを呑み込ませない', () => {
    expect(kinds('{# <!-- #}{# <a title=" #}<span data-jinja>1</span>{# " #}')).toEqual([
      'attr:data-jinja',
    ]);
    expect(kinds(`{{ '<a title="' }}<span data-jinja>1</span>{{ '"' }}`)).toEqual([
      'attr:data-jinja',
    ]);
    expect(kinds('{# <script> #}<span data-jinja>1</span>{# </script> #}')).toEqual([
      'attr:data-jinja',
    ]);
  });

  it('Jinja の区切りはエディタと同じ字句解析で取る(引用符の中の閉じ記号で切らない)', () => {
    expect(kinds(`{{ '}}<a title="' }}<span data-jinja>1</span>{{ '"' }}`)).toEqual([
      'attr:data-jinja',
    ]);
    expect(kinds(`{{ "}}<a title='" }}<span data-jinja>1</span>{{ "'" }}`)).toEqual([
      'attr:data-jinja',
    ]);
    expect(
      kinds(`{% set a = '%}<a title="' %}<span data-opaque>1</span>{% set b = '"' %}`),
    ).toEqual(['attr:data-opaque']);
  });

  // エディタは Jinja を空白でなく文字(`J`)で伏せて読む。空白で伏せると、Jinja だけの引用符なしの
  // 値が消えて後ろの属性が値に化ける。`<` + Jinja はエディタではテキストだが、描画すると要素に
  // なる(x = span など)ので印として扱う。
  it.each([
    [`{{ '<b title="' }}<a title={{x}} data-jinja>1</a>{{ '"' }}`, 'attr:data-jinja'],
    [`{{ '<b title="' }}<a title= {{x}} class=jinja-chip>1</a>{{ '"' }}`, 'class:jinja-chip'],
    ['<{{x}} data-jinja>1', 'attr:data-jinja'],
  ])('Jinja を文字で伏せた写しも読む: %s', (html, marker) => {
    expect(kinds(html)).toEqual([marker]);
  });

  it('伏せは位置を保つ(改行を含む Jinja の後でも index が原文と一致する)', () => {
    const html = '{% if a\n %}x{# \n #}<span data-jinja>1</span>';
    expect(findEditingMarkers(html)).toEqual([
      { marker: 'attr:data-jinja', index: html.indexOf('span') },
    ]);
  });

  it('コメント・<!…>・終了タグの中の引用符に、後ろの本物のタグを呑み込ませない', () => {
    expect(kinds('<!-- <a title=" --><span data-jinja="x">1</span>')).toEqual(['attr:data-jinja']);
    expect(kinds('<!x <a title="> <span data-jinja> ">')).toEqual(['attr:data-jinja']);
    expect(kinds('<?x <a title="?> <span data-jinja> ">')).toEqual(['attr:data-jinja']);
    expect(kinds('<!--> <span data-jinja></span>')).toEqual(['attr:data-jinja']);
    // 終了タグの属性はブラウザが捨てる。引用符の中は終了タグの一部。
    expect(kinds('</p title="<span data-jinja>"><b data-opaque></b>')).toEqual([
      'attr:data-opaque',
    ]);
    // 長さの変わる大文字(`İ`)の後でも raw text の終端を正しく見つける。
    expect(kinds('İİİİ<script>x</script><span data-jinja></span>')).toEqual(['attr:data-jinja']);
  });

  it('閉じない入力の反復でも入力長に線形で終わる(申請の入口で 8MB まで受ける)', () => {
    // 正規表現版は `<a` の 4000 回反復で 1 分を超えた。時間は測らず、既定のタイムアウトで守る。
    expect(findEditingMarkers('<a'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('<a "'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('<a b="'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('<script>'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('<!x'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('<!--'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('<!--x-->'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('</a "'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('{{'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('{%'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('{#'.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('{{ x }}<a '.repeat(200_000))).toEqual([]);
    expect(findEditingMarkers('{%}'.repeat(200_000))).toEqual([]);
    expect(kinds(`${'<a x '.repeat(200_000)}data-jinja>`)).toEqual(['attr:data-jinja']);
  });
});

describe('editingMarkerMessage', () => {
  it('印が無ければ null、あれば種類を重複なしで並べた文になる', () => {
    expect(editingMarkerMessage([], 'T1')).toBeNull();
    const msg = editingMarkerMessage(
      findEditingMarkers(
        '<span data-jinja="a">1</span><span data-jinja="b">2</span><!--jinja-rt:t:x-->',
      ),
      'T1',
    );
    expect(msg).toBe(
      '申請本文に編集用の印(attr:data-jinja, comment:jinja-rt)が残っています。' +
        '編集画面を開き直してから申請してください: T1',
    );
  });
});
