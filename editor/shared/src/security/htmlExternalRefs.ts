// =============================================================================
// htmlExternalRefs.ts — HTML の属性が「文書の外へ取りに行く」参照かを判定する
// =============================================================================
// 文書は CSS・JS・画像を **文書の置き場から見た相対パス**(`../css/…` `../js/…` `../images/…`)で
// 参照する(論理配置は `resolveDocAssetPath`)。これは正当どころか必須で、遮断してはならない。遮断すべきなのは
// **オリジン外への絶対参照**(`https://…` / `//host` / 許可外 `data:`)だけである。
//
// つまり「外部参照要素を要素名で落とす」という方針は誤りである。`<link>` を無条件に
// 落とすと per-fund CSS が読めず、`<script src>` を落とすとテンプレ JS が動かない。
// 判定軸は**要素名ではなく URL の形**へ移す。
//
// 判定基準は `cssExternalRefs.ts` の `isSelfContainedUrl` と**同一関数**を使う。
// CSS 側と HTML 側で別々のブロックリストを持つと、片方だけ緩い形が必ず生まれる。
//
// 置き場が `shared` なのは、**関門をサーバ側に置きつつ web にも同じ早期フィードバックを
// 出す**ため(`cssExternalRefs.ts` 冒頭の解説と同じ理由)。web の検査は唯一の関門ではない。

import { isSelfContainedUrl } from './cssExternalRefs.js';
import { decodeHtmlEntities, normalizeHtmlUrlValue } from './htmlEntities.js';

/**
 * 要素ごとの「取得(fetch)を起こす URL 属性」。ここに載る属性だけを外部参照検査に掛ける。
 *
 * **`a` / `area` の `href` は入れない。** あれは利用者の操作で初めて遷移する
 * ナビゲーションで、組版中に 1 バイトも取りに行かない。入れると「引用元 URL を注記に
 * 書いた帳票」がすべて 400 になり、egress を 1 つも減らさないまま業務を止める。
 *
 * `*` は要素名を問わず見る属性。`style` 属性の中の `url()` は CSS 側
 * (`findExternalRefsInCss`)が受け持つのでここには入れない。
 *
 * **`iframe` の `srcdoc` は入れない。** あれは URL ではなく HTML 文書そのもので、
 * URL として `isSelfContainedUrl` に掛けると `<` 始まりの断片は必ず「相対参照」と判定され
 * (実測: `srcdoc="<img src=https://evil/x>"` は 0 件)、**検査した気になるだけ**になる。
 * 入れ子の HTML は `nestedHtmlAttrsFor` 経由で呼び出し側が再帰的に走査する。
 *
 * ⚠ **この表(= 本ゲート全体)は best-effort である。** 属性の数え上げは必ず漏れる
 * (実測で漏れていた例: SVG `<script href>` / `<script xlink:href>`、
 * `<link rel=preload imagesrcset>`、`<meta http-equiv=refresh content="0;url=…">`)。
 * 漏れを致命傷にしないための強制点は**経路ごとに別**である。PDF ビルドは
 * `server/src/vivliostyle/egressGuard.ts`(組版ブラウザはそのビルドが押さえたオリジンの外へ
 * 出られない)、ブラウザ表示経路は各経路の CSP(`vivliostyle/previewHost.ts` のホストページ
 * CSP / `config.buildCspDirectives` / `previewProxy.CONTENT_CSP`)が受け持つ。
 * ここは「早期に 400 で拒んで運用者へ理由を返す」層であって、最後の砦ではない。
 * ⚠ 表示経路の砦は CSP なので、**CSP を緩める変更はこの表の漏れをそのまま実害にする**。
 */
