// =============================================================================
// htmlExternalRefs.ts — HTML の属性が「文書の外へ取りに行く」参照かを判定する
// =============================================================================
// テンプレは CSS・フォント・JS を **同梱資産への相対パス**(`css/…` `fonts/…` `js/…`)で
// 参照する。これは正当どころか必須で、遮断してはならない。遮断すべきなのは
// **オリジン外への絶対参照**(`https://…` / `//host` / 許可外 `data:`)だけである。
//
// つまり「外部参照要素を要素名で落とす」という旧方針は誤りだった。`<link>` を無条件に
// 落とすと per-fund CSS が読めず、`<script src>` を落とすとテンプレ JS が動かない。
// 判定軸は**要素名ではなく URL の形**へ移す。
//
// 判定基準は `cssExternalRefs.ts` の `isSelfContainedUrl` と**同一関数**を使う。
// CSS 側と HTML 側で別々のブロックリストを持つと、片方だけ緩い形が必ず生まれる。
//
// 置き場が `shared` なのは、**関門をサーバ側に置きつつ web にも同じ早期フィードバックを
// 出す**ため(`cssExternalRefs.ts` 冒頭の解説と同じ理由)。web の検査は唯一の関門ではない。

import { isSelfContainedUrl } from './cssExternalRefs.js';
import { normalizeHtmlUrlValue } from './htmlEntities.js';

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
 * 漏れを致命傷にしないための**強制点は `server/src/vivliostyle/egressGuard.ts`** で、
 * 組版ブラウザはそのビルドが押さえたオリジンの外へ出られない。ここは「早期に 400 で
 * 拒んで運用者へ理由を返す」層であって、最後の砦ではない。
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
 */
function metaRefreshUrl(attrs: ReadonlyArray<{ name: string; value: string }>): string | undefined {
  let isRefresh = false;
  let content: string | undefined;
  for (const a of attrs) {
    const name = a.name.toLowerCase();
    if (name === 'http-equiv' && a.value.trim().toLowerCase() === 'refresh') isRefresh = true;
    if (name === 'content') content = a.value;
  }
  if (!isRefresh || content === undefined) return undefined;
  const m = /^\s*[0-9.]*\s*[;,]?\s*(?:url\s*=\s*)?([\s\S]*)$/i.exec(content);
  const raw = (m?.[1] ?? '').trim();
  // 値は引用符で囲まれることがある(`content="0;url='https://evil/'"`)。
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  return unquoted === '' ? undefined : unquoted;
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
    if (refresh !== undefined && !isSelfContainedUrl(normalizeHtmlUrlValue(refresh))) {
      found.push(`<meta http-equiv="refresh" content="…${refresh}">`);
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
  const v = normalizeHtmlUrlValue(url);
  if (v === '' || !isSelfContainedUrl(v)) return undefined;
  // 断片・クエリは配信対象の識別に関与しない。
  const pathOnly = v.split(/[?#]/, 1)[0];
  if (pathOnly === '' || pathOnly.startsWith('/')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return undefined; // 復号不能は fail closed
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const segments: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // ルートより上へ出る形は配信ルート配下に解決できない。
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.length === 0 ? undefined : segments.join('/');
}
