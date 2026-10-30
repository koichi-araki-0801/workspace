// =============================================================================
// reviewableSource.ts — 作成経路の受付で、承認画面と本番で読みが割れる Jinja 原文を見つける
// =============================================================================
// server は作成経路の申請を受けるとき、Jinja 原文を全部の枝を描く形(`fillRender.ts` の reveal)で描き、
// 承認画面に見せる。本番は条件に合う枝だけを、本番の値で描く。HTML の区切り(コメント・タグ・raw text)
// を Jinja のトークンの前後でつなぐと、全部の枝を連結した承認画面の姿と、採った枝だけを連結した本番の
// 姿で読みが割れ、承認画面に出ない本文が本番だけに出る(`<!-{% if false %}-{% endif %}` など)。形を
// 数え上げて塞ぐと必ず漏れるので(設計正典の却下済み設計)、文脈に依らない制約で上から閉じる。
//   1. すべての Jinja のトークンは、地の文で、読みかけの区切りが無い位置にだけ置く。出力の式
//      `{{ }}` だけは、引用符付きの属性値の中と、RCDATA(`title` `textarea`)の中も許す。
//   2. 空白の刈り込み記号(`{%-` `-%}` `{{-` `-}}` `{#-` `-#}` と `+` の形)を使わない。本番の
//      trim_blocks / lstrip_blocks は分からないが、1 でトークンの両側を地の文に限るので、改行が
//      消えてもつながる区切りは無い。
//   3. raw text・RCDATA の要素(script を除く)の中身に、自分の閉じタグ以外の `<` を置かない。
//      外来要素(svg・math)の中で raw text として読まれない場合や、scripting の有無で読みが変わる
//      `noscript` でも、中身にマークアップが無ければ読みは割れない。`<![CDATA[` と `<plaintext` は
//      置かない。script の中身は不変ゲートが基準と突き合わせる(変えられない)が、外来要素の中では
//      マークアップとして読まれるので、原文の上で svg / math が開いている間(分岐の両側を合わせて
//      数える。閉じが無ければ末尾まで)の `<script` を止める。数える `<` は地の文の字面だけ。
//   4. 分岐・反復(if / elif / else / for / for の else)の本体の中で `set` しない。値の流れは追わない
//      (別名・for の変数・namespace の同一性で抜けるため)。
//   6. 文書(テンプレート)は「空白・コメント・doctype → `<html>` → `<head>`(title・meta・link・
//      style・script・base とコメント・空白だけ)→ `</head>` → `<body>` … `</body>` → `</html>` →
//      空白・コメント」の骨格にする。本文の外(head の中を含む)には本文も Jinja も置かず、本文の中に
//      `<html` `<head` `<body` を開き閉じしない。承認画面は DOM の body だけを見せるため。head の
//      meta・title・style・link は、呼び出し側が基準と同じ並びか確かめる(`headFixedSources`。meta の
//      charset を変えると、本番だけ別の文字コードで読まれる)。原文に C0 の制御文字(TAB・LF・CR・FF
//      以外)を置かない(ISO-2022-JP のエスケープ列などで、文字コードしだいで区切りが生まれる)。
// この制約は、不変ゲート(`server/src/security/templateScripts.ts`)の要素の許可リスト(`iframe`
// `noscript` `math` `template` などを単位にする)とあわせて成り立つ。許可リストを広げるときは raw text の
// 扱いを同時に見直す。走査は HTML の字句解析の状態機械の部分集合で、Jinja のトークン(式・文・コメント・
// `raw` の開閉)は状態を進めずに読み飛ばし、`raw` の中身は地の文として読む。部品は `html/htmlLex.ts`
// と同じく、ブラウザと同じ答えになる向きで持つ(設計正典の却下済み設計「HTML の走査器を 1 本に
// まとめる」)。

import { type JinjaToken, lexJinja } from './jinjaLex.js';
import { type JinjaNode, parseJinja } from './jinjaTree.js';

/** 見つけた違反の種類。文言は `reviewableIssueMessage`。 */
export type ReviewableIssueCode =
  | 'token-position'
  | 'trim-marker'
  | 'raw-markup'
  | 'cdata-plaintext'
  | 'foreign-script'
  | 'set-in-branch'
  | 'skeleton'
  | 'control-char';

export interface ReviewableIssue {
  readonly code: ReviewableIssueCode;
  /** 原文の位置。 */
  readonly at: number;
}

