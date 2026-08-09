// =============================================================================
// inlineCss.ts — CSS 文字列を HTML ドキュメントへインライン展開する純粋関数
// =============================================================================
// PDF build(`build.ts`)と結合 build(`mergeInput.ts`)が文書実体化で同じ展開を
// 共有するための独立モジュール。
//
// ── なぜタグの切り出しを自前の走査でやるのか ──
// この関数は「外部参照要素を落とす」「`</head>` の直前へ `<style>` を足す」の 2 つをするが、
// どちらも**タグの正確な範囲**を知らないと誤爆する。`<link` から次の `>` までを 1 タグと
// みなす素朴な切り出しでは、`<img alt="<link rel=stylesheet">…` のように属性値の中から
// 始まった span がその要素のタグ終端 `>` を食い、除去後に残ったテキストが属性トークン列
// として再解釈される(= `onerror=` が live な属性として復活する)。`</head>` の初出探索も
// 同型で、属性値に字面を置くとアプリが組み立てた `<style>` が属性値の内側へ落ちる。
//
// 正しい解は HTML パーサに読ませることだが、`editor/server` は DOM 実装(linkedom/jsdom)を
// 依存に持たない。よって本ファイルは**タグの境界だけを求める最小の走査器**(`scanTags`)を
// 持ち、引用符・コメント・raw text 要素の 3 点だけを仕様どおりに扱う。属性値の中身も
// 実体参照も解釈しない — 求めるのが「タグの開始と終了の位置」だけだからである。
// 走査器が確信を持てない入力(閉じないタグ / 閉じないコメント / 閉じない raw text)では
// `ok:false` を返し、呼び出し側は**加工を諦めて包むだけ**にする(fail closed)。
//
// ⚠ ここを `String.prototype.replace` + 正規表現へ戻さないこと。`[^>]*` は引用符を越えるので
// 上記の span 食いが即座に復活する。DOM 実装を依存に足せるようになったら、本ファイルは
// linkedom でのパース + `head.appendChild` へ置き換えるのが本来の姿(`docs` の申し送り)。
//
// 文字列連結で差し込むのも意図的: `String.prototype.replace` は置換文字列中の `$&` `$'`
// などを特殊解釈するため、CSS(利用者入力)をそのまま置換文字列に載せると内容が化ける。

import { resolveServedAssetPath } from '@editor/shared';

/** `servedAssets` 未指定時の既定(資産を 1 つも配置していない配信ルート)。 */
const EMPTY_SERVED: ReadonlySet<string> = new Set<string>();

/**
 * `<style>` の中身は HTML パーサにとって raw text で、終端は最初に現れる `</style` 1 つだけ。
 * CSS の文字列リテラルの内側かどうかは見ないため、`css`(= `/api/build` 等のリクエスト本文
 * そのもの)に `}</style><script>...` と書けば生成文書へ script を注入できる。プレビュー経路の
 * CSP より手前で潰す必要があり、PDF build 経路(headless で file:// を開く)には CSP が無い。
 *
 * 置換は `</` の `/` を CSS のエスケープ `\/` にするだけ。CSS 文字列中では `\/` は `/` と
 * 同義なので意味は変わらず、HTML パーサからは `</style` に一致しなくなる。
 * web 側の同義処理は `web/src/lib/sanitizeCss.ts`(こちらは DOM 組み立て用に別実装)。
 */
const STYLE_CLOSE_RE = /<\/(?=style)/gi;

/**
 * 中身を raw text / RCDATA として読む要素。開始タグの後は、対応する終了タグまで一切の
 * マークアップが解釈されない。ここを見落とすと `<script>var s='</head>'</script>` の
 * 文字列リテラルを本物の終了タグと誤認する。
 *
 * `noscript` は本来「スクリプト有効時のみ raw text」だが、常に raw text 扱いにしておく。
 * 誤って raw text とみなす方向の間違いは「中の本物のタグを見落とす」= 加工を諦める側へ
 * 倒れるだけで、偽のタグを掴むより安全だからである。
 */
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
]);

/**
 * URL によらず必ず落とす要素。
 *
 * `<base>` は相対 URL の解決先を丸ごと別オリジンへ向け替えられるので、値の形に関わらず
 * 落とす(相対参照を許す設計の土台そのものを動かせてしまう)。`<meta http-equiv>` は
 * 宣言的リフレッシュで遷移を起こせるので同様。
 *
 * **`link` と `script` はここに入れない。** テンプレは per-fund CSS・共通フォント・
 * テンプレ JS を相対パスで参照し、その実体は `docAssets.ts` が配信ルートへ置く。
 * 要素名で落とすと同梱資産まで道連れになるため、判定は
 * 「**href / src が配信ルート配下の実体に解決されるか**」で行う(`dropsUnservedRef`)。
 */
