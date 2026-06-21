// =============================================================================
// snapshotFiles.ts — 確定保存スナップショット(凍結本体のディスク I/O)
// =============================================================================
// 確定保存(confirm-save)時に凍結(frozen)したスナップショットをディスク上に持つ
// (`data/snapshots/<historyId>.{html,css}`)。履歴(種別=edit)の行がこれらを
// 索引する(fundCode + 相対ファイル名)。凍結された本体(body)はここに置き、
// 比較画面(compare screen)が要求時に再レンダリングする。

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
