// =============================================================================
// sanitizeHtml.ts — 他ユーザ由来 HTML の能動コンテンツ除去(プレビュー / 編集 canvas)
// =============================================================================
// テンプレ HTML は「別のユーザが書いたもの」を開く前提で、しかも 2 つの経路でアプリと同一
// オリジンへ入る。経路ごとに手段が違うため、本ファイルは 2 本の関数を持つ:
//   1. プレビュー / PDF — `@vivliostyle/core` が本体 document に直接描画するので、文字列を
//      DOMPurify に通す(`sanitizePreviewHtml`)。
//   2. 編集 canvas — GrapesJS のパーサが作った node ツリーを、component 化される前に
//      刈り取る(`pruneCanvasActiveContent`)。文字列を再直列化しないのが要点。
import DOMPurify, { type Config as PurifyConfig } from 'dompurify';
import { sanitizeStyleContent } from './sanitizeCss';

// ── 1. プレビュー / PDF 経路 ──
//
// **不変則**: サニタイズが最後に喋る。出力バイトを最終的に決めるのはサニタイザとその直列化で
// なければならず、サニタイズ後に文字列を触る処理を置いてはならない。整形(js-beautify)も
// サニタイズの**前**で行う。ここが破られると DOMPurify の保証は後段の 1 行で消える —
// 実際に `nunjucksRender.ts` の `<link>` 除去正規表現が `alt="<link rel=stylesheet">` の
// 字面に当たって `<img>` のタグ終端まで食い、直後のテキストが `onerror=` 属性として復活した。
//
// **不変則**: 「探す・切る」は DOM の上でだけ行う。文字列でやってよいのは*包む*(前後に定数を
// 連結する)ことだけで、それも素材が 100% 自分の管理下にある場合に限る。`</head>` を探す・
// `<link…>` を消す、といったアンカー探索と部分除去は文字列では禁止。

/** DOMPurify へ渡す共通設定を毎回新しく作る(DOMPurify は Config を破壊的に読むため使い回さない)。 */
function previewPurifyConfig(): PurifyConfig {
  return {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style'],
    // 主防御は DOMPurify 既定の**許可リスト**で、`link`/`base`/`meta` はそこに元々含まれない。
    // ここでの禁止指定は「将来の版で既定の許可リストへ入ったら黙って穴が開く」一点だけを塞ぐ
    // 保険であり、これを主防御に据えてはならない(ブロックリストは必ず漏れる)。
    FORBID_TAGS: ['link', 'base', 'meta'],
  };
}

/**
 * テンプレ HTML(レンダリング済み)をサニタイズし、**DOM のまま**返す。文字列を経由しないので
 * 呼び出し側は構造の上で `<style>` を足すなどの加工ができる(不変則: 探す・切るは DOM の上で)。
 *
 * `WHOLE_DOCUMENT: true` + `RETURN_DOM: true` の DOMPurify は入力が断片でも
 * `<html><head></head><body>…` へ正規化した `<html>` 要素を返す(dompurify 3.4 実測)。
 * よって呼び出し側に「head が無い / body が無い」の分岐は要らない。
 */
export function sanitizePreviewRoot(html: string): Element {
  return DOMPurify.sanitize(html, {
    ...previewPurifyConfig(),
    RETURN_DOM: true,
  }) as unknown as Element;
}

/**
 * `sanitizePreviewRoot` が返した `<html>` 要素を文書文字列へ直列化する。直列化はここ 1 箇所に
 * 集約する(複数箇所に散ると「片方だけ doctype を忘れる」形の退行が起きる)。
 *
 * DOMPurify は doctype を出力に含めないため補う。quirks モードだと vivliostyle のページ
 * 分割/レイアウトが崩れる。
 */
export function serializePreviewRoot(root: Element): string {
  return `<!doctype html>\n${root.outerHTML}`;
}

