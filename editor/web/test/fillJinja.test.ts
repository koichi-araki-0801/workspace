import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSampleData, type FundMaster, parseTemplateFileName } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import fundMaster from '../src/api/fixtures/funds.json';
import { defaultSkeleton } from '../src/api/local/store';
import { toFilled, toFilledWithDiagnostics } from '../src/lib/fillJinja';
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

  // 値差込は `jinjaExpr.ts` の許可リスト評価器で行う(`nunjucks.compile` を使わない)。
  // 許可リストの外の式は空値へ落ちるので、**実テンプレが 1 件も外に出ていない**ことを
  // ここで固定する。テンプレへ新しい式の形(フィルタ等)が入った瞬間にここが落ち、
  // 「値が黙って空になる」状態でコミットされるのを防ぐ。未定義キー(`missing`)も同罪 —
  // 評価器は例外にしないため `unsupported` に載らず、表示だけが黙って空になる。
  for (const [file, fund] of templates) {
    it(`${file}: 解釈できない/未定義の Jinja 式が無い`, () => {
      const raw = readFileSync(resolve(fixtures, 'templates', file), 'utf8');
      const attrs = parseTemplateFileName(file);
      const { diagnostics } = toFilledWithDiagnostics(
        raw,
        buildSampleData(funds[fund], fund, attrs ?? undefined),
      );
      expect(diagnostics.unsupported).toEqual([]);
      expect(diagnostics.missing).toEqual([]);
    });
  }
});

// fixture テンプレ(上)と REST 検証データ(`editor/data/templates`)・生成スケルトンは
// 書きぶりが分岐しており、fixture だけを検査すると後者だけが参照するキー
// (`report.baseDate` / `fund.navChange` で実際に起きた)の欠落が素通りする。
// 参照キーがサンプルデータで満たされることを、全系統に対して固定する。
describe('data/templates と生成スケルトンの参照キーがサンプルで満たされる', () => {
  const funds = fundMaster as Record<string, FundMaster>;
  const dataTemplates = resolve(__dirname, '../../data/templates');

  for (const file of readdirSync(dataTemplates).filter((f) => f.endsWith('.html'))) {
    it(`${file}: 解釈できない/未定義の Jinja 式が無い`, () => {
      const raw = readFileSync(resolve(dataTemplates, file), 'utf8');
      const attrs = parseTemplateFileName(file);
      expect(attrs).not.toBeNull();
      if (!attrs) return;
      const { diagnostics } = toFilledWithDiagnostics(
        raw,
        buildSampleData(funds[attrs.fundCode], attrs.fundCode, attrs),
      );
      expect(diagnostics.unsupported).toEqual([]);
      expect(diagnostics.missing).toEqual([]);
    });
  }

  it('defaultSkeleton(local の新規作成雛形): 解釈できない/未定義の Jinja 式が無い', () => {
    const { diagnostics } = toFilledWithDiagnostics(
      defaultSkeleton(),
      buildSampleData(undefined, '000000', { editionType: '交付版', baseDate: '20260101' }),
    );
    expect(diagnostics.unsupported).toEqual([]);
    expect(diagnostics.missing).toEqual([]);
  });
});

describe('toFilled は解釈できない式を黙って捨てない', () => {
  it('フィルタ付きの式を診断へ挙げ、表示は空にする(画面は落とさない)', () => {
    const { html, diagnostics } = toFilledWithDiagnostics(`<p>{{ fund.name | upper }}</p>`, sample);
    expect(diagnostics.unsupported).toEqual(['fund.name | upper']);
    expect(html).toContain('data-jinja='); // ソースは保持され round-trip する
    expect(html).not.toContain('日本株式オープン');
  });

  it('同じ式がループで何度出ても診断は 1 件(種類を数える)', () => {
    const { diagnostics } = toFilledWithDiagnostics(
      `<tbody>{% for h in holdings %}<tr><td>{{ h.name | upper }}</td></tr>{% endfor %}</tbody>`,
      sample,
    );
    expect(diagnostics.unsupported).toEqual(['h.name | upper']);
  });

  it('解釈できる式しか無ければ診断は空', () => {
    const { diagnostics } = toFilledWithDiagnostics(
      `<p>{{ fund.name }}{% if fund.navChange >= 0 %}<b>{{ loop.index }}</b>{% endif %}</p>`,
      sample,
    );
    expect(diagnostics.unsupported).toEqual([]);
  });

  it('サンプルに無いキーの {{ expr }} は missing に載る(表示は空・画面は落とさない)', () => {
    const { html, diagnostics } = toFilledWithDiagnostics(
      `<p>{{ report.noSuchKey }} 円</p>`,
      sample,
    );
    expect(diagnostics.missing).toEqual(['report.noSuchKey']);
    expect(diagnostics.unsupported).toEqual([]);
    expect(html).toContain('data-jinja='); // ソースは保持され round-trip する
  });

  it('{% if %} の条件は undefined が正当な値なので missing に数えない', () => {
    const { diagnostics } = toFilledWithDiagnostics(
      `<section>{% if report.noSuchKey %}<p>A</p>{% else %}<p>B</p>{% endif %}</section>`,
      sample,
    );
    expect(diagnostics.missing).toEqual([]);
  });

  it('コンパイラ非依存: prototype 経由の式は値を返さない(SSTI の入口を塞ぐ)', () => {
    const { html } = toFilledWithDiagnostics(`<p>{{ constructor }}</p>`, sample);
    expect(html).not.toContain('native code');
  });

  it('条件式が解釈できなければ false 扱いにして診断へ挙げる', () => {
    const { html, diagnostics } = toFilledWithDiagnostics(
      `<section>{% if holdings | length %}<p class="up">U</p>{% else %}<p class="down">D</p>{% endif %}</section>`,
      sample,
    );
    expect(diagnostics.unsupported).toEqual(['holdings | length']);
    expect(html).toContain('class="down"');
  });

  it('反復対象が解釈できなければ展開せず(テンプレ行を残し)診断へ挙げる', () => {
    const { html, diagnostics } = toFilledWithDiagnostics(
      `<tbody>{% for h in holdings | reverse %}<tr><td>{{ h.name }}</td></tr>{% endfor %}</tbody>`,
      sample,
    );
    expect(diagnostics.unsupported).toContain('holdings | reverse');
    expect(html).not.toContain('data-jinja-loop-clone');
    expect(html).toContain('data-jinja-open=');
  });

  it('`toFilled` は解釈できない式をコンソールへ 1 度だけ知らせる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 無言の空値化(ここで**何も出さない**形)へ戻っていないことを見る。
      const raw = `<p>{{ fund.name | title }}</p>`;
      toFilled(raw, sample);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('[fillJinja]');
      // 2 度目は同じ式なので黙る(ループ・再読込でログが溢れない)。
      toFilled(raw, sample);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
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
