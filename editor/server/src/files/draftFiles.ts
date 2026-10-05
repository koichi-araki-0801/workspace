// =============================================================================
// draftFiles.ts — 自動保存ドラフトの作業コピー(ディスク I/O)
// =============================================================================
// 自動保存(autosave)のドラフト作業コピーをディスク上に持つ
// (`<dataRoot>/drafts/<id>.{html,css}`)。台帳(ledger)の行は保存者/タイムスタンプと
// これら相対ファイル名だけを保持し、本体(body)はここに置く。ドラフトは
// template ごとに 1 件で、autosave のたびに上書きする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertAnyTemplateId, isValidAnyTemplateId } from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

// `templateId` は request 由来のまま渡ってくる(body の `templateId` / URL の `:id`)。
// ディレクトリと連結する前にここで必ず検査する — 検査を呼び出し側へ委ねると、
// `../templates/<確定版>` を渡すだけで承認ゲートを迂回して確定ファイルを上書きできてしまう。
// 下書きはテンプレート(3 つ区切り)と値入り HTML(4 つ区切り)のどちらの id も受ける。
const htmlName = (templateId: string): string => `${assertAnyTemplateId(templateId)}.html`;
const cssName = (templateId: string): string => `${assertAnyTemplateId(templateId)}.css`;

/**
 * 台帳が持つドラフトファイル名を、drafts ディレクトリ内の実パスへ解決する。台帳の値も
 * 元をたどれば request 由来なので、`<検証済み templateId>.{html,css}` の形以外は受け付けない
 * (規約外なら null を返し、呼び出し側は「無い」として扱う)。
 */
function draftFilePath(fileName: string): string | null {
  const m = /^(.+)\.(html|css)$/.exec(fileName);
  if (!m || !isValidAnyTemplateId(m[1])) return null;
  return path.join(config.draftsDir, fileName);
}

interface DraftFileRefs {
  htmlFile: string;
  cssFile: string;
}

export async function writeDraft(
  templateId: string,
  html: string,
  css: string,
): Promise<DraftFileRefs> {
  // 検査を先に済ませてからディレクトリを作る(不正 id で drafts だけ生える副作用を避ける)。
  const htmlFile = htmlName(templateId);
  const cssFile = cssName(templateId);
  await fs.mkdir(config.draftsDir, { recursive: true });
  await atomicWrite(path.join(config.draftsDir, htmlFile), html);
  await atomicWrite(path.join(config.draftsDir, cssFile), css);
  return { htmlFile, cssFile };
}

/**
 * 下書きの HTML/CSS を読む。規約外の名前と ENOENT だけを空文字へ倒し、それ以外の読み取り失敗は
 * 例外にする — 一過性の失敗を `''` へ倒すと、空で復元された下書きが次の自動保存で上書きされる。
 */
export async function readDraft(
  htmlFile: string | null,
  cssFile: string | null,
): Promise<{ html: string; css: string }> {
  const read = (f: string | null): Promise<string> => {
    const p = f ? draftFilePath(f) : null;
    if (!p) return Promise.resolve('');
    return fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e?.code === 'ENOENT') return '';
      throw e;
    });
  };
  return { html: await read(htmlFile), css: await read(cssFile) };
}

/** template の下書き(HTML)が存在するか。台帳を引かずファイル有無で判定する。 */
export function draftExists(templateId: string): Promise<boolean> {
  const p = draftFilePath(`${templateId}.html`);
  if (!p) return Promise.resolve(false);
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** 下書き(HTML)の最終更新時刻(ISO)。無ければ(id が規約外なら)null。 */
export function draftMtime(templateId: string): Promise<string | null> {
  const p = draftFilePath(`${templateId}.html`);
  if (!p) return Promise.resolve(null);
  return fs
    .stat(p)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/**
 * 下書きの作業コピー(HTML/CSS)を破棄する。確定保存せずメニューへ戻った際に
 * 未確定の編集を消すため呼ぶ。既に無ければ no-op(`ENOENT` は握りつぶす)。
 * id が規約外なら削除する前に例外にする(任意ファイル削除の経路を塞ぐ)。
 */
export async function deleteDraft(templateId: string): Promise<void> {
  const htmlFile = htmlName(templateId);
  const cssFile = cssName(templateId);
  await Promise.all([
    fs.rm(path.join(config.draftsDir, htmlFile), { force: true }),
    fs.rm(path.join(config.draftsDir, cssFile), { force: true }),
  ]);
}

/** 下書きのある `templateId` の一覧(本体の `.html` があるもの)。規約外の名前は捨てる。 */
export async function listDraftIds(): Promise<string[]> {
  const entries = await fs.readdir(config.draftsDir).catch(() => [] as string[]);
  return entries
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.slice(0, -'.html'.length))
    .filter((id) => isValidAnyTemplateId(id));
}
