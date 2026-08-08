// =============================================================================
// inlineDocScripts.ts — `<script src>` を配信ルートの実体でインライン展開する(PDF 経路)
// =============================================================================
// テンプレ JS は正当なコンテンツ(列幅自動調整など)だが、**PDF 組版では外部 `src` が実行
// されない**。ビューアは文書 DOM を DOMParser で作り、script 要素を自分の window へ作り直す
// ため、`src` の解決基準が「文書の場所」ではなく**ビューアアプリのページ URL**
// (`/__vivliostyle-viewer/index.html`)になる。`js/x.js` は `/__vivliostyle-viewer/js/x.js`
// へ解決され 404 になる(実測)。しかも **script の 404 はビルドを失敗させない** ため、
// 「JS が効いていない PDF が黙って出る」形になる。
//
// 一方で**インライン script は組版時に実行され、その DOM 変更は PDF 出力へ反映される**
// (実測)。よって組版へ渡す直前に、配信ルート上の実体を読んでインライン化する。
//
// ── なぜ `docAssets.ts` ではなく inlineCss の走査段に置くのか ──
// `docAssets.ts` は**ファイルを配信ルートへ写すだけ**で HTML を 1 バイトも読まない。そこへ
// 展開を置くと「タグ境界を正しく求める走査器」をもう 1 つ持つことになり、`inlineCss.ts`
// 冒頭が戒めている「`[^>]*` で属性値を跨いで span を食う」種類の誤爆を二重に抱える。
// 対して本モジュールは `inlineCss.scanTags` と `resolveServedAssetPath` をそのまま使う =
// **残す/落とすの判定(`dropsUnservedRef`)と完全に同じ物差し**で展開対象を決められる。
// 実行順も `inlineCss` の**後**にする: そこで既に「実体の無い相対参照」は要素ごと落ちて
// いるので、本モジュールが見る `<script src>` は必ず配信ルートに実体がある。
//
// ── 対象は PDF 経路(`buildInlinePdf` / `buildMergedPdf`)だけ ──
// zip 経路(`extractProjectZip`)は利用者が持ち込んだ自己完結のプロジェクトで、我々の
// 資産許可リストとも配信ルートの形とも無関係に組み立てられている。中身を書き換えるのは
// 「アップロードされた実体をそのまま配る」という段階の判断と食い違うので対象外にする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveServedAssetPath } from '@editor/shared';
import { scanTags, type TagSpan } from './inlineCss.js';

/**
 * インライン化する 1 ファイルのサイズ上限。展開結果は組版へ渡る HTML そのものになるので、
 * 巨大な JS を無制限に載せると文書サイズが跳ねる。超えたものは展開せず原文のまま残す
 * (= 従来どおり 404 で不実行。挙動は退行するが文書は壊れない)。
 */
const MAX_INLINE_SCRIPT_BYTES = 2 * 1024 * 1024;

/**
 * `</script` を無害化する。`<style>` 側の `STYLE_CLOSE_RE`(`inlineCss.ts`)と同じ発想で、
 * raw text の終端は最初に現れる `</script` 1 つだけなので、JS 本文に字面があると
 * **要素がそこで閉じ、残りが地の HTML として再解釈される**(= 任意マークアップの注入)。
 *
 * 置換は `/` を `\/` にするだけ。JS では文字列リテラル中・正規表現リテラル中のいずれでも
 * `\/` は `/` と同義なので意味は変わらず、HTML パーサからは `</script` に一致しなくなる。
 */
const SCRIPT_CLOSE_RE = /<\/(?=script)/gi;

/**
 * 展開を諦めるべき本文か。
 *
 * script data には「エスケープ状態」がある: 本文に `<!--` が現れるとトークナイザは
 * script-data-escaped へ入り、さらに `<script` が現れると script-data-**double**-escaped へ
 * 進む。二重エスケープ状態では我々が付ける `</script>` が終了タグとして扱われず、
 * **文書の残り全部が script の中身へ飲み込まれる**。`<!--` は JS では行コメント開始
 * (Annex B)なので `\` で潰すと意味が変わってしまい、`</script` のような無害な書き換えが
 * できない。よってこの形は**展開せず原文のまま残す**(fail closed)。
 *
 * テンプレ JS は開発者が生成時に書くもので `<!--` を含む実例は無い。仮に含んでいても
 * 失う挙動は「外部 JS が効かない」= 展開前と同じで、文書破壊には倒れない。
 */
function isUnsafeToInline(body: string): boolean {
  return body.includes('<!--');
}

/**
 * インライン化後も意味を保てる `type` 値(小文字比較)。空 = 省略も同義で classic 扱い。
 * ここに無い `type`(`text/template` 等のデータブロック)は実行面ではないので触らない。
 */
const INLINEABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

/**
 * 開始タグを組み直す。**原文を編集せず、属性の許可リストで作り直す。**
 *
 * 原文から `src` だけを切り出す実装も考えられるが、引用符・実体参照・大小文字の揺れを
 * 我々が正しく再現し続ける必要があり、`inlineCss.ts` 冒頭が戒めている「タグ内部を
 * 部分的に文字列手術する」形そのものになる。テンプレの外部 JS 参照は
 * `<script src="js/x.js"></script>`(せいぜい `type` 付き)で、それ以外の属性
 * (`integrity` / `nonce` / `data-*` など)を持つ形はインライン化で意味が変わるか、
 * そもそも我々の想定外である。よって **`src` と許可された `type` だけの script** を
 * 展開対象とし、それ以外は原文のまま残す(fail closed)。
 *
 * 戻り値の中身は全て定数か許可リストの語なので、属性値の再エスケープ問題が起きない。
 */
function rebuildOpenTag(tag: TagSpan): string | undefined {
  let type = '';
  for (const a of tag.attrs) {
    if (a.name === 'src') continue;
    if (a.name === 'type') {
      type = a.value.trim().toLowerCase();
      if (!INLINEABLE_TYPES.has(type)) return undefined;
      continue;
    }
    return undefined;
  }
  return type === '' || type === 'text/javascript' || type === 'application/javascript'
    ? '<script>'
    : `<script type="${type}">`;
}

/** 展開対象の 1 件(原文の置換範囲と、そこへ入れる新しい要素)。 */
interface Replacement {
  start: number;
  end: number;
  text: string;
}

/**
 * `<script src="…">` の要素全体(開始タグ + 中身 + 終了タグ)の終端位置を返す。
 * `inlineCss.dropEndOf` と同じ考え方で、raw text の中身と終了タグまでを 1 単位として扱う。
 */
function elementEnd(tags: readonly TagSpan[], index: number, tag: TagSpan): number {
  if (tag.rawText === undefined) return tag.end;
  const contentEnd = tag.end + tag.rawText.length;
  const next = tags[index + 1];
  return next?.isEnd && next.name === tag.name && next.start === contentEnd ? next.end : contentEnd;
}

/**
 * `servedRoot`(= 配信ルート)へ既に配置済みの実体を読み、`<script src>` をインライン
 * `<script>` へ展開した HTML を返す。
 *
 * 判定は `resolveServedAssetPath` **1 本**で、`inlineCss` の残す/落とす判定と同じ物差し。
 * 別実装の判定を置くと「落とさないのに展開もしない」形の穴が必ず生まれる。
 *
 * 展開できない参照(実体が読めない・大きすぎる・`<!--` を含む・タグの形が想定外)は
 * **原文のまま残す**。残った外部参照は組版側で 404 になるだけで、展開前と同じ挙動である。
 */
export async function inlineDocScripts(
  html: string,
  servedRoot: string,
  served: ReadonlySet<string>,
): Promise<string> {
  if (served.size === 0) return html;
  const scan = scanTags(html);
  // 走査が一意に決まらない入力は加工しない(`inlineCss` と同じ fail closed)。
  if (!scan.ok) return html;

  const replacements: Replacement[] = [];
  for (const [i, tag] of scan.tags.entries()) {
    if (tag.isEnd || tag.name !== 'script') continue;
    const src = tag.attrs.find((a) => a.name === 'src');
    if (src === undefined) continue;
    const rel = resolveServedAssetPath(src.value);
    if (rel === undefined || !served.has(rel)) continue;
    const openTag = rebuildOpenTag(tag);
    if (openTag === undefined) continue;

    const source = path.join(servedRoot, ...rel.split('/'));
    let body: string;
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size > MAX_INLINE_SCRIPT_BYTES) continue;
      body = await fs.readFile(source, 'utf8');
    } catch {
      continue;
    }
    if (isUnsafeToInline(body)) continue;

    replacements.push({
      start: tag.start,
      end: elementEnd(scan.tags, i, tag),
      // 元の中身(空のはず)は捨てる。HTML 仕様上 `src` 付き script の中身は実行されない。
      text: `${openTag}\n${body.replace(SCRIPT_CLOSE_RE, '<\\/')}\n</script>`,
    });
  }
  if (replacements.length === 0) return html;

  const out: string[] = [];
  let cursor = 0;
  for (const r of replacements) {
    out.push(html.slice(cursor, r.start), r.text);
    cursor = r.end;
  }
  out.push(html.slice(cursor));
  return out.join('');
}
