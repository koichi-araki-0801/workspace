// =============================================================================
// confirmedHtml.ts — 確定版 HTML の読み分け
// =============================================================================
// 承認が書く先は対象(`filled` = 値入り HTML / `template` = Jinja スケルトン)で別のディレクトリになる。
// 読む側も同じ対象で揃える。混ぜると値入り HTML の変更をスケルトンへ転写する(またはその逆)ことになる。

import { readFilledHtml, readTemplateHtml } from './templateFiles.js';

/** 確定版 HTML を読む。無い・規約外の名前は空文字、それ以外の読み取り失敗は例外(各 reader と同じ)。 */
export function readConfirmedHtml(
  target: 'filled' | 'template',
  fileName: string,
): Promise<string> {
  return target === 'filled' ? readFilledHtml(fileName) : readTemplateHtml(fileName);
}
