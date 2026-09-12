// =============================================================================
// templateFiles.ts — 確定 template 本体(HTML)・値入り HTML(filled)・ファンド別共有 CSS(ディスク I/O)
// =============================================================================
// 確定済み template 本体(HTML)とファンド別(per-fund)共有 CSS をディスク上に持つ。
// DB レジストリ(台帳)はメタデータのみを保持し、バイト列(本体)はここに置く。
// キーはファイル名規約 / `fundCode`(ファイルレイアウトの不変規約)。
//
// **このモジュールは読み取りとパス解決のみを持つ。** 確定ディレクトリへの書き込みは
// `repositories/confirmedWrite.ts` が唯一の実装で、書き込みプリミティブ(`atomicWrite`)を
// そちらのモジュール境界の内側へ閉じてある。書き込み関数を素の export でここへ置くと、
// 承認ゲートを通らない呼び出し元
// (生成ルート・ペア同期)が直接確定ファイルを書ける。「唯一の関所」を doc comment
// でなくモジュール境界で強制するのが本構成の目的。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertFundCode, assertTemplateFileName } from '@editor/shared';
import { config } from '../config.js';

// パス検査はこの 2 つの解決関数に内蔵する。呼び出し側(ルート・リポジトリ・同期)ごとに
// 検査を置くと必ずどこかで漏れるため、ディレクトリと連結する唯一の場所で強制する。
// 名前は request 由来のまま渡ってくる前提で読むこと。
// export しているが、これ単体では 1 バイトも書けない(純粋なパス解決 + 検査)。
export const templatePath = (fileName: string): string =>
  path.join(config.templatesDir, assertTemplateFileName(fileName));
export const cssPath = (fundCode: string): string =>
  path.join(config.cssDir, `${assertFundCode(fundCode)}.css`);
/**
 * 値入り HTML(`filledDir`)の解決子。`templatePath` と同じく名前検査を内蔵し、書込側
 * (`confirmedWrite.ts`)だけが使う。読み取りは下の `readFilledHtml` 等を通す。
 */
export const filledPath = (fileName: string): string =>
  path.join(config.filledDir, assertTemplateFileName(fileName));

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
const filledPathOrNull = (fileName: string): string | null => {
  try {
    return filledPath(fileName);
  } catch {
    return null;
  }
};

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

/**
 * テンプレート本体を読む。`readFundCss` と同方針で、**規約外の名前(解決できない)と
 * ENOENT(まだ確定していないテンプレ)だけを空文字へ倒し、解決できたパスのそれ以外の
 * 読み取り失敗は例外にする。** 読んだ値は実行コード不変性の基準
 * (`confirmedWrite.baselineTemplateHtml`)やペア同期の入力になるため、EACCES / EBUSY /
 * EISDIR を `''` へ倒すと「本文が空」を前提に後段が進む。
 */
export function readTemplateHtml(fileName: string): Promise<string> {
  const p = templatePathOrNull(fileName);
  if (!p) return Promise.resolve('');
  return fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
}
/**
 * ファンド共有 CSS を読む。**規約外の名前(解決できない)だけを空文字へ倒し、解決できた
 * パスの読み取り失敗は例外にする。** 読んだ値をそのまま書き戻す経路が実在するため、
 * EACCES / EBUSY / EMFILE を `''` へ倒すと一過性の I/O 障害で共有 CSS を空にできてしまう。
 * `reviewFiles.ts` の `readReview` と同方針(あちらも「空文字へ倒すと本番テンプレートを
 * 空内容で上書きしてしまうため必ずエラーにする」と書いている)。
 * ENOENT だけは「まだ CSS が無いファンド」という正常状態なので `''` を返す。
 */
export function readFundCss(fundCode: string): Promise<string> {
  const p = cssPathOrNull(fundCode);
  if (!p) return Promise.resolve('');
  return fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
}

// ── filled/(値入り HTML)。templates/ と同じ規約で、置き場だけが違う ──

/** 値入り HTML の `*.html` 一覧(編集タブの一覧はここが源)。 */
export async function listFilledFiles(): Promise<string[]> {
  const entries = await fs.readdir(config.filledDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.html'));
}

/** 値入り HTML の最終更新時刻(ISO)。無ければ(名前が規約外なら)null。 */
export function filledMtime(fileName: string): Promise<string | null> {
  const p = filledPathOrNull(fileName);
  if (!p) return Promise.resolve(null);
  return fs
    .stat(p)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}

/** 値入り HTML が存在するか(名前が規約外なら false)。 */
export function filledExists(fileName: string): Promise<boolean> {
  const p = filledPathOrNull(fileName);
  if (!p) return Promise.resolve(false);
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * 値入り HTML を読む。`readTemplateHtml` と同方針で、規約外の名前と ENOENT だけを
 * 空文字へ倒し、それ以外の読み取り失敗は例外にする(承認の基準と履歴の入力になるため)。
 */
export function readFilledHtml(fileName: string): Promise<string> {
  const p = filledPathOrNull(fileName);
  if (!p) return Promise.resolve('');
  return fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
}
