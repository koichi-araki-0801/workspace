// =============================================================================
// jinjaMask.ts — 生 Jinja2 HTML <-> GrapesJS-safe HTML の相互変換
// =============================================================================
// 役割:
//   生 Jinja2 HTML <-> GrapesJS-safe HTML を, 全ての `{{ }}` / `{% %}` / `{# #}`
//   タグを verbatim に保持しつつ相互変換する。
//
// 戦略:
// `toTemplate(editable)`: パース済み DOM 上での厳密な逆変換。復元した Jinja はまず
//   serialization-safe な placeholder として出力し, 最後の文字列パスで decode する。
//   これにより式中の `<`, `>`, `&` 等が serializer に HTML エスケープされない。

import { findEditingMarkers } from '@editor/shared';
import { MATH_TEX_RE, OPAQUE_MATH_RE, OPAQUE_SCRIPT_RE } from './fillAnalysis';
import { formatHtml } from './formatOutput';
import { defaultHtmlParser, type HtmlParser } from './htmlParser';
import { maskJinja, scanHtml } from './htmlScan';
import {
  b64decodeUtf8,
  b64encodeUtf8,
  DATA_JINJA,
  DATA_JINJA_LOOP_ROW,
  DATA_OPAQUE,
  DATA_OPAQUE_KIND,
  parseRtCommentData,
  type RtMarker,
} from './jinjaAttrs';
import {
  isBlockTagKeyword,
  type JinjaBranch,
  type JinjaNode,
  type JinjaToken,
  lexJinja,
  parseJinja,
} from './jinjaLex';

export const TOKEN_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;
// Private-use 区切り文字: HTML serialization をエスケープされずに通過する。
const PH_START = String.fromCharCode(0xe000);
const PH_END = String.fromCharCode(0xe001);
const PH_RE = new RegExp(`${PH_START}([A-Za-z0-9+/=]*)${PH_END}`, 'g');

/**
 * 要素の属性で往復の印を持つ旧形式。読み手は持たず、見つけたら `legacy-draft` の違反にする。
 * lib は features を import しないので属性名はここに書き、`legacyDraft.ts` の
 * `LEGACY_DRAFT_ATTRS` との一致はテストが突き合わせる。
 */
export const LEGACY_ATTR_SELECTOR =
  '[data-jinja-open],[data-jinja-close],[data-jinja-block],[data-jinja-loop-clone]';

