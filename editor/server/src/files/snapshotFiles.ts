/**
 * Frozen confirm-save snapshots on disk (`data/snapshots/<historyId>.{html,css}`).
 * The 履歴(種別=edit) row indexes these (fundCode + relative filenames); the
 * frozen body lives here and is re-rendered on demand by the compare screen.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

const htmlName = (historyId: string): string => `${historyId}.html`;
const cssName = (historyId: string): string => `${historyId}.css`;

export interface SnapshotFileRefs {
  htmlFile: string;
  cssFile: string;
}

export async function writeSnapshot(
  historyId: string,
  html: string,
  css: string,
): Promise<SnapshotFileRefs> {
  await fs.mkdir(config.snapshotsDir, { recursive: true });
  await atomicWrite(path.join(config.snapshotsDir, htmlName(historyId)), html);
  await atomicWrite(path.join(config.snapshotsDir, cssName(historyId)), css);
  return { htmlFile: htmlName(historyId), cssFile: cssName(historyId) };
}

export async function readSnapshot(
  htmlFile: string | null,
  cssFile: string | null,
): Promise<{ html: string; css: string }> {
  const read = (f: string | null) =>
    f
      ? fs.readFile(path.join(config.snapshotsDir, f), 'utf8').catch(() => '')
      : Promise.resolve('');
  return { html: await read(htmlFile), css: await read(cssFile) };
}
