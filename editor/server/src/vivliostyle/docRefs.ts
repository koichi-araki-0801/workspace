// =============================================================================
// docRefs.ts — 文書が実際に参照している同梱資産の論理ルート相対パスを洗い出す
// =============================================================================
// `docAssets.stageDocAssets` は「置き場 × 拡張子」の許可リストで作業フォルダへ資産を写すが、
// **文書が参照していないものまで写す**と 2 つの困りごとが出る:
//   ① 単一テンプレのビルドの配信ルートへ他テンプレの CSS が載り、文書が
//      `<link href="../css/<他テンプレ>.css">` と書けばそれで組版できてしまう
//   ② 共通フォント一式が PDF 1 本ごと・プレビュー起動ごとに丸ごとコピーされる
// どちらも「参照されたものだけ」に絞れば消える。
//
// 文書は論理ルートの `doc/` に置かれたものとして参照を解く(`resolveDocAssetPath(url, DOC_DIR)`)。
// 判定関数は staging・`inlineCss`・`inlineDocScripts` と**同じもの**を使う。別実装で拾い直すと
// 「`inlineCss` は実体があると思って `<link>` を残したが、staging はそれを置いていない」
// = 404 でページ分割が止まる、という食い違いが生まれる。
//
// 見落としは「資産が置かれない → `inlineCss` が参照ごと落とす」= 静かな見た目の劣化になる。
// よって迷ったら**拾う側**へ倒す(過剰に拾ってもコピーが 1 つ増えるだけである)。

import { collectCssUrlCandidates, DOC_DIR, resolveDocAssetPath } from '@editor/shared';
import { scanTags } from './inlineCss.js';

/** CSS 内の相対参照を辿る段数。`css/x.css` → `css/fonts/y.woff2` の 1 段で足りるが余裕を持つ。 */
export const MAX_ASSET_REF_DEPTH = 3;

/** CSS 1 枚が参照する論理ルート相対パスを `out` へ積む。`from` は CSS の置き場(文書なら `DOC_DIR`)。 */
function addCssRefs(css: string, from: string, out: Set<string>): void {
  for (const candidate of collectCssUrlCandidates(css)) {
    const rel = resolveDocAssetPath(candidate, from);
    if (rel !== undefined) out.add(rel);
  }
}

/**
 * 文書(HTML + 付随 CSS)が直接参照する論理ルート相対パスの集合。
 *
 * 属性は**取得系に限らず全部**見る。取得系の一覧(`fetchUrlAttrsFor`)へ絞ると、その一覧に
 * 載っていない属性で資産を引く形が出たときに「参照しているのに置かれない」= 静かな見た目の
 * 劣化になる。ここは検査ではないので、拾いすぎてもコピーが 1 つ増えるだけである。
 * CSS を書ける面は 3 つ(リクエストの `css` / `<style>` ブロック / `style="…"` 属性)で、
 * どれも文書の中に置かれる = 文書の位置(`doc/`)が基準になる。リクエストの `css` は入口で
 * `rebaseCssForDoc` 済み(`requestCss.ts`)なので、同じ基準で解ける。
 * `scanTags` が諦めた入力は空集合を返す — その入力は `assertNoDocumentExternalRefs` が
 * 400 で先に落とす(`DOCUMENT_UNPARSABLE`)ので、ここが手当てする必要は無い。
 */
export function collectDocumentAssetRefs(html: string, css: string): Set<string> {
  const refs = new Set<string>();
  addCssRefs(css, DOC_DIR, refs);
  const scan = scanTags(html);
  if (!scan.ok) return refs;
  for (const tag of scan.tags) {
    if (tag.isEnd) continue;
    if (tag.name === 'style' && tag.rawText !== undefined) addCssRefs(tag.rawText, DOC_DIR, refs);
    for (const a of tag.attrs) {
      if (a.name === 'style') {
        addCssRefs(a.value, DOC_DIR, refs);
        continue;
      }
      const rel = resolveDocAssetPath(a.value, DOC_DIR);
      if (rel !== undefined) refs.add(rel);
    }
  }
  return refs;
}
