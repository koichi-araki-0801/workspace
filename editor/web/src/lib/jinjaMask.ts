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

import { formatHtml } from './formatOutput';
import { defaultHtmlParser, type HtmlParser } from './htmlParser';

export const TOKEN_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;
// Private-use 区切り文字: HTML serialization をエスケープされずに通過する。
export const PH_START = String.fromCharCode(0xe000);
export const PH_END = String.fromCharCode(0xe001);
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

export function b64decode(b: string): string {
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
    return `${tagStart} data-jinja-open="${b64encode(openStmt)}" data-jinja-close="${b64encode(closeStmt)}"${rest}`;
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
        return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-jinja="${b64encode(token)}">${htmlEscape(token)}</span>`;
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

export function toTemplate(
  editable: string,
  opts: ToTemplateOptions = {},
  parse: HtmlParser = defaultHtmlParser,
): string {
  const hadDoctype = /^\s*<!doctype/i.test(editable);
  const doc = parse(editable);
  const ph = (enc: string) => doc.createTextNode(`${PH_START}${enc}${PH_END}`);

  // 0. `fillJinja.ts` の `toFilled` が生成した loop clone を破棄する: 展開した
  //    `{% for %}` の先頭(テンプレート)行だけが data-jinja-open/close を運ぶ。
  //    filled clone は表示専用であり, 復元後のテンプレートに残してはならない。
  doc.querySelectorAll('[data-jinja-loop-clone]').forEach((el) => {
    el.remove();
  });

  // 1. chip span -> placeholder テキストへ復元する
  doc.querySelectorAll('[data-jinja]').forEach((el) => {
    const enc = el.getAttribute('data-jinja');
    if (enc === null) return;
    el.replaceWith(ph(enc));
  });

  // 1b. opaque mask されたコンテンツを復元する — `<script>`, MathML `<math>`, TeX
  //     数式(`fillJinja.ts` の `toFilled` がこれらを inert chip として GrapesJS から
  //     隠す。verbatim ソースは data-opaque に入る)。
  doc.querySelectorAll('[data-opaque]').forEach((el) => {
    const enc = el.getAttribute('data-opaque');
    if (enc === null) return;
    el.replaceWith(ph(enc));
  });

  // 1c. collapse 済みの `{% if %}…{% endif %}` を復元する(`fillJinja.ts` の
  //     `toFilled` は表示用に taken branch のみを残し, ブロック全体を
  //     data-jinja-block に保持する)。
  doc.querySelectorAll('[data-jinja-block]').forEach((el) => {
    const enc = el.getAttribute('data-jinja-block');
    if (enc === null) return;
    el.replaceWith(ph(enc));
  });

  // 2. absorb したブロック文を, その要素の前後へ復元する
  doc.querySelectorAll('[data-jinja-open]').forEach((el) => {
    const open = el.getAttribute('data-jinja-open');
    const close = el.getAttribute('data-jinja-close');
    el.removeAttribute('data-jinja-open');
    el.removeAttribute('data-jinja-close');
    if (open !== null) el.parentNode?.insertBefore(ph(open), el);
    if (close !== null) el.parentNode?.insertBefore(ph(close), el.nextSibling);
  });

  // 2.5 (任意)整形する。この時点で Jinja は全て placeholder(private-use 文字のテキスト
  //     ノード/属性)に退避済みで `serialized` は valid HTML。フォーマッタは Jinja を見ない
  //     ため `{% for %}` 等の構文を壊さず、placeholder の前後にインデントが入るだけ。
  const serializedRaw = opts.asFragment ? doc.body.innerHTML : doc.documentElement.outerHTML;
  const serialized = opts.pretty ? formatHtml(serializedRaw) : serializedRaw;

  // 3. placeholder を生文字列置換で decode する(HTML エスケープなし)
  let out = serialized.replace(PH_RE, (_m, enc: string) => b64decode(enc));
  if (!opts.asFragment && hadDoctype) out = `<!doctype html>\n${out}`;
  return out;
}
