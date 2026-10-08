// =============================================================================
// htmlLex.ts — HTML の字句解析の小さな部品(文字の分類・コメントの終わり・属性 1 つ)
// =============================================================================
// タグを読む走査器は 5 本あり、用途ごとに失敗時の倒し方が違うので 1 本にはしない
// (`docs/editor/src/設計正典.md` の「HTML の走査器を 1 本にしない理由」)。共有するのは、どの
// 走査器でもブラウザと同じ答えになるべき部品だけで、ここに置く。raw text の終わり探しは
// `html/rawText.ts`。使う側: `security/editingMarkers.ts`、`server/src/vivliostyle/inlineCss.ts`、
// `server/src/security/templateScripts.ts`、`server/src/sync/partSync.ts`、`web/src/lib/htmlScan.ts`。
// 部品の意味を変えると 5 本の判定が同時に動くので、ブラウザの字句解析と違う向きへは変えない。

/** HTML の空白(TAB / LF / FF / CR / SP)。`\s` は NBSP なども含み、ブラウザと読みがずれる。 */
export function isHtmlSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** ASCII の英字。タグ名の 1 文字目になれるのはこれだけ(`<1` や `<é` はテキスト)。 */
export function isAsciiAlpha(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}

/**
 * タグ名の終わり。タグ名の状態は空白・`/`・`>` でしか終わらない。`=` を含めると `<style=x>` を
 * `style` と読み、ブラウザが未知要素として読む中身を raw text として読み飛ばしてしまう。
 * 属性名は `=` でも終わるので、属性名の終わりにこれを流用しない(`readAttr` が別に持つ)。
 */
export function isTagNameEnd(c: string | undefined): boolean {
  return isHtmlSpace(c) || c === '/' || c === '>';
}

/**
 * `commentEnd` が閉じ方ごとに覚える直近の検索結果。-2 は未検索、-1 は「以後に無い」。走査 1 回に
 * つき 1 つ作り、その走査のコメントすべてに渡す。覚えないと、片方の閉じ方が後ろに無い入力で
 * コメントごとに末尾まで読み直し、入力長の 2 乗になる。
 */
export interface CommentEndMemo {
  dash: number;
  bang: number;
}

export function newCommentEndMemo(): CommentEndMemo {
  return { dash: -2, bang: -2 };
}

/**
 * `<!--` の直後(`from`)から、コメントを閉じる位置の次を返す。閉じなければ -1。閉じ方は
 * `-->` / `--!>` / `<!-->` / `<!--->` で、ブラウザと同じ。閉じないときに走査を打ち切るか末尾まで
 * コメントとみなすかは走査器ごとに違うので、-1 のまま返して呼び出し側に決めさせる。
 */
export function commentEnd(src: string, from: number, memo: CommentEndMemo): number {
  if (src.startsWith('>', from)) return from + 1;
  if (src.startsWith('->', from)) return from + 2;
  if (memo.dash !== -1 && memo.dash < from) memo.dash = src.indexOf('-->', from);
  if (memo.bang !== -1 && memo.bang < from) memo.bang = src.indexOf('--!>', from);
  const { dash, bang } = memo;
  if (dash === -1 && bang === -1) return -1;
  if (bang === -1 || (dash !== -1 && dash < bang)) return dash + 3;
  return bang + 4;
}

/** `readAttr` の結果。`value` は `=` が無ければ null、引用符を外した原文で実体参照は解かない。 */
interface ReadAttrResult {
  name: string;
  value: string | null;
  next: number;
}

/**
 * 開始タグの属性を `src[i]` から 1 つ読む。`i` は `end` より前で、空白・`/`・`>` でない位置。
 * HTML の属性名・属性名の後・属性値の前の状態を写し、引用符を値の区切りと見るのは `=` の直後
 * だけにする(名前や裸の値の途中の `"` `'` は普通の文字)。先頭の 1 文字は `=` でも名前に含める
 * ので、`next` は必ず `i` より先へ進む。名前は小文字にする。裸の値は空白か `>` で終わり、閉じない
 * 引用符は `end` まで読む。`=` が無いときの `next` は名前の後の空白を読み飛ばした位置。
 */
export function readAttr(src: string, i: number, end: number): ReadAttrResult {
  const start = i;
  let k = i + 1;
  while (k < end) {
    const c = src[k];
    if (isHtmlSpace(c) || c === '/' || c === '=' || c === '>') break;
    k++;
  }
  const name = src.slice(start, k).toLowerCase();
  while (k < end && isHtmlSpace(src[k])) k++;
  if (k >= end || src[k] !== '=') return { name, value: null, next: k };
  k++;
  while (k < end && isHtmlSpace(src[k])) k++;
  const quote = k < end ? src[k] : undefined;
  if (quote === '"' || quote === "'") {
    const close = src.indexOf(quote, k + 1);
    if (close === -1 || close >= end) return { name, value: src.slice(k + 1, end), next: end };
    return { name, value: src.slice(k + 1, close), next: close + 1 };
  }
  const valueStart = k;
  while (k < end && !isHtmlSpace(src[k]) && src[k] !== '>') k++;
  return { name, value: src.slice(valueStart, k), next: k };
}
