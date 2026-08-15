// =============================================================================
// externalRefs.ts — build へ渡す文書が「文書の外へ取りに行く」参照を持たないことを強制する
// =============================================================================
// PDF は CSP の無い headless ブラウザ(`@vivliostyle/cli`)で組版される。CSS の `@import` /
// `url(絶対URL)` / `image-set("http://…")` はそのまま fetch になり、
//   - ビルドサーバのネットワーク位置から任意 URL への GET(SSRF)
//   - 属性セレクタ + 背景画像で 1 文字ずつ URL へ載せる帳票内容の持ち出し
// が 1 リクエストで成立する。
//
// **関門はここ(サーバの build 入口)に置く。** 検査がブラウザの `web/src/lib/pdfDocument.ts`
// だけにあると、公開 API `POST /api/build` `/api/build/project` `/api/build/merge` へ
// 直接 POST すれば無検査で headless へ届く。守るべき境界ではなく迂回できる側へ関門を
// 置く形(「経路を閉じずヘッダだけ足す」と同型)になる。web 側の検査は
// 早期フィードバックとして残すが、判定関数は `@editor/shared` の 1 つを共有する。
//
// 検査対象は 4 面ある。1 つでも欠けるとそこが迂回路になる:
//   1. リクエストの `css`(そのまま `<style>` へ入る)
//   2. HTML 中の `<style>` ブロック(DOMPurify は `<style>` の中身を逐語保存する)
//   3. HTML の `style="…"` 属性(インライン宣言も `url()` を取れる)

//   4. HTML の取得系属性(`<link href>` `<script src>` `<img src>` …)
//
// ── 相対参照は「拒む対象」ではない。むしろ必須である ──
// テンプレは per-fund CSS・共通フォント・テンプレ JS を `css/…` `fonts/…` `js/…` の
// 相対パスで参照し、その実体は `vivliostyle/docAssets.ts` が配信ルートへ置く。よって
// 4 の判定は「取得系属性かどうか」ではなく「**その URL がオリジンの外を指すか**」で行い、
// 基準は CSS 側と同じ `isSelfContainedUrl`(`@editor/shared`)1 つに揃える。

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  decodeHtmlEntities,
  findExternalRefsInCss,
  findExternalRefsInTag,
  isSelfContainedUrl,
  nestedHtmlAttrsFor,
  validation,
} from '@editor/shared';
import { scanTags } from '../vivliostyle/inlineCss.js';

/** 拒否時にクライアントへ返す文言。外部クライアントの契約になるので変えるときは OpenAPI も。 */
export const EXTERNAL_REF_MESSAGE =
  'CSSまたはHTMLに外部参照(@import / 絶対URLのurl() / 絶対URLのhref・src)が含まれるため' +
  'PDFを作成できません。' +
  'フォントや画像やスクリプトは文書に同梱するか、同梱資産への相対パス(css/… fonts/… js/…)で' +
  '指定してください。';

/** 応答に載せる機械可読コード(OpenAPI に明記。クライアントはこれで分岐する)。 */
export const EXTERNAL_REF_CODE = 'DOCUMENT_EXTERNAL_REF';

/** タグ境界が一意に決まらない HTML を拒んだときの文言とコード。 */
export const UNPARSABLE_MESSAGE =
  'HTMLのタグが閉じていないためPDFを作成できません。' +
  '閉じていないタグ・コメント・<style>/<script> を閉じてから送信してください。';
export const UNPARSABLE_CODE = 'DOCUMENT_UNPARSABLE';

/**
 * JSON として読めないファイルを拒んだときの文言。コードは HTML と同じ
 * `UNPARSABLE_CODE` を使う — クライアントから見た意味は「中身を検査できないので受け取れない」
 * で同じであり、コードを増やすと外部契約が理由なく太る。
 */
