import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('does not split on a <body> that lives inside a head comment', () => {
    const doc = `<html><head><!-- <body class=x> --><title>{{ f }}</title></head><body class="real"><p>inner</p></body></html>`;
    expect(getBodyInner(doc)).toBe('<p>inner</p>');
  });

  it('does not split on a <body> that lives inside an attribute value', () => {
    const doc = `<html><head><meta content="<body>"><title>t</title></head><body><p>inner</p></body></html>`;
    expect(getBodyInner(doc)).toBe('<p>inner</p>');
  });

  it('does not treat a </body> inside a comment as the terminator', () => {
    const doc = `<html><head></head><body><p>a</p><!-- </body> --><p>b</p></body></html>`;
    expect(getBodyInner(doc)).toBe('<p>a</p><!-- </body> --><p>b</p>');
  });

  it('does not treat raw-text element content as markup', () => {
    // `<script>` / `<style>` の中身に現れる `<body>` を実タグと誤認しない。
    const doc = `<html><head><style>body::before{content:"<body>"}</style></head><body><p>ok</p></body></html>`;
    expect(getBodyInner(doc)).toBe('<p>ok</p>');
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

  it('keeps head Jinja byte-identical when the body is replaced', () => {
    const doc = `<html><head><title>{{ fund.name }}</title><link rel="stylesheet" href="{{ css_url }}"></head><body><p>old</p></body></html>`;
    const out = replaceBodyInner(doc, '<p>new</p>');
    expect(
      out.startsWith(
        '<html><head><title>{{ fund.name }}</title><link rel="stylesheet" href="{{ css_url }}"></head>',
      ),
    ).toBe(true);
    expect(out).toContain('<body><p>new</p></body>');
  });
});

describe('round-trip identity on real fixtures', () => {
  const FIXTURES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/api/fixtures',
  );
  const cases: Array<{ label: string; raw: string }> = [];
  for (const sub of ['filled', 'templates']) {
    const dir = path.join(FIXTURES, sub);
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith('.html'))
      .slice(0, 4)) {
      cases.push({ label: `${sub}/${name}`, raw: readFileSync(path.join(dir, name), 'utf8') });
    }
  }

  it.each(cases)('$label: replaceBodyInner(raw, getBodyInner(raw)) === raw', ({ raw }) => {
    expect(replaceBodyInner(raw, getBodyInner(raw))).toBe(raw);
  });
});
