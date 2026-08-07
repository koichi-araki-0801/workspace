// =============================================================================
// templateScripts.ts — テンプレの能動コンテンツ面を抽出し「生成時から不変」を強制する
// =============================================================================
// テンプレの JavaScript は正当なコンテンツである(列幅自動調整など、開発者が生成時に
// 埋め込む)。したがって守り方は除去(sanitize)ではなく「出所の固定」= 生成時に確定した
// 能動コンテンツが、編集・申請・承認・ペア転写のどの経路でも変わらないことをサーバが照合する。
// 承認者は実行結果しか見ない運用のため、この照合が実効的な防壁になる。
//
// **抽出は許可リストで書く。危険物の数え上げ(denylist)にしない。**
// 初版は script 要素 / `on*` 属性 / 生の `javascript:` の 3 形態だけを数えており、
// `<iframe srcdoc="&lt;script&gt;…">`・`<iframe src="data:text/html;base64,…">`・
// `<svg><animate to="javascript&#58;…">`・`<meta http-equiv=refresh>`・
// `<style>@import url(…)</style>` がいずれも素通りした(実測)。列挙は必ず漏れる。
// そこで「通してよい要素・属性・URL スキーム」を数え、**それ以外は全部**能動コンテンツ面の
// 単位(unit)として拾う方式へ反転した。
//
// 過剰包含は害にならない。基準側(生成物 / 確定ファイル)と提出側を**同じ関数**へ通して
// 単位列を突き合わせるだけなので、余計に拾った要素は両側に同じだけ現れて一致する。
// 逆に見落としは即「承認を経ない実行面の追加」を許す。よって迷ったら拾う側へ倒す。
//
// 単位は生の文字列ではなく**正規化した射影**(タグ名 + 属性名 = 復号済み値を名前順)にする。
// 生テキストで比べると、GrapesJS の再直列化で属性順や引用符が動いただけで正当な保存が
// 拒否される(誤検知は運用を止め、結果として検査ごと外される圧力になる)。

import { decodeHtmlEntities, findExternalRefsInCss, forbidden } from '@editor/shared';

// ── 1. round-trip 用に退避された属性の復号 ──

/**
 * round-trip 用に base64 で退避されている属性。`web/src/lib/jinjaAttrs.ts` と対の定義で、
 * どれも `toTemplate` が**逐語復元**するため「任意バイト列の窓」になる。チップの見た目
 * (ラベル)は信用できないので、照合前に必ず復号した実体へ展開する。
 */
const ENCODED_ATTRS = [
  'data-opaque',
  'data-jinja',
  'data-jinja-block',
  'data-jinja-open',
  'data-jinja-close',
] as const;

const ENCODED_ATTR_RE = new RegExp(
  `(?:${ENCODED_ATTRS.join('|')})\\s*=\\s*(?:"([A-Za-z0-9+/=\\s]*)"|'([A-Za-z0-9+/=\\s]*)')`,
  'gi',
);

// チップの中に更にチップが入る形(復号結果がまた base64 属性を含む)を想定して繰り返す。
// 上限を置くのは、自己参照する入力で無限ループさせないため(超えた分は展開せず、
// 展開しきれなかった入力は基準側と一致しないので拒否側に倒れる)。
const MAX_DECODE_DEPTH = 4;

function decodeBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, '');
  if (compact === '') return '';
  try {
    return Buffer.from(compact, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

interface ChipPayload {
  /** 退避属性が在った位置(除去後テキストでの索引)。単位の並び順を保つために持つ。 */
  at: number;
  decoded: string;
}

/**
 * 退避属性を**テキストから取り除き**、その中身を位置つきの別ストリームとして返す。
 * 復号結果をその場へ差し込まないのは、payload が本文相当(`{{ fund.name }}` 等)のときに
 * 「タグの内側にテキストが入り込んだ」壊れた形になり、タグ走査が基準側と別解釈をするため。
 */
function splitEncodedChips(html: string): { text: string; payloads: ChipPayload[] } {
  const payloads: ChipPayload[] = [];
  let out = '';
  let last = 0;
  ENCODED_ATTR_RE.lastIndex = 0;
  for (let m = ENCODED_ATTR_RE.exec(html); m !== null; m = ENCODED_ATTR_RE.exec(html)) {
    const decoded = decodeBase64(m[1] ?? m[2] ?? '');
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (decoded !== null && decoded !== '') payloads.push({ at: out.length, decoded });
  }
  out += html.slice(last);
  return { text: out, payloads };
}

/**
 * 退避属性を復号後の実体へ**その場で**置き換えた走査用テキスト。単位抽出そのものは
 * `splitEncodedChips` を使う(こちらは診断とテスト用の可視化)。
 */
export function expandEncodedChips(html: string): string {
  let text = html;
  for (let depth = 0; depth < MAX_DECODE_DEPTH; depth++) {
    let changed = false;
    text = text.replace(ENCODED_ATTR_RE, (whole, dq?: string, sq?: string) => {
      const decoded = decodeBase64(dq ?? sq ?? '');
      if (decoded === null || decoded === '') return whole;
      changed = true;
      return `\n${decoded}\n`;
    });
    if (!changed) break;
  }
  return text;
}

// ── 2. HTML 実体参照の復号 ──

/**
 * 属性値・CSS 値の比較前に実体参照を解く。`javascript&#58;alert(1)` や
 * `&lt;script&gt;` のように、パーサが解いてから解釈するものを解かずに比べると
 * 「基準に無い実行面」を実体参照の衣で通せる。
 *
 * 実装は `@editor/shared` の `decodeHtmlEntities` **1 本**に寄せる。ここに私有の複製を
 * 置いていた版では、外部参照ゲート(`security/externalRefs.ts` が呼ぶ
 * `findExternalRefsInTag`)が復号を**しない**まま判定しており、`&#104;ttps://evil/x` は
 * 不変性照合には掛かるのに 400 ゲートは素通りする、という非対称ができていた。
 * 復号器が 1 つなら、その形の食い違いを構造的に作れない。
 */
const decodeEntities = decodeHtmlEntities;

// ── 3. 許可リスト ──

/**
 * 能動コンテンツを持たない(= 単位を作らない)要素。ここに**無い**要素は開始タグ丸ごとが
 * 単位になる。`iframe`/`object`/`embed`/`frame`/`link`/`base`/`form`/`use`/`image`/
 * `animate` 系・`foreignObject` などを「足し忘れる」ことが構造的に起きない向きである。
 * `script` と `style` は専用の扱い(下記)。
 */
const INERT_ELEMENTS = new Set([
  // 文書骨格・テキスト
  'html',
  'head',
  'body',
  'title',
  'meta',
  'div',
  'span',
  'p',
  'br',
  'wbr',
  'hr',
  'a',
  'img',
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
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'mark',
  'abbr',
  'cite',
  'q',
  'blockquote',
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'del',
  'ins',
  'time',
  'address',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'hgroup',
  'ruby',
  'rt',
  'rp',
  'bdi',
  'bdo',
  // SVG の静的描画サブセット(テンプレのグラフは固定ジオメトリの inline svg)。
  // `use` / `image` / `foreignObject` / `animate` 系 / `a` (xlink) は**入れない**。
  'svg',
  'g',
  'defs',
  'symbol',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'desc',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'pattern',
  'marker',
]);

/**
 * 内容をタグとして解釈せず、終了タグまで読み飛ばす要素。
 *
 * **不変則: 読み飛ばした範囲は必ず単位化すること。** ここに載る要素は下の `collectInto` が
 * 中身を単位へ変換する専用分岐を持つ(`script` = 本文丸ごと 1 単位 / `style` = CSS の外部
 * 参照を単位化)。単位化しない要素をここへ足すと、その内側が単位抽出から**完全に消える**。
 *
 * 実際に `title` と `textarea` を載せていた版が破れていた: HTML の `<title>` が RCDATA
 * なのは HTML 名前空間の場合だけで、SVG の foreign content では普通の外来要素である。
 * `<svg><title><script>…</script></title></svg>` は Chromium で実行されるのに単位ゼロで
 * 通った(`<svg><title><style>@import url(…)` も同様)。よって両者はここから外し、素の
 * マークアップとして走査する。HTML 名前空間では実行されない字面まで拾うことになるが、
 * 過剰包含は基準側にも同じだけ現れるので害にならない(ファイル冒頭の方針どおり)。
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * 能動性を持たない属性。ここに**無い**属性は単位になる。`on*`(既知/未知を問わず)・
 * `srcdoc`・`http-equiv`・`formaction`・`xlink:href`・`attributeName`/`to`/`from`/`values`
 * (SVG アニメーション)などは自動的に単位側へ落ちる。
 * `data-*` / `aria-*` / `xml:*` は接頭辞で許す(いずれもブラウザが実行しない)。
 */
const INERT_ATTRS = new Set([
  'class',
  'id',
  'style',
  'title',
  'lang',
  'dir',
  'role',
  'charset',
  'name',
  'content',
  'alt',
  'src',
  'href',
  'rel',
  'type',
  'media',
  'width',
  'height',
  'colspan',
  'rowspan',
  'span',
  'align',
  'valign',
  'border',
  'cellpadding',
  'cellspacing',
  'start',
  'value',
  'hidden',
  'translate',
  'datetime',
  'reversed',
  'loading',
  'decoding',
  'referrerpolicy',
  // SVG の描画属性(値は幾何・配色で、参照は `url(#id)` の局所断片のみ)
  'viewbox',
  'preserveaspectratio',
  'xmlns',
  'version',
  'transform',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'display',
  'visibility',
  'overflow',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  'word-spacing',
  'paint-order',
  'shape-rendering',
  'vector-effect',
  'clip-path',
  'clip-rule',
  'mask',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'patternunits',
  'patterntransform',
  'markerwidth',
  'markerheight',
  'refx',
  'refy',
  'orient',
]);

const INERT_ATTR_PREFIXES = ['data-', 'aria-', 'xml:'];

/**
 * URL を値に取る属性。許可属性であっても値のスキームを別途検査する — `href`/`src` は
 * 正当な用途があるが `javascript:` / `data:text/html` を載せれば実行面になる。
 */
const URL_ATTRS = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'cite',
  'ping',
  'longdesc',
  'xlink:href',
]);

