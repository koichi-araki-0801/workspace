import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findEditingMarkers, sampleCommon } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { renderPartForInsert } from '@/features/editor/partRender';
import { toFilled } from '@/lib/fillJinja';
import { defaultHtmlParser } from '@/lib/htmlParser';
import { normalizeForRoundTrip, toTemplate } from '@/lib/jinjaMask';

const sample = {
  fund: { name: '日本株式オープン', nav: '12,345' },
  holdings: [
    { name: 'トヨタ自動車', weight: '5.2' },
    { name: 'ソニーグループ', weight: '4.8' },
  ],
};

const norm = (html: string) => normalizeForRoundTrip(html, defaultHtmlParser);

/** `ok: true` の結果だけを取り出す(テストの前提が崩れたら落とす)。 */
function rendered(r: ReturnType<typeof renderPartForInsert>) {
  if (!r.ok) throw new Error(`ok: false: ${r.error}`);
  return r;
}

describe('renderPartForInsert: 編集経路', () => {
  const edit = (values: object, valuesFound = true) =>
    ({ route: 'edit', values, valuesFound }) as const;

  it('編集経路は値で描き、印もチップも持たない', () => {
    const part = `<div class="p"><p>{{ fund.name }}</p><table><tbody>{% for h in holdings %}<tr><td>{{ h.name }}</td></tr>{% endfor %}</tbody></table></div>`;
    const r = rendered(renderPartForInsert(part, edit(sample)));
    expect(r.html).toContain('<p>日本株式オープン</p>');
    expect(r.html).toContain('<tr><td>トヨタ自動車</td></tr><tr><td>ソニーグループ</td></tr>');
    expect(r.html).not.toContain('jinja-chip');
    expect(r.html).not.toMatch(/data-jinja|data-opaque|data-gjs-type/);
    expect(findEditingMarkers(r.html)).toEqual([]);
    expect(r.html).not.toMatch(/\{\{|\{%/);
    expect(r.warnings).toEqual([]);
  });

  it('編集経路で値の < " & はエスケープされて地の文字になる', () => {
    const values = { fund: { name: '<b>A&B</b> "x"' } };
    const r = rendered(
      renderPartForInsert('<p title="{{ fund.name }}">{{ fund.name }}</p>', edit(values)),
    );
    expect(r.html).not.toContain('<b>');
    const p = defaultHtmlParser(`<body>${r.html}</body>`).body.querySelector('p');
    expect(p?.textContent).toBe('<b>A&B</b> "x"');
    expect(p?.getAttribute('title')).toBe('<b>A&B</b> "x"');
    expect(p?.children.length).toBe(0);
  });

  it('編集経路で値ファイルが無ければ空欄で描き、値ファイル無しの警告を返す', () => {
    const r = rendered(renderPartForInsert('<p>{{ fund.name }}</p>', edit({}, false)));
    expect(r.html).toBe('<p></p>');
    expect(r.warnings).toEqual([
      'このテンプレートの値ファイル（json）が見つからないため、値を空欄で挿入しました',
    ]);
  });

  it('編集経路で欠けた値を警告に並べる', () => {
    const r = rendered(
      renderPartForInsert(
        '<p>{{ fund.name }}</p><p>{{ fund.code }}</p><p>{{ report.baseDate }}</p><p>{{ x | foo }}</p>',
        edit(sample),
      ),
    );
    expect(r.html).toContain('<p>日本株式オープン</p><p></p><p></p>');
    expect(r.warnings).toEqual([
      '次の値が見つからないため空欄で挿入しました: fund.code、report.baseDate',
      '次の書き方は描画できないため空欄で挿入しました: x | foo',
    ]);
  });

  it('編集経路で壊れた Jinja は ok: false', () => {
    const r = renderPartForInsert('<p>{% if fund.name %}{{ fund.name }}</p>', edit(sample));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^パーツの Jinja を読めないため挿入できません: /);
  });
});

describe('renderPartForInsert: fixture のパーツ', () => {
  const FIXTURES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/api/fixtures',
  );
  const parts = JSON.parse(readFileSync(path.join(FIXTURES, 'parts.json'), 'utf8')) as Array<{
    id: string;
    content: string;
  }>;
  const jinjaParts = parts.filter((p) => /\{\{|\{%/.test(p.content));
  const values = JSON.parse(
    readFileSync(path.join(FIXTURES, 'json', 'AM01_510037_20240710_交付版.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('Jinja のパーツを含み、{% for %} を持つ表もある(セルフテスト)', () => {
    expect(jinjaParts.length).toBeGreaterThanOrEqual(4);
    expect(jinjaParts.some((p) => /<table[\s\S]*\{% for /.test(p.content))).toBe(true);
  });

  // fixture の変数名が local の値の源(値ファイルと `sampleCommon`)のキーと揃っていること。
  it.each(
    jinjaParts.map((p) => [p.id, p.content]),
  )('%s は編集経路で値ファイルの値だけで描け、警告が無い', (_id, content) => {
    const r = rendered(renderPartForInsert(content, { route: 'edit', values, valuesFound: true }));
    expect(r.warnings).toEqual([]);
    expect(r.html).not.toMatch(/\{\{|\{%/);
  });

  it.each(
    jinjaParts.map((p) => [p.id, p.content]),
  )('%s は作成経路で共通サンプルの値がチップで入り、原文に戻る', (_id, content) => {
    const r = rendered(renderPartForInsert(content, { route: 'create', sample: sampleCommon }));
    expect(r.warnings).toEqual([]);
    expect(r.html).toContain('jinja-chip');
    expect(norm(toTemplate(r.html, { asFragment: true }))).toBe(norm(content));
  });
});

describe('renderPartForInsert: 作成経路', () => {
  const create = { route: 'create', sample } as const;

  it('作成経路はチップ付きで描き、toTemplate で原文に戻る', () => {
    const part = '<div class="p"><p>{{ fund.name }}</p><p>{{ fund.nav }} 円</p></div>';
    const r = rendered(renderPartForInsert(part, create));
    expect(r.html).toContain('jinja-chip');
    expect(r.html).toContain('日本株式オープン');
    expect(r.warnings).toEqual([]);
    expect(norm(toTemplate(r.html, { asFragment: true }))).toBe(norm(part));
  });

  it('作成経路で <table> 内の {% for %} を含む断片も原文に戻る', () => {
    const part = `<table class="h"><tbody>
{% for h in holdings %}
<tr><td>{{ loop.index }}</td><td>{{ h.name }}</td><td>{{ h.weight }}%</td></tr>
{% endfor %}
</tbody></table>`;
    const r = rendered(renderPartForInsert(part, create));
    expect(r.html).toContain('ソニーグループ');
    expect(norm(toTemplate(r.html, { asFragment: true }))).toBe(norm(part));
  });

  it('作成経路で本文を toFilled した後にパーツ断片を挿入しても、本文全体が toTemplate で本文 + パーツの原文に戻る', () => {
    const body =
      '<section>{% if fund.name %}<h1>{{ fund.name }}</h1>{% endif %}<p>{{ fund.nav }}</p></section>';
    const part =
      '<div class="part">{% if fund.name %}<p>{{ fund.name }} の組入</p>{% endif %}<ul>{% for h in holdings %}<li>{{ h.name }}</li>{% endfor %}</ul></div>';
    const filledBody = toFilled(body, sample);
    const r = rendered(renderPartForInsert(part, create));
    const back = toTemplate(filledBody + r.html, { asFragment: true });
    expect(norm(back)).toBe(norm(body + part));
  });

  it('作成経路で描けない書き方は警告に並べる', () => {
    const r = rendered(renderPartForInsert('<p>{{ fund.name | foo }}</p>', create));
    expect(r.warnings).toEqual(['次の書き方は描画できないため空欄で挿入しました: fund.name | foo']);
  });
});
