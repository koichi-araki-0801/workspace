// =============================================================================
// templateScripts.ts — テンプレの能動コンテンツ面を抽出し「生成時から不変」を強制する
// =============================================================================
// テンプレの JavaScript は正当なコンテンツである(列幅自動調整など、開発者が生成時に
// 埋め込む)。したがって守り方は除去(sanitize)ではなく「出所の固定」= 生成時に確定した
// 能動コンテンツが、編集・申請・承認・ペア転写のどの経路でも変わらないことをサーバが照合する。
// 承認者は実行結果しか見ない運用のため、この照合が実効的な防壁になる。
//
// **抽出は許可リストで書く。危険物の数え上げ(denylist)にしない。**
// script 要素 / `on*` 属性 / 生の `javascript:` の 3 形態だけを数える方式では、
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
//
// ── 仕様準拠パーサへ置き換えない理由(試作して実測した)──
// 走査器は手書きで、HTML 仕様の木構築を実装していない。これを parse5 のような仕様準拠
// パーサへ置き換える案を実際に試作して差分を採ったが、**この成果物に対しては退行**だった。
//
// 検査対象は帳票の**描画前 Jinja テンプレ**であって HTML 文書ではない。仕様準拠パーサは
// 「その字面を HTML として読んだらどうなるか」に忠実だが、実行されるのは Jinja 描画後の
// 文書で、包みの方が条件分岐で消える。`{% if false %}<textarea>{% endif %}<script>…` は
// 字面上 raw text の内側だが描画後は素の `<script>` で、試作は単位ゼロで通した。同型が
// コメント・`<title>` でも成立する。加えて木構築は要素を**捨てる/移す**ので、チップ復号後の
// 断片(`<tr onclick=…>` 等)が文書文脈を持たず丸ごと消えた。
// 「script を足したのに単位へ現れない」形を数えた実測は 19 形中 手書き 2 / parse5 12。
// 残る手書きの 2 形(属性値の引用符が閉じない・重複属性)はブラウザも同じく実行しない。
//
// 逆に試作が捕まえて手書きが取りこぼしていた形(タグ内 Jinja の読み飛ばしで走査を打ち切る
// 迂回路)は**本ファイル側を直した**(`jinjaEnd` の注意書き)。つまり得られた価値は
// 「差分テストで穴を見つけること」であって「パーサへ寄せること」ではない。
// 再提案する場合は `test/templateScripts.test.ts` の
// 「描画前テンプレ特有の隠し方」を先に読むこと。
// なお `parse5` は現状 server の依存に無く、追加はオフライン重量物バンドルの再生成を伴う。
//
// ── ほかの走査器と 1 本にしない理由 ──
// 同じ理由で、PDF 経路(`vivliostyle/inlineCss.ts`)や申請の関所(`@editor/shared` の
// `editingMarkers.ts`)の走査器とも共通化しない。ここは描画前の Jinja を読み、コメントの中まで
// 走査し、raw text は `script` / `style` だけ、タグ内の Jinja を読み飛ばし、作業量の予算で打ち切った
// ら拒否する。どれもほかの走査器とは違う倒し方である(設計正典の却下済み設計「HTML の走査器を 1 本にまとめる」)。
// 共有するのは、ブラウザと同じ答えになるべき部品だけ: `@editor/shared` の `html/htmlLex.ts`(空白・
// 英字・タグ名の終わり)と `html/rawText.ts` の `findRawTextEnd`(予算は `scanned` でここが数える)。
// 属性の読み取りは共有の `readAttr` を使わない。タグ内の Jinja を属性の手前で読み飛ばすのと、
// `=` で始まる名前を空名として捨てる(`<a =x>` は単位を作らない)現行の単位列を保つため。
//
// ── 描画で生まれる実行面 ──
// 走査器は「`<` の直後が英字」の字面しか見ない。描画前の Jinja は、字面に無いタグ・URL・CSS の
// 参照を描画で生む(`{{ "<"|safe }}script>`・`href="{{ 'java' + 'script:x' }}"`・
// `style="background:{{ u }}(//evil/x)"`)。そこで走査器が返すタグと本文の範囲を使い、Jinja の
// トークン(区切りは `@editor/shared` の `lexJinja`)を文脈で分けて単位にする(`pushJinjaUnits`)。
// タグの中と CSS の中は形を問わず固定し、テキストの位置だけを許可リスト(`InertJinjaJudge`)で
// 判定する。危ない形を数え上げないのは、許可リストで書く上の方針と同じ理由である。走査器は
// 増やさない。足したのは走査器の返す範囲でトークンを分ける処理だけである。

import {
  asciiLower,
  decodeHtmlEntities,
  findExternalRefsInCss,
  findRawTextEnd,
  forbidden,
  InertJinjaJudge,
  isAsciiAlpha,
  isHtmlSpace,
  isTagNameEnd,
  type JinjaToken,
  jinjaCloserOf,
  lexJinja,
  MARKER_ATTRS,
} from '@editor/shared';

// ── 1. round-trip 用に退避された属性の復号 ──

/**
 * round-trip 用に base64 で退避されている属性。`web/src/lib/jinjaAttrs.ts` と対の定義で、
 * どれも `toTemplate` が**逐語復元**するため「任意バイト列の窓」になる。チップの見た目
 * (ラベル)は信用できないので、照合前に必ず復号した実体へ展開する。
 */
