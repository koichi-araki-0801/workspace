// =============================================================================
// fundImages.ts — 編集画面でファンド別画像を差すための純関数(対象の判定と CSS の生成)
// =============================================================================
// 編集画面(GrapesJS の canvas)は相対 URL をアプリの URL 基準で解くので、`../images/…` は必ず
// 404 になる。属性を書き換えて直すと、文字編集・ペースト・Undo・`getHtml` のどこかで配信 URL が
// 保存内容へ混ざる経路が残る。だから属性には触らず、canvas 専用の `<style>` に
// `img[src="<原文>"]{content:url("<配信 URL>")}` を書いて表示だけを差し替える(DOM とモデルが
// 変わらないので、保存内容は原理的に原文のまま)。
//
// 参照は文書位置基準(文書は論理ルートの `doc/` にあるものとして `../images/…` を解く)で、
// 判定・配信 URL・会社フォルダの照合は `lib/fundImages.ts` と共有する。差す範囲は PDF・
// プレビューと同じにする(編集画面だけ見えるずれを作らない):
//  - Jinja 本文(作成タブと、値入り HTML の無いテンプレ)は描画で `{{ fund.code }}` が展開される
//    ので、同じ値(テンプレ ID のファンドコード = `buildSampleData` が `fund.code` に入れる値)で解く。
//  - 値入り本文(編集タブ)は描画を通らないので、確定したパスだけを差す。`{{` が残る参照は
//    PDF にも出ないため解かず、警告で外部ツール側の修正を促す。
// Chromium は読み込みに失敗した img を代替表示のインライン要素として扱い、幅と高さの指定が効か
// ないので、`display:inline-block` を詳細度 0(`:where`)で足す(テンプレの `display` が勝つ)。
// GrapesJS への配線は `fundImageLayer.ts`。

import { DOC_DIR, parseAnyTemplateFileName, resolveDocAssetPath } from '@editor/shared';
import { type ImageRefIssue, imageIssueMessages, imageRefIssue } from '@/lib/assetWarnings';
import {
  companyFolderMatches,
  type FundImageRef,
  fundImageRefOf,
  fundImageUrl,
} from '@/lib/fundImages';

/** 本文の種類。`jinja` = 描画を通る本文、`filled` = 値入り HTML(描画を通らない)。 */
export type FundImageMode = 'jinja' | 'filled';

export interface FundImageContext {
  mode: FundImageMode;
  /** テンプレ ID のファンドコード。ID が規約に合わなければ null(Jinja の参照を解かない)。 */
  fundCode: string | null;
  /** テンプレ ID の会社コード。会社フォルダの照合に使う。ID が規約に合わなければ null。 */
  companyCode: string | null;
}

const FUND_CODE_EXPR_RE = /\{\{\s*fund\.code\s*\}\}/g;
/** 解いた後にも残る Jinja の開始記号(式・文・コメント)。 */
const JINJA_RE = /\{[{%#]/;

/**
 * テンプレ ID(値入り HTML `<会社>_<ファンド>_<基準日>_<版>`、テンプレート `<会社>_<ファンド>_<版>`)から
 * ファンドコードを取り出す。
 */
export function fundCodeOfTemplateId(templateId: string): string | null {
  return parseAnyTemplateFileName(`${templateId}.html`)?.fundCode ?? null;
}

/** `src` が差す対象なら、配信する画像を返す。対象外は null。 */
export function resolveFundImageSrc(src: string, ctx: FundImageContext): FundImageRef | null {
  let resolved = src;
  if (ctx.mode === 'jinja') {
    const { fundCode } = ctx;
    if (fundCode === null) return null;
    // 置換文字列に `$` を含むファンドコードでも置換記法として読ませない。
    resolved = resolved.replace(FUND_CODE_EXPR_RE, () => fundCode);
  }
  if (JINJA_RE.test(resolved)) return null;
  const rel = resolveDocAssetPath(resolved, DOC_DIR);
  if (rel === undefined) return null;
  const ref = fundImageRefOf(rel);
  if (ref === undefined || !companyFolderMatches(ref, ctx.companyCode)) return null;
  return ref;
}

/**
 * canvas の `<img>` の `src` と CSS 由来の問題から、警告欄の文を作る。Jinja 本文は
 * `{{ fund.code }}` を解いてから判定し、他の式が残る参照は描画で決まるので見ない。値入り本文の
 * `{{` の残る参照は、PDF にも出ないので警告する。
 */
export function fundImageWarnings(
  srcs: Iterable<string>,
  ctx: FundImageContext,
  cssIssues: ReadonlyArray<readonly [string, ImageRefIssue]>,
): string[] {
  const issues: Array<readonly [string, ImageRefIssue]> = [];
  for (const src of new Set(srcs)) {
    let resolved = src;
    if (ctx.mode === 'jinja') {
      const { fundCode } = ctx;
      if (fundCode === null) continue;
      resolved = resolved.replace(FUND_CODE_EXPR_RE, () => fundCode);
      if (JINJA_RE.test(resolved)) continue;
    }
    const kind = imageRefIssue(resolved, DOC_DIR, ctx.companyCode);
    if (kind !== null) issues.push([src, kind]);
  }
  return imageIssueMessages([...issues, ...cssIssues], ctx.companyCode);
}

/**
 * CSS の二重引用符文字列にする。`"` `\` はエスケープし、制御文字と `<` `>` は 16 進エスケープ
 * にする(`<style>` の中身として直列化される場面でも要素を閉じる字面を作らない)。
 */
export function cssString(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (cp < 0x20 || cp === 0x7f || ch === '<' || ch === '>') out += `\\${cp.toString(16)} `;
    else out += ch;
  }
  return `"${out}"`;
}

/** canvas の `<img>` の `src` 一覧から、差し替えの CSS と先読みする URL を作る(重複は 1 つ)。 */
export function fundImageCss(
  srcs: Iterable<string>,
  ctx: FundImageContext,
): { css: string; urls: string[] } {
  const rules: string[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    if (seen.has(src)) continue;
    seen.add(src);
    const ref = resolveFundImageSrc(src, ctx);
    if (ref === null) continue;
    const url = fundImageUrl(ref);
    rules.push(`img[src=${cssString(src)}]{content:url(${cssString(url)})}`);
    rules.push(`:where(img[src=${cssString(src)}]){display:inline-block}`);
    if (!urls.includes(url)) urls.push(url);
  }
  return { css: rules.join('\n'), urls };
}