export function extractJinjaTokens(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

export { b64encodeUtf8 as b64encode };

function b64decode(b: string): string {
  return b64decodeUtf8(b);
}

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function tokenKind(token: string): 'var' | 'stmt' | 'comment' {
  if (token.startsWith('{{')) return 'var';
  if (token.startsWith('{#')) return 'comment';
  return 'stmt';
}

// ── 1. toTemplate — GrapesJS-safe → 生 Jinja2 ──

export interface ToTemplateOptions {
  /** true なら `<body>` の inner HTML だけを返す(GrapesJS の body 編集用)。 */
  asFragment?: boolean;
  /**
   * true なら復元前の(= Jinja を placeholder に退避済みの)HTML を整形する。確定版テンプレを
   * git に読める形で残すための pretty-print。整形は placeholder マスク後・decode 前に行うので
   * Jinja 構文は壊れない(下記 step 6 参照)。
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

/** `src` 全体をちょうど 1 個の Jinja トークンが覆うなら、そのトークン。 */
function soleToken(src: string): JinjaToken | null {
  const lexed = lexJinja(src);
  if (!lexed.ok || lexed.tokens.length !== 1) return null;
  const tok = lexed.tokens[0];
  return tok.start === 0 && tok.end === src.length ? tok : null;
}

/**
 * 復号値が「ちょうど 1 つの Jinja トークンそのもの」か(chip/open/close の生成は 1 トークンしか
 * 作らない)。`}}` の後ろへ HTML を継ぎ足す形は 2 トークン以上に割れて弾かれる。
 */
function isSingleJinjaToken(dec: string, kind?: 'stmt'): boolean {
  const tok = soleToken(dec);
  return tok !== null && (kind === undefined || tok.kind === kind);
}

/** `src` 全体を覆う、最上位でただ 1 個のブロック。 */
function soleBlock(src: string): JinjaNode | null {
  const r = parseJinja(src);
  if (!r.ok || r.nodes.length !== 1) return null;
  const n = r.nodes[0];
  if (n.type === 'text' || n.type === 'token') return null;
  return n.start === 0 && n.end === src.length ? n : null;
}

/**
 * 復号値が `re`(生成側の抽出正規表現)の 1 マッチだけで全体を覆うか。生成 1 単位を超える連結や、
 * タグの外への HTML 混入(`</script>` の後ろへ `<img onerror>` 等)を弾く。
 */
function isSoleFullMatch(dec: string, re: RegExp): boolean {
  const g = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  const m = dec.match(g);
  return m !== null && m.length === 1 && m[0] === dec;
}

const RAWTEXT_CHIP_TAGS = new Set(['style', 'textarea', 'title']);

/** 復号値が、伏せた内容の種類ごとに生成側が作りうる形か。種類の無いものは旧形式の script / math。 */
function isOpaqueShape(dec: string, kind: string | null): boolean {
  if (kind === null || kind === 'script' || kind === 'math') {
    return (
      isSoleFullMatch(dec, OPAQUE_SCRIPT_RE) ||
      isSoleFullMatch(dec, OPAQUE_MATH_RE) ||
      isSoleFullMatch(dec, MATH_TEX_RE)
    );
  }
  if (kind === 'body') return parseJinja(dec).ok;
  if (kind !== 'frozen' && kind !== 'rawtext') return false;
  // `{% raw %}` ブロックも中身を見せないチップにする(中身が文字どおり出るので要素と同じ扱い)。
  if (kind === 'rawtext' && soleBlock(dec)?.type === 'raw') return true;
  // 固めた要素は原文の 1 要素そのもの。外側へ HTML を足した形を弾く。
  const lexed = lexJinja(dec);
  if (!lexed.ok) return false;
  const tops = scanHtml(maskJinja(dec, lexed.tokens)).elements.filter((e) => e.parent === null);
  if (tops.length !== 1 || tops[0].start !== 0 || tops[0].end !== dec.length) return false;
  return kind === 'frozen' || RAWTEXT_CHIP_TAGS.has(tops[0].tag);
}

// ── 1a. 範囲の印 ──
// 印は兄弟の並びの中で開き・閉じが入れ子になる(`fillJinja.ts` の `toFilled` が本文の前後に置く)。
// 親の違う開き・閉じは、それぞれの親で相手が見つからずに違反になる。

interface RtNode {
  node: Comment;
  marker: RtMarker;
}
interface RtPair {
  open: Comment;
  close: Comment;
  /** 2 回目以降の繰り返しの始まり。 */
  repeat: Comment | null;
  head: string;
  tail: string;
}
interface RtSingle {
  node: Comment;
  payload: string;
}

function collectRtComments(doc: Document, violations: string[]): RtNode[] {
  const out: RtNode[] = [];
  const walk = (n: Node) => {
    for (const ch of Array.from(n.childNodes)) {
      if (ch.nodeType === 8) {
        const m = parseRtCommentData((ch as Comment).data);
        if (m === 'invalid') violations.push('rt-comment');
        else if (m !== null) out.push({ node: ch as Comment, marker: m });
      } else walk(ch);
    }
  };
  walk(doc);
  return out;
}

/** 開き・閉じを親ごとに対応づけ、前半 + 後半の形を検査する。`t` は 1 個のトークンに限る。 */
function pairRtComments(
  nodes: RtNode[],
  violations: string[],
): { pairs: RtPair[]; singles: RtSingle[] } {
  const pairs: RtPair[] = [];
  const singles: RtSingle[] = [];
  const byParent = new Map<Node, RtNode[]>();
  for (const n of nodes) {
    const p = n.node.parentNode;
    // 文書の直下にはテキストを置けないので、印をそこへ戻せない。
    if (p === null || p.nodeType === 9) {
      violations.push('rt-pair');
      continue;
    }
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  for (const group of byParent.values()) {
    const stack: { id: number; node: Comment; head: string; repeat: Comment | null }[] = [];
    for (const { node, marker } of group) {
      if (marker.kind === 't') {
        const tok = soleToken(marker.payload);
        if (tok === null || isBlockTagKeyword(tok.keyword)) violations.push('rt-shape');
        else singles.push({ node, payload: marker.payload });
        continue;
      }
      if (marker.kind === 'o') {
        stack.push({ id: marker.id, node, head: marker.payload, repeat: null });
        continue;
      }
      const top = stack[stack.length - 1];
      if (top === undefined || top.id !== marker.id) {
        violations.push('rt-pair');
        continue;
      }
      if (marker.kind === 'x') {
        if (top.repeat !== null) violations.push('rt-pair');
        top.repeat = node;
        continue;
      }
      stack.pop();
      pairs.push({
        open: top.node,
        close: node,
        repeat: top.repeat,
        head: top.head,
        tail: marker.payload,
      });
    }
    if (stack.length > 0) violations.push('rt-pair');
  }
  for (const p of pairs) checkPairShape(p, violations);
  return { pairs, singles };
}

/**
 * 前半 + 後半がちょうど 1 個の if / for で、合わせ目が枝の本文の位置(本文が空になった位置)に
 * あるか。後半が空なのは採用した枝が無い if で、前半だけでブロックが閉じ、間は空でなければならない。
 */
function checkPairShape(p: RtPair, violations: string[]): void {
  if (p.tail === '') {
    const blk = soleBlock(p.head);
    if (blk?.type !== 'if' && blk?.type !== 'for') violations.push('rt-shape');
    if (p.repeat !== null) violations.push('rt-pair');
    for (let n = p.open.nextSibling; n !== null && n !== p.close; n = n.nextSibling) {
      if (n.nodeType !== 3 || (n.nodeValue ?? '').trim() !== '') {
        violations.push('rt-body');
        break;
      }
    }
    return;
  }
  const blk = soleBlock(p.head + p.tail);
  const at = p.head.length;
  const seam = (b: JinjaBranch | null) => b !== null && b.bodyStart === at && b.bodyEnd === at;
  if (blk?.type === 'if') {
    if (!blk.branches.some(seam)) violations.push('rt-shape');
    // 繰り返しを持つのは for だけ。if の組の x は採用した枝の後ろを黙って捨てることになる。
    if (p.repeat !== null) violations.push('rt-pair');
  } else if (blk?.type === 'for') {
    if (!seam(blk.body) && !seam(blk.elseBranch)) violations.push('rt-shape');
  } else {
    violations.push('rt-shape');
  }
}

/** `from` から `until` の手前までの兄弟を取り除く(`from` を含む)。 */
function removeSiblings(from: Node, until: Node): void {
  let n: Node | null = from;
  while (n !== null && n !== until) {
    const next: Node | null = n.nextSibling;
    n.parentNode?.removeChild(n);
    n = next;
  }
}

/**
 * 本文の断片(`<html>` も `<body>` も持たない)を文書で包む。断片のまま読ませると、先頭の
 * コメント(範囲の開きの印や原文のコメント)はパーサが `<body>` の外(文書の直下)へ置き、本文から
 * 落ちる。文書や `<body>` で包んだ下書きはそのまま渡す(二重に包むと `<body>` が入れ子になる)。
 * 判定はタグの走査で行い、コメントや属性値の中の字面には反応しない。
 */
function asDocument(editable: string): string {
  const lexed = lexJinja(editable);
  const masked = lexed.ok ? maskJinja(editable, lexed.tokens) : editable;
  const hasShell = scanHtml(masked).elements.some((e) => e.tag === 'html' || e.tag === 'body');
  if (hasShell || /^\s*<!doctype/i.test(editable)) return editable;
  return `<!doctype html><html><head></head><body>${editable}</body></html>`;
}

export function toTemplate(
  editable: string,
  opts: ToTemplateOptions = {},
  parse: HtmlParser = defaultHtmlParser,
): string {
  const hadDoctype = /^\s*<!doctype/i.test(editable);
  const doc = parse(asDocument(editable));
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

  // 0. 旧形式の印は読まない。採用した枝しか持たない形から元のブロックは戻せない。
  if (doc.querySelector(LEGACY_ATTR_SELECTOR) !== null) violations.push('legacy-draft');

  // 1. 範囲の印を集めて対応づけ、中身の形を検査する。
  const { pairs, singles } = pairRtComments(collectRtComments(doc, violations), violations);

  // 2. for の 2 回目以降の繰り返し(x の印から閉じの手前まで)は表示専用なので捨てる。
  for (const p of pairs) if (p.repeat !== null) removeSiblings(p.repeat, p.close);

  // 3a. chip span -> placeholder テキストへ復元する。復号値は単一 Jinja トークンに限る。
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

  // 3b. 伏せた内容(script / math / 固めた要素 / 生テキスト要素 / 本文全体)を原文へ戻す。
  //     ⚠ script の *中身* はここでは検査しない — テンプレ JS は正当なコンテンツで、改変検出は
  //     確定保存側 server `templateScripts` の不変性ゲートが担う。ここが担うのは「種類ごとの
  //     生成形の外の HTML を opaque チャネルへ混ぜない」ことだけ。
  doc.querySelectorAll(`[${DATA_OPAQUE}]`).forEach((el) => {
    const enc = el.getAttribute(DATA_OPAQUE);
    if (enc === null) return;
    const dec = tryB64decode(enc);
    if (dec === null || !isOpaqueShape(dec, el.getAttribute(DATA_OPAQUE_KIND))) {
      violations.push(DATA_OPAQUE);
      return;
    }
    el.replaceWith(ph(enc));
  });

  // 4. 範囲の印と t の印を placeholder へ置き換える。空の後半は印を外すだけ。
  for (const p of pairs) {
    p.open.replaceWith(ph(b64encodeUtf8(p.head)));
    if (p.tail === '') p.close.remove();
    else p.close.replaceWith(ph(b64encodeUtf8(p.tail)));
  }
  for (const s of singles) s.node.replaceWith(ph(b64encodeUtf8(s.payload)));

  // 5. 表示専用のテンプレート行の属性を外す。
  doc.querySelectorAll(`[${DATA_JINJA_LOOP_ROW}]`).forEach((el) => {
    el.removeAttribute(DATA_JINJA_LOOP_ROW);
  });

  // 6. (任意)整形する。この時点で Jinja は全て placeholder(private-use 文字のテキスト
  //    ノード/属性)に退避済みで `serialized` は valid HTML。フォーマッタは Jinja を見ない
  //    ため `{% for %}` 等の構文を壊さず、placeholder の前後にインデントが入るだけ。
  const serializedRaw = opts.asFragment ? doc.body.innerHTML : doc.documentElement.outerHTML;
  const serialized = opts.pretty ? formatHtml(serializedRaw) : serializedRaw;

  // 7. placeholder を生文字列置換で decode する(HTML エスケープなし)。復号は `ph` が発行した
  //    enc に限り、未知 placeholder(偽装)は復号せず違反にする。
  let out = serialized.replace(PH_RE, (_m, enc: string) => {
    if (!issued.has(enc)) {
      violations.push('placeholder');
      return '';
    }
    return b64decode(enc);
  });

  // 8. 事後検査。窓ごとの形が正しくても、組み合わせた結果のブロックが閉じない形や、外しきれ
  //    ない印が残る形は、そのまま申請へ進めると確定テンプレートを壊す。
  if (violations.length === 0) {
    if (!parseJinja(out).ok) violations.push('structure');
    if (findEditingMarkers(out).length > 0) violations.push('leftover-marker');
  }

  if (violations.length > 0) {
    throw new Error(
      `toTemplate: 復元できない Jinja マスクを検出しました (${violations.join(', ')})`,
    );
  }
  if (!opts.asFragment && hadDoctype) out = `<!doctype html>\n${out}`;
  return out;
}

// ── 2. 往復の比較用の正規形 ──

const RAW_WS_TAGS = new Set(['PRE', 'TEXTAREA', 'SCRIPT', 'STYLE']);

/**
 * テキスト位置の Jinja 記号を、コメントの印へ置き換える。コメントは DOM パーサの表の
 * 追い出し(foster parenting)を受けないので、行がループの外へ出た差が両側で見分けられる。
 * タグや属性値の中の記号は文字のまま残す。
 */
function tokensToComments(src: string): string {
  const lexed = lexJinja(src);
  if (!lexed.ok) return src;
  const scan = scanHtml(maskJinja(src, lexed.tokens));
  let out = '';
  let at = 0;
  for (const t of lexed.tokens) {
    if (scan.contextAt(t.start).kind !== 'text') continue;
    out += `${src.slice(at, t.start)}<!--tok:${b64encodeUtf8(t.source)}-->`;
    at = t.end;
  }
  return out + src.slice(at);
}

/**
 * 往復の比較用の正規形。`<body>` の中身として解析し、GrapesJS が読み込みで捨てるテキスト
 * ノードだけを除いて直列化する。捨てる条件は GrapesJS と同じで、全体が空白であり、丁度
 * 1 個の空白ではなく、親の先頭か末尾にあるか改行を含むもの。Jinja の記号はノードの境で区切る
 * (編集用の HTML では記号が別の節点になる)。`pre` / `textarea` / `script` / `style` の中は
 * 空白が意味を持つので触らない。元と戻した結果を同じパーサへ通すため、パーサの並べ替えは
 * 両側に同じく効く。
 */
export function normalizeForRoundTrip(bodyHtml: string, parse: HtmlParser): string {
  const doc = parse(
    `<!doctype html><html><head></head><body>${tokensToComments(bodyHtml)}</body></html>`,
  );
  doc.body.normalize();
  dropBlankText(doc.body);
  sortAttributes(doc.body);
  return doc.body.innerHTML;
}

/**
 * 各要素の属性を名前順に並べ直す。GrapesJS は直列化で `class` を属性の末尾へ移すので、
 * キャンバスを通した本文は属性の順序だけが原文と変わる。属性の順序は描画に効かないため、
 * 比較では揃える(順序だけの並べ替えは差として検出しない)。
 */
function sortAttributes(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.attributes.length < 2) continue;
    // 属性の節点ごと付け替える。名前で付け直すと、タグの中の Jinja が作る `{%` のような
    // 名前を DOM の API が拒む(パーサは受け入れる)。
    const attrs = Array.from(el.attributes).sort((x, y) =>
      x.name < y.name ? -1 : x.name > y.name ? 1 : 0,
    );
    const put = (list: Attr[]) => {
      for (const a of list) el.removeAttributeNode(a);
      for (const a of list) el.setAttributeNode(a);
    };
    put(attrs);
    // linkedom は足した属性を先頭へ積むので、足した順と逆に並ぶ。そのときは逆順で足し直す。
    if (el.attributes[0]?.name !== attrs[0]?.name) put(attrs.reverse());
  }
}

function dropBlankText(el: Node): void {
  if (el.nodeType === 1 && RAW_WS_TAGS.has((el as Element).tagName.toUpperCase())) return;
  const kids = Array.from(el.childNodes);
  const last = kids.length - 1;
  kids.forEach((n, i) => {
    if (n.nodeType === 1) {
      dropBlankText(n);
      return;
    }
    if (n.nodeType !== 3) return;
    const v = n.nodeValue ?? '';
    if (v !== ' ' && !v.trim() && (i === 0 || i === last || v.includes('\n')))
      n.parentNode?.removeChild(n);
  });
}