/**
 * 値として許すスキーム。相対 URL(スキーム無し)はここを素通りする。`data:` は
 * 画像とフォントに限る(`data:text/html` は実行面そのもの)。
 */
const INERT_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const INERT_DATA_MEDIA = /^(image|font)\//;

// ── 4. タグ走査 ──

interface ParsedAttr {
  name: string;
  value: string;
}

interface ParsedTag {
  at: number;
  /** 開始タグの直後(内容の先頭)。raw text 要素の内容取り出しに使う。 */
  contentAt: number;
  name: string;
  attrs: ParsedAttr[];
  /** タグ内に現れた Jinja 断片(`{{ … }}` / `{% … %}` / `{# … #}`)。 */
  jinja: string[];
}

const TAG_TERMINATORS = new Set([' ', '\t', '\n', '\r', '\f', '/', '>', '=']);

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** タグ内の Jinja 断片を読み飛ばす。読めたら閉じ位置を、閉じていなければ `-1` を返す。 */
function jinjaEnd(text: string, at: number): number {
  const open = text.slice(at, at + 2);
  const close = open === '{{' ? '}}' : open === '{%' ? '%}' : open === '{#' ? '#}' : null;
  if (close === null) return -1;
  const e = text.indexOf(close, at + 2);
  return e < 0 ? -1 : e + 2;
}

/**
 * `<!--` で始まるコメントの終端(終端記号の直後)を返す。
 *
 * HTML のコメントは `-->` **と `--!>` の両方**で終わり、`<!-->` / `<!--->` は開いた直後に
 * 閉じる(abrupt closing)。`-->` だけを見ていた版は `<!-- a --!><script>…</script>-->` を
 * 「コメント 1 個」と読み、中の `<script>` を単位ゼロで申請・承認へ通した(ブラウザは
 * `--!>` でコメントを閉じるので、確定テンプレでは実行される)。
 *
 * ⚠ 本ファイルの走査器は手書きで、仕様準拠パーサではない。本筋は基準側・提出側の両方を
 * 仕様準拠パーサで DOM 化して実行面を列挙することだが、ここは申請ゲートの中核で
 * 「単位列が動く = 正当な保存が止まる」ため、今回は既知の乖離(コメント終端・終了タグの
 * 直後文字)を塞ぐに留める。パーサ化は別途評価する。
 */
function commentEnd(text: string, lt: number): number {
  // `<!-->` / `<!--->` は開始直後に閉じる。
  if (text.startsWith('<!-->', lt)) return lt + 5;
  if (text.startsWith('<!--->', lt)) return lt + 6;
  const a = text.indexOf('-->', lt + 4);
  const b = text.indexOf('--!>', lt + 4);
  if (a < 0 && b < 0) return -1;
  if (a < 0) return b + 4;
  if (b < 0) return a + 3;
  return a < b ? a + 3 : b + 4;
}

