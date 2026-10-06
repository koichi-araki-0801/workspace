// =============================================================================
// svgInspect.ts — 配信する SVG を許可リストで検査する(字句走査・fail closed)
// =============================================================================
// ファンド別画像の SVG はエディタの外のツールが置き、PDF の headless ブラウザ・画面内プレビュー・
// 編集画面の 3 経路で表示される。SVG はスクリプト・イベント属性・外部参照・アニメーションによる
// 属性の書き換えを持ち込めるので、配る前に「知っている形だけ」を通す。
//
// DOM パーサに頼らない字句走査にしているのは、サーバ(Node。DOM が無い)とブラウザで同じ判定を
// 出すため。XML として解釈しきれない入力は違反にする(fail closed) — 我々の走査とブラウザの
// XML パーサの解釈がずれる余地を残さない。属性値は XML が定義する参照(数値文字参照と 5 種の
// 実体参照)だけを許し、それを解いた値で判定する。
//
// 許可集合は SVG 1.1 の要素・属性一覧から起こし、Illustrator「書き出し(SVG 1.1)」と
// Inkscape「プレーン SVG」の通常出力が通ることを `test/svgInspect.test.ts` の見本で固定する。
// 正当な画像が落ちたときは、サーバログの警告で違反名を見て、ここの集合へ足す。
//
// 呼ぶ場所は 2 つ(配置時 `server/src/vivliostyle/docAssets.ts`、単体配信
// `server/src/routes/fundAssets.routes.ts`)。画面内プレビューは後者から取得するので同じ関所を通る。

import {
  collectCssStringsInFunctions,
  collectCssUrlSpansInContext,
  findExternalRefsInCss,
  isAllowedDataUrl,
} from './cssExternalRefs.js';
import { decodeHtmlEntities, normalizeHtmlUrlValue } from './htmlEntities.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `xmlns:<接頭辞>` として宣言を許す接頭辞と URI(完全一致)。`Map` にしているのは、利用者入力の
 * 接頭辞で引くため(`__proto__` のような名前で `Object.prototype` を引かない)。
 * `svg` は Inkscape のプレーン SVG が冗長に宣言する。`svg:` 接頭辞の要素自体は通さない。
 */
const KNOWN_NAMESPACES: ReadonlyMap<string, readonly string[]> = new Map([
  ['svg', [SVG_NS]],
  ['xlink', ['http://www.w3.org/1999/xlink']],
  ['sodipodi', ['http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd']],
  ['inkscape', ['http://www.inkscape.org/namespaces/inkscape']],
  ['rdf', ['http://www.w3.org/1999/02/22-rdf-syntax-ns#']],
  ['dc', ['http://purl.org/dc/elements/1.1/']],
  ['cc', ['http://creativecommons.org/ns#', 'http://web.resource.org/cc/']],
]);

/** 編集ツールの付帯情報。描画にも実行にも関わらないので、要素・属性とも中身を問わず通す。 */
const EDITOR_PREFIXES: ReadonlySet<string> = new Set(['sodipodi', 'inkscape']);

/** RDF メタデータの接頭辞。`<metadata>` の内側でだけ要素として通す。 */
const METADATA_PREFIXES: ReadonlySet<string> = new Set(['rdf', 'dc', 'cc']);

/** 名前で拒む要素(許可外と分けて持つのは、違反の理由を名指しするため)。 */
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'a',
  'animate',
  'set',
  'animateMotion',
  'animateTransform',
  'animateColor',
  'handler',
  'listener',
]);

/** SVG 1.1 の要素のうち通すもの(構造・図形・テキスト・塗り・クリップ・マスク・フィルタ)。 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'desc',
  'title',
  'metadata',
  'symbol',
  'use',
  'switch',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'pattern',
  'clipPath',
  'mask',
  'marker',
  'image',
  'style',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
]);

/** 値を CSS として検査する属性(SVG 1.1 のプレゼンテーション属性と、その後継の数個)。 */
const PRESENTATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-profile',
  'color-rendering',
  'cursor',
  'direction',
  'display',
  'dominant-baseline',
  'enable-background',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'image-rendering',
  'isolation',
  'kerning',
  'letter-spacing',
  'lighting-color',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'mix-blend-mode',
  'opacity',
  'overflow',
  'paint-order',
  'pointer-events',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'word-spacing',
  'writing-mode',
]);

