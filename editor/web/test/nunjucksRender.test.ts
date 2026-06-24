import { describe, expect, it } from 'vitest';
import { buildPreviewDocument, renderJinja } from '../src/lib/nunjucksRender';

describe('renderJinja', () => {
  it('renders a template with the given data', () => {
    const r = renderJinja('Hello {{ name }}', { name: 'World' });
    expect(r.error).toBeNull();
    expect(r.html).toBe('Hello World');
  });

  it('returns an error string (not a throw) on a broken template', () => {
    const r = renderJinja('{% if %}', {});
    expect(r.html).toBe('');
    expect(r.error).toBeTruthy();
  });
});

describe('buildPreviewDocument', () => {
  const data = { name: 'X' };

  it('injects the style tag just before </head>', () => {
    const r = buildPreviewDocument(
      '<html><head><title>t</title></head><body>{{ name }}</body></html>',
      '.a{color:red}',
      data,
    );
    expect(r.error).toBeNull();
    expect(r.html).toContain('<style data-preview-css>');
    // the inlined CSS lands inside the document and the template is rendered
    expect(r.html).toContain('color:red');
    expect(r.html).toContain('X');
    expect(r.html.indexOf('data-preview-css')).toBeLessThan(r.html.indexOf('</head>'));
  });

  it('normalizes a head-less document and injects the inlined CSS (body attrs/content kept)', () => {
    // サニタイズ(DOMPurify, WHOLE_DOCUMENT)が <head> を補完するため、CSS は head に入る。
    // body の属性と描画内容は保持される。
    const r = buildPreviewDocument('<body class="r">{{ name }}</body>', '.a{}', data);
    expect(r.html).toContain('<!doctype html>');
    expect(r.html).toContain('<style data-preview-css>');
    expect(r.html).toContain('<body class="r">');
    expect(r.html).toContain('X');
  });

  it('wraps a bare fragment in a full document', () => {
    const r = buildPreviewDocument('{{ name }}', '.a{}', data);
    expect(r.html).toContain('<!doctype html>');
    expect(r.html).toContain('<style data-preview-css>');
    expect(r.html).toContain('X');
  });

  it('propagates a render error without producing HTML', () => {
    const r = buildPreviewDocument('{% if %}', '.a{}', data);
    expect(r.error).toBeTruthy();
    expect(r.html).toBe('');
  });

  it('strips the external stylesheet <link> (CSS is inlined; the link would 404 in the viewer)', () => {
    const r = buildPreviewDocument(
      '<html><head><link rel="stylesheet" href="css/{{ fund.code }}.css" /></head><body>x</body></html>',
      '.a{color:red}',
      { fund: { code: '110024' } },
    );
    expect(r.error).toBeNull();
    // 外部 link は除去され, CSS は inline 化されている
    expect(r.html).not.toContain('rel="stylesheet"');
    expect(r.html).not.toContain('css/110024.css');
    expect(r.html).toContain('<style data-preview-css>');
    expect(r.html).toContain('color:red');
  });

  it('strips a stylesheet link regardless of attribute order or quoting', () => {
    const r = buildPreviewDocument(
      `<head><link href='a.css' rel=stylesheet></head><body>y</body>`,
      '.a{}',
      data,
    );
    expect(r.html).not.toContain('a.css');
    expect(r.html).not.toMatch(/rel=stylesheet/);
  });

  // 保存型 XSS 対策: テンプレ本文の能動コンテンツは除去され, 体裁(style/構造/値)は保持される。
  it('strips active content (<script> / on* handlers / javascript: URLs)', () => {
    const r = buildPreviewDocument(
      '<html><head></head><body>' +
        '<h1>レポート</h1>' +
        '<script>window.__xss=1</script>' +
        '<img src="x" onerror="window.__xss=2">' +
        '<a href="javascript:alert(1)">link</a>' +
        '<div style="margin-top:10mm">本文 {{ name }}</div>' +
        '</body></html>',
      '.a{color:red}',
      data,
    );
    expect(r.error).toBeNull();
    // 危険要素は除去
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(/onerror=/i);
    expect(r.html).not.toMatch(/javascript:/i);
    // 体裁・内容は保持
    expect(r.html).toContain('レポート');
    expect(r.html).toContain('margin-top:10mm');
    expect(r.html).toContain('<style data-preview-css>');
    expect(r.html).toContain('color:red');
    expect(r.html).toContain('X');
  });
});