/**
 * 外部リソースを取りに行く要素を構造の上で落とし、落とした件数を返す。
 *
 * 主防御は `sanitizePreviewRoot` の許可リストで、正規の `<link rel=stylesheet>` はそこで
 * 既に消えている。本関数はサニタイザを通らない経路(自前で組んだ文書の再加工など)と版差の
 * ための二重化で、**CSP の無い PDF ビルド経路で外向き通信を作らせない**ことが目的。
 * `<template>` の中身は `querySelectorAll` の走査対象外なので明示的に降りる。
 */
export function stripExternalRefs(root: Element): number {
  let removed = 0;
  const scopes: Array<ParentNode> = [root];
  while (scopes.length > 0) {
    const scope = scopes.pop() as ParentNode;
    for (const el of Array.from(scope.querySelectorAll('template'))) {
      scopes.push((el as HTMLTemplateElement).content);
    }
    for (const el of Array.from(scope.querySelectorAll('link, base, meta[http-equiv]'))) {
      el.remove();
      removed++;
    }
  }
  return removed;
}

/**
 * パース済み文書の `<head>` 末尾へ `<style>` を足し、足した要素を返す。
 *
 * `textContent` 代入なので `String.prototype.replace` の `$&` 特殊解釈も属性値への漏れも
 * 構造的に起きない。ただし**直列化器は raw text をエスケープしない**(linkedom もブラウザも
 * `<style>` の中身を生で書き出す)ため、DOM で組んでも `sanitizeStyleContent` は必須で、
 * これを「DOM 経路なので不要」と外すと `</style>` 脱出が即座に復活する。
 */
export function appendPreviewStyle(
  root: Element,
  css: string,
  attrs: Record<string, string> = {},
): Element {
  const doc = root.ownerDocument;
  let head = root.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    root.insertBefore(head, root.firstChild);
  }
  const style = doc.createElement('style');
  for (const [name, value] of Object.entries(attrs)) style.setAttribute(name, value);
  style.textContent = sanitizeStyleContent(css);
  head.appendChild(style);
  return style;
}

/**
 * テンプレ HTML(レンダリング済み)をサニタイズした文書文字列を返す。`<script>`・イベント
 * ハンドラ属性・`javascript:`/`data:` 等の危険な URL を除去しつつ、レポートの構造と CSS は保つ。
 *
 * ⚠ この戻り値へ後段で正規表現を当ててはならない(冒頭の不変則)。加工が要るなら
 * `sanitizePreviewRoot` で DOM を受け取り、DOM の上で加工してから `serializePreviewRoot` する。
 */
export function sanitizePreviewHtml(html: string): string {
  return serializePreviewRoot(sanitizePreviewRoot(html));
}

// ── 2. 編集 canvas(GrapesJS パーサ)経路 ──
//
// canvas の iframe は `about:blank` としてアプリのオリジンを継承し、GrapesJS が親から中の
// DOM を直接触る。つまり canvas へ入った要素はアプリと同一オリジンで動く。draft HTML は
// 「保存できる誰か」が書けるため、ここは**許可リスト**でなければならない。
//
// **危険物を列挙する形(denylist)へ戻さないこと。** 旧実装の
// `FORBIDDEN_TAGS`(iframe/object/embed/frame/frameset)+ `on*` + `javascript:` の 3 判定は
// GrapesJS の **prop チャネル**を 1 つも見ていなかった: `data-gjs-` で始まる属性は
// 「属性」ではなく component の **prop** として model に載る(`grapes.mjs` の
// `parseNodeAttr`)ため、`data-gjs-attributes='{"onerror":"…"}'` は `on*` 判定を素通りして
// `setAttribute` され、`data-gjs-type="iframe"` はタグ名が `<span>` のままなので要素名の
// 判定も素通りして実 iframe になる。列挙は必ず漏れる(`tagName` / `components` /
// `script-export` / 将来の prop…)ので、**通すものだけを書く**。

