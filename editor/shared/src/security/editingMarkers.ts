// =============================================================================
// editingMarkers.ts — 作成タブの往復用の印が本文に残っていないかを見つける
// =============================================================================
// 値入り HTML(`web/src/lib/fillJinja.ts` の `toFilled` の出力)は、Jinja を戻すための印を
// 本文へ埋める。`toTemplate` がそれを外しきれないまま申請・確定へ進むと、確定テンプレートに
// チップや clone が焼き付く。サーバの関所・検出スクリプト・`toTemplate` の事後検査が同じ
// 定義を使うよう、ここに 1 つだけ置く(定義が分かれると、片側だけ印を足し忘れる)。

import { lexJinja } from '../jinja/jinjaLex.js';

interface EditingMarkerHit {
  marker: string;
  index: number;
}

/** 印の属性名。`web/src/lib/jinjaAttrs.ts` の書き手と対になる。 */
export const EDITING_MARKER_ATTRS = [
  'data-jinja',
  'data-jinja-open',
  'data-jinja-close',
  'data-jinja-block',
  'data-jinja-loop-clone',
  'data-jinja-loop-row',
  'data-opaque',
  'data-opaque-kind',
] as const;

const MARKER_CLASSES = ['jinja-chip', 'jinja-frozen-body'] as const;
const COMMENT_RE = /<!--\s*jinja-rt:/g;
// `toTemplate` の placeholder(`web/src/lib/jinjaMask.ts` の `PH_RE` と同じ形)。私用領域の文字
// 単独では印としない。CP932 の外字は U+E000〜 へ写るので、編集タブの実値の本文に正当に現れる。
const PLACEHOLDER_RE = /\u{e000}[A-Za-z0-9+/=]*\u{e001}/gu;
// 中身が文字データの要素。タグに見える文字列があっても要素ではないので、閉じタグまで読み飛ばす。
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

const isAsciiAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
// HTML の空白(TAB / LF / FF / CR / SP)。
const isHtmlSpace = (c: number): boolean => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const SLASH = 47;
const GT = 62;
const EQ = 61;
const BANG = 33;
const QUESTION = 63;
// class の区切り。HTML は ASCII 空白だけで区切る(`\s` だと NBSP などでも切れてしまう)。
const HTML_SPACE_RUN = /[\t\n\f\r ]+/;
const isTagNameEnd = (c: number): boolean => isHtmlSpace(c) || c === SLASH || c === GT;

type AttrSink = (name: string, value: string, at: number) => void;

/**
 * タグ 1 個の属性部分を `from`(タグ名の直後)から読み、`onAttr` へ渡す。戻り値はタグを閉じる
 * `>` の次の位置で、閉じないまま入力が尽きたら -1(ブラウザはそのタグを捨て、後にタグは無い)。
 * 引用符は `=` の直後だけが値の区切りで、属性名の途中の引用符は名前の一部(ブラウザと同じ)。
 */
function readAttrs(html: string, from: number, at: number, onAttr: AttrSink | null): number {
  const n = html.length;
  const skipSpace = (k: number): number => {
    while (k < n && isHtmlSpace(html.charCodeAt(k))) k++;
    return k;
  };
  let j = from;
  for (;;) {
    while (j < n && (isHtmlSpace(html.charCodeAt(j)) || html.charCodeAt(j) === SLASH)) j++;
    if (j >= n) return -1;
    if (html.charCodeAt(j) === GT) return j + 1;
    const nameStart = j;
    j++; // 先頭の `=` も名前に含める(ブラウザと同じ)
    while (j < n) {
      const c = html.charCodeAt(j);
      if (isHtmlSpace(c) || c === SLASH || c === GT || c === EQ) break;
      j++;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    let value = '';
    j = skipSpace(j);
    if (j < n && html.charCodeAt(j) === EQ) {
      j = skipSpace(j + 1);
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close === -1) {
          onAttr?.(name, html.slice(j + 1), at);
          return -1;
        }
        value = html.slice(j + 1, close);
        j = close + 1;
      } else {
        const valueStart = j;
        while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== GT) j++;
        value = html.slice(valueStart, j);
      }
    }
    onAttr?.(name, value, at);
  }
}

/**
 * `<!--` の後(`from`)から、コメントを閉じる位置の次を返す。閉じなければ -1。
 * `seen` は閉じ方ごとの直近の検索結果。後ろのコメントで同じ範囲を読み直さない(-1 は以後も -1)。
 */
function commentEnd(html: string, from: number, seen: { dash: number; bang: number }): number {
  // `<!-->` と `<!--->` はその場で閉じる(ブラウザと同じ)。
  if (html.startsWith('>', from)) return from + 1;
  if (html.startsWith('->', from)) return from + 2;
  if (seen.dash !== -1 && seen.dash < from) seen.dash = html.indexOf('-->', from);
  if (seen.bang !== -1 && seen.bang < from) seen.bang = html.indexOf('--!>', from);
  const { dash, bang } = seen;
  if (dash === -1 && bang === -1) return -1;
  if (bang === -1 || (dash !== -1 && dash < bang)) return dash + 3;
  return bang + 4;
}

