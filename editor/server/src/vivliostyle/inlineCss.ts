// =============================================================================
// inlineCss.ts — CSS 文字列を HTML ドキュメントへインライン展開する純粋関数
// =============================================================================
// 元は `build.ts` の私有関数。結合 build(`mergeInput.ts`)が文書実体化で同じ展開を
// 必要とするため独立モジュールへ切り出した。
//
// タグの検出を正規表現でなく indexOf 主体の線形走査で行う理由: `<link\b[^>]*...>` の形は
// `>` を含まない入力(例 `'<link '.repeat(1e6)`)に対し `<link` の出現位置ごとに末尾まで
// 舐め直す(二次のバックトラック)。`html` はリクエスト本文そのもので長さは呼び出し側の
// ボディ上限までしか縛られておらず、1 リクエストで単一スレッドのイベントループを塞げる。
// 走査位置を単調に前進させる実装なら、同じ結果を入力長に比例する時間で得られる。
//
// 文字列連結で差し込むのも意図的: `String.prototype.replace` は置換文字列中の `$&` `$'`
// などを特殊解釈するため、CSS(利用者入力)をそのまま置換文字列に載せると内容が化ける。

/** 開きタグ 1 つの位置。`start` は `<` の位置、`end` は対応する `>` の次の位置。 */
interface TagSpan {
  start: number;
  end: number;
}

/** `\b` 相当の判定に使う語構成文字。 */
const WORD_RE = /[A-Za-z0-9_]/;

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
 * `<name` で始まる開きタグを先頭から順に列挙する(大文字小文字は無視)。
 *
 * `>` が以降に 1 つも無ければ、閉じられる開きタグはもう存在しないので走査を打ち切る。
 * これと「次の探索を直前のタグの `>` の後ろから始める」ことで、入力全体を高々 1 回しか
 * 舐めない(上のヘッダで述べた二次挙動の回避)。
 *
 * `boundary` は元の正規表現の `\b` に対応する。`<link` は `\b` 付き(`<linkfoo>` は別要素)、
 * `<body` は `\b` 無し(`<bodyfoo>` も一致)で、挙動を移行前と揃えるため呼び分ける。
 */
function* openTags(html: string, name: string, boundary: boolean): Generator<TagSpan> {
  const starts = new RegExp(`<${name}`, 'gi');
  let from = 0;
  while (from < html.length) {
    starts.lastIndex = from;
    const m = starts.exec(html);
    if (!m) return;
    const afterName = m.index + m[0].length;
    // 境界判定は `>` 探索より先に行う。逆順にすると `<linkx` の連続で毎回末尾まで
    // 走査してしまい、避けたはずの二次挙動が戻る。
    if (boundary && WORD_RE.test(html[afterName] ?? '')) {
      from = afterName;
      continue;
    }
    const gt = html.indexOf('>', afterName);
    if (gt === -1) return;
    yield { start: m.index, end: gt + 1 };
    from = gt + 1;
  }
}

/**
 * タグ本文が外部 stylesheet の `<link>` かを判定する。判定式は移行前の
 * `\brel=["']?stylesheet["']?` と同一(引用符は任意、閉じ引用符の欠落も許す)。
 */
function isStylesheetLink(tag: string): boolean {
  return /\brel=["']?stylesheet["']?/i.test(tag);
}

/** CSS 文字列を HTML ドキュメントへインライン展開する(head / body / 完全ラッパ)。 */
export function inlineCss(html: string, css: string): string {
  // CSS は inline 化するため, テンプレ由来の外部 stylesheet `<link>` は除去する(head/body 分岐の前)。
  // PDF(headless browser)では 404 で無視されるだけだが, ブラウザ内 `@vivliostyle/core` を使う
  // プレビュー経路(`buildPreviewDocument`)と挙動を揃え, 不要な失敗フェッチも無くす。
  const kept: string[] = [];
  let cursor = 0;
  for (const span of openTags(html, 'link', true)) {
    if (!isStylesheetLink(html.slice(span.start, span.end))) continue;
    kept.push(html.slice(cursor, span.start));
    cursor = span.end;
  }
  const cleaned = kept.length === 0 ? html : kept.join('') + html.slice(cursor);

  if (!css) return cleaned;
  const styleTag = `<style>\n${css.replace(STYLE_CLOSE_RE, '<\\/')}\n</style>`;
  const headEnd = cleaned.search(/<\/head>/i);
  if (headEnd !== -1) {
    return `${cleaned.slice(0, headEnd)}${styleTag}${cleaned.slice(headEnd)}`;
  }
  const body = openTags(cleaned, 'body', false).next();
  if (!body.done) {
    return `${cleaned.slice(0, body.value.end)}${styleTag}${cleaned.slice(body.value.end)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${cleaned}</body></html>`;
}
