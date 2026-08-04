// =============================================================================
// pendingFiles.ts — 新規生成テンプレの未確定(pending)実体(ディスク I/O)
// =============================================================================
// `POST /api/generate` の成果物を置く場所(`pending/<id>.{html,css}`、git 管理外)。
// 確定ディレクトリ(templatesDir)へは生成経路から一切書かないという不変則の受け皿で、
// 確定への昇格は承認(`repositories/confirmedWrite.ts`)だけが行う。
//
// pending の内容が確定へ流れる経路は「人が編集して申請 → 承認」以外に無い。
// 「承認時に pending が在ればそれを使う」といった最適化を足すと、そこが承認ゲートを
// 迂回する第 2 経路になるので入れないこと。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertTemplateId, isValidTemplateId } from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

// `templateId` は request 由来のまま渡ってくる。ディレクトリと連結する前にここで必ず
// 検査する — 検査を呼び出し側へ委ねると `../templates/<確定版>` を渡すだけで承認ゲートを
// 迂回して確定ファイルを書ける(`draftFiles.ts` が同じ経緯を記録している)。
const htmlName = (templateId: string): string => `${assertTemplateId(templateId)}.html`;
const cssName = (templateId: string): string => `${assertTemplateId(templateId)}.css`;

/** 規約外の名前は null を返し、読み取り側は「無い」として扱う(書き込み系は例外にする)。 */
function pendingPathOrNull(templateId: string, ext: 'html' | 'css'): string | null {
  if (!isValidTemplateId(templateId)) return null;
  return path.join(config.pendingDir, `${templateId}.${ext}`);
}

export async function writePending(templateId: string, html: string, css: string): Promise<void> {
  // 検査を先に済ませてからディレクトリを作る(不正 id で pending だけ生える副作用を避ける)。
  const htmlFile = htmlName(templateId);
  const cssFile = cssName(templateId);
  await fs.mkdir(config.pendingDir, { recursive: true });
  await atomicWrite(path.join(config.pendingDir, htmlFile), html);
  await atomicWrite(path.join(config.pendingDir, cssFile), css);
}

export async function readPending(
  templateId: string,
): Promise<{ html: string; css: string } | null> {
  const htmlPath = pendingPathOrNull(templateId, 'html');
  if (!htmlPath) return null;
  const html = await fs.readFile(htmlPath, 'utf8').catch(() => null);
  if (html === null) return null;
  const cssPath = pendingPathOrNull(templateId, 'css');
  const css = cssPath ? await fs.readFile(cssPath, 'utf8').catch(() => '') : '';
  return { html, css };
}

/**
 * pending 実体の `templateId` 一覧。編集タブの一覧はここを確定分と合成する — 混ぜないと
 * 生成直後のテンプレが検索に出ず、id を知る術が UI から消える(作成タブは生成後に
 * `/edit/:id` へ 1 回遷移するだけで、履歴タブは遷移経路を持たない)。
 * 規約外の名前は捨てる(`pendingDir` は git 管理外で、手で置かれた物が混ざりうる)。
 */
export async function listPendingIds(): Promise<string[]> {
  const entries = await fs.readdir(config.pendingDir).catch(() => [] as string[]);
  return entries
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.slice(0, -'.html'.length))
    .filter((id) => isValidTemplateId(id));
}

export function pendingExists(templateId: string): Promise<boolean> {
  const p = pendingPathOrNull(templateId, 'html');
  if (!p) return Promise.resolve(false);
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

export function pendingMtime(templateId: string): Promise<string | null> {
  const p = pendingPathOrNull(templateId, 'html');
  if (!p) return Promise.resolve(null);
  return fs
    .stat(p)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/** 承認で確定へ昇格した後の後始末。既に無ければ no-op。id が規約外なら例外にする。 */
export async function deletePending(templateId: string): Promise<void> {
  const htmlFile = htmlName(templateId);
  const cssFile = cssName(templateId);
  await Promise.all([
    fs.rm(path.join(config.pendingDir, htmlFile), { force: true }),
    fs.rm(path.join(config.pendingDir, cssFile), { force: true }),
  ]);
}