/**
 * 開始タグを先頭から 1 回だけ走査し、属性ごとに `onAttr` を呼ぶ。申請の入口(`POST
 * /api/review-requests`)から最大 8MB の本文で呼ばれるので、正規表現の後戻りに任せず入力長に
 * 線形で読む(`<a<a<a…` のような閉じない入力で、正規表現版は 8KB で 1 分を超えた)。
 * 区切りはブラウザの字句解析に合わせ、コメント・`<!…>` `<?…>`・終了タグも同じ範囲で読み飛ばす。
 * それらの中にタグ風の文字列があると、そこの引用符が後ろの本物のタグを呑み込み、ブラウザが
 * 要素として読む印を見落とすため。
 * `skipComments` が false のときは `<!--` の中も読む(`findEditingMarkers` の伏せた写しの走査)。
 */
function scanStartTags(html: string, onAttr: AttrSink, skipComments: boolean): void {
  // 大小文字を無視した閉じタグ探しに使う。走査 1 回につき 1 コピーに留める。ASCII だけを
  // 小文字にするのは、`toLowerCase` が長さを変える文字(`İ` など)で位置がずれるため。
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  // 閉じタグが見つからなかった raw text 要素名。2 回目以降の探索で末尾まで読み直さない。
  const unclosed = new Set<string>();
  // -2 はまだ探していない印(-1 は「以後に無い」)。
  const commentSeen = { dash: -2, bang: -2 };
  let i = html.indexOf('<');
  while (i !== -1) {
    const c1 = html.charCodeAt(i + 1);
    let next: number;
    if (isAsciiAlpha(c1)) {
      const at = i + 1;
      let j = at;
      while (j < html.length && !isTagNameEnd(html.charCodeAt(j))) j++;
      const tagName = lower.slice(at, j);
      next = readAttrs(html, j, at, onAttr);
      // 閉じタグが無ければ伏せずに先を読み続ける(見落としより誤検出の側へ倒す)。
      if (next !== -1 && RAW_TEXT_TAGS.has(tagName) && !unclosed.has(tagName)) {
        const end = findRawTextEnd(lower, tagName, next);
        if (end === -1) unclosed.add(tagName);
        else next = end;
      }
    } else if (c1 === SLASH && isAsciiAlpha(html.charCodeAt(i + 2))) {
      // 終了タグ。属性はブラウザが捨てるので報告しないが、引用符の範囲は同じく読み飛ばす。
      let j = i + 2;
      while (j < html.length && !isTagNameEnd(html.charCodeAt(j))) j++;
      next = readAttrs(html, j, i + 2, null);
    } else if (html.startsWith('!--', i + 1)) {
      next = skipComments ? commentEnd(html, i + 4, commentSeen) : i + 4;
    } else if (c1 === BANG || c1 === QUESTION || c1 === SLASH) {
      // `<!DOCTYPE>` などと、ブラウザが最初の `>` までを捨てる形(`</>` を含む)。
      const gt = html.indexOf('>', i + 2);
      next = gt === -1 ? -1 : gt + 1;
    } else {
      next = i + 1;
    }
    if (next === -1) return;
    i = html.indexOf('<', next);
  }
}

/** `</name` に空白・`/`・`>` が続く位置(ブラウザが閉じタグと読む位置)。無ければ -1。 */
function findRawTextEnd(lower: string, tagName: string, from: number): number {
  const needle = `</${tagName}`;
  let k = lower.indexOf(needle, from);
  while (k !== -1) {
    const c = lower.charCodeAt(k + needle.length);
    if (Number.isNaN(c) || isHtmlSpace(c) || c === SLASH || c === GT) return k;
    k = lower.indexOf(needle, k + 1);
  }
  return -1;
}

const JINJA_CLOSERS: Readonly<Record<string, string>> = { '{': '}}', '%': '%}', '#': '#}' };

interface Range {
  start: number;
  end: number;
}

/**
 * Jinja のトークン(`{{…}}` `{%…%}` `{#…#}`)の範囲。区切り方は `web/src/lib/jinjaMask.ts` の
 * `TOKEN_RE` と同じ(最短一致)だが、閉じない `{{` の反復で後戻りが入力長の 2 乗になるのを
 * 避けるため、閉じ記号の位置を種類ごとに覚えて線形に読む(-1 は「以後に無い」)。
 */