export const JSON_UNPARSABLE_MESSAGE =
  'JSONファイルを読めないためPDFを作成できません。' +
  '構文を確認してから送信してください(検査できないファイルは受け取れません)。';

/** 応答へ載せる参照の最大件数。全部返すと入力の反射になるので頭だけ返す。 */
const MAX_REPORTED_REFS = 5;

/**
 * 文書(HTML + 付随 CSS)に含まれる外部参照をすべて列挙する。空配列 = 参照なし。
 *
 * `scanTags` が走査を諦めた入力(閉じないタグ / 閉じない raw text)は、`inlineCss` が
 * 「加工せず包むだけ」に倒れる = HTML がそのまま headless へ届く入力である。よって
 * ここでも**タグ単位の検査は当てにせず**、HTML 全体を CSS として舐めた結果を採る
 * (誤検知側へ倒れるが、判定不能な入力を通すよりよい)。
 */
export function findDocumentExternalRefs(html: string, css: string): string[] {
  const refs = [...findExternalRefsInCss(css)];
  collectHtmlRefs(html, refs, 0);
  return refs;
}

/**
 * `srcdoc` の中の HTML を走査し直す深さの上限。1 段で足りる(`srcdoc` の中の `srcdoc` も
 * 同じ経路でもう 1 段拾えるが、無限に降りる意味は無い)。上限を置くのは自己参照する
 * 入力で走査が止まらなくなるのを防ぐため。
 */
const MAX_NESTED_HTML_DEPTH = 2;

/**
 * 走査不能な入れ子文書(`srcdoc`)を報告するときの説明文字列。トップレベルの
 * `assertNoDocumentExternalRefs` は `scanTags` が諦めた入力を `UNPARSABLE_CODE` で 400 に
 * するが、入れ子は「参照 1 件」として計上して同じ 400 へ倒す(呼び出し側が
 * `findDocumentExternalRefs` を件数でしか見ない経路もあるため)。
 */
const NESTED_UNPARSABLE_REF = '<iframe srcdoc="(解析不能)">';

/** HTML 1 枚分の外部参照を `out` へ積む(`srcdoc` の入れ子文書は再帰で降りる)。 */
function collectHtmlRefs(html: string, out: string[], depth: number): void {
  const scan = scanTags(html);
  if (!scan.ok) {
    // 解析を諦めた入力でも **諦める前に読めたタグは必ず検査する**。捨てると、
    // 末尾に閉じないタグを 1 つ置くだけで手前の全タグが検査から消える。
    collectFromTags(scan.tags, out, depth);
    out.push(...findExternalRefsInCss(html));
    // 入れ子は fail closed。CSS 走査は引用符なし属性値を 1 つも見ないので、
    // `<iframe srcdoc="<img src=https://evil/x><b">` が零件で通る(実測)。
    if (depth > 0) out.push(NESTED_UNPARSABLE_REF);
    return;
  }
  collectFromTags(scan.tags, out, depth);
}

