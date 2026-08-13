import { describe, expect, it } from 'vitest';
import { extractJinjaTokens, toEditable, toTemplate } from '../src/lib/jinjaMask';
import { renderJinja } from '../src/lib/nunjucksRender';

const cases: Record<string, string> = {
  'inline var': `<p>こんにちは {{ user.name }} さん</p>`,
  'attribute jinja': `<a href="{{ url }}" class="x {{ cls }}">link</a>`,
  'for loop around tr': `<table><tbody>
{% for h in holdings %}
<tr class="r" data-rank="{{ loop.index }}"><td>{{ loop.index }}</td><td>{{ h.name }}</td></tr>
{% endfor %}
</tbody></table>`,
  'if else around p': `<section>
{% if x >= 0 %}
<p class="up">+{{ x }}</p>
{% else %}
<p class="down">{{ x }}</p>
{% endif %}
</section>`,
  'comment and set': `<div>{# note #}{% set total = 1 + 2 %}<span>{{ total }}</span></div>`,
  'for around li': `<ul>{% for p in items %}<li>{{ p.label }}: {{ p.value }}</li>{% endfor %}</ul>`,
};

describe('jinjaMask round-trip preserves all Jinja tokens', () => {
  for (const [name, raw] of Object.entries(cases)) {
    it(name, () => {
      const restored = toTemplate(toEditable(raw));
      expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
    });
  }
});

describe('toEditable produces GrapesJS-safe markers', () => {
  it('wraps inline vars in locked chips', () => {
    const e = toEditable(`<p>{{ a }}</p>`);
    expect(e).toContain('data-gjs-type="jinja-var"');
    expect(e).toContain('data-jinja=');
  });

  it('absorbs for-loops onto the wrapped element (no stray text in table)', () => {
    const e = toEditable(`<tbody>{% for h in xs %}<tr><td>{{ h }}</td></tr>{% endfor %}</tbody>`);
    expect(e).toContain('data-jinja-open=');
    expect(e).toContain('data-jinja-close=');
    // the raw {% for %} text should no longer float between tbody and tr
    expect(e).not.toMatch(/<tbody>\s*\{%\s*for/);
  });

  it('leaves attribute jinja untouched (not wrapped in a chip)', () => {
    const e = toEditable(`<a href="{{ url }}">x</a>`);
    expect(e).toContain('href="{{ url }}"');
  });
});

describe('toTemplate pretty mode', () => {
  // 整形は placeholder マスク後に行うため、Jinja トークンは欠落も改変もしない。
  for (const [name, raw] of Object.entries(cases)) {
    it(`preserves all Jinja tokens (${name})`, () => {
      const restored = toTemplate(toEditable(raw), { pretty: true });
      expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
    });
  }

  // 整形は空白だけを変え、Jinja 評価結果(描画結果)を変えてはならない — 最重要の保証。
  it('changes only whitespace, not the rendered result', () => {
    const raw = `<table><tbody>{% for h in xs %}<tr><td>{{ h.name }}</td></tr>{% endfor %}</tbody></table>`;
    const data = { xs: [{ name: 'A' }, { name: 'B' }] };
    // タグ間に入るインデント空白はブロック要素では表示に影響しないので畳んでから比較する
    // (整形が変えてよいのはこの空白だけ — テキストノードの内容は両者で不変)。
    const norm = (s: string) => s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
    const plain = toTemplate(toEditable(raw), {});
    const pretty = toTemplate(toEditable(raw), { pretty: true });
    expect(norm(renderJinja(plain, data).html)).toBe(norm(renderJinja(pretty, data).html));
  });
});

describe('jinja data attribute names stay stable', () => {
  // 属性名リテラルは意図的に定数(jinjaAttrs.ts)を import せず固定する: 定数の値を
  // 誤変更したとき、このテストと fixture round-trip が「破壊」として検知するため。
  it('canvas CSS still targets [data-jinja-open]', async () => {
    const { jinjaChipCanvasCss } = await import('../src/features/editor/jinjaComponents');
    expect(jinjaChipCanvasCss).toContain('[data-jinja-open]');
  });
});

describe('full document round-trip', () => {
  it('keeps doctype and all tokens', () => {
    const raw = `<!doctype html>
<html><head><title>{{ fund.name }}</title></head>
<body>
<table><tbody>
{% for h in holdings %}
<tr><td>{{ h.name }}</td></tr>
{% endfor %}
</tbody></table>
</body></html>`;
    const restored = toTemplate(toEditable(raw));
    expect(restored.toLowerCase()).toContain('<!doctype html>');
    expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
  });

  // `<html>` ラッパ無しの `<body>…</body>` は GrapesJS の `getHtml()` が返す draft の形で、
  // `toTemplate` の正式な入力形の 1 つ(プレビュー/申請が autosave 済み draft を復元する経路)。
  // `asFragment` はこの形でも本文(body inner)を返すことを契約として固定する。
  it('restores the body inner from a `<body>`-wrapped fragment', () => {
    const raw = '<div class="page"><p>基準価額 {{ fund.nav }} 円</p></div>';
    const wrapped = `<body id="wrapper">${toEditable(raw)}</body>`;
    const restored = toTemplate(wrapped, { asFragment: true });
    expect(restored).toContain('{{ fund.nav }}');
    expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
  });
});
