import { describe, expect, it } from 'vitest';
import { formatCss, formatHtml } from '../src/lib/formatOutput';

describe('formatHtml', () => {
  it('indents nested elements onto their own lines', () => {
    const out = formatHtml('<div><p>x</p></div>');
    expect(out).toMatch(/<div>\s*\n\s+<p>x<\/p>/);
  });

  it('is idempotent (re-formatting an already-formatted string is a no-op)', () => {
    const once = formatHtml('<section><div><p>x</p></div></section>');
    expect(formatHtml(once)).toBe(once);
  });

  it('keeps the content of whitespace-sensitive elements intact', () => {
    const out = formatHtml('<pre>a   b\n  c</pre>');
    expect(out).toContain('a   b\n  c');
  });
});

describe('formatCss', () => {
  it('expands a minified rule with spacing', () => {
    expect(formatCss('.a{color:red}')).toMatch(/color:\s*red/);
  });

  it('is idempotent', () => {
    const once = formatCss('.a{color:red;margin:0}');
    expect(formatCss(once)).toBe(once);
  });
});