const ALWAYS_DROPPED_ELEMENTS = new Set(['base']);

/** タグ 1 つの位置。`start` は `<` の位置、`end` は対応する `>` の次の位置。 */
export interface TagSpan {
  start: number;
  end: number;
  /** 小文字化したタグ名。 */
  name: string;
  /** 終了タグ(`</name>`)か。 */
  isEnd: boolean;
  /** `<` から `>` までの原文(診断用)。 */
  raw: string;
  /**
   * 小文字化した属性名の列(開始タグのみ。終了タグは空)。
   * **属性の有無を `raw` への正規表現で嗅ぎ分けないこと。** `/[\s"']http-equiv=/` は
   * `<meta/http-equiv=refresh>` を取り逃がす — タグ名直後の `/` は self-closing 開始タグ
   * 状態を経て before-attribute-name へ**再消費**されるので、これは正当な属性である
   * (Chromium で実際に遷移する)。境界を正しく求める走査器を持ちながら中身だけ正規表現に
   * 戻すと、その 1 箇所が穴になる。
   */
  attrNames: string[];
  /** 属性名と値の組(開始タグのみ)。値は引用符を外した原文で、実体参照は解かない。 */
  attrs: ParsedAttr[];
  /**
   * raw text 要素(`script` / `style` 等)の中身。終了タグを持つ開始タグにのみ入る。
   * `<style>` の CSS を外部参照検査へ回すために使う(`security/externalRefs.ts`)。
   */
  rawText?: string;
}

/** 属性 1 つ。`name` は小文字化済み。 */
export interface ParsedAttr {
  name: string;
  value: string;
}

interface ScanResult {
  tags: TagSpan[];
  /** 走査が最後まで一意に決まったか。false なら加工してはならない(fail closed)。 */
  ok: boolean;
}

const isAsciiAlpha = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/** タグ名を構成しうる文字(空白・`/`・`>` でタグ名は終わる)。 */
const isTagNameChar = (c: string): boolean => !/[\s/>]/.test(c);

/**
 * raw text 要素 `name` の終了タグ位置(`<` の index)を返す。見つからなければ -1。
 * 終端条件は仕様どおり「`</` + 名前 + 空白 / `/` / `>`」で、大文字小文字は無視する。
 *
 * ⚠ `lower`(= `html` 全体の小文字化コピー)は**呼び出し側が 1 回だけ作って渡す**。
 * ここで `html.toLowerCase()` すると、raw text 開始タグ 1 つにつき入力全体の
 * コピーを 1 つ作ることになる。`RAW_TEXT_ELEMENTS` には `title` が入っているので
 * `'<title></title>'` の反復が最悪形で、1MB の本文でも O(タグ数 × 長さ)=数十 GB の
 * コピーになり、同期区間なのでイベントループが恒久停止する(= 全 API の停止)。
 * 走査 1 回につきコピー 1 回に保つこと。
 */
function findRawTextEnd(html: string, lower: string, from: number, name: string): number {
  const needle = `</${name}`;
  let i = from;
  while (i < lower.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) return -1;
    const after = html[at + needle.length];
    if (after === undefined || /[\s/>]/.test(after)) return at;
    i = at + needle.length;
  }
  return -1;
}

/**
 * 開始タグの属性領域(タグ名の直後 〜 閉じ `>` の手前)から属性名を切り出す。
 * HTML の before-attribute-name / attribute-name / before-attribute-value の 3 状態だけを
 * 素直に写したもので、`/` と空白はどちらも属性名の区切りとして読み飛ばす。
 */
