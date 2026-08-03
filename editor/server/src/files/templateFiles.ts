// =============================================================================
// templateFiles.ts — 確定 template 本体(HTML)とファンド別共有 CSS(ディスク I/O)
// =============================================================================
// 確定済み template 本体(HTML)とファンド別(per-fund)共有 CSS をディスク上に持つ。
// DB レジストリ(台帳)はメタデータのみを保持し、バイト列(本体)はここに置く。
// キーはファイル名規約 / `fundCode`(phase 1 のファイルレイアウトから不変)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertFundCode, assertTemplateFileName } from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

// パス検査はこの 2 つの解決関数に内蔵する。呼び出し側(ルート・リポジトリ・同期)ごとに
// 検査を置くと必ずどこかで漏れるため、ディレクトリと連結する唯一の場所で強制する。
// 名前は request 由来のまま渡ってくる前提で読むこと。
const templatePath = (fileName: string): string =>
  path.join(config.templatesDir, assertTemplateFileName(fileName));
const cssPath = (fundCode: string): string =>
  path.join(config.cssDir, `${assertFundCode(fundCode)}.css`);

/**
 * 読み取り・存在確認向けの解決。規約外の名前は例外にせず null を返し、呼び出し側が
 * 「無い」として扱えるようにする。ベストエフォートの経路(ペア同期・メタ組み立て)を
 * 不正入力 1 件で落とさないため。書き込み系は上の 2 つを直接使い、必ず例外にする。
 */
const templatePathOrNull = (fileName: string): string | null => {
  try {
    return templatePath(fileName);
  } catch {
    return null;
  }
};
const cssPathOrNull = (fundCode: string): string | null => {
  try {
    return cssPath(fundCode);
  } catch {
    return null;
  }
};

/** 確定済みテンプレートの `*.html` 一覧(台帳ではなくディレクトリ走査が一覧の源)。 */
export async function listTemplateFiles(): Promise<string[]> {
  const entries = await fs.readdir(config.templatesDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.html'));
}

/** テンプレート本体ファイルの最終更新時刻(ISO)。無ければ(名前が規約外なら)null。 */
export function templateMtime(fileName: string): Promise<string | null> {
  const p = templatePathOrNull(fileName);
  if (!p) return Promise.resolve(null);
  return fs
    .stat(p)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/** テンプレート本体ファイルが存在するか(名前が規約外なら false)。 */
export function templateExists(fileName: string): Promise<boolean> {
  const p = templatePathOrNull(fileName);
  if (!p) return Promise.resolve(false);
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

export function readTemplateHtml(fileName: string): Promise<string> {
  const p = templatePathOrNull(fileName);
  if (!p) return Promise.resolve('');
  return fs.readFile(p, 'utf8').catch(() => '');
}
export function readFundCss(fundCode: string): Promise<string> {
  const p = cssPathOrNull(fundCode);
  if (!p) return Promise.resolve('');
  return fs.readFile(p, 'utf8').catch(() => '');
}

/** 確定保存(confirm-save)失敗時にロールバックできるよう、現在のバイト列を読む。 */
export async function snapshotCurrent(
  fileName: string,
  fundCode: string,
): Promise<{ html: string | null; css: string | null }> {
  const read = (p: string | null) =>
    p === null
      ? Promise.resolve(null)
      : fs
          .readFile(p, 'utf8')
          .then((s) => s as string | null)
          .catch(() => null);
  return {
    html: await read(templatePathOrNull(fileName)),
    css: await read(cssPathOrNull(fundCode)),
  };
}

export async function writeTemplateAndCss(
  fileName: string,
  html: string,
  fundCode: string,
  css: string,
): Promise<void> {
  // 先に両方のパスを解決する。不正な名前でディレクトリだけ作られる(片方書けて片方落ちる)
  // 中途半端な状態を避けるため、副作用の前に検査を済ませる。
  const htmlPath = templatePath(fileName);
  const stylePath = cssPath(fundCode);
  await fs.mkdir(config.templatesDir, { recursive: true });
  await fs.mkdir(config.cssDir, { recursive: true });
  await atomicWrite(htmlPath, html);
  await atomicWrite(stylePath, css);
}

/**
 * テンプレ本体だけの単ファイル書込。ペア同期(`pairSyncService.ts`)が転写結果を書く経路で、
 * CSS はファンド単位共有(ペアの双方が同一ファイル)のため触らない。
 */
export async function writeTemplateHtml(fileName: string, html: string): Promise<void> {
  const htmlPath = templatePath(fileName);
  await fs.mkdir(config.templatesDir, { recursive: true });
  await atomicWrite(htmlPath, html);
}

/** 先に読んだバイト列を復元する(DB コミット失敗時の補償 = compensation)。 */
export async function restoreTemplateAndCss(
  fileName: string,
  fundCode: string,
  prev: { html: string | null; css: string | null },
): Promise<void> {
  if (prev.html !== null) await atomicWrite(templatePath(fileName), prev.html);
  if (prev.css !== null) await atomicWrite(cssPath(fundCode), prev.css);
}
