import { describe, expect, it } from 'vitest';
import { getBodyInner, replaceBodyInner } from '../src/lib/templateDoc';

const DOC = `<!doctype html>
<html><head><title>{{ fund.name }}</title></head>
<body class="report">
<h1>{{ fund.name }}</h1>
</body></html>`;

describe('getBodyInner', () => {
  it('extracts only the inner HTML of <body>', () => {
    expect(getBodyInner(DOC).trim()).toBe('<h1>{{ fund.name }}</h1>');
  });

  it('returns the input unchanged when there is no <body>', () => {
    const fragment = '<p>{{ x }}</p>';
    expect(getBodyInner(fragment)).toBe(fragment);
  });
});

describe('replaceBodyInner', () => {
  it('swaps the body inner HTML while preserving doctype and <head>', () => {
    const out = replaceBodyInner(DOC, '<p>new</p>');
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<title>{{ fund.name }}</title>');
    expect(out).toContain('<body class="report"><p>new</p></body>');
    expect(out).not.toContain('<h1>{{ fund.name }}</h1>');
  });

  it('returns just the new inner when there is no <body> to replace', () => {
    expect(replaceBodyInner('<p>x</p>', '<p>new</p>')).toBe('<p>new</p>');
  });

  it('round-trips: replacing with the extracted inner reproduces the document', () => {
    expect(replaceBodyInner(DOC, getBodyInner(DOC))).toBe(DOC);
  });
});