/** 走査済みタグ列から外部参照を積む(`collectHtmlRefs` の ok/失敗の両経路が共有する)。 */
function collectFromTags(
  tags: ReturnType<typeof scanTags>['tags'],
  out: string[],
  depth: number,
): void {
  for (const tag of tags) {
    if (tag.name === 'style' && tag.rawText !== undefined) {
      out.push(...findExternalRefsInCss(tag.rawText));
    } else if (
      tag.rawText !== undefined &&
      tag.name !== 'script' &&
      depth < MAX_NESTED_HTML_DEPTH
    ) {
      // `title` / `textarea` / `noscript` の中身。走査器はこれらを常に raw text として
      // 読み飛ばすが、**HTML 名前空間の外ではそうではない** — `<svg><title>` は foreign
      // content で普通の外来要素になり、内側の `<img src=https://…>` は実要素として
      // 取得しにいく。読み飛ばした範囲を検査しないと、そこが外部参照ゲートの死角になる。
      // `script` を除くのは、中身が JS であってマークアップではないため(字面の一致を
      // 参照として数えると誤検知が出る。実行面の固定は `templateScripts` の担当)。
      collectHtmlRefs(tag.rawText, out, depth + 1);
    }
    // 属性値は走査器が切り出したものを使う。原文への正規表現で拾うと
    // `data-style="…"` や他属性の値の中の字面まで拾って誤検知になる。
    // 値は**引用符を外しただけの原文**なので、CSS 検査へ渡す前に実体参照を解く —
    // 解かない版は `style="background:url(&#104;ttp://evil/x)"` を 0 件で通した(実測)。
    for (const a of tag.attrs) {
      if (a.name === 'style') out.push(...findExternalRefsInCss(decodeHtmlEntities(a.value)));
    }
    if (tag.isEnd) continue;
    // `<base>` は **URL の形を見ずに**拒む。相対 href でも「相対参照は同梱資産を指す」という
    // 前提そのものを別オリジンへ移せるので、値の検査では守れない。inline 経路では
    // `inlineCss` が要素ごと落とすが、zip project 経路(`POST /api/build/project`)はそこを
    // 通らないため、除去に頼ると防御が egressGuard 単独へ落ちる。
    if (tag.name === 'base') out.push('<base>');
    // 取得系属性の絶対 URL。相対参照(同梱資産)は `isSelfContainedUrl` が通す。
    out.push(...findExternalRefsInTag(tag.name, tag.attrs));
    // `srcdoc` は URL ではなく HTML 文書。URL として検査すると必ず「相対参照」と判定され、
    // 中に書いた絶対参照が丸ごと検査から消える(`htmlExternalRefs.ts` の注記)。
    if (depth >= MAX_NESTED_HTML_DEPTH) continue;
    const nested = nestedHtmlAttrsFor(tag.name);
    if (nested.length === 0) continue;
    for (const a of tag.attrs) {
      if (nested.includes(a.name)) collectHtmlRefs(decodeHtmlEntities(a.value), out, depth + 1);
    }
  }
}

/**
 * 外部参照を 1 件でも含む文書を 400 で拒む(削らずに拒む = fail closed)。
 * 削る実装は CSS のエスケープ(`url(\68ttp://…)`)で必ず迂回されるため採らない。
 */
export function assertNoDocumentExternalRefs(html: string, css: string, where: string): void {
  // 走査を諦めた入力は `inlineCss` が「加工せず包むだけ」に倒れる = HTML がそのまま
  // headless へ届く。ここを「検査できないから通す」にすると、閉じないタグを 1 つ置くだけで
  // ゲートを回避できるので拒否へ倒す(fail closed)。
  if (html !== '' && !scanTags(html).ok) {
    throw validation(UNPARSABLE_MESSAGE, { code: UNPARSABLE_CODE, cause: { where } });
  }
  const refs = findDocumentExternalRefs(html, css);
  if (refs.length === 0) return;
  throw validation(EXTERNAL_REF_MESSAGE, {
    code: EXTERNAL_REF_CODE,
    cause: { where, refs: refs.slice(0, MAX_REPORTED_REFS), total: refs.length },
  });
}

/** 展開済みファイルの検査のしかた。`inert` = バイナリ資産で参照を書けない。 */
export type InspectionKind = 'css' | 'doc' | 'markdown' | 'json' | 'inert';

/**
 * 展開を許す拡張子ごとの検査のしかた。
 *
 * **`projectInput.ts` の `ALLOWED_EXTENSIONS` の全キーに分類を与えること。** 「検査する集合」を
 * 別に並べる形だと、展開だけ許されて検査されない形式が静かに生まれる(実際 `.md` と `.svg` が
 * そうで、vivliostyle は `.md` を原稿として組版するため markdown 標準の画像 1 行で絶対 URL を
 * 無検査で通せた)。分類を必須にすれば、拡張子を足すときに「これはどう検査するか」を必ず
 * 決めることになる。一致は `externalRefs.test.ts` が機械で要求する。
 *
 * `doc` はタグ構造で書かれた文書(SVG も `<image href>` / `<use href>` / `<style>` を持つ)。
 * `json` は publication manifest と source map で、どちらも原稿・資産の場所を値として持つ。
 */
