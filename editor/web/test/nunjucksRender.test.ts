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

  it('injects the style right after <body> when there is no </head>', () => {
    const r = buildPreviewDocument('<body class="r">{{ name }}</body>', '.a{}', data);
    expect(r.html).toContain('<body class="r"><style data-preview-css>');
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
});