const FETCH_URL_ATTRS: ReadonlyMap<string, readonly string[]> = new Map([
  // `imagesrcset` は `<link rel=preload as=image>` が実際に取得を起こす URL 列。
  // `imagesizes` は URL を持たない記述子だが、ファイル冒頭の「過剰包含は害にならない」
  // 方針に従って対で載せる(誤検知側へ倒れるだけで、見落としへは倒れない)。
  ['link', ['href', 'imagesrcset', 'imagesizes']],
  // SVG の `<script>` は `href`(SVG2)/ `xlink:href`(SVG1.1)で外部 JS を引く。
  ['script', ['src', 'href', 'xlink:href']],
  ['img', ['src', 'srcset', 'longdesc']],
  ['source', ['src', 'srcset']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['track', ['src']],
  ['iframe', ['src']],
  ['frame', ['src']],
  ['embed', ['src']],
  ['object', ['data', 'archive', 'codebase']],
  ['input', ['src']],
  ['body', ['background']],
  ['table', ['background']],
  ['td', ['background']],
  ['th', ['background']],
  // SVG。`href` は SVG2、`xlink:href` は SVG1.1(両方現役)。
  ['image', ['href', 'xlink:href']],
  ['use', ['href', 'xlink:href']],
  ['feimage', ['href', 'xlink:href']],
  ['filter', ['href', 'xlink:href']],
  ['pattern', ['href', 'xlink:href']],
  ['lineargradient', ['href', 'xlink:href']],
  ['radialgradient', ['href', 'xlink:href']],
  ['textpath', ['href', 'xlink:href']],
  ['mpath', ['href', 'xlink:href']],
]);

/** `tagName`(小文字)で取得を起こしうる属性名(小文字)の列。無ければ空配列。 */
export function fetchUrlAttrsFor(tagName: string): readonly string[] {
  return FETCH_URL_ATTRS.get(tagName.toLowerCase()) ?? [];
}

/** その属性が取得を起こす URL 属性か。 */
export function isFetchUrlAttr(tagName: string, attrName: string): boolean {
  return fetchUrlAttrsFor(tagName).includes(attrName.toLowerCase());
}

/**
 * 値が **URL ではなく HTML 文書**である属性。呼び出し側はこの値を復号したうえで
 * 通常の HTML と同じ走査へ掛け直す(深さ 1 で足りる — 入れ子の `srcdoc` も同じ経路で
 * また 1 段拾えるが、無限に降りる意味は無い)。
 *
 * ここを `FETCH_URL_ATTRS` へ混ぜてはならない。混ぜた版は `srcdoc` の中の絶対参照を
 * 1 件も報告しなかった(`FETCH_URL_ATTRS` の注記を見よ)。
 */
const NESTED_HTML_ATTRS: ReadonlyMap<string, readonly string[]> = new Map([['iframe', ['srcdoc']]]);

/** `tagName`(小文字)で HTML 文書を値に取る属性名(小文字)の列。無ければ空配列。 */
export function nestedHtmlAttrsFor(tagName: string): readonly string[] {
  return NESTED_HTML_ATTRS.get(tagName.toLowerCase()) ?? [];
}

/**
 * 複数の URL を 1 つの属性値へ詰める属性の区切り。
 *
 * `srcset` は `url 1x, url 2x` のカンマ区切り、`object` の `archive` は
 * (HTML4 の applet 由来で)空白区切りとカンマ区切りの両方が現れる。**分解しないと
 * 2 個目以降が丸ごと検査から消える**(実測: `archive="a.jar https://evil/b.jar"` が 0 件)。
 * 分解の失敗は「余計に候補が増える」= 誤検知側へ倒れるだけで、見落としへは倒れない。
 */
const MULTI_URL_ATTRS = new Set(['srcset', 'imagesrcset', 'archive']);

/**
 * `<meta http-equiv="refresh" content="0;url=https://evil/">` から URL 部分を取り出す。
 *
 * `content` は URL 属性ではないので `FETCH_URL_ATTRS` には載せられない(`content` を
 * 無条件に URL 扱いすると `<meta name=description content="…">` の本文が全部 URL 判定へ
 * 掛かる)。`http-equiv` が `refresh` のときだけ、HTML 仕様の refresh 値の構文
 * (時間 → 区切り → 任意の `url=` → URL)で切り出す。`url=` を省いた
 * `content="0;https://evil/"` も仕様上ナビゲートするので同じ経路で拾う。
 *
 * `http-equiv` の比較も `content` の切り出しも、ブラウザが見る**文字参照を解いた値**で行う
 * (`&#114;efresh` や `0&#59;url=` で隠せないように)。属性は**最初の 1 つだけ**を採る
 * (HTML の字句解析は 2 つ目以降の同名属性を捨てる)。
 *
 * 戻り値は**復号済み**の URL(呼び出し側で再度 `decodeHtmlEntities` を通さないこと)。
 * 再度復号すると `&amp;#104;ttps://…` のように 1 段だけ隠した文字参照が余計に解けて、
 * ブラウザが解く形と食い違う。TAB/LF/CR の除去と前後の trim だけは呼び出し側で行う。
 */
function metaRefreshUrl(attrs: ReadonlyArray<{ name: string; value: string }>): string | undefined {
  let httpEquiv: string | undefined;
  let content: string | undefined;
  for (const a of attrs) {
    const name = a.name.toLowerCase();
    if (name === 'http-equiv' && httpEquiv === undefined) httpEquiv = a.value;
    if (name === 'content' && content === undefined) content = a.value;
  }
  if (httpEquiv === undefined || content === undefined) return undefined;
  if (decodeHtmlEntities(httpEquiv).trim().toLowerCase() !== 'refresh') return undefined;
  const url = refreshUrlPart(decodeHtmlEntities(content)).trim();
  return url === '' ? undefined : url;
}

/**
 * refresh の値から URL 部分を、HTML 仕様の refresh の手順どおりに切り出す。
 *
 * `url` の字は 1 つずつ照合し、合わない字が来たら**戻らずに**引用符の手順へ進む。照合済みの字は
 * 捨てるので、`0;url https://evil/` や `0;ur'https://evil/'` もブラウザは `https://evil/` へ
 * 遷移する。「`url=` があれば除く」という正規表現では、`=` の無い形を相対参照と見誤る。
 *
 * 引用符の手順: 先頭が引用符なら 1 文字飛ばし、同じ引用符が後にあればそこで切る(無ければ末尾
 * まで)。閉じ引用符の後ろの余りや閉じ忘れでも、ブラウザは URL として辿る。
 *
 * 空白には仕様の ASCII 空白より広い `\s` を使い、時間の欠落や区切りの不正でも打ち切らない。
 * どちらもブラウザより多くの値を URL として拾う側(誤検知側)へ倒すためである。
 */
function refreshUrlPart(s: string): string {
  let i = 0;
  const skipSpaces = (): void => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  skipSpaces();
  while (i < s.length && /[0-9.]/.test(s[i])) i++;
  skipSpaces();
  if (s[i] === ';' || s[i] === ',') i++;
  skipSpaces();
  keyword: {
    for (const c of 'url') {
      if (s[i]?.toLowerCase() !== c) break keyword;
      i++;
    }
    skipSpaces();
    if (s[i] !== '=') break keyword;
    i++;
    skipSpaces();
  }
  const quote = s[i];
  if (quote !== '"' && quote !== "'") return s.slice(i);
  const rest = s.slice(i + 1);
  const close = rest.indexOf(quote);
  return close === -1 ? rest : rest.slice(0, close);
}

function splitCandidateUrls(attrName: string, value: string): string[] {
  if (!MULTI_URL_ATTRS.has(attrName)) return [value];
  return value
    .split(',')
    .flatMap((part) => part.trim().split(/\s+/))
    .filter((u) => u !== '');
}

/**
 * 1 タグ分の属性から外部参照を洗い出し、見つかった順に説明文字列で返す
 * (空配列 = 外部参照なし)。呼び出し側は**削らずに拒む**こと — 削る実装は
 * 実体参照や大小文字の揺れで必ず迂回される。
 *
 * ⚠ 値は必ず `normalizeHtmlUrlValue` を通してから判定する。走査器が渡してくるのは
 * **引用符を外しただけの原文**で、ブラウザが解く文字参照も URL パーサが落とす
 * TAB/LF/CR も解決されていない(`htmlEntities.ts` 冒頭に実測を書いた)。
 */
export function findExternalRefsInTag(
  tagName: string,
  attrs: ReadonlyArray<{ name: string; value: string }>,
): string[] {
  const found: string[] = [];
  if (tagName.toLowerCase() === 'meta') {
    const refresh = metaRefreshUrl(attrs);
    // `refresh` は復号済みなので、`&` を `&amp;` へ戻してから正規化し、復号を二重にしない。
    const refreshUrl =
      refresh === undefined ? undefined : normalizeHtmlUrlValue(refresh.replaceAll('&', '&amp;'));
    if (refreshUrl !== undefined && !isSelfContainedUrl(refreshUrl)) {
      found.push(`<meta http-equiv="refresh" content="…${refreshUrl}">`);
    }
  }
  const watched = fetchUrlAttrsFor(tagName);
  if (watched.length === 0) return found;
  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    if (!watched.includes(name)) continue;
    for (const url of splitCandidateUrls(name, normalizeHtmlUrlValue(attr.value))) {
      if (!isSelfContainedUrl(url)) found.push(`<${tagName} ${name}="${url}">`);
    }
  }
  return found;
}

