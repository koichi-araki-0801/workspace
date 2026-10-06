import { describe, expect, it } from 'vitest';
import { maskJinja, scanHtml } from '../src/lib/htmlScan';

const ctx = (html: string, needle: string) => {
  const s = scanHtml(html);
  const c = s.contextAt(html.indexOf(needle));
  if (c.kind === 'text') return `text:${c.parent?.tag ?? '-'}`;
  if (c.kind === 'htmlComment') return 'comment';
  return `${c.kind}:${c.element.tag}`;
};

describe('scanHtml', () => {
  it('テキスト・属性値・タグ内のその他・生テキスト・コメントを見分ける', () => {
    const h = '<div a="AV" b=UQ OTHER><p>TX</p><style>ST</style><!-- CM --><title>TI</title></div>';
    expect(ctx(h, 'AV')).toBe('attrValue:div');
    expect(ctx(h, 'UQ')).toBe('tagOther:div');
    expect(ctx(h, 'OTHER')).toBe('tagOther:div');
    expect(ctx(h, 'TX')).toBe('text:p');
    expect(ctx(h, 'ST')).toBe('rawText:style');
    expect(ctx(h, 'CM')).toBe('comment');
    expect(ctx(h, 'TI')).toBe('rawText:title');
  });

  it('表の中の位置の親', () => {
    const h = '<table><tbody>GAP<tr>ROWGAP<td>CELL</td></tr></tbody></table>';
    expect(ctx(h, 'GAP')).toBe('text:tbody');
    expect(ctx(h, 'ROWGAP')).toBe('text:tr');
    expect(ctx(h, 'CELL')).toBe('text:td');
  });

  it('暗黙の終了(p・li・td・tr)', () => {
    const h = '<p>A<div>B</div><ul><li>C<li>D</ul><table><tr><td>E<td>F<tr><td>G</table>';
    expect(ctx(h, 'B')).toBe('text:div');
    expect(ctx(h, 'D')).toBe('text:li');
    const s = scanHtml(h);
    expect(s.elements.filter((e) => e.tag === 'li')).toHaveLength(2);
    expect(s.elements.filter((e) => e.tag === 'tr')).toHaveLength(2);
    expect(ctx(h, 'G')).toBe('text:td');
  });

  it('svg の内側は foreign、自己終了を扱う', () => {
    const h = '<svg><rect/><text>V</text></svg><p>after</p>';
    const s = scanHtml(h);
    expect(s.elements.find((e) => e.tag === 'text')?.foreign).toBe('svg');
    expect(ctx(h, 'after')).toBe('text:p');
  });

  it('要素の範囲と、範囲を丸ごと含む最も内側の要素', () => {
    const h = '<div><p>abc</p></div>';
    const s = scanHtml(h);
    const p = s.elements.find((e) => e.tag === 'p');
    expect(p && h.slice(p.start, p.end)).toBe('<p>abc</p>');
    expect(s.innermostContaining(h.indexOf('abc'), h.indexOf('abc') + 3)?.tag).toBe('p');
    expect(s.innermostContaining(h.indexOf('<p>'), h.indexOf('</div>'))?.tag).toBe('div');
  });

  it('引用符の中の > を読み飛ばし、対応しない終了タグは無視する', () => {
    const h = '<a title="x>y">L</a></span><b>M</b>';
    expect(ctx(h, 'L')).toBe('text:a');
    expect(ctx(h, 'M')).toBe('text:b');
  });

  it('暗黙に閉じた要素と末尾で開いたままの要素に印が付く', () => {
    const h = '<ul><li>A<li>B</ul><div>open';
    const s = scanHtml(h);
    const li = s.elements.filter((e) => e.tag === 'li');
    expect(li[0]?.implicitlyClosed).toBe(true);
    expect(h.slice(li[0]?.start, li[0]?.end)).toBe('<li>A');
    const div = s.elements.find((e) => e.tag === 'div');
    expect(div?.implicitlyClosed).toBe(true);
    expect(div?.end).toBe(h.length);
  });

  it('空要素は積まず、foreignObject の中は通常要素に戻る', () => {
    const h = '<p>A<br>B</p><svg><foreignObject><div>X</div></foreignObject></svg>';
    expect(ctx(h, 'B')).toBe('text:p');
    const s = scanHtml(h);
    expect(s.elements.find((e) => e.tag === 'div')?.foreign).toBeNull();
  });

  it('svg 内の style は通常要素、HTML の script は閉じタグまで生テキスト', () => {
    const h = '<svg><style>S</style></svg><script>if (a</b>) {}</script>Z';
    expect(ctx(h, 'S')).toBe('text:style');
    expect(ctx(h, '</b>')).toBe('rawText:script');
    expect(ctx(h, 'Z')).toBe('text:-');
  });
});

describe('maskJinja', () => {
  it('位置を保って伏せる', () => {
    const src = '<p title="{{ "a>b" }}">{% if x %}</p>';
    const m = maskJinja(src, [
      { start: 10, end: 21 },
      { start: 23, end: 33 },
    ]);
    expect(m.length).toBe(src.length);
    expect(m).toBe('<p title="JJJJJJJJJJJ">JJJJJJJJJJ</p>');
  });

  it('改行は残す', () => {
    expect(maskJinja('a{#\n#}b', [{ start: 1, end: 6 }])).toBe('aJJ\nJJb');
  });
});

describe('scanHtml 伏せ字と境界', () => {
  it('`<` 直後の伏せ字は開始タグにしない', () => {
    const h = '<p>price <JJJJJJJ yen</p><b>N</b>';
    const s = scanHtml(h);
    expect(s.elements.map((e) => e.tag)).toEqual(['p', 'b']);
    expect(ctx(h, ' yen')).toBe('text:p');
  });

  it('`</` 直後の伏せ字は偽コメント(> まで)として読む', () => {
    const h = '<p>a</JJJJJ>b</p>';
    expect(ctx(h, 'JJJJJ')).toBe('comment');
    expect(ctx(h, '>b')).toBe('comment');
    expect(ctx(h, 'b<')).toBe('text:p');
    expect(scanHtml(h).elements[0]?.end).toBe(h.length);
  });

  it('foreignObject と template の内側の開始タグは外側の p を閉じない', () => {
    const a = '<p>x<svg><foreignObject><div>D</div></foreignObject></svg>y</p>';
    const sa = scanHtml(a);
    expect(sa.elements.find((e) => e.tag === 'svg')?.implicitlyClosed).toBe(false);
    expect(ctx(a, 'y<')).toBe('text:p');
    const b = '<p>q<template><div>T</div></template>R</p>';
    expect(scanHtml(b).elements.find((e) => e.tag === 'template')?.implicitlyClosed).toBe(false);
    expect(ctx(b, 'R<')).toBe('text:p');
  });
});
