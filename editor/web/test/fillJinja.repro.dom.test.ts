import { findEditingMarkers } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { toFilled } from '../src/lib/fillJinja';
import { defaultHtmlParser } from '../src/lib/htmlParser';
import { extractJinjaTokens, normalizeForRoundTrip, toTemplate } from '../src/lib/jinjaMask';

/** jsdom のパーサで一度読み直してから戻す(キャンバスの読み込みに近づける)。 */
function viaParser(filled: string): string {
  const doc = defaultHtmlParser(`<!doctype html><html><body>${filled}</body></html>`);
  return doc.body.innerHTML;
}
function roundTrip(raw: string, sample: Record<string, unknown>): string {
  return toTemplate(viaParser(toFilled(raw, sample)), { asFragment: true });
}
function expectSame(raw: string, sample: Record<string, unknown>) {
  const back = roundTrip(raw, sample);
  expect(normalizeForRoundTrip(back, defaultHtmlParser)).toBe(
    normalizeForRoundTrip(raw, defaultHtmlParser),
  );
  expect(extractJinjaTokens(back)).toEqual(extractJinjaTokens(raw));
}

describe('dig の再現ケースが往復する', () => {
  it.each([
    [
      'if の中の for',
      '<div>{% if show %}<table><tbody>{% for r in rows %}<tr><td>{{ r.a }}</td></tr>{% endfor %}</tbody></table>{% endif %}</div>',
      { show: true, rows: [{ a: 1 }, { a: 2 }] },
    ],
    [
      'if の中の script と数式',
      '<div>{% if show %}<div class="c"><script>f()</script>$$x^2$$</div>{% endif %}</div>',
      { show: true },
    ],
    [
      '入れ子の if',
      '<div>{% if a %}<p>1</p>{% if b %}<p>2</p>{% endif %}{% endif %}</div>',
      { a: true, b: true },
    ],
    [
      'tbody の中の複数行の if',
      '<table><tbody>{% if x %}<tr><td>a</td></tr><tr><td>b</td></tr>{% endif %}</tbody></table>',
      { x: true },
    ],
    ['svg の text の出力', '<svg><text x="1">{{ v }}</text></svg>', { v: 3 }],
    [
      '複数の兄弟を持つ for',
      '<table><tbody>{% for r in rows %}<tr><td>{{ r }}</td></tr><tr><td>sub</td></tr>{% endfor %}</tbody></table>',
      { rows: [1, 2] },
    ],
    [
      'elif',
      '<div>{% if a %}<p>A</p>{% elif b %}<p>B</p>{% else %}<p>C</p>{% endif %}</div>',
      { a: false, b: true },
    ],
    ['空白制御', '<div>{% if a -%}<p>A</p>{%- endif %}</div>', { a: true }],
    ['本文中の style', '<div><style>.a{color:{{ c }}}</style></div>', { c: 'red' }],
    [
      '表の中の地の出力',
      '<table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table>',
      { rows: [1] },
    ],
    [
      'td の中の固めた表',
      '<table><tbody><tr><td><table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table></td></tr></tbody></table>',
      { rows: [1, 2] },
    ],
    ['raw ブロック', '<p>a{% raw %}{{ x }}{% endraw %}b</p>', {}],
    [
      'endif -%} と複数要素の枝',
      '<div>{% if a %}<p>1</p><p>2</p>{% endif -%}\n<p>3</p></div>',
      { a: true },
    ],
  ])('%s', (_n, raw, sample) => {
    expectSame(raw as string, sample as Record<string, unknown>);
  });

  it('script は確定テンプレートへ素の script として戻る(チップが焼き付かない)', () => {
    const back = roundTrip('<div>{% if show %}<script>f()</script>{% endif %}</div>', {
      show: true,
    });
    expect(back).toContain('<script>f()</script>');
    expect(back).not.toMatch(/data-opaque|jinja-chip/);
  });

  it('elif: a=false, b=true で B の枝を表示する', () => {
    const filled = toFilled(
      '<div>{% if a %}<p>A</p>{% elif b %}<p>B</p>{% else %}<p>C</p>{% endif %}</div>',
      { a: false, b: true },
    );
    expect(filled).toContain('<p>B</p>');
    expect(filled).not.toContain('<p>C</p>');
  });
});

describe('採用した枝の編集は原文のその枝へ書き戻す', () => {
  it('他の枝は 1 バイトも変わらない', () => {
    const raw =
      '<section>{% if n >= 0 %}<p class="up">前日比 +{{ n }} 円</p>{% else %}<p class="down">前日比 {{ n }} 円</p>{% endif %}</section>';
    const edited = viaParser(toFilled(raw, { n: 5 }))
      .replace('前日比 +', '前日比(修正) +')
      .replace('class="up"', 'class="up bold"');
    expect(toTemplate(edited, { asFragment: true })).toBe(
      '<section>{% if n >= 0 %}<p class="up bold">前日比(修正) +{{ n }} 円</p>{% else %}<p class="down">前日比 {{ n }} 円</p>{% endif %}</section>',
    );
  });
  it('採用した枝の中の入れ子の for への編集も戻る', () => {
    const raw =
      '<div>{% if a %}<ul>{% for i in xs %}<li>{{ i }}</li>{% endfor %}</ul>{% endif %}</div>';
    const edited = viaParser(toFilled(raw, { a: true, xs: [1, 2] })).replace(
      '<li data-jinja-loop-row="">',
      '<li data-jinja-loop-row="" class="k">',
    );
    expect(toTemplate(edited, { asFragment: true })).toBe(
      '<div>{% if a %}<ul>{% for i in xs %}<li class="k">{{ i }}</li>{% endfor %}</ul>{% endif %}</div>',
    );
  });
});

describe('固めた表は追い出された値ごと包む', () => {
  it('表の行の間の値はパーサが表の手前へ出すが、包みの div の中に残る', () => {
    const raw = '<table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table>';
    const doc = defaultHtmlParser(
      `<!doctype html><html><body>${toFilled(raw, { rows: [1] })}</body></html>`,
    );
    const wrap = doc.body.firstElementChild;
    expect(wrap?.tagName).toBe('DIV');
    expect(wrap?.className).toBe('jinja-frozen-body');
    expect(wrap?.getAttribute('data-opaque-kind')).toBe('frozen');
    expect(wrap?.textContent).toBe('1');
    expect(doc.body.childNodes.length).toBe(1);
  });

  it('包みは申請の関所で編集用の印として検出される', () => {
    const filled = toFilled(
      '<table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table>',
      {
        rows: [1],
      },
    );
    const markers = findEditingMarkers(filled).map((h) => h.marker);
    expect(markers).toContain('attr:data-opaque');
  });
});
