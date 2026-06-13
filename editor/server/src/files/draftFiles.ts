/**
 * Autosave draft working copies on disk (`data/drafts/<id>.{html,css}`). The
 * 台帳 row stores only the saver/timestamp + these relative filenames; the
 * body lives here. Draft is 1-per-template, overwritten on each autosave.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

const htmlName = (templateId: string): string => `${templateId}.html`;
const cssName = (templateId: string): string => `${templateId}.css`;

export interface DraftFileRefs {
  htmlFile: string;
  cssFile: string;
}

export async function writeDraft(
  templateId: string,
  html: string,
  css: string,
): Promise<DraftFileRefs> {
  await fs.mkdir(config.draftsDir, { recursive: true });
  await atomicWrite(path.join(config.draftsDir, htmlName(templateId)), html);
  await atomicWrite(path.join(config.draftsDir, cssName(templateId)), css);
  return { htmlFile: htmlName(templateId), cssFile: cssName(templateId) };
}

export async function readDraft(
  htmlFile: string | null,
  cssFile: string | null,
): Promise<{ html: string; css: string }> {
  const read = (f: string | null) =>
    f ? fs.readFile(path.join(config.draftsDir, f), 'utf8').catch(() => '') : Promise.resolve('');
  return { html: await read(htmlFile), css: await read(cssFile) };
}