/**
 * GrapesJS の HTML パーサが返す node の最小構造。`grapesjs` の `ParsedNode` と構造的に
 * 互換で、lib 層が GrapesJS へ型依存しないよう自前で持つ。
 *
 * `nodeType` と `namespaceURI` は許可リスト判定に要る(GrapesJS の `domToParsedNode` が
 * 両方を積む)。`nodeType` を見ずに「タグ名が許可リストに無ければ落とす」と書くと、
 * `tagName` を持たないテキストノードが全滅する。
 */
export interface ParsedHtmlNode {
  /** 1=element 3=text 8=comment 9=document 11=fragment。未定義なら element 以外として扱う。 */
  nodeType?: number;
  namespaceURI?: string;
  tagName?: string;
  attributes?: Record<string, string>;
  childNodes?: ParsedHtmlNode[];
}

const NODE_TYPE_ELEMENT = 1;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * canvas に置いてよい HTML 要素(小文字比較)。実テンプレの census(`fixtures/{filled,
 * templates}` と `parts.json`)＋ レポート系マークアップの標準語彙で構成する。
 *
 * `html`/`head`/`body` は「入ってきたら中身ごと消える」事故を避けるために通す(それ自体は
 * 無害な構造要素)。`meta`/`link`/`base`/`title` は外部参照と宣言的リフレッシュを作れるので
 * 通さない。`style`/`script` は GrapesJS のパーサが `parse:html:root` より前に取り除くので
 * ここへは来ないが、許可リストにも入れない。`form`/`input`/`button` 系は帳票エディタに
 * 不要で `formaction` 等の実行面を増やすだけなので入れない。
 */
const ALLOWED_HTML_TAGS = new Set([
  'html',
  'head',
  'body',
  'div',
  'p',
  'span',
  'br',
  'hr',
  'a',
  'img',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'footer',
  'section',
  'article',
  'aside',
  'main',
  'nav',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'code',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'small',
  'sup',
  'sub',
  'mark',
  'abbr',
  'cite',
  'q',
  'time',
  'wbr',
  'address',
  'ruby',
  'rt',
  'rp',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
]);

/**
 * canvas に置いてよい SVG 要素(小文字比較。SVG の camelCase 名も小文字化して照合する)。
 * SMIL(`animate` 等)は入れない — `<a><animate attributeName="href" to="javascript:…">` で
 * 任意 JS 実行に到達できるため。`foreignObject`/`image`/`style`/`script` も入れない。
 */
const ALLOWED_SVG_TAGS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'marker',
  'mask',
  'clippath',
  'pattern',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'title',
  'desc',
  'lineargradient',
  'radialgradient',
  'stop',
]);

/**
 * 完全名で許可する属性(小文字比較)。census の実使用 + レポート表現に要る標準属性のみ。
 * `on*` は「`on` 始まりを消す」のではなく「許可リストに無いから消える」に変わるので、
 * `ONERROR` の大小文字も未知の将来ハンドラも自動的に落ちる。
 */
const ALLOWED_ATTRS = new Set([
  'class',
  'id',
  'style',
  'title',
  'lang',
  'dir',
  'role',
  'hidden',
  'charset',
  'colspan',
  'rowspan',
  'headers',
  'scope',
  'span',
  'width',
  'height',
  'alt',
  'href',
  'src',
  'rel',
  'target',
  'xlink:href',
  'xmlns',
  'xmlns:xlink',
  'viewbox',
  'preserveaspectratio',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'dx',
  'dy',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'offset',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'writing-mode',
  'font-size',
  'font-family',
  'font-weight',
  'gradientunits',
  'patternunits',
  'clip-path',
  'marker-start',
  'marker-end',
]);

/** 前方一致で許可する属性名。`data-gjs-*` は**この判定より先に**処理する(下記 fail closed)。 */
const ALLOWED_ATTR_PREFIXES = ['data-', 'aria-'];

/**
 * URL を取りうる属性。SMIL の `values`/`from`/`to`/`by` も含める — 当該要素は許可リストに
 * 無いので届かないはずだが、要素側の判断が緩んだときの二重化。
 */
const URL_ATTRS = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'values',
  'from',
  'to',
  'by',
]);

