// =============================================================================
// jinjaMask.ts — 生 Jinja2 HTML <-> GrapesJS-safe HTML の相互変換
// =============================================================================
// 役割:
//   生 Jinja2 HTML <-> GrapesJS-safe HTML を, 全ての `{{ }}` / `{% %}` / `{# #}`
//   タグを verbatim に保持しつつ相互変換する。
//
// 戦略:
// `toEditable(raw)`:
//   1. nested statement を持たず単一要素を包む単純なブロック文
//      (`{% for %}<tr>…</tr>{% endfor %}`)を, その要素へ `data-jinja-open` /
//      `data-jinja-close` (base64)として "absorb" する。これにより HTML パーサが
//      ループマーカを `<table>`/`<tbody>` の外へ foster-parent するのを防ぐ。
//   2. 残りの, *テキスト中*(タグ内ではない)の Jinja を locked chip 要素として包む:
//      `<span data-gjs-type="jinja-…" data-jinja="b64">…</span>`。可視ラベルは
//      HTML エスケープし, 厳密なソースは `data-jinja` に入れる。
//   要素の属性内の Jinja(例 href="{{ url }}")は触らない — 属性値は GrapesJS を
//   verbatim に round-trip するため。
//
// `toTemplate(editable)`: パース済み DOM 上での厳密な逆変換。復元した Jinja はまず
//   serialization-safe な placeholder として出力し, 最後の文字列パスで decode する。
//   これにより式中の `<`, `>`, `&` 等が serializer に HTML エスケープされない。

import { IF_RE, MATH_TEX_RE, OPAQUE_MATH_RE, OPAQUE_SCRIPT_RE } from './fillJinja';
import { formatHtml } from './formatOutput';
import { defaultHtmlParser, type HtmlParser } from './htmlParser';
import {
  DATA_JINJA,
  DATA_JINJA_BLOCK,
  DATA_JINJA_CLOSE,
  DATA_JINJA_LOOP_CLONE,
  DATA_JINJA_OPEN,
  DATA_OPAQUE,
} from './jinjaAttrs';

export const TOKEN_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;
// Private-use 区切り文字: HTML serialization をエスケープされずに通過する。
const PH_START = String.fromCharCode(0xe000);
const PH_END = String.fromCharCode(0xe001);
const PH_RE = new RegExp(`${PH_START}([A-Za-z0-9+/=]*)${PH_END}`, 'g');