/** 値の形を問わない SVG 1.1 の属性(幾何・単位・フィルタの係数・条件処理など)。 */
// `name` は SVG 1.1 の属性ではないが、外部ツールの出力に現れ、スクリプトも URL も持たない。
const PLAIN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'name',
  'class',
  'lang',
  'version',
  'baseProfile',
  'zoomAndPan',
  'x',
  'y',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'transform',
  'd',
  'points',
  'pathLength',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'offset',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'markerUnits',
  'markerWidth',
  'markerHeight',
  'refX',
  'refY',
  'orient',
  'filterUnits',
  'primitiveUnits',
  'filterRes',
  'in',
  'in2',
  'result',
  'mode',
  'type',
  'values',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'stdDeviation',
  'dx',
  'dy',
  'rotate',
  'textLength',
  'lengthAdjust',
  'startOffset',
  'method',
  'spacing',
  'requiredFeatures',
  'requiredExtensions',
  'systemLanguage',
  'externalResourcesRequired',
  'kernelMatrix',
  'kernelUnitLength',
  'divisor',
  'bias',
  'targetX',
  'targetY',
  'edgeMode',
  'preserveAlpha',
  'order',
  'surfaceScale',
  'diffuseConstant',
  'specularConstant',
  'specularExponent',
  'scale',
  'xChannelSelector',
  'yChannelSelector',
  'radius',
  'baseFrequency',
  'numOctaves',
  'seed',
  'stitchTiles',
  'tableValues',
  'slope',
  'intercept',
  'amplitude',
  'exponent',
  'azimuth',
  'elevation',
  'z',
  'pointsAtX',
  'pointsAtY',
  'pointsAtZ',
  'limitingConeAngle',
  'media',
  'title',
]);

/** `href` に `data:image/*`(共有の許可リスト内)を許す要素。それ以外の href は `#id` だけ。 */
const DATA_HREF_ELEMENTS: ReadonlySet<string> = new Set(['image', 'feImage']);

