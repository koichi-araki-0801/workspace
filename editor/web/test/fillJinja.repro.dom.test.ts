import { findEditingMarkers } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { toFilled } from '../src/lib/fillJinja';
import { defaultHtmlParser } from '../src/lib/htmlParser';
import { extractJinjaTokens, normalizeForRoundTrip, toTemplate } from '../src/lib/jinjaMask';
import { REPRO_CASES } from './helpers/jinjaReproCases';

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
  it.each(REPRO_CASES)('%s', (_n, raw, sample) => {
    expectSame(raw, sample);
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

describe('for の表示専用の行', () => {
  const raw = '<ul>{% for i in xs %}<li>行 {{ i }}</li>{% endfor %}</ul>';
  const filled = viaParser(toFilled(raw, { xs: [1, 2] }));

  it('x の印より後ろの行を編集しても原文は変わらない', () => {
    const at = filled.indexOf('<!--jinja-rt:x:');
    expect(at).toBeGreaterThan(0);
    const edited = filled.slice(0, at) + filled.slice(at).replace('行 ', '列 ');
    expect(edited).not.toBe(filled);
    expect(toTemplate(edited, { asFragment: true })).toBe(raw);
  });

  it('最初の行(テンプレートの行)を編集すると原文が変わる', () => {
    const edited = filled.replace('行 ', '列 ');
    expect(toTemplate(edited, { asFragment: true })).toBe(
      '<ul>{% for i in xs %}<li>列 {{ i }}</li>{% endfor %}</ul>',
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