/** 論理ルートでの文書の置き場(1 段下)。文書の相対参照はここを基準に解く。 */
export const DOC_DIR = 'doc';

/** scheme 付き(`data:` やドライブ指定 `C:` を含む)の形。資産のパスにはならない。 */
const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * 正規化済みの URL 値からパス部分を取り出して百分率復号する。配信ルート配下のパスに
 * なりえない形(外部参照・ルート絶対・空・復号不能)は `undefined`。
 *
 * `strict` では区切りと相対指定を**復号前の字面**で確定する。`%2F` `%5C` `%2e%2e` は
 * 区切りや `..` として働かせず(ブラウザも同じ扱い)、そうなる形は `undefined` にする。
 */
function decodedPathOf(value: string, strict: boolean): string | undefined {
  if (value === '' || !isSelfContainedUrl(value)) return undefined;
  // 断片・クエリは配信対象の識別に関与しない。
  const pathOnly = value.split(/[?#]/, 1)[0];
  if (pathOnly === '' || pathOnly.startsWith('/')) return undefined;
  try {
    if (!strict) return decodeURIComponent(pathOnly);
    const parts: string[] = [];
    for (const raw of pathOnly.split('/')) {
      const seg = decodeURIComponent(raw);
      if (seg.includes('/') || seg.includes('\\')) return undefined;
      if ((seg === '.' || seg === '..') && seg !== raw) return undefined;
      parts.push(seg);
    }
    return parts.join('/');
  } catch {
    return undefined; // 復号不能は fail closed
  }
}

/**
 * 復号済みのパスを `base`(ルート相対のセグメント列)の下で解く。ルートより上へ出る形と
 * NUL・`\` を含む形は `undefined`。
 */
function resolveSegments(base: readonly string[], decoded: string): string[] | undefined {
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const segments = [...base];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments;
}

/**
 * 相対 URL を「配信ルート相対のパス」へ正規化する。配信ルート配下へ解決できない形
 * (絶対 URL・scheme 相対・ルート絶対 `/…`・`..` でルート外へ出る形)は `undefined`。
 *
 * 呼び出し側はこの戻り値を「実際に配置した資産の集合」と突き合わせる。つまり
 * `<link href>` / `<script src>` を残してよいかは **配信ルート配下に実体があるか**で
 * 決まり、要素名では決まらない(本ファイル冒頭の方針)。
 */
export function resolveServedAssetPath(url: string): string | undefined {
  // 判定も解決も**ブラウザが実際に取りに行く形**で行う(`htmlEntities.ts`)。生値のままだと
  // `&#104;ttps://evil/x` が「相対参照」として配信ルート配下へ解決されうる。
  const decoded = decodedPathOf(normalizeHtmlUrlValue(url), false);
  const segments = decoded === undefined ? undefined : resolveSegments([], decoded);
  return segments === undefined || segments.length === 0 ? undefined : segments.join('/');
}

/**
 * **復号済みのルート引数**(Fastify が 1 回百分率復号して渡す値)を配信ルート相対のパスとして
 * 検める。文書の URL 値ではないので、文字参照の復号・`?` `#` での切断・百分率復号はしない
 * (`a#b.svg` は字面の名前で、`%41` も `A` ではなく字面の名前)。もう一度解くと `#` で切れて
 * 別のファイルを探し、`100%.png` は復号不能で落ち、二重符号化が区切りや `..` へ化ける。
 *
 * 拒む形は `resolveSegments` と同じ NUL・`\`・空に加え、空・`.`・`..` のセグメント、ルート絶対、
 * scheme やドライブ指定(`C:`)で始まる形。ルートの引数は正規化済みの名前で来るので、正規化で
 * 形が変わる入力はどこを指すかを推測せずに拒む。戻り値は入力と同じ文字列。
 */
export function resolveServedRoutePath(decoded: string): string | undefined {
  if (decoded === '' || SCHEME_PREFIX_RE.test(decoded)) return undefined;
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  return segments.join('/');
}

/** 参照元ファイルの論理パスから、相対参照の基準になるディレクトリのセグメント列を作る。 */
function baseSegmentsOf(from: string): string[] | undefined {
  if (from === DOC_DIR) return [DOC_DIR];
  const segments = resolveSegments([], from);
  return segments === undefined || segments.length === 0 ? undefined : segments.slice(0, -1);
}

/**
 * 文書または CSS 等からの相対参照を、論理ルート相対のパスへ解く。
 *
 * 文書は「論理ルートの 1 段下(`doc/<文書>.html`)」にあるものとして解く。`from` が `'doc'` なら
 * 文書から、それ以外は参照元ファイルの論理パス(例 `css/A_1_交付版.css`)から見た相対になる。
 * 結果が `doc/` 配下になる参照(文書直下基準の `css/x.css` など)は資産の置き場を指さないので
 * `undefined` にする。ルート外・絶対・scheme 付き・`data:` も `undefined`。
 *
 * 綴りの扱い: クエリ・断片は落とす。百分率符号化は区間ごとに復号し、`%2F` `%5C` `%2e%2e` の
 * ように区切りや `..` になる形は `undefined`。大文字小文字は変えない(照合側の責務)。
 */
export function resolveDocAssetPath(url: string, from: string): string | undefined {
  const base = baseSegmentsOf(from);
  if (base === undefined) return undefined;
  const decoded = decodedPathOf(normalizeHtmlUrlValue(url), true);
  if (decoded === undefined || SCHEME_PREFIX_RE.test(decoded)) return undefined;
  const segments = resolveSegments(base, decoded);
  if (segments === undefined || segments.length === 0) return undefined;
  if (segments[0].toLowerCase() === DOC_DIR) return undefined;
  return segments.join('/');
}
