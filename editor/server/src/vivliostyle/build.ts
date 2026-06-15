import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { sharedInlineConfig } from './options.js';

/** Inline (rendered HTML + optional CSS) build input. */
export interface BuildInlineInput {
  html: string;
  css?: string;
  /** Page size handed to vivliostyle (default 'A4'). */
  size?: string;
  /** Treat the input as a single document (no per-file pagination). */
  singleDoc?: boolean;
}

/**
 * Generate a PDF from rendered HTML (+ optional CSS) using `@vivliostyle/cli`.
 * The CSS is inlined into the HTML before handing it to vivliostyle.
 *
 * With `{html, css}` only (size defaulting to 'A4'), this reproduces the old
 * `htmlToPdf` call byte-for-byte — the inline route is a drop-in replacement.
 */
export async function buildInlinePdf(input: BuildInlineInput): Promise<Buffer> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const htmlPath = path.join(config.tmpDir, `doc-${stamp}.html`);
  const pdfPath = path.join(config.tmpDir, `doc-${stamp}.pdf`);

  const doc = inlineCss(input.html, input.css ?? '');
  await fs.writeFile(htmlPath, doc, 'utf8');

  try {
    const { build } = await import('@vivliostyle/cli');
    await build({
      input: htmlPath,
      output: [{ path: pdfPath, format: 'pdf' }],
      size: input.size ?? 'A4',
      ...(input.singleDoc ? { singleDoc: true } : {}),
      ...sharedInlineConfig(),
    } as Parameters<typeof build>[0]);

    return await fs.readFile(pdfPath);
  } finally {
    await Promise.allSettled([fs.rm(htmlPath, { force: true }), fs.rm(pdfPath, { force: true })]);
  }
}

/** Project (extracted dir) build input. See `projectInput.ts`. */
export interface BuildProjectInput {
  /** Directory holding the extracted vivliostyle project. */
  dir: string;
  /** `vivliostyle.config.*` path when present (preferred entry). */
  configPath?: string;
  /** Relative entry file used when there is no config. */
  entry?: string;
  size?: string;
  singleDoc?: boolean;
}

/**
 * Build a PDF from an extracted vivliostyle project directory. Uses the
 * project's `vivliostyle.config.*` when present, otherwise a single entry file.
 */
export async function buildProjectPdf(input: BuildProjectInput): Promise<Buffer> {
  const pdfPath = path.join(input.dir, `__out-${Date.now()}.pdf`);

  try {
    const { build } = await import('@vivliostyle/cli');
    // `cwd` is set in both cases so vivliostyle resolves entries relative to the
    // extracted project dir, not the server's working directory.
    const entry = input.configPath
      ? { config: input.configPath, cwd: input.dir }
      : { cwd: input.dir, input: input.entry };
    await build({
      ...entry,
      output: [{ path: pdfPath, format: 'pdf' }],
      ...(input.size ? { size: input.size } : {}),
      ...(input.singleDoc ? { singleDoc: true } : {}),
      ...sharedInlineConfig(),
    } as Parameters<typeof build>[0]);

    return await fs.readFile(pdfPath);
  } finally {
    await fs.rm(pdfPath, { force: true });
  }
}

/**
 * Write an inline (HTML + CSS) document into a fresh temp directory for live
 * preview. Unlike {@link buildInlinePdf} the file must persist (the preview
 * server serves it live), so the caller owns cleanup of the returned dir.
 */
export async function prepareInlineDoc(
  input: BuildInlineInput,
): Promise<{ dir: string; entry: string }> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dir = path.join(config.tmpDir, `vivlio-prev-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  const entry = path.join(dir, 'index.html');
  await fs.writeFile(entry, inlineCss(input.html, input.css ?? ''), 'utf8');
  return { dir, entry };
}

/** Inline a CSS string into an HTML document (head, body, or full wrapper). */
function inlineCss(html: string, css: string): string {
  if (!css) return html;
  const styleTag = `<style>\n${css}\n</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styleTag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${html}</body></html>`;
}