/**
 * raw text 要素(`script` / `style`)の終了タグの `<` 位置を返す(無ければ `-1`)。
 *
 * `</script` の前方一致だけでは足りない。HTML のトークナイザは終了タグ名の直後が
 * 空白 / `/` / `>` のときにだけ終了タグとみなすので、`</scriptx>` は**本文の一部**である。
 * 前方一致で切っていた版は `<script>init()</scriptx>/;evil()</script>` の本文を
 * `init()` と読み、基準と一致させたまま `evil()` を確定テンプレへ通した。
 * 判定は `inlineCss.ts` の `findRawTextEnd` と同じ規則(片方だけ緩めない)。
 *
 * ⚠ `lower`(= `text` 全体の小文字化コピー)は**呼び出し側が 1 回だけ作って渡す**。
 * ここで `text.toLowerCase()` していた版は script/style 1 つにつき入力全体のコピーを
 * 作り、`collectInto` は `scanOpenTags` と `rawTextOf` の双方から呼ぶので要素あたり
 * 概ね 2 コピーだった。`'<style></style>'` の反復を `POST /api/review-requests` に
 * 載せるだけで、`submitReview` 冒頭の同期区間がイベントループを恒久停止させる。
 * `inlineCss.findRawTextEnd` と同じ欠陥で、直すときは両方直すこと。
 */
function rawTextEnd(text: string, lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let i = from;
  while (i < lower.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) return -1;
    const after = text[at + needle.length];
    if (after === undefined || isSpace(after) || after === '/' || after === '>') return at;
    i = at + needle.length;
  }
  return -1;
}

/**
 * 開始タグだけを順に取り出す簡易走査。**HTML パーサではない**(整形式でない入力でも
 * 止まらず、拾いすぎる方へ倒れる)。終了タグ・コメント・doctype は読み飛ばす。
 */
function* scanOpenTags(text: string, lower: string): Generator<ParsedTag> {
  const len = text.length;
  let i = 0;
  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return;
    const next = text[lt + 1] ?? '';
    if (next === '!') {
      if (text.startsWith('<!--', lt)) {
        // コメントは `-->` / `--!>` まで(`commentEnd`)。閉じないコメントは読み飛ばさず
        // **中身を走査する**(fail closed) — 閉じないコメントを 1 つ置くだけで以降の
        // 実行面が単位から消える形を作らないため。過剰包含は基準側にも同じだけ現れる。
        const end = commentEnd(text, lt);
        i = end > lt ? end : lt + 4;
        continue;
      }
      // doctype 等の markup declaration は `>` まで。
      const end = text.indexOf('>', lt) + 1 || len;
      i = end <= lt ? len : end;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      i = lt + 1;
      continue;
    }
    let p = lt + 1;
    while (p < len && !TAG_TERMINATORS.has(text[p] as string)) p++;
    const name = text.slice(lt + 1, p).toLowerCase();
    const attrs: ParsedAttr[] = [];
    const jinja: string[] = [];
    while (p < len) {
      while (p < len && (isSpace(text[p] as string) || text[p] === '/')) p++;
      if (p >= len) break;
      if (text[p] === '>') {
        p++;
        break;
      }
      if (text[p] === '{') {
        const e = jinjaEnd(text, p);
        if (e < 0) {
          p = len;
          break;
        }
        jinja.push(text.slice(p, e));
        p = e;
        continue;
      }
      const nameStart = p;
      while (p < len && !TAG_TERMINATORS.has(text[p] as string)) p++;
      const attrName = text.slice(nameStart, p).toLowerCase();
      while (p < len && isSpace(text[p] as string)) p++;
      let value = '';
      if (text[p] === '=') {
        p++;
        while (p < len && isSpace(text[p] as string)) p++;
        const quote = text[p];
        if (quote === '"' || quote === "'") {
          const e = text.indexOf(quote, p + 1);
          value = e < 0 ? text.slice(p + 1) : text.slice(p + 1, e);
          p = e < 0 ? len : e + 1;
        } else {
          const vs = p;
          while (p < len && !isSpace(text[p] as string) && text[p] !== '>') p++;
          value = text.slice(vs, p);
        }
      }
      if (attrName !== '') attrs.push({ name: attrName, value });
    }
    yield { at: lt, contentAt: p, name, attrs, jinja };
    // raw text 要素の内容はタグとして解釈されない。走査位置を終了タグの後ろへ進める。
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = rawTextEnd(text, lower, name, p);
      i = close < 0 ? len : close + name.length + 2;
    } else {
      i = p > lt ? p : lt + 1;
    }
  }
}

