// =============================================================================
// nunjucksRender.ts — ブラウザでの Jinja2 テンプレートのプレビュー描画
// =============================================================================
import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';

/**
 * 生 Jinja2 テンプレートを sample data でブラウザ上に Nunjucks (Jinja2 互換)で
 * 描画する。プレビュー専用 — 本番レンダリングではない。
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
 * 自己完結なプレビュー文書を組み立てる: テンプレートを sample data で描画し,
 * ファンドごとの CSS を inline 化する(外部 `<link>` は viewer では 404 になるため)。
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