const ENCODED_ATTRS = [
  MARKER_ATTRS.opaque,
  MARKER_ATTRS.jinja,
  MARKER_ATTRS.jinjaBlock,
  MARKER_ATTRS.jinjaOpen,
  MARKER_ATTRS.jinjaClose,
] as const;

const ENCODED_ATTR_RE = new RegExp(
  `(?:${ENCODED_ATTRS.join('|')})\\s*=\\s*(?:"([A-Za-z0-9+/=\\s]*)"|'([A-Za-z0-9+/=\\s]*)')`,
  'gi',
);

// チップの中に更にチップが入る形(復号結果がまた base64 属性を含む)を想定して繰り返す。
// 上限を置くのは、自己参照する入力で無限ループさせないため。超えた分は展開しない代わりに
// 単位列の末尾へ `SCAN_INCOMPLETE_UNIT` を積み、照合は拒否側へ倒す。上限の先を黙って
// 捨てると、そこへ何を足しても単位列が変わらず、基準と一致したまま照合を通ってしまう。
const MAX_DECODE_DEPTH = 4;

/**
 * 走査に費やしてよい総バイト数の予算。入力サイズ上限(申請本文の契約上限 4 MiB)だけでは、
 * 閉じない `{{` や `<style>` の反復が開始位置ごとに末尾まで舐め直す二次爆発を止められない
 * (4 MiB 未満の入力で数百 GB 規模の走査になりうる)。走査系はこの予算を減算し、尽きたら
 * 走査を打ち切る。打ち切った入力は `SCAN_INCOMPLETE_UNIT` を積んで照合を拒否側へ倒す
 * (fail closed)。打ち切りの先は基準側でも走査されないので、単位列の一致だけでは差分を
 * 検出できない。正当なテンプレの走査コスト(入力長の数倍)を十分上回る値にしてある。
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * 走査を上限(深さ・作業量予算)で打ち切ったことを表す単位。入力の一部が単位抽出から
 * 外れたことを示し、`assertTemplateScriptsUnchanged` は提出側にこれがあれば基準との
 * 一致に関わらず拒否する。基準側も同じ上限に達する形では、上限の先の差分が両側から
 * 等しく消えて単位列が一致してしまうため、一致比較だけには任せない。
 */
const SCAN_INCOMPLETE_UNIT = 'scan-incomplete';

/** 走査中に共有する可変の作業量予算。`collectExecutableUnits` が 1 回作って配る。 */
interface ScanBudget {
  remaining: number;
  /** 深さの上限で展開・再走査を打ち切ったか。予算切れは `remaining` で判る。 */
  truncated: boolean;
}

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

// 属性値・CSS 値は比較前に `@editor/shared` の `decodeHtmlEntities` で実体参照を解く。
// `javascript&#58;alert(1)` や `&lt;script&gt;` のように、パーサが解いてから解釈するものを解かずに
// 比べると「基準に無い実行面」を実体参照の衣で通せる。外部参照ゲート(`security/externalRefs.ts`
// の `findExternalRefsInTag`)と復号器を共有するので、両者の判定が実体参照の形で食い違わない。

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
 * 参照 **+ マークアップとしての再走査**)。単位化しない要素をここへ足すと、その内側が
 * 単位抽出から**完全に消える**。この対応は `templateScripts.test.ts` の
 * 「raw text 要素は必ず単位化される」節が機械検証する — 要素を足して分岐を書き忘れたら落ちる。
 *
 * 実際に `title` と `textarea` を載せていた版が破れていた: HTML の `<title>` が RCDATA
 * なのは HTML 名前空間の場合だけで、SVG の foreign content では普通の外来要素である。
 * `<svg><title><script>…</script></title></svg>` は Chromium で実行されるのに単位ゼロで
 * 通った(`<svg><title><style>@import url(…)` も同様)。よって両者はここから外し、素の
 * マークアップとして走査する。HTML 名前空間では実行されない字面まで拾うことになるが、
 * 過剰包含は基準側にも同じだけ現れるので害にならない(ファイル冒頭の方針どおり)。
 *
 * **同じ理由が `style` にも当たる。**
 * `<svg><style><img src=x onerror=…>` は Chromium で onerror が発火するのに、CSS 外部参照
 * しか単位化しないと単位ゼロで通ってしまう。`style` は CSS 参照の抽出が要るので
 * ここへ残したまま、中身をマークアップとしても走査する形にしてある。
 */
const SCRIPT_SCAN_RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style']);

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
  /** 値の範囲 `[valueAt, valueEnd)`。値の無い属性は両方 -1。値の中の Jinja の文脈の判定に使う。 */
  valueAt: number;
  valueEnd: number;
}

interface ParsedTag {
  at: number;
  /** 開始タグの直後(内容の先頭)。raw text 要素の内容取り出しに使う。 */
  contentAt: number;
  name: string;
  attrs: ParsedAttr[];
  /** タグ内に現れた Jinja 断片(`{{ … }}` / `{% … %}` / `{# … #}`)。 */
  jinja: string[];
  /** `jinja` の各断片の先頭の位置。字句解析のトークンと二重に単位にしないために持つ。 */
  jinjaAt: number[];
}