export const EXT_INSPECTION: Readonly<Record<string, InspectionKind>> = {
  '.html': 'doc',
  '.htm': 'doc',
  '.xhtml': 'doc',
  '.xht': 'doc',
  '.svg': 'doc',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.css': 'css',
  '.css.map': 'json',
  '.json': 'json',
  '.png': 'inert',
  '.jpg': 'inert',
  '.jpeg': 'inert',
  '.gif': 'inert',
  '.webp': 'inert',
  '.apng': 'inert',
  '.ttf': 'inert',
  '.otf': 'inert',
  '.woff': 'inert',
  '.woff2': 'inert',
};

/**
 * ファイル名の分類。判定は `projectInput.ts` の展開可否と**同じ物差し**(小文字化した
 * basename の末尾一致)で行う。`path.extname` を使う版は `.css.map` を `.map` と読んで
 * 分類不能にしていた = 展開は許すのに検査しないファイルが 1 種類あった。
 * 末尾一致が複数当たる場合は長い方を採る(`x.css.map` を `.css` と読まない)。
 */
function inspectionFor(name: string): InspectionKind | undefined {
  const base = name.toLowerCase().split(/[/\\]/).pop() ?? '';
  let kind: InspectionKind | undefined;
  let matched = 0;
  for (const [ext, value] of Object.entries(EXT_INSPECTION)) {
    if (base.endsWith(ext) && ext.length > matched) {
      kind = value;
      matched = ext.length;
    }
  }
  return kind;
}

/**
 * JSON-LD の文脈として**値の完全一致**でだけ許す URL。publication manifest はこれを書かないと
 * 仕様上成立しないので、拒むと正当なプロジェクトが必ず 400 になる。前方一致で緩めては
 * ならない(`https://schema.org.evil.example/` が通る)。
 */
const ALLOWED_JSON_CONTEXT_URLS = new Set([
  'https://schema.org',
  'https://www.w3.org/ns/pub-context',
]);

/**
 * JSON(publication manifest / source map)の中の外部参照を集める。
 *
 * vivliostyle は publication manifest を読んで原稿と資産の場所を決めるので、HTML にも CSS にも
 * 1 バイト書かずにここだけで外部から取りに行かせられる。どのキーが URL を取るかの列挙は
 * 版で変わるうえ必ず漏れるため、**全文字列値**を他の面と同じ `isSelfContainedUrl` で見る。
 * 過剰包含側(URL でない文字列が scheme の形をしていたら報告する)へ倒れるのは意図どおりで、
 * 見落とし側へは倒れない。
 */