function parseAttrs(inner: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  let i = 0;
  while (i < inner.length) {
    if (/[\s/]/.test(inner[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < inner.length && !/[\s/=>]/.test(inner[i])) i++;
    const name = inner.slice(start, i).toLowerCase();
    while (i < inner.length && /\s/.test(inner[i])) i++;
    let value = '';
    if (inner[i] === '=') {
      i++;
      while (i < inner.length && /\s/.test(inner[i])) i++;
      const quote = inner[i];
      if (quote === '"' || quote === "'") {
        const e = inner.indexOf(quote, i + 1);
        value = inner.slice(i + 1, e === -1 ? inner.length : e);
        i = e === -1 ? inner.length : e + 1;
      } else {
        const vs = i;
        while (i < inner.length && !/\s/.test(inner[i])) i++;
        value = inner.slice(vs, i);
      }
    }
    if (name !== '') attrs.push({ name, value });
  }
  return attrs;
}

/**
 * HTML 中のタグを先頭から順に列挙する。属性値の引用符・コメント・raw text を跨がないので、
 * 返る span は必ず本物のタグ 1 つに対応する。
 *
 * 入力全体を高々 1 回しか舐めない(走査位置は単調前進)。`'<link '.repeat(200_000)` のような
 * 病的入力では最初のタグで `>` が見つからず `ok:false` で即座に打ち切るため、素朴な
 * 正規表現切り出しで起きる二次のバックトラックも起きない。
 */
export function scanTags(html: string): ScanResult {
  const tags: TagSpan[] = [];
  // 小文字化コピーは走査ごとに 1 つだけ(`findRawTextEnd` の注意書きを見よ)。
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      i++;
      continue;
    }
    const next = html[i + 1];
    if (next === '!') {
      // コメントは `-->` まで。それ以外の markup declaration(doctype 等)は bogus comment
      // として最初の `>` まで。どちらも中身にタグは無い。
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        if (end === -1) return { tags, ok: false };
        i = end + 3;
      } else {
        const end = html.indexOf('>', i + 2);
        if (end === -1) return { tags, ok: false };
        i = end + 1;
      }
      continue;
    }
    if (next === '?') {
      const end = html.indexOf('>', i + 2);
      if (end === -1) return { tags, ok: false };
      i = end + 1;
      continue;
    }
    const isEnd = next === '/';
    const nameStart = i + (isEnd ? 2 : 1);
    if (!isAsciiAlpha(html[nameStart])) {
      // `</` + 非英字は bogus comment(最初の `>` まで)。`<` + 非英字はただのテキスト。
      if (isEnd) {
        const end = html.indexOf('>', nameStart);
        if (end === -1) return { tags, ok: false };
        i = end + 1;
      } else {
        i++;
      }
      continue;
    }
    let j = nameStart;
    while (j < html.length && isTagNameChar(html[j])) j++;
    const name = html.slice(nameStart, j).toLowerCase();
    // 属性領域を引用符状態つきで走査する。引用符の外に現れた `>` だけがタグを閉じる
    // (未引用の属性値中の `>` もタグを閉じる — これは仕様どおりの挙動)。
    let k = j;
    let quote = '';
    while (k < html.length) {
      const ch = html[k];
      if (quote !== '') {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') break;
      k++;
    }
    if (k >= html.length) return { tags, ok: false };
    const end = k + 1;
    const span: TagSpan = {
      start: i,
      end,
      name,
      isEnd,
      raw: html.slice(i, end),
      attrs: isEnd ? [] : parseAttrs(html.slice(j, k)),
      attrNames: [],
    };
    span.attrNames = span.attrs.map((a) => a.name);
    tags.push(span);
    i = end;
    if (!isEnd && RAW_TEXT_ELEMENTS.has(name)) {
      const close = findRawTextEnd(html, lower, i, name);
      if (close === -1) return { tags, ok: false };
      span.rawText = html.slice(i, close);
      i = close;
    }
  }
  return { tags, ok: true };
}

/** 開始タグが `http-equiv` 属性を持つか(`<meta http-equiv=refresh>` の判定用)。 */
function hasHttpEquiv(tag: TagSpan): boolean {
  return tag.attrNames.includes('http-equiv');
}

/**
 * `<link rel="stylesheet">` か(`rel` は空白区切りの複数値・大小文字を区別しない)。
 */
function isStylesheetLink(tag: TagSpan): boolean {
  if (tag.name !== 'link') return false;
  const rel = tag.attrs.find((a) => a.name === 'rel');
  if (rel === undefined) return false;
  return rel.value.toLowerCase().split(/\s+/).includes('stylesheet');
}

/**
 * `<link href>` / `<script src>` が **配信ルートに実体の無い**参照か。
 *
 * 絶対参照(`https://…` 等)はここへ来るより前に 400 で拒否済み
 * (`security/externalRefs.ts` の `assertNoDocumentExternalRefs`)なので、ここで見るのは
 * 「相対参照だが実体が無い」形だけである。残すと組版側のフェッチャが 404 を踏み、
 * ページ分割が中断する — だから**残すのは実体があるときだけ**という非対称にする。
 *
 * 属性そのものが無い場合(素の `<script>` = テンプレ JS 本体、href の無い `<link>`)は
 * 取得を起こさないので落とさない。
 */
function dropsUnservedRef(tag: TagSpan, served: ReadonlySet<string>): boolean {
  const attrName = tag.name === 'link' ? 'href' : 'src';
  const attr = tag.attrs.find((a) => a.name === attrName);
  if (attr === undefined) return false;
  const rel = resolveServedAssetPath(attr.value);
  return rel === undefined || !served.has(rel);
}