export function extractJinjaTokens(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b: string): string {
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function tokenKind(token: string): 'var' | 'stmt' | 'comment' {
  if (token.startsWith('{{')) return 'var';
  if (token.startsWith('{#')) return 'comment';
  return 'stmt';
}

// ── 1. toEditable — 生 Jinja2 → GrapesJS-safe ──

/**
 * `{% open … %}<el …>…</el>{% close … %}` を包まれた要素へ absorb する。
 * body は `{% … %}` 文を含んではならず, これにより `if/else` chain や nested loop を
 * 除外し(chip へフォールバックさせる), マッチが `{% else %}` をまたぐのを防ぐ。
 */
function absorbBlocks(html: string, open: string, close: string): string {
  const re = new RegExp(
    `(\\{%\\s*${open}\\b[^%]*%\\})\\s*(<([a-zA-Z][\\w-]*)\\b)((?:[^>]*>)(?:(?!\\{%)[\\s\\S])*?<\\/\\3>)\\s*(\\{%\\s*${close}\\s*%\\})`,
    'g',
  );
  return html.replace(re, (_m, openStmt, tagStart, _tagName, rest, closeStmt) => {
    return `${tagStart} ${DATA_JINJA_OPEN}="${b64encode(openStmt)}" ${DATA_JINJA_CLOSE}="${b64encode(closeStmt)}"${rest}`;
  });
}

function wrapInlineTokens(html: string): string {
  // タグ(<...>)とテキストの segment へ分割し, テキスト中の token だけを包む。
  const parts = html.split(/(<[^>]*>)/);
  return parts
    .map((part) => {
      if (part.startsWith('<')) return part; // タグ — 属性はそのままにする
      return part.replace(TOKEN_RE, (token) => {
        const kind = tokenKind(token);
        return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" ${DATA_JINJA}="${b64encode(token)}">${htmlEscape(token)}</span>`;
      });
    })
    .join('');
}

export function toEditable(raw: string): string {
  let s = raw;
  s = absorbBlocks(s, 'for', 'endfor');
  s = absorbBlocks(s, 'if', 'endif');
  s = wrapInlineTokens(s);
  return s;
}

// ── 2. toTemplate — GrapesJS-safe → 生 Jinja2 ──

export interface ToTemplateOptions {
  /** true なら `<body>` の inner HTML だけを返す(GrapesJS の body 編集用)。 */
  asFragment?: boolean;
  /**
   * true なら復元前の(= Jinja を placeholder に退避済みの)HTML を整形する。確定版テンプレを
   * git に読める形で残すための pretty-print。整形は placeholder マスク後・decode 前に行うので
   * Jinja 構文は壊れない(下記 step 2.5 参照)。
   */
  pretty?: boolean;
}

/** 不正 base64(`atob` が throw する攻撃入力)を検査対象から外し、違反として計上するため。 */
function tryB64decode(b: string): string | null {
  try {
    return b64decode(b);
  } catch {
    return null;
  }
}

/**
 * 復号値が「ちょうど 1 つの Jinja トークンそのもの」か。生成側と同じ `TOKEN_RE` で抽出し、
 * 全体を 1 トークンが過不足なく覆うことを要求する(chip/open/close の生成は 1 トークンしか
 * 作らない)。`}}` の後ろへ HTML を継ぎ足す形は 2 トークン以上に割れて弾かれる。
 */
function isSingleJinjaToken(dec: string, kind?: 'stmt'): boolean {
  const toks = extractJinjaTokens(dec);
  if (toks.length !== 1 || toks[0] !== dec) return false;
  return kind === undefined || tokenKind(dec) === kind;
}

/**
 * 復号値が `re`(生成側の抽出正規表現)の 1 マッチだけで全体を覆うか。opaque/if ブロックの
 * ように内部に HTML を含む形でも、生成 1 単位を超える連結や、タグの外への HTML 混入
 * (`</script>` の後ろへ `<img onerror>` 等)を弾く。
 */
function isSoleFullMatch(dec: string, re: RegExp): boolean {
  const g = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  const m = dec.match(g);
  return m !== null && m.length === 1 && m[0] === dec;
}

/** 復号値が opaque mask の生成 3 形(単一の script / math / TeX)のいずれかに完全一致するか。 */
function isOpaqueShape(dec: string): boolean {
  return (
    isSoleFullMatch(dec, OPAQUE_SCRIPT_RE) ||
    isSoleFullMatch(dec, OPAQUE_MATH_RE) ||
    isSoleFullMatch(dec, MATH_TEX_RE)
  );
}

export function toTemplate(
  editable: string,
  opts: ToTemplateOptions = {},
  parse: HtmlParser = defaultHtmlParser,
): string {
  const hadDoctype = /^\s*<!doctype/i.test(editable);
  const doc = parse(editable);
  // 発行集合: この呼び出しが実際に生成した placeholder の enc だけを最終段で復号する。
  // canvas 入口を素通りした偽 placeholder(editable テキストへ U+E000/U+E001 直書き)を
  // 復号しないための鍵。`ph` の生成と復号の許可を 1 箇所に束ねる。
  const issued = new Set<string>();
  const ph = (enc: string) => {
    issued.add(enc);
    return doc.createTextNode(`${PH_START}${enc}${PH_END}`);
  };
  // チャネル別形状検査の違反。1 件でもあれば復元せず throw する(黙って残す/削るをしない)。
  const violations: string[] = [];

  // 0. `fillJinja.ts` の `toFilled` が生成した loop clone を破棄する: 展開した
  //    `{% for %}` の先頭(テンプレート)行だけが data-jinja-open/close を運ぶ。
  //    filled clone は表示専用であり, 復元後のテンプレートに残してはならない。
  doc.querySelectorAll(`[${DATA_JINJA_LOOP_CLONE}]`).forEach((el) => {
    el.remove();
  });

  // 1. chip span -> placeholder テキストへ復元する。復号値は単一 Jinja トークンに限る
  //    (`wrapInlineTokens`/`fillInline` の生成形)。
  doc.querySelectorAll(`[${DATA_JINJA}]`).forEach((el) => {
    const enc = el.getAttribute(DATA_JINJA);
    if (enc === null) return;
    const dec = tryB64decode(enc);
    if (dec === null || !isSingleJinjaToken(dec)) {
      violations.push(DATA_JINJA);
      return;
    }
    el.replaceWith(ph(enc));
  });

  // 1b. opaque mask されたコンテンツを復元する — `<script>`, MathML `<math>`, TeX
  //     数式(`fillJinja.ts` の `toFilled` がこれらを inert chip として GrapesJS から
  //     隠す。verbatim ソースは data-opaque に入る)。復号値は `maskOpaque` の生成 3 形に限る。
  //     ⚠ script の *中身* はここでは検査しない — テンプレ JS は正当なコンテンツで、改変検出は
  //     確定保存側 server `templateScripts` の不変性ゲートが担う。ここが担うのは「script 以外の
  //     HTML を opaque チャネルへ混ぜない」ことだけ。
  doc.querySelectorAll(`[${DATA_OPAQUE}]`).forEach((el) => {
    const enc = el.getAttribute(DATA_OPAQUE);
    if (enc === null) return;
    const dec = tryB64decode(enc);
    if (dec === null || !isOpaqueShape(dec)) {
      violations.push(DATA_OPAQUE);
      return;
    }
    el.replaceWith(ph(enc));
  });

  // 1c. collapse 済みの `{% if %}…{% endif %}` を復元する(`fillJinja.ts` の
  //     `toFilled` は表示用に taken branch のみを残し, ブロック全体を
  //     data-jinja-block に保持する)。復号値は `collapseIfs` の生成形(単一 if ブロック)に限る。
  doc.querySelectorAll(`[${DATA_JINJA_BLOCK}]`).forEach((el) => {
    const enc = el.getAttribute(DATA_JINJA_BLOCK);
    if (enc === null) return;
    const dec = tryB64decode(enc);
    if (dec === null || !isSoleFullMatch(dec, IF_RE)) {
      violations.push(DATA_JINJA_BLOCK);
      return;
    }
    el.replaceWith(ph(enc));
  });

  // 2. absorb したブロック文を, その要素の前後へ復元する。open/close は単一 stmt トークンに限る
  //    (`absorbBlocks`/`expandLoops` の生成形。HTML は含められない)。
  doc.querySelectorAll(`[${DATA_JINJA_OPEN}]`).forEach((el) => {
    const open = el.getAttribute(DATA_JINJA_OPEN);
    const close = el.getAttribute(DATA_JINJA_CLOSE);
    el.removeAttribute(DATA_JINJA_OPEN);
    el.removeAttribute(DATA_JINJA_CLOSE);
    const openDec = open === null ? null : tryB64decode(open);
    const closeDec = close === null ? null : tryB64decode(close);
    const openOk = open === null || (openDec !== null && isSingleJinjaToken(openDec, 'stmt'));
    const closeOk = close === null || (closeDec !== null && isSingleJinjaToken(closeDec, 'stmt'));
    if (!openOk || !closeOk) {
      violations.push(DATA_JINJA_OPEN);
      return;
    }
    if (open !== null) el.parentNode?.insertBefore(ph(open), el);
    if (close !== null) el.parentNode?.insertBefore(ph(close), el.nextSibling);
  });

  // 2.5 (任意)整形する。この時点で Jinja は全て placeholder(private-use 文字のテキスト
  //     ノード/属性)に退避済みで `serialized` は valid HTML。フォーマッタは Jinja を見ない
  //     ため `{% for %}` 等の構文を壊さず、placeholder の前後にインデントが入るだけ。
  const serializedRaw = opts.asFragment ? doc.body.innerHTML : doc.documentElement.outerHTML;
  const serialized = opts.pretty ? formatHtml(serializedRaw) : serializedRaw;

  // 3. placeholder を生文字列置換で decode する(HTML エスケープなし)。復号は `ph` が発行した
  //    enc に限り、未知 placeholder(偽装)は復号せず違反にする。
  let out = serialized.replace(PH_RE, (_m, enc: string) => {
    if (!issued.has(enc)) {
      violations.push('placeholder');
      return '';
    }
    return b64decode(enc);
  });

  if (violations.length > 0) {
    throw new Error(
      `toTemplate: 復元できない Jinja マスクを検出しました (${violations.join(', ')})`,
    );
  }
  if (!opts.asFragment && hadDoctype) out = `<!doctype html>\n${out}`;
  return out;
}