/**
 * **属性名**の終端文字。属性名状態はタグ名と違い `=` でも終わる。
 *
 * **タグ名**の終端は `@editor/shared` の `isTagNameEnd`(空白・`/`・`>`)で、こちらとは別に持つ。
 * タグ名に `=` を入れてはならない。タグ名状態は空白・`/`・`>` でしか終わらず、`=` は
 * 普通のタグ名文字なので、`<style=x>` の要素名はブラウザにとって `style=x` という**未知要素**
 * であり、中身は raw text にならず通常マークアップとして解析される(実 Chromium で
 * `<style=x><img src=x onerror=…>` の onerror 発火を確認)。ここに `=` があると走査器だけが
 * 要素名を `style` と読み、`</style` まで読み飛ばして内側が単位ゼロになる。
 * 2 つを同じ集合で兼ねると片方が必ず間違う。
 */
const ATTR_NAME_TERMINATORS = new Set([' ', '\t', '\n', '\r', '\f', '/', '>', '=']);

/** 「タグの開始に見える `<`」の字面。読み飛ばし幅がこれを跨がないよう縛るのに使う。 */
const TAG_LIKE_LT_RE = /<[a-zA-Z!/?]/;

/**
 * タグ内の Jinja 断片を読み飛ばす。読めたら閉じ位置を、**読み飛ばして良いと言えなければ
 * `-1`** を返す(呼び出し側は `-1` を「普通の属性名文字」として扱い、走査を止めない)。
 *
 * ⚠ ここが `-1` を返したとき、呼び出し側が入力の残り全部を捨てる形は
 * **不変性ゲートそのものの迂回路**になる。`{{` が閉じない・そもそも Jinja 開始でない
 * (`<div {>`)だけで `scanOpenTags` が以降を走査せず、単位列が基準と完全一致したまま
 * `<script>` を足せる(実測: 7 文字の `<div {>` を挟むだけで申請・承認を通る)。
 * ブラウザは `{` を普通の属性名文字として読み、タグは最初の `>` で閉じて後続の
 * `<script>` を実行する。よって「閉じない = 読み飛ばさない」が正しい向きである。
 *
 * 閉じていても**タグらしい `<` を跨ぐ断片は読み飛ばさない**。`}}` を文書のずっと後ろに
 * 置けば、その間の `<script>` が丸ごと 1 つの Jinja 断片として単位から消せてしまう
 * (`<div {{ >` … `<script>evil()</script>` … `}}`)。ブラウザはタグを `>` で閉じるので
 * この読み飛ばしは字面の上でも誤り。`{% if a > b %}` のような正当な断片は `<` を含まない
 * ので影響を受けない。
 */
function jinjaEnd(text: string, at: number, budget: ScanBudget): number {
  const close = jinjaCloserOf(text.slice(at, at + 2));
  if (close === undefined) return -1;
  const e = text.indexOf(close, at + 2);
  // 閉じ記号を探して走った距離を予算から引く(閉じない `{{` が末尾まで舐める分をここで数える)。
  budget.remaining -= (e < 0 ? text.length : e) - at;
  if (e < 0) return -1;
  return TAG_LIKE_LT_RE.test(text.slice(at + 2, e)) ? -1 : e + 2;
}

/**
 * raw text 要素(`script` / `style`)の終了タグの `<` 位置を返し(無ければ `-1`)、探すのに読んだ
 * 分を予算から引く。終わりの規則は `@editor/shared` の `findRawTextEnd`(`inlineCss.ts` などと共有)。
 *
 * `</script` の前方一致だけでは足りない。HTML のトークナイザは終了タグ名の直後が
 * 空白 / `/` / `>` のときにだけ終了タグとみなすので、`</scriptx>` は**本文の一部**である。
 * 前方一致で切ると `<script>init()</scriptx>/;evil()</script>` の本文を
 * `init()` と読み、基準と一致させたまま `evil()` を確定テンプレへ通してしまう。
 *
 * ⚠ `lower`(= `text` 全体を `asciiLower` で小文字にしたコピー)は**呼び出し側が 1 回だけ作って
 * 渡す**。`toLowerCase` で作ると `İ` が 2 単位に伸びて位置がずれ、閉じタグの後ろの本物のタグを
 * 見落とす。ここで入力全体を小文字にすると script/style 1 つにつき入力全体のコピーを
 * 作り、`collectInto` は `scanOpenTags` と `rawTextOf` の双方から呼ぶので要素あたり
 * 概ね 2 コピーになる。`'<style></style>'` の反復を `POST /api/review-requests` に
 * 載せるだけで、`submitReview` 冒頭の同期区間がイベントループを恒久停止させる。
 */
function rawTextEnd(lower: string, name: string, from: number, budget: ScanBudget): number {
  const { at, scanned } = findRawTextEnd(lower, name, from);
  budget.remaining -= scanned; // 終了タグを探して読んだ分(見つからなければ末尾まで)を数える
  return at;
}

/**
 * 開始タグだけを順に取り出す簡易走査。**HTML パーサではない**(整形式でない入力でも
 * 止まらず、拾いすぎる方へ倒れる)。終了タグ・コメント・doctype は読み飛ばす。
 */
