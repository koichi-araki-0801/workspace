import { describe, expect, it } from 'vitest';
import { extractJinjaTokens, toEditable, toTemplate } from '../src/lib/jinjaMask';

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
});