export function findJsonExternalRefs(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validation(JSON_UNPARSABLE_MESSAGE, { code: UNPARSABLE_CODE });
  }
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (ALLOWED_JSON_CONTEXT_URLS.has(value.trim())) return;
      if (!isSelfContainedUrl(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(parsed);
  return out;
}

/** JSON の外部参照を拒む(読めない JSON は検査不能なので fail closed で 400)。 */
export function assertNoJsonExternalRefs(text: string, where: string): void {
  let refs: string[];
  try {
    refs = findJsonExternalRefs(text);
  } catch {
    // 読める JSON なら走査は必ず完走する(値を舐めるだけ)。ここへ来るのは parse 失敗だけで、
    // 中身を検査できない以上は通さない。どのファイルかを添え直すためにここで投げ直す。
    throw validation(JSON_UNPARSABLE_MESSAGE, { code: UNPARSABLE_CODE, cause: { where } });
  }
  if (refs.length === 0) return;
  throw validation(EXTERNAL_REF_MESSAGE, {
    code: EXTERNAL_REF_CODE,
    cause: { where, refs: refs.slice(0, MAX_REPORTED_REFS), total: refs.length },
  });
}

/**
 * markdown の参照先(画像・リンク・参照定義)を集める。
 *
 * markdown は HTML のタグ走査では拾えない — `![alt](http://evil/x.png)` にタグは無い。
 * vivliostyle は `.md` を HTML へ変換して組版するので、変換後に残る参照をここで先に見る。
 * 生 HTML ブロックも書けるため、この関数の結果と HTML 走査の結果を**両方**使う。
 *
 * 判定基準は他の面と同じ `isSelfContainedUrl` 1 つに揃える(相対参照 = 同梱資産は通す)。
 */
function findMarkdownExternalRefs(md: string): string[] {
  const out: string[] = [];
  // インラインの `](dest)` と、参照定義の `[label]: dest`。dest は空白かカッコで終わる。
  const inline = /\]\(\s*<?([^)\s>]+)>?/g;
  const refDef = /^[ \t]{0,3}\[[^\]]*\]:[ \t]*<?([^\s>]+)>?/gm;
  for (const re of [inline, refDef]) {
    re.lastIndex = 0;
    for (let m = re.exec(md); m !== null; m = re.exec(md)) {
      const dest = decodeHtmlEntities(m[1]);
      if (!isSelfContainedUrl(dest)) out.push(dest);
    }
  }
  return out;
}

/** markdown 原稿の外部参照を拒む(生 HTML ブロックも同時に見る)。 */
export function assertNoMarkdownExternalRefs(md: string, where: string): void {
  const refs = findMarkdownExternalRefs(md);
  if (refs.length > 0)
    throw validation(EXTERNAL_REF_MESSAGE, {
      code: EXTERNAL_REF_CODE,
      cause: { where, refs: refs.slice(0, MAX_REPORTED_REFS), total: refs.length },
    });
  // markdown 内の生 HTML は HTML として検査する。走査できない字面は markdown では
  // 珍しくない(`<` を素で書ける)ので、ここでは参照だけを見て未走査には倒さない。
  const htmlRefs = findDocumentExternalRefs(md, '');
  if (htmlRefs.length > 0)
    throw validation(EXTERNAL_REF_MESSAGE, {
      code: EXTERNAL_REF_CODE,
      cause: { where, refs: htmlRefs.slice(0, MAX_REPORTED_REFS), total: htmlRefs.length },
    });
}

/**
 * 展開済み vivliostyle プロジェクト配下の CSS / HTML を再帰的に検査する。
 * zip 経路(`POST /api/build/project` と project プレビュー)は inline 経路と違って
 * リクエスト本文に CSS が現れないため、`assertNoDocumentExternalRefs` だけでは素通りする。
 * 展開直後に 1 度通し、以降のビルド・プレビューは検査済みディレクトリだけを見る形にする。
 */
export async function assertProjectDirHasNoExternalRefs(dir: string): Promise<void> {
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    // 読めないディレクトリ・ファイルは読み飛ばす(展開直後なので実際には起きない)。
    // ここを `.catch(() => …)` のラムダで書かないのは、到達しない関数がカバレッジの
    // 関数指標を下げ、閾値を下げる圧力になるため。
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const kind = inspectionFor(entry.name);
      if (kind === undefined || kind === 'inert') continue;
      let text = '';
      try {
        text = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const where = `project:${path.relative(dir, full).split(path.sep).join('/')}`;
      if (kind === 'css') assertNoDocumentExternalRefs('', text, where);
      else if (kind === 'markdown') assertNoMarkdownExternalRefs(text, where);
      else if (kind === 'json') assertNoJsonExternalRefs(text, where);
      else assertNoDocumentExternalRefs(text, '', where);
    }
  }
}