function* scanOpenTags(text: string, lower: string, budget: ScanBudget): Generator<ParsedTag> {
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (budget.remaining <= 0) return; // 作業量予算が尽きたら走査を止める(fail closed)
    const lt = text.indexOf('<', i);
    if (lt < 0) return;
    const next = text[lt + 1] ?? '';
    if (next === '!') {
      if (text.startsWith('<!--', lt)) {
        // コメントは**読み飛ばさず中身を走査する**(fail closed)。
        //
        // 終端規則を仕様どおりに実装しても足りない。検査対象は描画前の Jinja テンプレで、
        // コメント記号自体を Jinja が出し分けられるためである:
        // `{% if false %}<!--{% endif %}<script>…</script>{% if false %}-->{% endif %}` は
        // 字面ではコメント 1 個だが、描画後は素の `<script>` になって実行される。
        // 終端を数える限りこの形は必ず素通りする(実測。仕様準拠パーサでも同じく通る
        // — ファイル冒頭「仕様準拠パーサへ置き換えない理由」)。
        // 過剰包含の代償は小さい: 散文のコメントは走査しても単位を 1 つも作らない
        // (実コーパス 19 ファイルで単位数は不変)。単位が出るのはコメント内に
        // 実行面の字面がある場合だけで、それは基準側にも同じだけ現れる。
        //
        // 旧版は `-->` だけを終端とみなし、`<!-- a --!><script>…</script>-->` の中身を
        // 単位ゼロで申請・承認へ通していた(ブラウザは `--!>` で閉じるので実行される)。
        // 走査してしまえばこの種の終端差そのものが効かなくなる。
        i = lt + 4;
        continue;
      }
      // doctype 等の markup declaration は `>` まで。
      const end = text.indexOf('>', lt) + 1 || len;
      i = end <= lt ? len : end;
      continue;
    }
    if (!isAsciiAlpha(next)) {
      i = lt + 1;
      continue;
    }
    let p = lt + 1;
    while (p < len && !isTagNameEnd(text[p])) p++;
    const name = text.slice(lt + 1, p).toLowerCase();
    const attrs: ParsedAttr[] = [];
    const jinja: string[] = [];
    const jinjaAt: number[] = [];
    while (p < len) {
      if (budget.remaining <= 0) break; // 1 タグ内で多数の `{{` を舐める形も予算で止める
      while (p < len && (isHtmlSpace(text[p]) || text[p] === '/')) p++;
      if (p >= len) break;
      if (text[p] === '>') {
        p++;
        break;
      }
      if (text[p] === '{') {
        const e = jinjaEnd(text, p, budget);
        if (e > 0) {
          jinja.push(text.slice(p, e));
          jinjaAt.push(p);
          p = e;
          continue;
        }
        // 読み飛ばして良い断片ではない。`{` はブラウザ同様「普通の属性名文字」として
        // 下の属性名走査へ落とす — ここで走査を打ち切ると入力の残りが単位から消える。
      }
      const nameStart = p;
      while (p < len && !ATTR_NAME_TERMINATORS.has(text[p] as string)) p++;
      const attrName = text.slice(nameStart, p).toLowerCase();
      while (p < len && isHtmlSpace(text[p])) p++;
      let value = '';
      let valueAt = -1;
      let valueEnd = -1;
      if (text[p] === '=') {
        p++;
        while (p < len && isHtmlSpace(text[p])) p++;
        const quote = text[p];
        if (quote === '"' || quote === "'") {
          const e = text.indexOf(quote, p + 1);
          valueAt = p + 1;
          valueEnd = e < 0 ? len : e;
          value = text.slice(valueAt, valueEnd);
          p = e < 0 ? len : e + 1;
        } else {
          valueAt = p;
          while (p < len && !isHtmlSpace(text[p]) && text[p] !== '>') p++;
          valueEnd = p;
          value = text.slice(valueAt, p);
        }
      }
      if (attrName !== '') attrs.push({ name: attrName, value, valueAt, valueEnd });
    }
    yield { at: lt, contentAt: p, name, attrs, jinja, jinjaAt };
    // raw text 要素の内容はタグとして解釈されない。走査位置を終了タグの後ろへ進める。
    if (SCRIPT_SCAN_RAW_TEXT.has(name)) {
      const close = rawTextEnd(lower, name, p, budget);
      i = close < 0 ? len : close + name.length + 2;
    } else {
      i = p > lt ? p : lt + 1;
    }
  }
}

/**
 * raw text 要素の内容と、その終わりの位置(終了タグの `<`。無ければ EOF)。終端規則は `rawTextEnd`
 * と共有する。終わりの位置は本文の中の Jinja の文脈の判定に使う。
 */
function rawTextOf(
  text: string,
  lower: string,
  tag: ParsedTag,
  budget: ScanBudget,
): { body: string; end: number } {
  const close = rawTextEnd(lower, tag.name, tag.contentAt, budget);
  const end = close < 0 ? text.length : close;
  return { body: text.slice(tag.contentAt, end), end };
}

// ── 5. 単位の組み立て ──