/** URL 値として通すスキーム。`javascript:`/`vbscript:` を列挙する denylist の逆。 */
const ALLOWED_URL_SCHEMES = new Set(['http', 'https', 'mailto']);

/** `data:` で通す MIME。SVG は文脈次第でスクリプトを持ち込むため入れない(fail closed)。 */
const ALLOWED_DATA_URL_PREFIXES = [
  'data:image/png',
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/gif',
  'data:image/webp',
];

/** GrapesJS が component prop として解釈する属性の接頭辞。 */
const GJS_PREFIX = 'data-gjs-';

/**
 * prop チャネルのうち唯一通す属性。`data-gjs-type` は `fillJinja`/`jinjaMask` が生成する
 * Jinja chip の型指定そのもので、落とすと chip が汎用 component へ落ちて `editable:false`
 * が効かなくなり、RTE が `data-jinja` 付き span を分解して `toTemplate` の復元が壊れる
 * (= 編集 2 系統の round-trip が壊れる)。値は呼び出し側が渡す許可リストで別途縛る。
 */
const ALLOWED_GJS_ATTR = 'data-gjs-type';

/** `PruneReport` に積む上限。攻撃入力で件数が爆発してもログ/通知が壊れないようにする。 */
const REPORT_LIMIT = 20;

export interface PruneOptions {
  /** 通してよい `data-gjs-type` の値。`jinjaComponents` の `JINJA_COMPONENT_TYPE_SET` を渡す。 */
  allowedGjsTypes: ReadonlySet<string>;
}

export interface PruneReport {
  /** 落とした要素名(重複あり・`REPORT_LIMIT` で打ち切り)。 */
  droppedElements: string[];
  /** 落とした属性名(同上)。 */
  droppedAttrs: string[];
  /** 打ち切り前の総件数。「黙って中身が減っていた」を防ぐため利用者へ件数を出す。 */
  droppedCount: number;
}