function jinjaRangesShortest(html: string): Range[] {
  const seen: Record<string, number> = { '}}': -2, '%}': -2, '#}': -2 };
  const ranges: Range[] = [];
  let i = html.indexOf('{');
  while (i !== -1) {
    const closer = JINJA_CLOSERS[html[i + 1] ?? ''];
    if (closer === undefined) {
      i = html.indexOf('{', i + 1);
      continue;
    }
    let close = seen[closer] ?? -2;
    if (close !== -1 && close < i + 2) {
      close = html.indexOf(closer, i + 2);
      seen[closer] = close;
    }
    if (close === -1) {
      i = html.indexOf('{', i + 1);
      continue;
    }
    ranges.push({ start: i, end: close + 2 });
    i = html.indexOf('{', close + 2);
  }
  return ranges;
}

/**
 * 範囲ごとに、改行以外を `fill` 1 文字ずつへ置き換えた写し。改行は残すので、位置と行は原文と
 * 一致する。範囲が無ければ原文をそのまま返す。
 */
function maskRanges(html: string, ranges: readonly Range[], fill: string): string {
  if (ranges.length === 0) return html;
  const parts: string[] = [];
  let last = 0;
  for (const r of ranges) {
    const token = html.slice(r.start, r.end);
    const masked = /[\r\n]/.test(token)
      ? token.replace(/[^\r\n]/g, fill)
      : fill.repeat(token.length);
    parts.push(html.slice(last, r.start), masked);
    last = r.end;
  }
  parts.push(html.slice(last));
  return parts.join('');
}

export function findEditingMarkers(html: string): EditingMarkerHit[] {
  const hits: EditingMarkerHit[] = [];
  for (const m of html.matchAll(COMMENT_RE))
    hits.push({ marker: 'comment:jinja-rt', index: m.index });
  for (const m of html.matchAll(PLACEHOLDER_RE))
    hits.push({ marker: 'placeholder', index: m.index });
  // 作成経路の本文は Jinja の原文で、エディタは Jinja を伏せてから読む。`{# <!-- #}` や
  // `{{ '<a title="' }}` のように Jinja の中の `<` や引用符が見かけのコメント・タグを作ると、原文を
  // ブラウザどおりに読むだけではその後ろの本物のタグを見落とす。そこで Jinja を伏せた写しも読む。
  // 区切りは 2 通り: エディタと同じ字句解析(`lexJinja`)の区切りと、字句解析が失敗する入力でも
  // 働く最短一致の区切り。偽の枝の中の `<!--`(`{% if false %}<!--{% endif %}`)は伏せても残るので、
  // 伏せた写しはコメントの中まで読む走査も掛ける。どれかで見つかれば印とし、同じ位置の同じ印は
  // 1 件にまとめる。
  const seen = new Set<string>();
  const onAttr: AttrSink = (name, value, at) => {
    const push = (marker: string) => {
      const key = `${marker}@${at}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ marker, index: at });
    };
    if ((EDITING_MARKER_ATTRS as readonly string[]).includes(name)) push(`attr:${name}`);
    if (name === 'data-gjs-type' && value.toLowerCase().startsWith('jinja-'))
      push('gjs-type:jinja');
    if (name === 'class')
      for (const c of MARKER_CLASSES)
        if (value.split(HTML_SPACE_RUN).includes(c)) push(`class:${c}`);
  };
  scanStartTags(html, onAttr, true);
  // 区切り 2 通り × 伏せ字 2 通り。エディタ(`web/src/lib/htmlScan.ts` の `maskJinja`)は `J` で
  // 伏せて読むので、Jinja だけの引用符なしの値(`title={{x}} data-jinja`)は値として残る。空白で
  // 伏せると値が消えて後ろの属性が値に化けるため、`J` の写しが要る。一方 `<a{{x}}data-jinja>` は
  // `J` だとタグ名・属性名に溶けるので、空白の写しも残す。`J` の写しでは `<` + Jinja もタグの始まりに
  // なる。エディタはそこをテキストとして読むが、描画すると要素になる(x = span など)ので拾ってよい。
  const lexed = lexJinja(html);
  const shortest = jinjaRangesShortest(html);
  const rangeSets = lexed.ok ? [lexed.tokens, shortest] : [shortest];
  const copies = new Set<string>();
  for (const ranges of rangeSets)
    for (const fill of [' ', 'J']) copies.add(maskRanges(html, ranges, fill));
  for (const masked of copies) {
    if (masked !== html) scanStartTags(masked, onAttr, true);
    scanStartTags(masked, onAttr, false);
  }
  return hits.sort((x, y) => x.index - y.index);
}

/**
 * 印が残った申請・確定を拒否するときの文言。server と local が同じ文を出すよう、ここに置く。
 * 印が無ければ null。
 */
export function editingMarkerMessage(
  hits: readonly EditingMarkerHit[],
  templateId: string,
): string | null {
  if (hits.length === 0) return null;
  const kinds = [...new Set(hits.map((h) => h.marker))].join(', ');
  return `申請本文に編集用の印(${kinds})が残っています。編集画面を開き直してから申請してください: ${templateId}`;
}
