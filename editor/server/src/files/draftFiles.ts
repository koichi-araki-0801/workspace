// =============================================================================
// draftFiles.ts — 自動保存ドラフトの作業コピー(ディスク I/O)
// =============================================================================
// 自動保存(autosave)のドラフト作業コピーをディスク上に持つ
// (`data/drafts/<id>.{html,css}`)。台帳(ledger)の行は保存者/タイムスタンプと
// これら相対ファイル名だけを保持し、本体(body)はここに置く。ドラフトは
// template ごとに 1 件で、autosave のたびに上書きする。

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

/** template の下書き(HTML)が存在するか。台帳を引かずファイル有無で判定する。 */
export function draftExists(templateId: string): Promise<boolean> {
  return fs
    .stat(path.join(config.draftsDir, htmlName(templateId)))
    .then(() => true)
    .catch(() => false);
}

/** 下書き(HTML)の最終更新時刻(ISO)。無ければ null。 */
export function draftMtime(templateId: string): Promise<string | null> {
  return fs
    .stat(path.join(config.draftsDir, htmlName(templateId)))
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/**
 * 下書きの作業コピー(HTML/CSS)を破棄する。確定保存せずメニューへ戻った際に
 * 未確定の編集を消すため呼ぶ。既に無ければ no-op(`ENOENT` は握りつぶす)。
 */
export async function deleteDraft(templateId: string): Promise<void> {
  await Promise.all([
    fs.rm(path.join(config.draftsDir, htmlName(templateId)), { force: true }),
    fs.rm(path.join(config.draftsDir, cssName(templateId)), { force: true }),
  ]);
}
