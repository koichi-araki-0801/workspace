// =============================================================================
// nunjucksRender.ts — ブラウザでの Jinja2 テンプレートのプレビュー描画
// =============================================================================
import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';
import { sanitizePreviewHtml } from './sanitizeHtml';

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

  // 本体 document に直接描画される前に能動コンテンツ(`<script>`/`on*`/`javascript:`)を除去する
  // (保存型 XSS 対策)。この後で注入する自前 `<style data-preview-css>` はサニタイズ対象外＝
  // そのまま残す(信頼できる inline CSS のため)。サニタイズ前に行う理由でもある。
  const safe = sanitizePreviewHtml(rendered.html);

  // 外部 stylesheet `<link>`(例: `<link rel="stylesheet" href="css/110024.css">`)を除去する。
  // CSS は直後に inline 化するため不要で, 残すと viewer が Blob 相対 URL で解決して 404 になり,
  // `@vivliostyle/core` のフェッチャがページ分割を中断してしまう(プレビューが 1 ページに崩れる)。
  const cleaned = safe.replace(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, '');
  const styleTag = `<style data-preview-css>\n${css}\n</style>`;
  let out: string;
  if (/<\/head>/i.test(cleaned)) {
    out = cleaned.replace(/<\/head>/i, `${styleTag}</head>`);
  } else if (/<body[^>]*>/i.test(cleaned)) {
    out = cleaned.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  } else {
    out = `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${cleaned}</body></html>`;
  }
  return { html: out, error: null };
}
