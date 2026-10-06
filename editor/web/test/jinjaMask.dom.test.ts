import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { toFilled } from '../src/lib/fillJinja';
import type { HtmlParser } from '../src/lib/htmlParser';
import { defaultHtmlParser } from '../src/lib/htmlParser';
import {
  b64encode,
  extractJinjaTokens,
  normalizeForRoundTrip,
  toTemplate,
} from '../src/lib/jinjaMask';
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
      const restored = toTemplate(toFilled(raw, {}));
      expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
    });
  }
});

describe('toTemplate pretty mode', () => {
  // 整形は placeholder マスク後に行うため、Jinja トークンは欠落も改変もしない。
  for (const [name, raw] of Object.entries(cases)) {
    it(`preserves all Jinja tokens (${name})`, () => {
      const restored = toTemplate(toFilled(raw, {}), { pretty: true });
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
    const plain = toTemplate(toFilled(raw, {}), {});
    const pretty = toTemplate(toFilled(raw, {}), { pretty: true });
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

describe('toTemplate は復元マスクの中身を検査して復号を限定する', () => {
  // toTemplate の最終段は placeholder を base64 復号して HTML へ生文字列で差し込む
  // (「サニタイズが最後に喋る」唯一の例外)。canvas 入口は data-* 属性値を無検査で通すため、
  // ここで各チャネルの形状を検査しないと data-jinja/data-opaque に任意 HTML を注入して
  // 保存テンプレへ書き戻せる。復号は「この toTemplate が発行した placeholder」かつ
  // 「生成元の形状に一致」する場合に限る。違反は黙って残さず throw する。

  it('data-jinja に Jinja トークンでない base64(script)を仕込むと throw する', () => {
    const enc = b64encode('<script>alert(1)</script>');
    const editable = `<p><span data-gjs-type="jinja-var" data-jinja="${enc}">x</span></p>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('data-jinja にトークン + タグ外 HTML の混入(タグ注入)を throw する', () => {
    // 単一トークン風に見せて `}}` の後ろへ HTML を継ぎ足す形。単一トークン検査で弾く。
    const enc = b64encode('{{ x }}<img src=x onerror=alert(1)>{{ y }}');
    const editable = `<p><span data-jinja="${enc}">x</span></p>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('data-opaque に script/math/TeX いずれでもない HTML を仕込むと throw する', () => {
    const enc = b64encode('<img src=x onerror=alert(1)>');
    const editable = `<p><span data-opaque="${enc}" data-opaque-kind="script">JS</span></p>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('data-opaque に「単一 script」を装った script + タグ外 HTML を throw する', () => {
    const enc = b64encode('<script>ok()</script><img src=x onerror=alert(1)><script>e()</script>');
    const editable = `<p><span data-opaque="${enc}" data-opaque-kind="script">JS</span></p>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('data-jinja-block に if ブロックでない base64 を仕込むと throw する', () => {
    const enc = b64encode('<div onclick=alert(1)>x</div>');
    const editable = `<div data-jinja-block="${enc}">x</div>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('data-jinja-open に stmt トークンでない base64 を仕込むと throw する', () => {
    const openEnc = b64encode('<img src=x onerror=alert(1)>');
    const closeEnc = b64encode('{% endfor %}');
    const editable = `<ul><li data-jinja-open="${openEnc}" data-jinja-close="${closeEnc}">x</li></ul>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('テキストへ私用領域文字で偽 placeholder を直書きすると復号されず throw する', () => {
    // U+E000/U+E001 は HTML serialization をエスケープされずに通過する。この toTemplate が
    // 発行していない placeholder は issued set に無く、復号せず違反にする。
    const enc = b64encode('<script>alert(1)</script>');
    const editable = `<p>${String.fromCharCode(0xe000)}${enc}${String.fromCharCode(0xe001)}</p>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('不正 base64(復号不能)を data-jinja に仕込むと throw する', () => {
    const editable = `<p><span data-jinja="@@@not-base64@@@">x</span></p>`;
    expect(() => toTemplate(editable)).toThrow();
  });

  it('正規の data-opaque(単一 script)は throw せず復元する', () => {
    const enc = b64encode('<script>doWidth();</script>');
    const editable = `<p><span data-opaque="${enc}" data-opaque-kind="script">JS</span></p>`;
    const restored = toTemplate(editable, { asFragment: true });
    expect(restored).toContain('<script>doWidth();</script>');
  });
});

describe('full document round-trip', () => {
  it('keeps doctype and all tokens', () => {
    const raw = `<!doctype html>
<html><head><title>fund</title></head>
<body>
<table><tbody>
{% for h in holdings %}
<tr><td>{{ h.name }}</td></tr>
{% endfor %}
</tbody></table>
</body></html>`;
    const restored = toTemplate(toFilled(raw, {}));
    expect(restored.toLowerCase()).toContain('<!doctype html>');
    expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
  });

  // `<html>` ラッパ無しの `<body>…</body>` は GrapesJS の `getHtml()` が返す draft の形で、
  // `toTemplate` の正式な入力形の 1 つ(プレビュー/申請が autosave 済み draft を復元する経路)。
  // `asFragment` はこの形でも本文(body inner)を返すことを契約として固定する。
  it('restores the body inner from a `<body>`-wrapped fragment', () => {
    const raw = '<div class="page"><p>基準価額 {{ fund.nav }} 円</p></div>';
    const wrapped = `<body id="wrapper">${toFilled(raw, {})}</body>`;
    const restored = toTemplate(wrapped, { asFragment: true });
    expect(restored).toContain('{{ fund.nav }}');
    expect(extractJinjaTokens(restored)).toEqual(extractJinjaTokens(raw));
  });
});

describe('normalizeForRoundTrip', () => {
  const n = (s: string) => normalizeForRoundTrip(s, defaultHtmlParser);
  it('Jinja と節点の端に接する改行入りの空白を無視し、パーサの並べ替えは両側に同じく効く', () => {
    const a =
      '<table><tbody>\n{% for r in rows %}\n<tr><td>1</td></tr>\n{% endfor %}\n</tbody></table>';
    const b = '<table><tbody>{% for r in rows %}<tr><td>1</td></tr>{% endfor %}</tbody></table>';
    expect(n(a)).toBe(n(b));
  });
  it('端の空白だけのテキストも無視する', () => {
    expect(n('<div>\n  <p>a</p>\n</div>')).toBe(n('<div><p>a</p></div>'));
  });
  it('中身の違いは残す', () => {
    expect(n('<p>a</p>')).not.toBe(n('<p>b</p>'));
  });
  it('GrapesJS が捨てない空白の差は残す', () => {
    expect(n('<p>{{ a }}\nb</p>')).not.toBe(n('<p>{{ a }}b</p>'));
    expect(n('<p>a\n{{ b }}</p>')).not.toBe(n('<p>a{{ b }}</p>'));
    expect(n('<pre>a\nb</pre>')).not.toBe(n('<pre>ab</pre>'));
    expect(n('<pre>\n\n</pre>')).not.toBe(n('<pre></pre>'));
    expect(n('<textarea>a\nb</textarea>')).not.toBe(n('<textarea>ab</textarea>'));
    expect(n('<script>a\nb</script>')).not.toBe(n('<script>ab</script>'));
  });
  it('GrapesJS が捨てる空白は無視する', () => {
    expect(n('<p><b>a</b>\n<i>b</i></p>')).toBe(n('<p><b>a</b><i>b</i></p>'));
    expect(n('<p>  <b>a</b></p>')).toBe(n('<p><b>a</b></p>'));
    expect(n('<p>{{ a }}\n{{ b }}</p>')).toBe(n('<p>{{ a }}{{ b }}</p>'));
  });
  it('ループの外へ出た行を jsdom でも見分ける', () => {
    const a = '<table><tbody>{% for r in rows %}<tr><td>1</td></tr>{% endfor %}</tbody></table>';
    const b = '<table><tbody>{% for r in rows %}{% endfor %}<tr><td>1</td></tr></tbody></table>';
    expect(n(a)).not.toBe(n(b));
  });
  it('丁度 1 個の空白と、非 Jinja の inline 同士の間の空白は残す', () => {
    expect(n('<p><b>a</b> <i>b</i></p>')).not.toBe(n('<p><b>a</b><i>b</i></p>'));
    expect(n('<p>{{ a }} {{ b }}</p>')).not.toBe(n('<p>{{ a }}{{ b }}</p>'));
  });
  it('linkedom のパーサでも同じ結果になる', () => {
    const parse: HtmlParser = (h) => parseHTML(h).document as unknown as Document;
    const a = '<ul>\n{% for p in xs %}\n<li>{{ p }}</li>\n{% endfor %}\n</ul>';
    const b = '<ul>{% for p in xs %}<li>{{ p }}</li>{% endfor %}</ul>';
    expect(normalizeForRoundTrip(a, parse)).toBe(normalizeForRoundTrip(b, parse));
  });
});
