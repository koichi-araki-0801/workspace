// =============================================================================
// svg_export/values.ts — SVG へ書き出す値のエスケープと形式検証
// =============================================================================
// SVG 属性を組み立てる手段をここ 1 つ (`attr`) に絞る。以前は「エスケープすべき属性」を
// 列挙する形で、同じ 1 行の中で `font-family` は escape され `fill` は素通し、という
// 非対称が生まれていた (`--font-weight '400" onload="alert(1)'` で全 `<text>` に onload が
// 付く実測済みの穴)。列挙は必ず漏れるので、**属性を書く手段そのものを 1 つにして
// 「その関数を使っていない箇所」を grep で機械検出できる形**へ反転する。
//
// エスケープだけでは足りない値がある。`font.ts` が組む `@font-face{...}` は属性ではなく
// CSS 宣言で、CSS の文脈では `"` を閉じて `;` で次の宣言へ移れる (XML エスケープは無力)。
// **CSS へ入る値 — 色・font-weight・埋め込みフォント名 — は形式の許可リストが唯一の防御**
// であり、`assertSvgColor` / `assertFontWeight` / `assertFontFamilyName` がそれを担う。
//
// ファイル内構成:
//   1. escapeXml — XML 1.0 不正文字の除去 + 特殊文字エスケープ
//   2. attr — 属性 1 個の直列化 (唯一の入口)
//   3. 値の許可リスト — 色 / font-weight / フォント名

// ── 1. escapeXml ──

/**
 * XML 1.0 が禁じる文字 (U+0000-U+0008 / U+000B / U+000C / U+000E-U+001F と孤立サロゲート)。
 * Excel セルや DB 値に 1 文字混じるだけで出力 SVG 全体がパース不能になり、`verify/svg.ts`
 * は整形式性を見ないので検証段でも検出されない。除去はエスケープの**前**に行う
 * (「不正文字を落としてから XML としてエスケープする」の順が説明できる)。
 * サロゲートは UTF-16 コードユニット単位で判定する。
 */
const XML_INVALID_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** XML 1.0 として出力できない文字を含むか(除去されると内容が変わる = 検出したい形)。 */
export function hasXmlInvalidChars(value: string): boolean {
  XML_INVALID_RE.lastIndex = 0;
  return XML_INVALID_RE.test(value);
}

/** SVG に安全に埋め込めるよう XML 不正文字を落とし特殊文字をエスケープ。 */
export function escapeXml(value: unknown): string {
  return String(value)
    .replace(XML_INVALID_RE, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// ── 2. attr ──

/**
 * SVG 属性 1 個を ` name="value"` の形で直列化する。**SVG 属性はこの関数経由でのみ書く**
 * — テンプレートリテラルで `x="${v}"` と組む箇所を残すと、そこが次の注入点になる。
 *
 * 出力バイトの不変則: 値は `String(value)` 相当で、数値の文字列化・空白の入り方を
 * 一切変えない (`out/_baseline` との byte-diff が鉄則)。**属性の出現順も変えないこと**
 * — `verify/svg.ts` の正規表現が並び順に依存している。
 */
export function attr(name: string, value: string | number): string {
  return ` ${name}="${escapeXml(value)}"`;
}

// ── 3. 値の許可リスト ──

/**
 * CSS の名前付き色 (CSS Color Module Level 4 の 148 語 + `transparent`)。正規表現で
 * 近似せず固定集合で持つ — 近似は必ず余計な形を通す。
 */
const NAMED_COLORS: ReadonlySet<string> = new Set([
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'transparent',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]);

/** hex 表記 (3/4/6/8 桁)。 */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * SVG paint として受理する色か。**`rgb()` / `hsl()` / `url(#x)` は許さない**:
 * 関数記法は CSS 経路で `rgb(0,0,0);x:y` と宣言を増やせ、`url()` は外部参照と
 * `javascript:` の入口になる。hex + 名前付き色 + `none` + `currentColor` で帳票の
 * 運用要件は満たせる。
 */
export function isSvgColor(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (HEX_COLOR_RE.test(value)) return true;
  return NAMED_COLORS.has(value.toLowerCase()) || value === 'none' || value === 'currentColor';
}

/** 色でなければ throw する (既定色へ黙って落とさない — 帳票では無警告の誤出力が最悪)。 */
export function assertSvgColor(label: string, value: unknown): string {
  if (isSvgColor(value)) return value as string;
  throw new Error(
    `${label} に SVG の色として受理できない値が渡されました: ${JSON.stringify(value)}。` +
      ' 受理するのは #rgb / #rgba / #rrggbb / #rrggbbaa / CSS 名前付き色 / none /' +
      ' currentColor です (rgb() hsl() url() は CSS 注入の経路になるため不可)。',
  );
}

/**
 * `font-weight` の受理集合。**正規表現でなく完全一致の Set で書く** — JS の `$` は
 * 既定で末尾改行の直前にも一致するため `/^\d{3}$/` は `'400\n'` を通す。
 */
const FONT_WEIGHTS: ReadonlySet<string> = new Set([
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  'normal',
  'bold',
]);

export function assertFontWeight(label: string, value: unknown): string {
  if (typeof value === 'string' && FONT_WEIGHTS.has(value)) return value;
  throw new Error(
    `${label} に font-weight として受理できない値が渡されました: ${JSON.stringify(value)}。` +
      ` 受理するのは ${[...FONT_WEIGHTS].join(' / ')} のいずれかです。`,
  );
}

/**
 * 埋め込みフォント名の許可リスト。この値は `font.ts` の `@font-face{font-family:"…"}`
 * = CDATA 内の CSS へ入るため、`"` で宣言を閉じる形も `]]>` で CDATA を閉じる形も
 * 潰す必要がある。Unicode 文字・数字・空白・ハイフン・アンダースコアのみを許す。
 */
const FONT_FAMILY_NAME_RE = /^[\p{L}\p{N} _-]{1,64}$/u;

export function assertFontFamilyName(label: string, value: unknown): string {
  if (typeof value === 'string' && FONT_FAMILY_NAME_RE.test(value)) return value;
  throw new Error(
    `${label} に埋め込みフォント名として受理できない値が渡されました: ${JSON.stringify(value)}。` +
      ' 受理するのは Unicode 文字・数字・空白・ハイフン・アンダースコア (64 文字以内) です' +
      ' (CSS/CDATA へ素通しするため記号は許可しません)。',
  );
}