const RAW_MARKUP_MESSAGE =
  '<style>・<title>・<textarea> などの中に < を書いているか、<![CDATA[・<plaintext>・svg / math の' +
  '中の <script> を使っているため、承認画面で正しく表示できません';

const MESSAGES: Readonly<Record<ReviewableIssueCode, string>> = {
  'token-position':
    'Jinja の差し込み・分岐・コメントを、タグ・コメント・<style> などの途中に置いているため、' +
    '承認画面で正しく表示できません。外へ出してください',
  'trim-marker': 'Jinja の空白の刈り込み記号（{%- や -%} など）は使えません。外してください',
  'raw-markup': RAW_MARKUP_MESSAGE,
  'cdata-plaintext': RAW_MARKUP_MESSAGE,
  'foreign-script': RAW_MARKUP_MESSAGE,
  'set-in-branch':
    'Jinja の分岐・繰り返し（{% if %}・{% for %}）の中では {% set %} を使えません。' +
    '分岐の外で値を決めてください',
  'control-char':
    '本文に制御文字（TAB・改行・改ページ以外）が入っているため、承認画面と本番で読みが変わる' +
    'おそれがあります。取り除いてください',
  skeleton:
    'テンプレートの骨格（<html>・<head>・<body>）の外や <head> の中に本文や差し込みを置いて' +
    'いるため、承認画面に出せません。本文は <body> の中に置いてください',
};

/** 違反の種類ごとの 400 の文言。 */
export function reviewableIssueMessage(code: ReviewableIssueCode): string {
  return MESSAGES[code];
}

/** 先頭の BOM(U+FEFF)を 1 文字だけ外す。検査と承認画面の描画は外した原文に掛ける。 */
export function stripLeadingBom(src: string): string {
  return src.startsWith('\uFEFF') ? src.slice(1) : src;
}

// ── 1. 字句の状態機械 ──

/** 中身を文字として読む要素。RCDATA は文字参照を解くが、マークアップは読まない。 */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const RCDATA = new Set(['title', 'textarea']);
/** 中で script の中身がマークアップとして読まれる外来要素。 */
const FOREIGN = new Set(['svg', 'math']);

type State =
  | 'DATA'
  | 'TAG_OPEN'
  | 'END_TAG_OPEN'
  | 'MARKUP_DECL'
  | 'MARKUP_DASH'
  | 'COMMENT_START'
  | 'COMMENT_START_DASH'
  | 'COMMENT'
  | 'COMMENT_END_DASH'
  | 'COMMENT_END'
  | 'COMMENT_END_BANG'
  | 'BOGUS'
  | 'DOCTYPE'
  | 'TAG_NAME'
  | 'BEFORE_ATTR'
  | 'ATTR_NAME'
  | 'AFTER_ATTR_NAME'
  | 'BEFORE_VALUE'
  | 'VALUE_DQ'
  | 'VALUE_SQ'
  | 'VALUE_UQ'
  | 'AFTER_VALUE'
  | 'SELF_CLOSING'
  | 'RAW';

/** 骨格の検査と head の原文に使う字句の出来事。 */
type LexEvent =
  | { t: 'start' | 'end'; name: string; at: number; end: number }
  | {
      t: 'rawEnd';
      name: string;
      /** 中身の範囲 `[start, end)`。 */
      start: number;
      end: number;
      /** 外来要素(svg・math)の中で開いたか。そこでは中身がマークアップとして読まれる。 */
      foreign: boolean;
    }
  | { t: 'comment' | 'doctype'; at: number }
  | { t: 'text'; at: number }
  | { t: 'token'; at: number };

