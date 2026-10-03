// =============================================================================
// fundImages.ts — 編集画面でファンド別画像を差すための純関数(対象の判定と CSS の生成)
// =============================================================================
// 編集画面(GrapesJS の canvas)は相対 URL をアプリの URL 基準で解くので、`images/…` は必ず
// 404 になる。属性を書き換えて直すと、文字編集・ペースト・Undo・`getHtml` のどこかで配信 URL が
// 保存内容へ混ざる経路が残る。だから属性には触らず、canvas 専用の `<style>` に
// `img[src="<原文>"]{content:url("<配信 URL>")}` を書いて表示だけを差し替える(DOM とモデルが
// 変わらないので、保存内容は原理的に原文のまま)。
//
// 差す範囲は PDF・プレビューと同じにする(編集画面だけ見えるずれを作らない):
//  - Jinja 本文(作成タブと、値入り HTML の無いテンプレ)は描画で `{{ fund.code }}` が展開される
//    ので、同じ値(テンプレ ID のファンドコード = `buildSampleData` が `fund.code` に入れる値)で解く。
//  - 値入り本文(編集タブ)は描画を通らないので、確定したパスだけを差す。`{{` が残る参照は
//    PDF にも出ないため解かず、警告で外部ツール側の修正を促す。
// GrapesJS への配線は `fundImageLayer.ts`。

import { parseAnyTemplateFileName } from '@editor/shared';
import { FUND_IMAGES_DIR, fundImageFileOf, fundImageUrl } from '@/lib/fundImages';

/** 本文の種類。`jinja` = 描画を通る本文、`filled` = 値入り HTML(描画を通らない)。 */
export type FundImageMode = 'jinja' | 'filled';

export interface FundImageContext {
  mode: FundImageMode;
  /** テンプレ ID のファンドコード。ID が規約に合わなければ null(Jinja の参照を解かない)。 */
  fundCode: string | null;
}

/**
 * 値入り本文に `{{ … }}` 入りの画像参照が残っているときの警告。テンプレート構文の字面を含むので、
 * Vue のテンプレートへ直書きせず定数として補間する(直書きすると Vue が式として評価する)。
 */
export const FUND_IMAGE_WARNING_MESSAGE =
  '値入り HTML の画像参照に {{ fund.code }} が残っています。' +
  '外部ツールで確定したパスを書いてください。PDF には表示されません';

const PREFIX = `${FUND_IMAGES_DIR}/`;
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

/** `src` が差す対象なら、配信するファイル名を返す。対象外は null。 */
export function resolveFundImageSrc(src: string, ctx: FundImageContext): string | null {
  if (!src.startsWith(PREFIX)) return null;
  let resolved = src;
  if (ctx.mode === 'jinja') {
    const { fundCode } = ctx;
    if (fundCode === null) return null;
    // 置換文字列に `$` を含むファンドコードでも置換記法として読ませない。
    resolved = resolved.replace(FUND_CODE_EXPR_RE, () => fundCode);
  }
  if (JINJA_RE.test(resolved)) return null;
  return fundImageFileOf(resolved) ?? null;
}

/** 値入り本文に、解けない(`{{` の残る)images/ 参照があるか。 */
export function needsFundImageWarning(srcs: Iterable<string>, ctx: FundImageContext): boolean {
  if (ctx.mode !== 'filled') return false;
  for (const src of srcs) {
    if (src.startsWith(PREFIX) && src.includes('{{')) return true;
  }
  return false;
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
    const file = resolveFundImageSrc(src, ctx);
    if (file === null) continue;
    const url = fundImageUrl(file);
    rules.push(`img[src=${cssString(src)}]{content:url(${cssString(url)})}`);
    if (!urls.includes(url)) urls.push(url);
  }
  return { css: rules.join('\n'), urls };
}