/**
 * 取得を起こす要素のうち、配信ルートで解決できないものを落とす。
 *
 * `link` まで要素名で無条件に落とすと、テンプレが CSS・
 * フォント・JS を同梱資産への相対パスで参照する、という要件と正面から衝突する
 * (`docAssets.ts` 冒頭を見よ)。判定軸は要素名ではなく URL の解決先に置く。
 *
 * ── CSS の適用元は 1 つに保つ(`hasInlineCss`)──
 * リクエストが `css` を持つとき、その CSS が**唯一の源**である。同じ per-fund CSS が
 * ディスク側にも在るので、`<link href="css/510037.css">` を残すと 2 重に当たり、しかも
 * 挿入位置の都合で**ディスク側が先・リクエスト側が後**になる。編集中の下書き CSS で
 * 規則を「削除」しても、後勝ちでは削除を上書きできないためディスクの旧規則が復活する。
 * プレビュー(`web/src/lib/nunjucksRender.ts`)は `<link>` を落として inline だけを当てるので、
 * 残すとプレビューと PDF で見た目が食い違う。よってこの場合は stylesheet の `<link>` を落とす。
 * `css` が空のリクエスト(同梱 CSS だけで組む外部クライアント)では従来どおり残す。
 */
function stripUnresolvableRefTags(
  html: string,
  tags: TagSpan[],
  served: ReadonlySet<string>,
  hasInlineCss: boolean,
): string {
  const kept: string[] = [];
  let cursor = 0;
  for (const [i, tag] of tags.entries()) {
    if (tag.isEnd) continue;
    const drop =
      ALWAYS_DROPPED_ELEMENTS.has(tag.name) ||
      (tag.name === 'meta' && hasHttpEquiv(tag)) ||
      (hasInlineCss && isStylesheetLink(tag)) ||
      ((tag.name === 'link' || tag.name === 'script') && dropsUnservedRef(tag, served));
    if (!drop) continue;
    kept.push(html.slice(cursor, tag.start));
    cursor = dropEndOf(tags, i, tag);
  }
  return kept.length === 0 ? html : kept.join('') + html.slice(cursor);
}

/**
 * 落とす要素の終端(除去後に再開する位置)。
 *
 * raw text 要素(`<script>`)は**中身と終了タグまで**落とす。開始タグだけ消すと、それまで
 * raw text として読まれていた中身が地の HTML として再解釈され、`<script src=…>` の中に
 * 書かれた `<img onerror=…>` が live なマークアップとして復活する。
 * `inlineCss.ts` 冒頭の「除去でタグ境界を壊さない」不変則と同じ種類の罠である。
 */
function dropEndOf(tags: TagSpan[], index: number, tag: TagSpan): number {
  if (tag.rawText === undefined) return tag.end;
  const next = tags[index + 1];
  // `scanTags` は raw text の直後に終了タグ span を積む。無ければ中身の末尾で止める。
  const contentEnd = tag.end + tag.rawText.length;
  return next?.isEnd && next.name === tag.name && next.start === contentEnd ? next.end : contentEnd;
}

/** `inlineCss` の任意設定。 */
export interface InlineCssOptions {
  /**
   * 配信ルートへ実際に配置した資産の相対パス集合(`docAssets.stageDocAssets` の戻り値)。
   * 省略 = 何も配置していない、なので相対参照を持つ `<link>`/`<script src>` は全部落ちる
   * (= 資産配置を入れる前と同じ挙動)。
   */
  servedAssets?: ReadonlySet<string>;
}

/** CSS 文字列を HTML ドキュメントへインライン展開する(head / body / 完全ラッパ)。 */
export function inlineCss(html: string, css: string, opts: InlineCssOptions = {}): string {
  const styleTag = css ? `<style>\n${css.replace(STYLE_CLOSE_RE, '<\\/')}\n</style>` : '';
  const served = opts.servedAssets ?? EMPTY_SERVED;

  const first = scanTags(html);
  if (!first.ok) {
    // 走査が一意に決まらない入力は加工しない。文書の前へ定数を連結するだけ(= *包む*)なら
    // アンカー探索も部分除去も要らず、誤った位置へ差し込む余地が無い。
    return styleTag ? `<!doctype html>\n${styleTag}\n${html}` : html;
  }
  const cleaned = stripUnresolvableRefTags(html, first.tags, served, styleTag !== '');
  if (!styleTag) return cleaned;

  // 除去でオフセットが動くので、挿入位置は掃除後の文字列から取り直す。
  const scan = scanTags(cleaned);
  if (!scan.ok) return `<!doctype html>\n${styleTag}\n${cleaned}`;

  const headEnd = scan.tags.find((t) => t.isEnd && t.name === 'head');
  if (headEnd) {
    return `${cleaned.slice(0, headEnd.start)}${styleTag}${cleaned.slice(headEnd.start)}`;
  }
  const bodyStart = scan.tags.find((t) => !t.isEnd && t.name === 'body');
  if (bodyStart) {
    return `${cleaned.slice(0, bodyStart.end)}${styleTag}${cleaned.slice(bodyStart.end)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${cleaned}</body></html>`;
}