const isAlpha = (c: string | undefined) =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isTrimmed = (t: JinjaToken) =>
  t.trimLeft || t.trimRight || /^\{[{%#]\+/.test(t.source) || /\+[}%#]\}$/.test(t.source);

interface LexResult {
  issues: ReviewableIssue[];
  events: LexEvent[];
}

/** 原文を前から読み、制約 1〜3 の違反と、骨格の検査に使う出来事を返す。 */
function lex(src: string, tokens: readonly JinjaToken[]): LexResult {
  const issues: ReviewableIssue[] = [];
  const events: LexEvent[] = [];
  const lower = src.toLowerCase();
  let st = 'DATA' as State;
  let name = '';
  let isEnd = false;
  let selfClosing = false;
  let tagAt = 0;
  /** raw text・RCDATA の要素の名前と、中身の地の文の `<` の位置(閉じタグの `<` を除く)。 */
  let raw = '';
  let rawStart = 0;
  let rawForeign = false;
  let rawLt: number[] = [];
  /** RCDATA・raw text の中身で、直前の地の文が `<` か `</` に英字の続く読みかけか。 */
  let rawPending = false;
  let foreignDepth = 0;
  let ti = 0;

  const emitTag = (end: number) => {
    events.push({ t: isEnd ? 'end' : 'start', name, at: tagAt, end });
    if (isEnd) {
      if (FOREIGN.has(name)) foreignDepth = Math.max(0, foreignDepth - 1);
      st = 'DATA';
      return;
    }
    if (name === 'plaintext') issues.push({ code: 'cdata-plaintext', at: tagAt });
    if (name === 'script' && foreignDepth > 0) issues.push({ code: 'foreign-script', at: tagAt });
    if (FOREIGN.has(name) && !selfClosing) foreignDepth++;
    if (!selfClosing && (RAW_TEXT.has(name) || RCDATA.has(name))) {
      st = 'RAW';
      raw = name;
      rawStart = end;
      rawForeign = foreignDepth > 0;
      rawLt = [];
      rawPending = false;
      return;
    }
    st = 'DATA';
  };

  /** 地の文の文字の出来事は、続く文字を 1 つにまとめる(骨格の検査は有無と最初の位置だけを見る)。 */
  const pushText = (at: number) => {
    if (events.at(-1)?.t !== 'text') events.push({ t: 'text', at });
  };

  const finishRaw = (closeAt: number) => {
    if (raw !== 'script') for (const at of rawLt) issues.push({ code: 'raw-markup', at });
    events.push({ t: 'rawEnd', name: raw, start: rawStart, end: closeAt, foreign: rawForeign });
  };

  let i = 0;
  while (i <= src.length) {
    // Jinja のトークンは状態を進めずに読み飛ばす(`raw` の中身はトークンではないので地の文として読む)。
    if (ti < tokens.length && tokens[ti].start === i) {
      const t = tokens[ti++];
      if (isTrimmed(t)) issues.push({ code: 'trim-marker', at: t.start });
      const ok =
        st === 'DATA' ||
        (t.kind === 'output' &&
          (st === 'VALUE_DQ' ||
            st === 'VALUE_SQ' ||
            (st === 'RAW' && RCDATA.has(raw) && !rawPending)));
      if (!ok) issues.push({ code: 'token-position', at: t.start });
      if (st === 'DATA') events.push({ t: 'token', at: t.start });
      i = t.end;
      continue;
    }
    if (i >= src.length) break;
    const c = src[i];
    if (st === 'RAW') {
      if (c === '<') {
        const needle = `</${raw}`;
        const after = src[i + needle.length];
        if (
          lower.startsWith(needle, i) &&
          (after === undefined || isSpace(after) || after === '/' || after === '>')
        ) {
          finishRaw(i);
          st = 'TAG_OPEN';
          tagAt = i;
          i++;
          continue;
        }
        rawLt.push(i);
        rawPending = true;
      } else if (rawPending && !(c === '/' || isAlpha(c))) rawPending = false;
      i++;
      continue;
    }
    let again = true;
    while (again) {
      again = false;
      switch (st) {
        case 'DATA':
          if (c === '<') {
            st = 'TAG_OPEN';
            tagAt = i;
          } else if (!isSpace(c)) pushText(i);
          break;
        case 'TAG_OPEN':
          if (c === '!') st = 'MARKUP_DECL';
          else if (c === '/') st = 'END_TAG_OPEN';
          else if (c === '?') st = 'BOGUS';
          else if (isAlpha(c)) {
            st = 'TAG_NAME';
            name = c.toLowerCase();
            isEnd = false;
            selfClosing = false;
          } else {
            // `<` の後が英字でなければ文字の `<`。
            pushText(tagAt);
            st = 'DATA';
            again = true;
          }
          break;
        case 'END_TAG_OPEN':
          if (isAlpha(c)) {
            st = 'TAG_NAME';
            name = c.toLowerCase();
            isEnd = true;
            selfClosing = false;
          } else if (c === '>') st = 'DATA';
          else st = 'BOGUS';
          break;
        case 'MARKUP_DECL':
          if (c === '-') st = 'MARKUP_DASH';
          else if (src.startsWith('[CDATA[', i)) {
            issues.push({ code: 'cdata-plaintext', at: tagAt });
            st = 'BOGUS';
          } else if (lower.startsWith('doctype', i)) st = 'DOCTYPE';
          else {
            st = 'BOGUS';
            again = true;
          }
          break;
        case 'MARKUP_DASH':
          if (c === '-') st = 'COMMENT_START';
          else {
            st = 'BOGUS';
            again = true;
          }
          break;
        case 'COMMENT_START':
          if (c === '-') st = 'COMMENT_START_DASH';
          else if (c === '>') {
            events.push({ t: 'comment', at: tagAt });
            st = 'DATA';
          } else {
            st = 'COMMENT';
            again = true;
          }
          break;
        case 'COMMENT_START_DASH':
          if (c === '-') st = 'COMMENT_END';
          else if (c === '>') {
            events.push({ t: 'comment', at: tagAt });
            st = 'DATA';
          } else st = 'COMMENT';
          break;
        case 'COMMENT':
          if (c === '-') st = 'COMMENT_END_DASH';
          break;
        case 'COMMENT_END_DASH':
          st = c === '-' ? 'COMMENT_END' : 'COMMENT';
          break;
        case 'COMMENT_END':
          if (c === '>') {
            events.push({ t: 'comment', at: tagAt });
            st = 'DATA';
          } else if (c === '!') st = 'COMMENT_END_BANG';
          else if (c !== '-') st = 'COMMENT';
          break;
        case 'COMMENT_END_BANG':
          if (c === '-') st = 'COMMENT_END_DASH';
          else if (c === '>') {
            events.push({ t: 'comment', at: tagAt });
            st = 'DATA';
          } else st = 'COMMENT';
          break;
        case 'BOGUS':
          if (c === '>') {
            events.push({ t: 'comment', at: tagAt });
            st = 'DATA';
          }
          break;
        case 'DOCTYPE':
          if (c === '>') {
            events.push({ t: 'doctype', at: tagAt });
            st = 'DATA';
          }
          break;
        case 'TAG_NAME':
          if (isSpace(c)) st = 'BEFORE_ATTR';
          else if (c === '/') st = 'SELF_CLOSING';
          else if (c === '>') emitTag(i + 1);
          else name += c.toLowerCase();
          break;
        case 'BEFORE_ATTR':
          if (isSpace(c)) break;
          if (c === '/') st = 'SELF_CLOSING';
          else if (c === '>') emitTag(i + 1);
          else st = 'ATTR_NAME';
          break;
        case 'ATTR_NAME':
          if (isSpace(c)) st = 'AFTER_ATTR_NAME';
          else if (c === '/') st = 'SELF_CLOSING';
          else if (c === '>') emitTag(i + 1);
          else if (c === '=') st = 'BEFORE_VALUE';
          break;
        case 'AFTER_ATTR_NAME':
          if (isSpace(c)) break;
          if (c === '/') st = 'SELF_CLOSING';
          else if (c === '=') st = 'BEFORE_VALUE';
          else if (c === '>') emitTag(i + 1);
          else st = 'ATTR_NAME';
          break;
        case 'BEFORE_VALUE':
          if (isSpace(c)) break;
          if (c === '"') st = 'VALUE_DQ';
          else if (c === "'") st = 'VALUE_SQ';
          else if (c === '>') emitTag(i + 1);
          else st = 'VALUE_UQ';
          break;
        case 'VALUE_DQ':
          if (c === '"') st = 'AFTER_VALUE';
          break;
        case 'VALUE_SQ':
          if (c === "'") st = 'AFTER_VALUE';
          break;
        case 'VALUE_UQ':
          if (isSpace(c)) st = 'BEFORE_ATTR';
          else if (c === '>') emitTag(i + 1);
          break;
        case 'AFTER_VALUE':
          if (isSpace(c)) st = 'BEFORE_ATTR';
          else if (c === '/') st = 'SELF_CLOSING';
          else if (c === '>') emitTag(i + 1);
          else {
            st = 'BEFORE_ATTR';
            again = true;
          }
          break;
        case 'SELF_CLOSING':
          if (c === '>') {
            selfClosing = true;
            emitTag(i + 1);
          } else {
            st = 'BEFORE_ATTR';
            again = true;
          }
          break;
      }
    }
    i++;
  }
  // 閉じの無い raw text の中身も、`<` があれば止める。
  if (st === 'RAW') finishRaw(src.length);
  return { issues, events };
}

// ── 2. 分岐・反復の中の set ──

function setsInBranches(nodes: readonly JinjaNode[], inBranch: boolean, out: ReviewableIssue[]) {
  for (const n of nodes) {
    if (inBranch && n.type === 'token' && n.token.keyword === 'set')
      out.push({ code: 'set-in-branch', at: n.token.start });
    if (inBranch && n.type === 'opaqueBlock' && n.open.keyword === 'set')
      out.push({ code: 'set-in-branch', at: n.start });
    if (n.type === 'if') for (const b of n.branches) setsInBranches(b.children, true, out);
    if (n.type === 'for') {
      setsInBranches(n.body.children, true, out);
      if (n.elseBranch) setsInBranches(n.elseBranch.children, true, out);
    }
  }
}

// ── 3. 文書の骨格 ──

const HEAD_ELEMENTS = new Set(['title', 'meta', 'link', 'style', 'script', 'base']);
const SKELETON_ELEMENTS = new Set(['html', 'head', 'body']);

/** 骨格の違反の位置(無ければ null)。 */
function skeletonIssue(events: readonly LexEvent[], srcLength: number): number | null {
  let k = 0;
  const skip = () => {
    while (k < events.length && (events[k].t === 'comment' || events[k].t === 'doctype')) k++;
  };
  const at = (e: LexEvent | undefined) => (e === undefined ? srcLength : 'at' in e ? e.at : e.end);
  const take = (t: 'start' | 'end', name: string): boolean => {
    skip();
    const e = events[k];
    if (e && e.t === t && e.name === name) {
      k++;
      return true;
    }
    return false;
  };
  if (!take('start', 'html')) return at(events[k]);
  if (!take('start', 'head')) return at(events[k]);
  for (;;) {
    skip();
    const e = events[k];
    if (e === undefined) return srcLength;
    if (e.t === 'end' && e.name === 'head') break;
    if (e.t === 'rawEnd' || ((e.t === 'start' || e.t === 'end') && HEAD_ELEMENTS.has(e.name))) {
      k++;
      continue;
    }
    return at(e);
  }
  k++;
  if (!take('start', 'body')) return at(events[k]);
  for (;;) {
    const e = events[k];
    if (e === undefined) return srcLength;
    if (e.t === 'end' && e.name === 'body') break;
    if ((e.t === 'start' || e.t === 'end') && SKELETON_ELEMENTS.has(e.name)) return e.at;
    k++;
  }
  k++;
  if (!take('end', 'html')) return at(events[k]);
  skip();
  return k < events.length ? at(events[k]) : null;
}

// ── 4. 入口 ──

/** C0 の制御文字(TAB・LF・FF・CR を除く)と DEL。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字そのものを探す
const CONTROL_RE = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g;

/**
 * 原文の違反を位置の順に返す。`document` は文書(テンプレート)で、骨格(制約 6)も見る。パーツの断片は
 * false。先頭の BOM は呼び出し側が `stripLeadingBom` で外してから渡す。Jinja として読めない原文は空を
 * 返す(受付の描画が「Jinja の書き方を読めない」で止める)。
 */
export function findReviewableIssues(src: string, opts: { document: boolean }): ReviewableIssue[] {
  const tree = parseJinja(src);
  if (!tree.ok) return [];
  const { issues, events } = lex(src, tree.tokens);
  setsInBranches(tree.nodes, false, issues);
  for (const m of src.matchAll(CONTROL_RE)) issues.push({ code: 'control-char', at: m.index ?? 0 });
  if (opts.document) {
    const at = skeletonIssue(events, src.length);
    if (at !== null) issues.push({ code: 'skeleton', at });
  }
  return issues.sort((a, b) => a.at - b.at);
}

/** 骨格のタグの字面(`<html` `</body` など。名前の後ろはタグ名の終わり)。 */
const SKELETON_TAG_RE = /<\/?(?:html|head|body)(?=[\s/>]|$)/i;

/** `src` の `[from, to)` にある骨格のタグの字面の最初の位置(無ければ null)。 */
function skeletonTagIn(src: string, from: number, to: number): number | null {
  const m = SKELETON_TAG_RE.exec(src.slice(from, to));
  return m === null ? null : from + m.index;
}

/**
 * 本文の範囲 `[from, to)` の中にある骨格のタグ(`<html` `<head` `<body` の開始タグと `</head>`
 * `</body>` `</html>`)の最初の位置(無ければ null)。数え方は骨格の検査(制約 6。`skeletonIssue` の
 * 本文の中の判定)と同じ字句の規則で、コメント・raw text・属性値の中は数えない(script の文字列の
 * `"</body>"` で止めない)。ただし外来要素(svg・math)の中の raw text・RCDATA の中身は、マークアップ
 * として読まれるので字面で探す。本文で最初に svg・math が開いた後ろの raw text・RCDATA は、閉じタグの
 * 後でもすべてそう扱う(ブラウザが無視する閉じタグを見分けられないため)。`jinja` は Jinja の
 * トークンを読み飛ばすか(作成経路の原文)。値入り HTML(編集経路)は Jinja で描かないので、`{{` も
 * 地の文として読む。
 *
 * 承認画面は DOM の body だけを見せる。本文の中に `<body style>` や `<html class>` を書くと、
 * ブラウザは既存の要素へ属性を足すので、承認画面に出ない変更が本番に出る。
 */
export function findSkeletonTagInBody(
  src: string,
  range: { from: number; to: number },
  opts: { jinja: boolean },
): number | null {
  let tokens: readonly JinjaToken[] = [];
  if (opts.jinja) {
    const lexed = lexJinja(src);
    if (lexed.ok) tokens = lexed.tokens;
  }
  const { events } = lex(src, tokens);
  /** 本文で svg・math が開いたか。開いた後ろの raw text・RCDATA は、閉じた後でも外来要素の中と読む。 */
  let foreignOpened = false;
  for (const e of events) {
    if (e.t === 'start' && FOREIGN.has(e.name) && e.at >= range.from) foreignOpened = true;
    if (e.t === 'rawEnd') {
      // 外来要素の中の style・title などは普通の要素で、中身はマークアップとして読まれる。ブラウザは
      // そこの `<body>`・`<html>` で外来要素を抜け、既存の body・html へ属性を足す。字句の状態機械
      // (`lex`)の raw text の扱いは制約 3 と結び付いているので変えず、ここで中身を探し直す。
      // 外来要素の深さ(`foreign`)だけでは足りない。`lex` は木構築をしないので、ブラウザが無視する
      // 閉じタグ(`<svg><foreignObject><div></svg>` の `</svg>`)でも深さを戻す。本文で最初に svg・math が
      // 開いた後ろは、すべて外来要素の中として探す(止めすぎる側に倒す)。
      if (!(e.foreign || foreignOpened) || e.end <= range.from || e.start >= range.to) continue;
      const at = skeletonTagIn(src, Math.max(e.start, range.from), Math.min(e.end, range.to));
      if (at !== null) return at;
      continue;
    }
    if (e.t !== 'start' && e.t !== 'end') continue;
    if (e.at < range.from) continue;
    if (e.at >= range.to) break;
    if (SKELETON_ELEMENTS.has(e.name)) return e.at;
  }
  return null;
}

/**
 * 文書の `<head>` の中の meta・title・style・link の原文を、並びのまま返す(骨格の無い原文は空)。承認画面に
 * 出ないので、受付は基準(生成物・確定テンプレート)と同じ並びのときだけ通す。
 */
export function headFixedSources(src: string): string[] {
  const lexed = lexJinja(src);
  if (!lexed.ok) return [];
  const { events } = lex(src, lexed.tokens);
  const out: string[] = [];
  let inHead = false;
  let open: { name: string; at: number } | null = null;
  for (const e of events) {
    if (e.t === 'start' && e.name === 'head') inHead = true;
    else if (e.t === 'end' && e.name === 'head') break;
    else if (!inHead) continue;
    else if (e.t === 'start' && (e.name === 'link' || e.name === 'meta'))
      out.push(src.slice(e.at, e.end));
    else if (e.t === 'start' && (e.name === 'title' || e.name === 'style'))
      open = { name: e.name, at: e.at };
    else if (e.t === 'end' && open !== null && e.name === open.name) {
      out.push(src.slice(open.at, e.end));
      open = null;
    }
  }
  return out;
}
