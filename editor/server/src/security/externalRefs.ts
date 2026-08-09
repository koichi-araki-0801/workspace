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
// 検査対象は 3 面ある。1 つでも欠けるとそこが迂回路になる:
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
    }
    // 属性値は走査器が切り出したものを使う。原文への正規表現で拾うと
    // `data-style="…"` や他属性の値の中の字面まで拾って誤検知になる。
    // 値は**引用符を外しただけの原文**なので、CSS 検査へ渡す前に実体参照を解く —
    // 解かない版は `style="background:url(&#104;ttp://evil/x)"` を 0 件で通した(実測)。
    for (const a of tag.attrs) {
      if (a.name === 'style') out.push(...findExternalRefsInCss(decodeHtmlEntities(a.value)));
    }
    if (tag.isEnd) continue;
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

/** 展開済みプロジェクトで中身を検査する拡張子(CSS を書ける面はこの 2 系統だけ)。 */
const CSS_FILE_EXT = new Set(['.css']);
const DOC_FILE_EXT = new Set(['.html', '.htm', '.xhtml', '.xht']);

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
      const ext = path.extname(entry.name).toLowerCase();
      const isCss = CSS_FILE_EXT.has(ext);
      if (!isCss && !DOC_FILE_EXT.has(ext)) continue;
      let text = '';
      try {
        text = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (isCss) assertNoDocumentExternalRefs('', text, `project:${rel}`);
      else assertNoDocumentExternalRefs(text, '', `project:${rel}`);
    }
  }
}
