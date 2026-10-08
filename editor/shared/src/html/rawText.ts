// =============================================================================
// rawText.ts — raw text 要素(中身をタグとして読まない要素)の終わり探し
// =============================================================================
// 終わりの規則はブラウザの字句解析と同じで、走査器ごとに変えてはならない。片方だけ緩めると、
// 緩めた側が `</scriptx>` などで早く閉じ、もう片方と違う本文を読む(関所なら見落としになる)。
// どの要素を raw text と見るかは走査器ごとに違ってよい(`inlineCss.ts` は加工を諦める向きへ倒すため
// 10 要素、`templateScripts.ts` は読み飛ばした中身を必ず単位化するため 2 要素)ので、集合は
// 共有できる走査器だけが `RAW_TEXT_ELEMENTS` を使う。部品の一覧は `html/htmlLex.ts` の冒頭。

import { isHtmlSpace } from './htmlLex.js';

/**
 * 中身を文字データとして読む要素(HTML の RAWTEXT / RCDATA のうち、テンプレに現れるもの)。
 * `security/editingMarkers.ts`、`server/src/sync/partSync.ts`、`web/src/lib/htmlScan.ts`、
 * `web/src/lib/templateDoc.ts` が使う。
 */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'textarea',
  'title',
]);

/**
 * ASCII の英大文字だけを小文字にした写し。長さも各文字の位置も原文と同じになる。ブラウザの
 * 字句解析もタグ名を ASCII だけで小文字にする。
 *
 * ⚠ `findRawTextEnd` へ渡す写しは必ずこれで作る。`toLowerCase` は `İ`(U+0130)を 2 単位へ伸ばす
 * ので、その写しの上の位置を原文の位置として使うと、`İ` 1 つにつき 1 文字ずつ後ろへずれる。
 * raw text の終わりを本物の閉じタグより後ろと読み、その間の本物のタグを見落とす(関所の迂回)。
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** `findRawTextEnd` の結果。`scanned` は探すのに読んだ文字数で、作業量の予算に数える。 */
interface RawTextEnd {
  at: number;
  scanned: number;
}

/**
 * `lower` の `from` 以降で、raw text 要素 `name`(小文字)を閉じる `</name` の `<` の位置を返す。
 * 無ければ `at` は -1。閉じタグと見るのは `</name` の直後が空白・`/`・`>`・入力の終わりのときだけ。
 *
 * ⚠ `lower`(入力全体を `asciiLower` で小文字にした写し)は呼び出し側が走査 1 回につき 1 回だけ
 * 作って渡す。
 * ここで作ると raw text の開始タグ 1 つごとに入力全体を写し、`<title></title>` の反復で
 * 同期区間が止まる(`server/test/scanQuadratic.guard.test.ts` が機械検査する)。
 */
export function findRawTextEnd(lower: string, name: string, from: number): RawTextEnd {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    const after = lower[at + needle.length];
    if (after === undefined || isHtmlSpace(after) || after === '/' || after === '>')
      return { at, scanned: at + needle.length - from };
    at = lower.indexOf(needle, at + needle.length);
  }
  return { at: -1, scanned: Math.max(0, lower.length - from) };
}
