import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSampleData, type FundMaster } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import fundMaster from '../src/api/fixtures/funds.json';
import { toFilled } from '../src/lib/fillJinja';
import { extractJinjaTokens, toTemplate } from '../src/lib/jinjaMask';
import { getBodyInner } from '../src/lib/templateDoc';

const sample = {
  company: { code: 'AM01', name: 'アセットマネジメント株式会社' },
  fund: { code: '510037', name: '日本株式オープン', nav: '12,345', navChange: 58 },
  report: { baseDate: '2024-07-10', editionType: 'kr' },
  holdings: [
    { name: 'トヨタ自動車', weight: '5.2' },
    { name: 'ソニーグループ', weight: '4.8' },
    { name: '三菱UFJ', weight: '3.9' },
  ],
};

describe('toFilled -> toTemplate round-trip preserves all Jinja tokens', () => {
  const cases: Record<string, string> = {
    'inline var': `<p>こんにちは {{ fund.name }} さん</p>`,
    'attribute jinja': `<a href="css/{{ fund.code }}.css">link</a>`,
    'for loop around tr': `<table><tbody>
{% for h in holdings %}
<tr class="r" data-rank="{{ loop.index }}"><td>{{ loop.index }}</td><td>{{ h.name }}</td><td>{{ h.weight }}%</td></tr>
{% endfor %}
</tbody></table>`,
    'if else around p': `<section>
{% if fund.navChange >= 0 %}
<p class="up">+{{ fund.navChange }} 円</p>
{% else %}
<p class="down">{{ fund.navChange }} 円</p>
{% endif %}
</section>`,
  };
  for (const [name, raw] of Object.entries(cases)) {
    it(name, () => {
      const restored = toTemplate(toFilled(raw, sample));
      expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
    });
  }
});

describe('toFilled substitutes values for display', () => {
  it('shows the resolved value in the chip, keeps the source in data-jinja', () => {
    const filled = toFilled(`<p>{{ fund.name }}</p>`, sample);
    expect(filled).toContain('>日本株式オープン<');
    expect(filled).toContain('data-jinja=');
  });

  it('expands a loop to one filled row per item', () => {
    const filled = toFilled(
      `<tbody>{% for h in holdings %}<tr><td>{{ h.name }}</td></tr>{% endfor %}</tbody>`,
      sample,
    );
    expect(filled).toContain('トヨタ自動車');
    expect(filled).toContain('ソニーグループ');
    expect(filled).toContain('三菱UFJ');
    // first row keeps the for/endfor markers; the other two are clones
    expect((filled.match(/data-jinja-loop-clone/g) ?? []).length).toBe(2);
    expect(filled).toContain('data-jinja-open=');
  });

  it('keeps only the taken branch of an if/else', () => {
    const filled = toFilled(
      `<section>{% if fund.navChange >= 0 %}<p class="up">+{{ fund.navChange }}</p>{% else %}<p class="down">{{ fund.navChange }}</p>{% endif %}</section>`,
      sample,
    );
    expect(filled).toContain('class="up"');
    expect(filled).not.toContain('class="down"');
    expect(filled).toContain('data-jinja-block=');
  });
});

describe('real report templates round-trip token-for-token', () => {
  const fixtures = resolve(__dirname, '../src/api/fixtures');
  const templates: ReadonlyArray<readonly [string, string]> = [
    ['AM01_510037_20240710_交付版.html', '510037'],
    ['AM01_510037_20240710_全体版.html', '510037'],
    ['AM01_510155_20240710_交付版.html', '510155'],
    ['AM01_510003_20250710_全体版.html', '510003'],
    ['AM01_110024_20251117_交付版.html', '110024'],
    ['AM01_110024_20251117_全体版.html', '110024'],
    ['AM01_510124_20251020_交付版.html', '510124'],
    ['AM01_510124_20251020_全体版.html', '510124'],
  ];
  const funds = fundMaster as Record<string, FundMaster>;
  for (const [file, fund] of templates) {
    it(file, () => {
      const raw = readFileSync(resolve(fixtures, 'templates', file), 'utf8');
      const data = buildSampleData(funds[fund], fund);
      // Mirror the editor's real path: only the <body> inner is filled, edited,
      // and restored; the <head> is taken verbatim from the source on save.
      const filledBody = getBodyInner(toFilled(raw, data));
      const restoredBody = toTemplate(filledBody, { asFragment: true });
      expect(extractJinjaTokens(restoredBody)).toEqual(extractJinjaTokens(getBodyInner(raw)));
    });
  }
});

describe('toFilled masks opaque content so GrapesJS cannot strip/restructure it', () => {
  it('round-trips a <script> verbatim', () => {
    const raw = `<div><script src="x.js"></script><script>doWidth();</script></div>`;
    const filled = toFilled(raw, sample);
    expect(filled).toContain('data-opaque=');
    expect(filled).not.toContain('<script');
    expect(toTemplate(filled)).toContain('<script src="x.js"></script>');
    expect(toTemplate(filled)).toContain('doWidth();');
  });

  it('round-trips MathJax TeX delimiters verbatim', () => {
    const raw = `<p>収益率 \\( r = \\frac{P_1 - P_0}{P_0} \\) と $$\\sum_{i} w_i$$ です</p>`;
    const filled = toFilled(raw, sample);
    expect(filled).toContain('data-opaque-kind="math"');
    // the raw TeX is hidden from the canvas (chip shows a label, not the source)
    expect(filled).not.toContain('\\frac');
    const restored = toTemplate(filled);
    expect(restored).toContain('\\( r = \\frac{P_1 - P_0}{P_0} \\)');
    expect(restored).toContain('$$\\sum_{i} w_i$$');
  });

  it('round-trips MathML <math> verbatim and never exposes its internals', () => {
    const raw = `<p><math><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow></math></p>`;
    const filled = toFilled(raw, sample);
    expect(filled).toContain('data-opaque-kind="math"');
    expect(filled).not.toContain('<mi>');
    expect(toTemplate(filled)).toContain(
      '<math><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow></math>',
    );
  });
});