const NAME_RE = /[A-Za-z_][\w.:-]*/y;
const WS_RE = /\s/;
const XML_DECL_RE =
  /^\s+version\s*=\s*(["'])1\.\d+\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][\w.-]*)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\4)?\s*$/;
const DOCTYPE_RE =
  /^\s+svg(?:\s+PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')|\s+SYSTEM\s+(?:"[^"]*"|'[^']*'))?\s*$/;
/** XML が定義済みとする参照以外の `&`(未定義の実体参照・裸の `&`)。 */
const BAD_REFERENCE_RE = /&(?!(?:#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot|apos);)/;

const BOM = '﻿';

/** 報告する違反の上限。これに達したら走査を打ち切る(悪意ある入力で時間を使わせない)。 */
const MAX_VIOLATIONS = 50;

interface SvgAttr {
  name: string;
  raw: string;
}

interface StartTag {
  name: string;
  attrs: SvgAttr[];
  selfClosing: boolean;
  end: number;
}

type Report = (message: string) => void;

/**
 * SVG 文書を検査し、違反の説明を返す(空配列 = 合格)。`text` は UTF-8 として読んだ文字列。
 * UTF-8 として読めないバイト列(U+FFFD)・NUL・UTF-8 以外の encoding 宣言は違反にする。
 */
export function inspectSvg(text: string): string[] {
  const found: string[] = [];
  // 重複の判定は Set で行う(配列の `includes` だと、名前の違う違反を大量に並べた入力で二乗時間になる)。
  const seen = new Set<string>();
  const add: Report = (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    found.push(message);
  };
  if (text.includes('\u0000')) add('NUL 文字を含む(UTF-16 などの可能性)');
  if (text.includes('�') || text.startsWith('￾')) add('UTF-8 として読めない');
  if (/<!ENTITY/i.test(text)) add('<!ENTITY 宣言');
  if (found.length > 0) return found;

  const stack: string[] = [];
  let pos = text.startsWith(BOM) ? 1 : 0;
  let sawRoot = false;
  let sawDoctype = false;
  let metadataDepth = 0;
  /** `<style>` の中にいる間だけ文字列(中身を CSS として集める)。外では null。 */
  let styleText = null as string | null;

  if (text.startsWith('<?xml', pos) && WS_RE.test(text.charAt(pos + 5))) {
    const end = text.indexOf('?>', pos);
    if (end < 0) {
      add('閉じていない XML 宣言');
      return found;
    }
    const decl = XML_DECL_RE.exec(text.slice(pos + 5, end));
    if (decl === null) add('解釈できない XML 宣言');
    else if (decl[3] !== undefined && decl[3].toLowerCase() !== 'utf-8') {
      add(`UTF-8 以外の encoding 宣言(${decl[3]})`);
    }
    pos = end + 2;
  }

  const takeText = (chunk: string): void => {
    if (BAD_REFERENCE_RE.test(chunk)) add('定義されていない実体参照');
    if (stack.length === 0) {
      if (chunk.trim() !== '') add('ルート要素の外の文字');
      return;
    }
    if (styleText !== null) styleText += decodeHtmlEntities(chunk);
  };

  const openElement = (tag: StartTag): void => {
    if (stack.length === 0) {
      if (sawRoot) add('ルート要素が 2 つ以上');
      if (tag.name !== 'svg') add(`ルート要素が svg ではない <${tag.name}>`);
      sawRoot = true;
    }
    if (styleText !== null) add('style 要素の中の要素');
    checkElement(tag.name, metadataDepth > 0, add);
    const foreign = tag.name.includes(':');
    for (const attr of tag.attrs) checkAttribute(tag.name, attr, foreign, add);
    if (tag.selfClosing) return;
    stack.push(tag.name);
    if (tag.name === 'metadata') metadataDepth++;
    if (tag.name === 'style') styleText = '';
  };

  const closeElement = (name: string): void => {
    if (name === 'metadata') metadataDepth--;
    if (name === 'style') {
      checkCss(styleText ?? '', 'style 要素', add);
      styleText = null;
    }
  };

  while (pos < text.length) {
    // 違反が出そろった時点で打ち切る。見るべき情報は十分で、残りを走査する意味が無い。
    if (found.length >= MAX_VIOLATIONS) {
      found.push('違反が多いため以降は省略');
      return found;
    }
    const lt = text.indexOf('<', pos);
    takeText(text.slice(pos, lt < 0 ? text.length : lt));
    if (lt < 0) break;
    pos = lt;
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end < 0) {
        add('閉じていないコメント');
        return found;
      }
      pos = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      if (end < 0) {
        add('閉じていない CDATA');
        return found;
      }
      if (stack.length === 0) add('ルート要素の外の CDATA');
      if (styleText !== null) styleText += text.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    if (text.startsWith('<!DOCTYPE', pos)) {
      const gt = text.indexOf('>', pos);
      if (gt < 0) {
        add('閉じていない DOCTYPE');
        return found;
      }
      // `[` の探索はこの宣言の `>` までに限る(文書末尾まで探すと、宣言の繰り返しで二乗時間になる)。
      const bracketRel = text.slice(pos, gt).indexOf('[');
      const bracket = bracketRel < 0 ? -1 : pos + bracketRel;
      if (bracket >= 0) {
        add('DOCTYPE の内部サブセット');
        const close = text.indexOf(']>', bracket);
        if (close < 0) return found;
        pos = close + 2;
        continue;
      }
      if (sawRoot || sawDoctype) add('DOCTYPE の位置が不正');
      if (!DOCTYPE_RE.test(text.slice(pos + 9, gt))) add('外部 ID だけの DOCTYPE ではない');
      sawDoctype = true;
      pos = gt + 1;
      continue;
    }
    if (text.startsWith('<?', pos) || text.startsWith('<!', pos)) {
      add(
        text.startsWith('<?', pos) ? '処理命令(先頭の <?xml ?> 以外)' : '許可されていない宣言 <!…>',
      );
      const gt = text.indexOf('>', pos);
      if (gt < 0) return found;
      pos = gt + 1;
      continue;
    }
    if (text.startsWith('</', pos)) {
      NAME_RE.lastIndex = pos + 2;
      const m = NAME_RE.exec(text);
      const gt = text.indexOf('>', pos);
      if (m === null || gt < 0 || text.slice(NAME_RE.lastIndex, gt).trim() !== '') {
        add('解釈できない終了タグ');
        return found;
      }
      const open = stack.pop();
      if (open !== m[0]) {
        add(`対応しない終了タグ </${m[0]}>`);
        return found;
      }
      closeElement(open);
      pos = gt + 1;
      continue;
    }
    const tag = readStartTag(text, pos);
    if (typeof tag === 'string') {
      add(tag);
      return found;
    }
    openElement(tag);
    pos = tag.end;
  }
  if (stack.length > 0) add(`閉じていないタグ <${stack[stack.length - 1]}>`);
  if (!sawRoot) add('svg 要素が無い');
  return found;
}

/** 開始タグを 1 つ読む。XML として読めない形は説明の文字列を返す(呼び出し側は走査を止める)。 */
function readStartTag(text: string, at: number): StartTag | string {
  NAME_RE.lastIndex = at + 1;
  const m = NAME_RE.exec(text);
  if (m === null) return '解釈できないタグ';
  const name = m[0];
  let p = NAME_RE.lastIndex;
  const attrs: SvgAttr[] = [];
  const names = new Set<string>();
  for (;;) {
    const before = p;
    while (p < text.length && WS_RE.test(text[p])) p++;
    if (p >= text.length) return `閉じていないタグ <${name}>`;
    if (text[p] === '>') return { name, attrs, selfClosing: false, end: p + 1 };
    if (text.startsWith('/>', p)) return { name, attrs, selfClosing: true, end: p + 2 };
    if (p === before) return `属性の前に空白が無い <${name}>`;
    NAME_RE.lastIndex = p;
    const an = NAME_RE.exec(text);
    if (an === null) return `解釈できない属性 <${name}>`;
    const attrName = an[0];
    p = NAME_RE.lastIndex;
    while (p < text.length && WS_RE.test(text[p])) p++;
    if (text[p] !== '=') return `値の無い属性 ${attrName}`;
    p++;
    while (p < text.length && WS_RE.test(text[p])) p++;
    const quote = text[p];
    if (quote !== '"' && quote !== "'") return `引用符の無い属性値 ${attrName}`;
    const close = text.indexOf(quote, p + 1);
    if (close < 0) return `閉じていない属性値 ${attrName}`;
    const raw = text.slice(p + 1, close);
    if (raw.includes('<')) return `属性値に < を含む ${attrName}`;
    if (names.has(attrName)) return `重複した属性 ${attrName}`;
    names.add(attrName);
    attrs.push({ name: attrName, raw });
    p = close + 1;
  }
}

function checkElement(name: string, inMetadata: boolean, add: Report): void {
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const prefix = name.slice(0, colon);
    if (EDITOR_PREFIXES.has(prefix) || (inMetadata && METADATA_PREFIXES.has(prefix))) return;
    add(`許可されていない要素 <${name}>`);
    return;
  }
  if (FORBIDDEN_ELEMENTS.has(name)) add(`禁止された要素 <${name}>`);
  else if (!ALLOWED_ELEMENTS.has(name)) add(`許可されていない要素 <${name}>`);
}

/**
 * 属性 1 つを検査する。`foreign` は編集ツール・RDF の要素で、接頭辞なしの属性は中身を問わない
 * (描画も実行もされない)。イベント属性・名前空間宣言・href はどの要素でも同じ規則で見る。
 */
function checkAttribute(el: string, attr: SvgAttr, foreign: boolean, add: Report): void {
  const { name, raw } = attr;
  if (BAD_REFERENCE_RE.test(raw)) add(`定義されていない実体参照(${name})`);
  const value = decodeHtmlEntities(raw);
  const colon = name.indexOf(':');
  const prefix = colon >= 0 ? name.slice(0, colon) : '';
  const local = colon >= 0 ? name.slice(colon + 1) : name;
  if (local.toLowerCase().startsWith('on')) {
    add(`イベント属性 ${name}`);
    return;
  }
  if (name === 'xmlns') {
    if (value !== SVG_NS) add('既定の名前空間が SVG ではない');
    return;
  }
  if (prefix === 'xmlns') {
    if (!(KNOWN_NAMESPACES.get(local) ?? []).includes(value)) {
      add(`許可されていない名前空間宣言 ${name}`);
    }
    return;
  }
  if (name === 'href' || name === 'xlink:href') {
    checkHref(el, raw, add);
    return;
  }
  if (prefix === 'xml') {
    if (local !== 'space' && local !== 'lang') add(`許可されていない属性 ${name}`);
    return;
  }
  if (prefix !== '') {
    if (name === 'xlink:title' || EDITOR_PREFIXES.has(prefix) || METADATA_PREFIXES.has(prefix)) {
      return;
    }
    add(`許可されていない属性 ${name}`);
    return;
  }
  if (name.startsWith('data-') || foreign) return;
  if (name === 'style' || PRESENTATION_ATTRIBUTES.has(name)) {
    checkCss(value, `${name} 属性`, add);
    return;
  }
  if (el === 'style' && name === 'type') {
    if (value.trim().toLowerCase() !== 'text/css') add('style 要素の type が text/css ではない');
    return;
  }
  if (!PLAIN_ATTRIBUTES.has(name)) add(`許可されていない属性 ${name}`);
}

/**
 * href は文書内の `#id` だけ。`<image>` / `<feImage>` に限り共有の許可リストの画像 data URI を
 * 許す。`raw` は復号前の値を渡す(`normalizeHtmlUrlValue` が 1 回だけ復号する。2 回解くと
 * `&amp;#35;x` が `#x` に化けて、ブラウザと違う値を判定してしまう)。
 */
function checkHref(el: string, raw: string, add: Report): void {
  const v = normalizeHtmlUrlValue(raw);
  if (v.startsWith('#')) return;
  if (DATA_HREF_ELEMENTS.has(el) && /^data:image\//i.test(v) && isAllowedDataUrl(v)) return;
  add(`外部を指す href(<${el}>)`);
}

/**
 * 埋め込みフォントの値か。`data:font/` だけで、SVG フォント(`data:font/svg…`)は文書として扱われ
 * うるので除く。フラグメント(`#`)を含むものも除く。
 */
function isEmbeddedFontData(v: string): boolean {
  const lower = v.trim().toLowerCase();
  return (
    lower.startsWith('data:font/') && !lower.startsWith('data:font/svg') && !lower.includes('#')
  );
}

/**
 * 引数の引用符の文字列が URL にならない関数。`image-set("x.png" 1x)` のように文字列で URL を取る
 * 関数があるので、関数の中の文字列は既定で URL 候補として扱い、ここに載る関数だけを外す
 * (知らない関数は違反の側へ倒れる)。前半は `@font-face` の `src` と `content` の関数、後半は
 * セレクタの関数で、値の関数としては存在しない名前(`:not([class="x"])` を落とさないため)。
 */
const STRING_ARG_SAFE_FUNCTIONS = new Set([
  'format',
  'local',
  'tech',
  'counter',
  'counters',
  'attr',
  'not',
  'is',
  'where',
  'has',
  'lang',
]);

/**
 * CSS(`<style>` の中身・`style` 属性・プレゼンテーション属性)の `url()` は `#id` だけ。例外は
 * `<style>` 要素の最上位 `@font-face` の `src` 記述子に置いた `data:font/…`(pdf-to-svg・pie-chart
 * が埋め込む)だけで、それ以外の文脈の data URI は通さない。外部参照の判定は検査・配置と同じ
 * トークナイザ(`findExternalRefsInCss`)に任せ、エスケープで隠した `url(\68ttp://…)` もそこで
 * 捕まえる。
 *
 * 関数の引数の引用符の文字列も同じく `#id` だけ(data URI の例外も無い)。URL にならない関数の
 * 許可リストは `STRING_ARG_SAFE_FUNCTIONS`。`var()` で関数の中へ差し込めるカスタムプロパティと
 * `initial-value` の値の文字列も対象にする(`collectCssStringsInFunctions`)。
 */
function checkCss(css: string, where: string, add: Report): void {
  if (findExternalRefsInCss(css).length > 0) add(`外部参照を含む CSS(${where})`);
  const allowFont = where === 'style 要素';
  const bad = collectCssUrlSpansInContext(css).some((span) => {
    if (span.value.trim().startsWith('#')) return false;
    return !(allowFont && span.inFontFaceSrc && isEmbeddedFontData(span.value));
  });
  if (bad) add(`url() が #id 以外を指す(${where})`);
  const badString = collectCssStringsInFunctions(css).some(
    (s) => !STRING_ARG_SAFE_FUNCTIONS.has(s.fn) && !s.value.trim().startsWith('#'),
  );
  if (badString) add(`引用符の文字列が #id 以外を指す(${where})`);
}
