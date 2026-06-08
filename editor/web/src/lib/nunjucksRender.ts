import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';

/**
 * Render a raw Jinja2 template with sample data in the browser using Nunjucks
 * (Jinja2-compatible). Preview only — not production rendering.
 */
const env = new nunjucks.Environment(undefined, {
  autoescape: true,
  throwOnUndefined: false,
});

export interface RenderResult {
  html: string;
  error: string | null;
}

export function renderJinja(template: string, data: SampleData): RenderResult {
  try {
    return { html: env.renderString(template, data as object), error: null };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build a self-contained preview document: render the template with sample data
 * and inline the per-fund CSS (the external <link> would 404 in the viewer).
 */
export function buildPreviewDocument(rawHtml: string, css: string, data: SampleData): RenderResult {
  const rendered = renderJinja(rawHtml, data);
  if (rendered.error) return rendered;

  const html = rendered.html;
  const styleTag = `<style data-preview-css>\n${css}\n</style>`;
  let out: string;
  if (/<\/head>/i.test(html)) {
    out = html.replace(/<\/head>/i, `${styleTag}</head>`);
  } else if (/<body[^>]*>/i.test(html)) {
    out = html.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  } else {
    out = `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${html}</body></html>`;
  }
  return { html: out, error: null };
}
