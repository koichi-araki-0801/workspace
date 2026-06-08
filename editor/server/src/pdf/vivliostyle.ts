import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Generate a PDF from rendered HTML (+ optional CSS) using @vivliostyle/cli.
 * The CSS is inlined into the HTML before handing it to vivliostyle.
 */
export async function htmlToPdf(html: string, css: string): Promise<Buffer> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const htmlPath = path.join(config.tmpDir, `doc-${stamp}.html`);
  const pdfPath = path.join(config.tmpDir, `doc-${stamp}.pdf`);

  const doc = inlineCss(html, css);
  await fs.writeFile(htmlPath, doc, 'utf8');

  try {
    const { build } = await import('@vivliostyle/cli');
    await build({
      input: htmlPath,
      targets: [{ path: pdfPath, format: 'pdf' }],
      size: 'A4',
      // Pin the browser when configured (e.g. system Edge) so offline runs never
      // try to download Chromium; otherwise fall back to vivliostyle's default.
      ...(config.pdf.executableBrowser ? { executableBrowser: config.pdf.executableBrowser } : {}),
      logLevel: 'silent',
    } as Parameters<typeof build>[0]);

    return await fs.readFile(pdfPath);
  } finally {
    await Promise.allSettled([fs.rm(htmlPath, { force: true }), fs.rm(pdfPath, { force: true })]);
  }
}

function inlineCss(html: string, css: string): string {
  if (!css) return html;
  const styleTag = `<style>\n${css}\n</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styleTag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${html}</body></html>`;
}