function collapse(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizedAttrs(attrs: readonly ParsedAttr[]): string {
  return [...attrs]
    .map((a) => `${a.name}=${collapse(decodeHtmlEntities(a.value))}`)
    .sort()
    .join(' ');
}

function isInertAttrName(name: string): boolean {
  return INERT_ATTRS.has(name) || INERT_ATTR_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Jinja のトークン(`{{...}}` / `{%...%}` / `{#...#}`)を**単調前進の 1 パス**で取り除く。
 *
 * 以前は global + lazy な正規表現 `replace` を使っていたが、閉じない `{{` の連なり
 * (`href="{{{{…"` の最大 4 MiB)では開始位置ごとに末尾まで舐め直す二次になった。ここは
 * URL 値のスキーム判定のためにトークンを剥がすだけなので、閉じるトークンは丸ごと飛ばし、
 * 閉じないトークンは以降を落とす(閉じない `{{` の先に活性スキームは現れないので安全側)。
 */
function stripJinjaTokens(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const close = s[i] === '{' ? jinjaCloserOf(s.slice(i, i + 2)) : undefined;
    if (close !== undefined) {
      const e = s.indexOf(close, i + 2);
      if (e < 0) break; // 閉じないトークン: 以降は捨てる
      i = e + 2; // 閉じるトークンは丸ごと飛ばす(indexOf は前進のみ = 全体で線形)
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

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
  const decoded = decodeHtmlEntities(value);
  if (!isInertUrlLiteral(decoded)) return false;
  const stripped = stripJinjaTokens(decoded);
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
  const decoded = decodeHtmlEntities(css);
  const refs = findExternalRefsInCss(decoded);
  // Jinja のトークンを消した形でも探す。`ur{# #}l(` のように、トークンを消すとつながる綴りは
  // 生の値では見えない。CSS の中のトークンは形を問わず単位にしてある(`pushJinjaUnits`)が、
  // 同じトークンが基準にもある(コメントを置いて綴りを割ってある)なら、それだけでは違いが出ない。
  const stripped = stripJinjaTokens(decoded);
  if (stripped !== decoded) {
    for (const ref of findExternalRefsInCss(stripped)) if (!refs.includes(ref)) refs.push(ref);
  }
  for (const ref of refs) {
    out.push({ at, seq: out.length, unit: `css-ref:${collapse(ref)}` });
  }
}

interface PositionedUnit {
  at: number;
  seq: number;
  unit: string;
  /**
   * テキストの位置のトークンで、判定を文書の走査の後へ回したもの。束ねた名前(`set ns = namespace()`)
   * は文書全体(チップの中を含む)から集めてから判定するので、この間 `unit` は空のまま置く。
   */
  pending?: JinjaToken;
}

/** タグの範囲。値の中の Jinja を、どの属性の中にあるかで単位にするために持つ。 */
interface TagSpan {
  start: number;
  end: number;
  tag: ParsedTag;
  /**
   * `tag.jinjaAt` と `tag.attrs` を読み進めた位置。タグの中のトークンは先頭の位置の順に来るので、
   * 毎回先頭から探し直さずに単調に進める(1 つのタグに断片を大量に並べた入力で二次にしない)。
   */
  jinjaCursor: number;
  attrCursor: number;
  /** このタグの中のトークンの単位。属性の名前順に並べてから積む(`flushTagJinjaUnits`)。 */
  pending: { key: string; unit: string }[];
}

/** `script` / `style` の本文の範囲。 */
interface BodySpan {
  start: number;
  end: number;
  kind: 'script' | 'style';
}

/** 字句解析に失敗したことを表す単位。位置は入れない(基準と提出で位置が違っても同じ単位にする)。 */
const JINJA_LEX_ERROR_UNIT = 'jinja-lex-error';

/** 直前の HTML の空白を飛ばした位置の文字が `<` か。`{%-` の刈り込みと `lstrip_blocks` を考える。 */
function followsLt(text: string, at: number): boolean {
  let b = at - 1;
  while (b >= 0 && isHtmlSpace(text[b])) b--;
  return text[b] === '<';
}

/**
 * 描画で生まれる実行面を単位にする。`text` の Jinja のトークンを、先頭の位置の文脈で分ける。
 *
 * - タグの文脈(タグの範囲の中。属性値の中を含む)と CSS の文脈(`<style>` の本文・`style` 属性の
 *   値): 形を問わず単位にする。属性値の中ではリテラルの文字を制限しても閉じられない
 *   (`'javascript'` は許可した文字だけだが、後ろの地の `:` とつながる。CSS の `{{ u }}(` も同じ)。
 *   タグに直接ある断片は `jinja-attr:` として積んであるので、ここでは積まない。
 * - `script` の本文: 本文ごと `script:` の単位に入っているので積まない。
 * - テキストの位置(地の文・コメントの中・`title` / `textarea` の中): `InertJinjaJudge` が
 *   不活性と言えないものを単位にする(判定は `collectExecutableUnits` が文書の走査の後で行う)。直前(空白を飛ばす)が `<` か、トークンの中にタグらしい `<`
 *   があれば、形を問わず単位にする。GrapesJS は地の文の `<` を `&lt;` で書き出すので、正当な編集
 *   からこの形は生まれない。
 *
 * 字句解析に失敗したら `jinja-lex-error` を 1 つ積んでやめる。本番の Jinja2 は字句の壊れた
 * テンプレートを描けず、値入り HTML は Jinja で描画しないので、打ち切った先を使われても実害は無い。
 * 基準が読めて提出側が読めなければ、この単位が増えて拒否される。
 */
function pushJinjaUnits(
  text: string,
  tags: readonly TagSpan[],
  bodies: readonly BodySpan[],
  out: PositionedUnit[],
  budget: ScanBudget,
  seen: JinjaToken[],
): void {
  budget.remaining -= text.length;
  const lexed = lexJinja(text);
  if (!lexed.ok) {
    out.push({ at: 0, seq: out.length, unit: JINJA_LEX_ERROR_UNIT });
    return;
  }
  // 束ねた名前は文脈を問わず集める(属性値・CSS・script の本文の `set` も。拾いすぎる側)。
  for (const tok of lexed.tokens) seen.push(tok);
  // タグ・本文の範囲は文書の順に並び、互いに重ならない。トークンも先頭の位置の順なので、
  // 2 本の添字を進めるだけで分類でき、全体で線形に収まる。
  let ti = 0;
  let bi = 0;
  for (const tok of lexed.tokens) {
    const s = tok.start;
    while (ti < tags.length && (tags[ti] as TagSpan).end <= s) ti++;
    while (bi < bodies.length && (bodies[bi] as BodySpan).end <= s) bi++;
    const tag = tags[ti];
    if (tag !== undefined && tag.start <= s) {
      pushTagJinjaUnit(tag, tok);
      continue;
    }
    const body = bodies[bi];
    if (body !== undefined && body.start <= s) {
      if (body.kind === 'style') {
        out.push({ at: s, seq: out.length, unit: `jinja-css:${collapse(tok.source)}` });
      }
      continue;
    }
    // 直前が `<` なら、描画でタグ名が後ろにつながる。トークンの中にタグらしい `<` があれば、
    // 走査器はそこからタグを読み、後ろの実行面を属性値として飲み込む(`{# <b title=#}<script>`)。
    // 描画でトークンが消えると飲み込まれた側が素で残るので、どちらも形を問わず単位にする。
    if (followsLt(text, s) || TAG_LIKE_LT_RE.test(tok.source)) {
      out.push({ at: s, seq: out.length, unit: `jinja-tag-open:${collapse(tok.source)}` });
    } else {
      out.push({ at: s, seq: out.length, unit: '', pending: tok });
    }
  }
  for (const span of tags) flushTagJinjaUnits(span, out);
}

function pushTagJinjaUnit(span: TagSpan, tok: JinjaToken): void {
  const { tag } = span;
  const s = tok.start;
  while (span.jinjaCursor < tag.jinjaAt.length && (tag.jinjaAt[span.jinjaCursor] as number) < s) {
    span.jinjaCursor++;
  }
  if (tag.jinjaAt[span.jinjaCursor] === s) return; // `jinja-attr:` として積んである
  // 値の無い属性は `valueEnd` が -1 なので、ここで読み飛ばされる。
  while (
    span.attrCursor < tag.attrs.length &&
    (tag.attrs[span.attrCursor] as ParsedAttr).valueEnd <= s
  ) {
    span.attrCursor++;
  }
  const cand = tag.attrs[span.attrCursor];
  const attr = cand !== undefined && cand.valueAt <= s ? cand : undefined;
  const source = collapse(tok.source);
  if (attr === undefined) {
    span.pending.push({ key: '', unit: `jinja-attr:${tag.name}|${source}` });
  } else if (attr.name === 'style') {
    span.pending.push({ key: attr.name, unit: `jinja-css:${source}` });
  } else {
    span.pending.push({ key: attr.name, unit: `jinja-val:${tag.name}.${attr.name}|${source}` });
  }
}

/**
 * タグの中のトークンの単位を、属性の名前順に並べて開始タグの位置に積む。属性の書き順で並べると、
 * GrapesJS の再直列化で属性順が動いただけで単位の並びが変わり、正当な保存が拒否される
 * (`normalizedAttrs` が属性を名前順に並べるのと同じ理由)。並べ替えは安定なので、同じ属性の中の
 * トークンの順は保つ(`href="{{ a }}{{ b }}"` と `href="{{ b }}{{ a }}"` は別の単位列になる)。
 */
function flushTagJinjaUnits(span: TagSpan, out: PositionedUnit[]): void {
  if (span.pending.length === 0) return;
  span.pending.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const p of span.pending) out.push({ at: span.tag.at, seq: out.length, unit: p.unit });
}

/**
 * `html` の単位を `out` へ積む。`jinja` が false のときは Jinja のトークンの分類を行わない。
 * `<style>` の本文の再走査がそれにあたる: 本文の中のトークンは外側の走査が CSS の文脈として
 * 形を問わず単位にしてあるので、本文だけを見てテキストの位置と読み直すと二重に数える。
 */
function collectInto(
  html: string,
  out: PositionedUnit[],
  depth: number,
  budget: ScanBudget,
  seen: JinjaToken[],
  jinja = true,
): void {
  // depth は「チップ復号の入れ子」と「<style> 本文の再走査」の両方を数える。閉じない
  // `<style>` の反復は残り全体を本文として同じ深さで再走査させるため、深さでも止める
  // (byte 予算と二段で、総走査バイト数・スタック深さの双方を入力長に対して線形に保つ)。
  if (html === '') return;
  if (depth > MAX_DECODE_DEPTH || budget.remaining <= 0) {
    budget.truncated = true;
    return;
  }
  const { text, payloads } = splitEncodedChips(html);
  // 小文字化コピーは走査 1 回につき 1 つで、位置がずれない `asciiLower` で作る(`rawTextEnd` の
  // 注意書きを見よ)。予算からも引く。
  const lower = asciiLower(text);
  budget.remaining -= text.length;
  const tagSpans: TagSpan[] = [];
  const bodySpans: BodySpan[] = [];
  for (const tag of scanOpenTags(text, lower, budget)) {
    tagSpans.push({
      start: tag.at,
      end: tag.contentAt,
      tag,
      jinjaCursor: 0,
      attrCursor: 0,
      pending: [],
    });
    if (tag.name === 'script') {
      // 中身まで含めて 1 単位。閉じタグを欠く断片も EOF まで拾う(パーサ差で
      // 「閉じていないから script ではない」と判断すると実行される断片を見逃す)。
      const { body, end } = rawTextOf(text, lower, tag, budget);
      bodySpans.push({ start: tag.contentAt, end, kind: 'script' });
      out.push({
        at: tag.at,
        seq: out.length,
        unit: `script:${normalizedAttrs(tag.attrs)}|${collapse(body)}`,
      });
      continue;
    }
    if (tag.name === 'style') {
      const { body, end } = rawTextOf(text, lower, tag, budget);
      bodySpans.push({ start: tag.contentAt, end, kind: 'style' });
      // 宣言の編集(色・寸法)はスタイルマネージャの正当な操作なので単位にしない。
      // 外部を引き込む面(`@import` / 非画像 `url()`)だけを固定する。
      pushCssUnits(body, tag.at, out);
      // **中身をマークアップとしても走査する。** `style` が raw text なのは HTML 名前空間の
      // 場合だけで、SVG の foreign content(`<svg><style>`)では普通の外来要素になり、
      // 内側の `<img src=x onerror=…>` が実要素として生きる(実 Chromium で確認)。CSS 参照の
      // 単位化だけでは能動属性を拾えず、`</style` まで読み飛ばした範囲が単位ゼロになる。
      // HTML 名前空間では実行されない字面まで拾うが、過剰包含は基準側にも同じだけ現れるので
      // 害にならない(ファイル冒頭の方針どおり)。同じ理由で `title` / `textarea` は
      // `SCRIPT_SCAN_RAW_TEXT` から外してある。
      // ⚠ 深さを 1 段下げて再走査する。閉じない `<style>` は本文＝残り全体になり、その中の
      // `<style>` がまた残り全体を本文にする…と同じ深さで再帰して二次爆発したため。
      // 再走査の単位の位置は本文を起点にしているので、本文の先頭の位置を足して文書の位置に
      // 直す。直さないと本文の中の単位が文書の先頭のほうへずれ、`<style>` より前のパーツを
      // 足し・消し・並べ替えるだけで単位の並びが変わって、正当な編集が拒否される。
      const nested: PositionedUnit[] = [];
      collectInto(body, nested, depth + 1, budget, seen, false);
      for (const n of nested) out.push({ ...n, at: n.at + tag.contentAt, seq: out.length });
      // 属性(`media` 等)も見る。`style` 自体は許可要素として扱わない代わりにここで拾う。
      for (const a of tag.attrs) {
        if (!isInertAttrName(a.name)) {
          out.push({
            at: tag.at,
            seq: out.length,
            unit: `attr:style.${a.name}=${collapse(decodeHtmlEntities(a.value))}`,
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
          unit: `attr:${tag.name}.${a.name}=${collapse(decodeHtmlEntities(a.value))}`,
        });
        continue;
      }
      if (URL_ATTRS.has(a.name) && !isInertUrl(a.value)) {
        out.push({
          at: tag.at,
          seq: out.length,
          unit: `url:${tag.name}.${a.name}=${collapse(decodeHtmlEntities(a.value))}`,
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
  if (jinja && budget.remaining > 0) {
    pushJinjaUnits(text, tagSpans, bodySpans, out, budget, seen);
  }
  if (depth >= MAX_DECODE_DEPTH) {
    if (payloads.length > 0) budget.truncated = true;
    return;
  }
  for (const p of payloads) {
    if (budget.remaining <= 0) return;
    const nested: PositionedUnit[] = [];
    collectInto(p.decoded, nested, depth + 1, budget, seen);
    for (const n of nested) out.push({ ...n, at: p.at, seq: out.length });
  }
}

/**
 * HTML から能動コンテンツ面を順序どおりに取り出す。`data-opaque` 等の退避属性は復号済みの
 * 実体に対して走査するので、チップへ畳んだ状態で提出しても同じ結果になる。
 *
 * 走査・判定の想定外の例外(深い入れ子の RangeError、評価器の検査の漏れなど)は、走査を打ち切った
 * ときと同じ `scan-incomplete` の単位だけを返す。照合はこの単位を見ると必ず拒否する(fail closed)。
 * 理由が何であれ中身を確かめられなかったことに変わりはなく、確かめられない本文を通す分岐を作らない
 * (`externalRefs.ts` の `assertNoJsonExternalRefs` と同じ扱い)。
 */
export function collectExecutableUnits(html: string): string[] {
  return scanUnits(html).units;
}

/** 走査の結果。想定外の例外で打ち切ったときは、その名前と文言をログ用に持つ。 */
interface UnitScan {
  units: string[];
  scanError?: { name: string; message: string };
}

/** ログに載せる例外の文言の長さの上限(例外の文言に本文の断片が入っても、ログを膨らませない)。 */
const MAX_SCAN_ERROR_MESSAGE = 200;

function scanUnits(html: string): UnitScan {
  try {
    return { units: collectUnits(html) };
  } catch (e) {
    const name = e instanceof Error ? e.name : typeof e;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, MAX_SCAN_ERROR_MESSAGE);
    return { units: [SCAN_INCOMPLETE_UNIT], scanError: { name, message } };
  }
}

function collectUnits(html: string): string[] {
  const out: PositionedUnit[] = [];
  const budget: ScanBudget = { remaining: MAX_SCAN_BYTES, truncated: false };
  const seen: JinjaToken[] = [];
  collectInto(html, out, 0, budget, seen);
  const judge = new InertJinjaJudge(seen);
  const units: string[] = [];
  for (const u of out.sort((a, b) => a.at - b.at || a.seq - b.seq)) {
    if (u.pending === undefined) units.push(u.unit);
    else if (!judge.isInert(u.pending)) units.push(`jinja:${collapse(u.pending.source)}`);
  }
  // 予算切れは `scanOpenTags` の途中打ち切りも含むので、残量で判定する。
  if (budget.truncated || budget.remaining <= 0) units.push(SCAN_INCOMPLETE_UNIT);
  return units;
}

// ── 6. 照合 ──

function unitsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 照合失敗時にユーザーへ返す文言。経路(申請/承認/転写)を問わず同じ案内にする。 */
const SCRIPT_IMMUTABLE_MESSAGE =
  '実行コード・外部参照は編集できません。変更が必要なら開発者へ依頼してください';

/**
 * 違いが Jinja の単位だけのときの文言。作成タブの利用者が差し込みを書き足して拒否されたときに、
 * 「実行コード」の文言では何を直せばよいか分からないため分ける。違いの中身は出さない。
 */
const JINJA_IMMUTABLE_MESSAGE =
  '差し込み（Jinja）の書き方のうち、承認で中身を確かめられないもの（タグや書式の中の差し込み・' +
  '{% set %}・{% include %}・文字列を出す式など）は追加・変更できません。変更が必要なら開発者へ' +
  '依頼してください';

/**
 * 走査を打ち切った(上限・想定外の例外)ときの文言。照合できなかったのであって、実行コードを
 * 変えたと決まったわけではないので、「編集できません」の文言と分ける(`externalRefs.ts` の
 * 「検査できないファイルは受け取れません」と同じ考え方)。
 */
const SCAN_INCOMPLETE_MESSAGE =
  '実行コードの変更の有無を検査できませんでした(検査できない本文は受け取れません)。' +
  '本文の入れ子や量を減らしてから送信し、それでも直らないときは開発者へ連絡してください';

const isJinjaUnit = (u: string): boolean => u.startsWith('jinja');

/** 単位の種類(`script` `jinja-val` など。`:` の前)ごとの数。ログの手掛かりにだけ使う。 */
function countKinds(units: readonly string[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const u of units) {
    const colon = u.indexOf(':');
    const kind = colon < 0 ? u : u.slice(0, colon);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

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
  const baseline = scanUnits(baselineHtml);
  const submitted = scanUnits(submittedHtml);
  const before = baseline.units;
  const after = submitted.units;
  const incomplete = before.includes(SCAN_INCOMPLETE_UNIT) || after.includes(SCAN_INCOMPLETE_UNIT);
  if (unitsEqual(before, after) && !incomplete) return;
  const jinjaOnly =
    !incomplete &&
    unitsEqual(
      before.filter((u) => !isJinjaUnit(u)),
      after.filter((u) => !isJinjaUnit(u)),
    );
  const message = incomplete
    ? SCAN_INCOMPLETE_MESSAGE
    : jinjaOnly
      ? JINJA_IMMUTABLE_MESSAGE
      : SCRIPT_IMMUTABLE_MESSAGE;
  const scanError = submitted.scanError ?? baseline.scanError;
  throw forbidden(
    `${message} (テンプレート=${context.templateId})`,
    // 差分の中身はユーザーへ出さない(攻撃者への手掛かりになる)。ログにだけ残す。走査の想定外の
    // 例外は名前と文言を残す(拒否に倒しても、何が起きたかを後から追えるように)。
    {
      code: 'TEMPLATE_SCRIPT_IMMUTABLE',
      cause: {
        where: context.where,
        baselineUnits: before.length,
        submittedUnits: after.length,
        baselineKinds: countKinds(before),
        submittedKinds: countKinds(after),
        ...(scanError === undefined ? {} : { scanError }),
      },
    },
  );
}