/** `xlink:href` のような名前空間付き属性を prefix / local へ分ける。 */
function splitNsName(name: string): { prefix: string; local: string } {
  const i = name.indexOf(':');
  return i < 0
    ? { prefix: '', local: name }
    : { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

/**
 * 属性名が許可リストに載るか。名前空間つきは**完全名と local 名の両方**で判定し、どちらかが
 * 落ちれば削除する(fail closed)。`data-gjs-*` はここへ来る前に結論が出ている。
 */
function isAllowedAttrName(lower: string): boolean {
  if (ALLOWED_ATTR_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (!ALLOWED_ATTRS.has(lower)) return false;
  const { prefix, local } = splitNsName(lower);
  return prefix === '' || ALLOWED_ATTRS.has(local);
}

/**
 * URL 属性の値が安全か。URL パーサは値中の空白・制御文字をスキーム判定の前に捨てるので、
 * 同じ正規化をしてから判定する(` \n JavaScript:` のような変形を取りこぼさない)。
 * `c > ' '` は空白と C0 制御文字をまとめて落とす比較で、正規表現に制御文字を書かずに済む。
 */
function isAllowedUrlValue(value: string): boolean {
  const normalized = [...value].filter((c) => c > ' ').join('');
  if (normalized === '') return true;
  // Jinja トークンを含む値は描画時に実値へ置き換わる。ここで「トークンで始まるなら
  // 無条件で通す」としていた版は `{{''}}javascript:alert(1)` を通した(実測)。トークンを
  // 空へ潰してから判定し、残りが危険なスキームを名乗るなら落とす
  // (サーバ側の `security/templateScripts.ts` の `isInertUrl` と同じ形)。
  const stripped = normalized.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g, '');
  if (stripped !== normalized) return stripped === '' || isAllowedUrlValue(stripped);
  const lower = normalized.toLowerCase();
  if (lower.startsWith('#')) return true;
  if (lower.startsWith('//')) return false; // scheme 相対 = 外部
  if (lower.startsWith('data:')) return ALLOWED_DATA_URL_PREFIXES.some((p) => lower.startsWith(p));
  const colon = lower.indexOf(':');
  if (colon < 0) return true; // 相対参照
  const slash = lower.search(/[/?#]/);
  if (slash >= 0 && slash < colon) return true; // `a/b:c` = path の中の `:`
  const scheme = lower.slice(0, colon);
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && ALLOWED_URL_SCHEMES.has(scheme);
}

/** 要素名(namespace 込み)が canvas に置いてよいか。 */
function isAllowedElement(node: ParsedHtmlNode): boolean {
  const name = (node.tagName ?? '').toLowerCase();
  if (name === '') return false;
  return node.namespaceURI === SVG_NS ? ALLOWED_SVG_TAGS.has(name) : ALLOWED_HTML_TAGS.has(name);
}

/**
 * GrapesJS のパース済みツリーを許可リストで刈る(その場で書き換える)。
 * `parse:html:root` フックから呼び、component 化される前のツリーを刈る。
 *
 * 判定順に意味がある(fail closed):
 *   1. element 以外(テキスト/コメント/fragment/document)は素通しして子だけ再帰する。
 *   2. 要素名が許可リストに無ければ **subtree ごと**外し、その中は再帰しない。
 *   3. 属性は (a) `data-gjs-*`(prop チャネル。**最優先**で、`data-` 接頭辞の許可へ落とさない)
 *      → (b) URL 属性 → (c) 完全名/接頭辞 の順に判定する。
 *
 * 文字列へ戻さないのが重要: 編集 canvas の HTML は Jinja chip(`data-jinja` 等)と
 * `{% for %}` を吸収した属性を持ち、DOM 再直列化を挟むと table の foster parenting や
 * 実体参照の再エンコードで差分が出る(`jinjaMask.ts` が避けている経路)。
 */
export function pruneCanvasActiveContent(root: ParsedHtmlNode, opts: PruneOptions): PruneReport {
  const report: PruneReport = { droppedElements: [], droppedAttrs: [], droppedCount: 0 };
  const note = (bucket: string[], name: string): void => {
    report.droppedCount++;
    if (bucket.length < REPORT_LIMIT) bucket.push(name);
  };

  const pruneAttrs = (attrs: Record<string, string>): void => {
    for (const name of Object.keys(attrs)) {
      const lower = name.toLowerCase();
      if (lower.startsWith(GJS_PREFIX)) {
        // 捕まえるのは小文字化した名前で広く、通すのは元の名前が正確に一致するものだけ。
        // GrapesJS 側の prop 名解決は完全一致の小文字接頭辞しか剥がさないので、この
        // 非対称が「GrapesJS は prop として読むのに prune は素通し」の隙間を埋める。
        if (name === ALLOWED_GJS_ATTR && opts.allowedGjsTypes.has(attrs[name])) continue;
        delete attrs[name];
        note(report.droppedAttrs, lower);
        continue;
      }
      const isUrlAttr = URL_ATTRS.has(lower) || URL_ATTRS.has(splitNsName(lower).local);
      const ok = isUrlAttr
        ? isAllowedAttrName(lower) && isAllowedUrlValue(attrs[name])
        : isAllowedAttrName(lower);
      if (ok) continue;
      delete attrs[name];
      note(report.droppedAttrs, lower);
    }
  };

  const visit = (node: ParsedHtmlNode): void => {
    if (node.nodeType === NODE_TYPE_ELEMENT && node.attributes) pruneAttrs(node.attributes);
    const kids = node.childNodes;
    if (!kids) return;
    const kept = kids.filter((kid) => {
      if (kid.nodeType !== NODE_TYPE_ELEMENT) return true;
      if (isAllowedElement(kid)) return true;
      note(report.droppedElements, (kid.tagName ?? '?').toLowerCase());
      return false;
    });
    if (kept.length !== kids.length) node.childNodes = kept;
    for (const kid of kept) visit(kid);
  };

  visit(root);
  return report;
}