/** raw text 要素の内容(終了タグが無ければ EOF まで)。終端規則は `rawTextEnd` と共有する。 */
function rawTextOf(text: string, lower: string, tag: ParsedTag): string {
  const close = rawTextEnd(text, lower, tag.name, tag.contentAt);
  return close < 0 ? text.slice(tag.contentAt) : text.slice(tag.contentAt, close);
}

// ── 5. 単位の組み立て ──

function collapse(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizedAttrs(attrs: readonly ParsedAttr[]): string {
  return [...attrs]
    .map((a) => `${a.name}=${collapse(decodeEntities(a.value))}`)
    .sort()
    .join(' ');
}

function isInertAttrName(name: string): boolean {
  return INERT_ATTRS.has(name) || INERT_ATTR_PREFIXES.some((p) => name.startsWith(p));
}

/** Jinja のトークン(描画時に任意の文字列へ展開される部分)。 */
const JINJA_TOKEN_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;

/** 字面のスキームだけを見る素の判定。`isInertUrl` の内側でのみ使う。 */
function isInertUrlLiteral(decoded: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ブラウザが URL から除く文字域
  const compact = decoded.replace(/[\s\u0000-\u001f\u007f]/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (!m) return true; // 相対 URL・断片(`#id`)・クエリのみ
  const scheme = (m[1] as string).toLowerCase();
  if (INERT_SCHEMES.has(scheme)) return true;
  if (scheme !== 'data') return false;
  return INERT_DATA_MEDIA.test(compact.slice(m[0].length));
}

/**
 * URL 値のスキームが不活性か。制御文字・空白はブラウザ同様に落としてから判定する。
 *
 * テンプレは Jinja で描画されてから帳票パイプラインへ渡るので、**描画後の形**でも判定する。
 * `href="{{''}}javascript:alert(1)"` は字面が `{` で始まるためスキーム正規表現に当たらず、
 * 素の判定だけだと「相対 URL」として無条件に inert になっていた(実測: 単位ゼロで通る)。
 * トークンを空文字へ潰した残りにも同じ判定を掛け、どちらかが活性なら単位化する。
 */
function isInertUrl(value: string): boolean {
  const decoded = decodeEntities(value);
  if (!isInertUrlLiteral(decoded)) return false;
  const stripped = decoded.replace(JINJA_TOKEN_RE, '');
  return stripped === decoded || isInertUrlLiteral(stripped);
}

/**
 * CSS の外部参照だけを取り出す。宣言(色・寸法)の編集は単位を動かさない。
 *
 * 判定は `@editor/shared` の `findExternalRefsInCss` へ一本化する。ここに独自の正規表現
 * (`/url\(…/`)を持っていた版は `image-set("http://evil/x.png" 1x)` を単位ゼロで通し、
 * PDF 経路のゲートと**別の入力集合**を見ていた。同じ関数を共有すれば、片方だけが破れる
 * 形が構造的に作れない。
 */
function pushCssUnits(css: string, at: number, out: PositionedUnit[]): void {
  for (const ref of findExternalRefsInCss(decodeEntities(css))) {
    out.push({ at, seq: out.length, unit: `css-ref:${collapse(ref)}` });
  }
}

interface PositionedUnit {
  at: number;
  seq: number;
  unit: string;
}

function collectInto(html: string, out: PositionedUnit[], depth: number): void {
  const { text, payloads } = splitEncodedChips(html);
  // 小文字化コピーは走査 1 回につき 1 つ(`rawTextEnd` の注意書きを見よ)。
  const lower = text.toLowerCase();
  for (const tag of scanOpenTags(text, lower)) {
    if (tag.name === 'script') {
      // 中身まで含めて 1 単位。閉じタグを欠く断片も EOF まで拾う(パーサ差で
      // 「閉じていないから script ではない」と判断すると実行される断片を見逃す)。
      const body = rawTextOf(text, lower, tag);
      out.push({
        at: tag.at,
        seq: out.length,
        unit: `script:${normalizedAttrs(tag.attrs)}|${collapse(body)}`,
      });
      continue;
    }
    if (tag.name === 'style') {
      // 宣言の編集(色・寸法)はスタイルマネージャの正当な操作なので単位にしない。
      // 外部を引き込む面(`@import` / 非画像 `url()`)だけを固定する。
      pushCssUnits(rawTextOf(text, lower, tag), tag.at, out);
      // 属性(`media` 等)も見る。`style` 自体は許可要素として扱わない代わりにここで拾う。
      for (const a of tag.attrs) {
        if (!isInertAttrName(a.name)) {
          out.push({
            at: tag.at,
            seq: out.length,
            unit: `attr:style.${a.name}=${collapse(decodeEntities(a.value))}`,
          });
        }
      }
      continue;
    }
    if (!INERT_ELEMENTS.has(tag.name)) {
      // 許可要素の外。開始タグを丸ごと 1 単位にする(属性へ payload を積む形
      // — `iframe srcdoc` / `object data` / `meta http-equiv` — もここで閉じる)。
      out.push({
        at: tag.at,
        seq: out.length,
        unit: `el:${tag.name}|${normalizedAttrs(tag.attrs)}|${tag.jinja.map(collapse).join(' ')}`,
      });
      continue;
    }
    for (const a of tag.attrs) {
      if (!isInertAttrName(a.name)) {
        out.push({
          at: tag.at,
          seq: out.length,
          unit: `attr:${tag.name}.${a.name}=${collapse(decodeEntities(a.value))}`,
        });
        continue;
      }
      if (URL_ATTRS.has(a.name) && !isInertUrl(a.value)) {
        out.push({
          at: tag.at,
          seq: out.length,
          unit: `url:${tag.name}.${a.name}=${collapse(decodeEntities(a.value))}`,
        });
      }
      if (a.name === 'style') pushCssUnits(a.value, tag.at, out);
    }
    // タグ内の Jinja は描画時に任意の属性文字列へ展開されうる(`<div {{ x }}>`)。
    // 実行面の入口なので、断片そのものを固定する。
    for (const j of tag.jinja) {
      out.push({ at: tag.at, seq: out.length, unit: `jinja-attr:${tag.name}|${collapse(j)}` });
    }
  }
  if (depth >= MAX_DECODE_DEPTH) return;
  for (const p of payloads) {
    const nested: PositionedUnit[] = [];
    collectInto(p.decoded, nested, depth + 1);
    for (const n of nested) out.push({ at: p.at, seq: out.length, unit: n.unit });
  }
}

/**
 * HTML から能動コンテンツ面を順序どおりに取り出す。`data-opaque` 等の退避属性は復号済みの
 * 実体に対して走査するので、チップへ畳んだ状態で提出しても同じ結果になる。
 */
export function collectExecutableUnits(html: string): string[] {
  const out: PositionedUnit[] = [];
  collectInto(html, out, 0);
  return out.sort((a, b) => a.at - b.at || a.seq - b.seq).map((u) => u.unit);
}

// ── 6. 照合 ──

function unitsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 照合失敗時にユーザーへ返す文言。経路(申請/承認/転写)を問わず同じ案内にする。 */
export const SCRIPT_IMMUTABLE_MESSAGE =
  '実行コード・外部参照は編集できません。変更が必要なら開発者へ依頼してください';

/**
 * `submitted` の能動コンテンツ面が `baseline` と完全一致することを要求する。不一致は
 * `forbidden`(403)。基準が取れない(確定テンプレも生成物も無い)場合、呼び出し側は
 * `baselineHtml` に空文字を渡す — その場合「能動コンテンツは 1 つも持てない」に倒れる
 * (fail-closed。基準の無い実行コードを承認へ通さない)。
 *
 * 注意: 本検査は「生成時から変わっていないこと」だけを保証する。生成時に埋め込まれた
 * JS 自体の安全性は検査していない(テンプレ生成器と開発者のレビューが最後の砦)。
 * また承認画面での隔離(`sandbox="allow-scripts"`・same-origin なし)と併せて初めて
 * 多層になる — 片方だけを「承認の防壁」と位置づけないこと。
 */
export function assertTemplateScriptsUnchanged(
  baselineHtml: string,
  submittedHtml: string,
  context: { templateId: string; where: string },
): void {
  const before = collectExecutableUnits(baselineHtml);
  const after = collectExecutableUnits(submittedHtml);
  if (unitsEqual(before, after)) return;
  throw forbidden(
    `${SCRIPT_IMMUTABLE_MESSAGE} (テンプレート=${context.templateId})`,
    // 差分の中身はユーザーへ出さない(攻撃者への手掛かりになる)。ログにだけ残す。
    {
      code: 'TEMPLATE_SCRIPT_IMMUTABLE',
      cause: { where: context.where, baselineUnits: before.length, submittedUnits: after.length },
    },
  );
}
