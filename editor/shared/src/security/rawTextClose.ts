// =============================================================================
// rawTextClose.ts — `<style>` / `<script>` へ差し込む本文に、要素を閉じる並びを残さない
// =============================================================================
// HTML パーサにとって `<style>` / `<script>` の中身は raw text で、終端は最初に現れる `</style` /
// `</script` 1 つだけ。CSS や JS の文字列リテラルの内側かどうかは見ないため、本文に
// `content:"</style><script>…"` と書くだけで要素を閉じ、残りを地の HTML として注入できる。
// 差し込む直前に潰す処理は web(`lib/sanitizeCss.ts`・`lib/previewSelfContain.ts`)とサーバ
// (`vivliostyle/inlineCss.ts`・`vivliostyle/inlineDocScripts.ts`)の 4 か所にあり、片方だけ緩めると
// プレビューと PDF の片方だけに穴が開くので、ここに 1 つだけ置く。
//
// 置換は `</` の `/` を `\/` にするだけ。CSS の文字列でも JS の文字列・正規表現リテラルでも `\/` は
// `/` と同義なので意味は変わらず、HTML パーサからは閉じタグに一致しなくなる。大文字小文字は
// 正規表現の `i` で無視する(`u` を付けないので、`ſ` などの非 ASCII は `s` と同じと見ない。
// ブラウザもタグ名を ASCII の範囲でだけ畳む)。

/** 要素名 → その閉じタグの `</`(直後に要素名が続くもの)。 */
const CLOSE_RE = {
  style: /<\/(?=style)/gi,
  script: /<\/(?=script)/gi,
} as const;

/** `text` の中の `</style`(`tag` が `script` なら `</script`)を、要素を閉じない `<\/…` にする。 */
export function neutralizeRawTextClose(text: string, tag: 'style' | 'script'): string {
  return text.replace(CLOSE_RE[tag], '<\\/');
}

/**
 * 外部 JS をインライン化しても意味を保てる `script` の `type`(小文字で比べる)。空 = 省略と同じで
 * classic 扱い。ここに無い `type`(`text/template` などのデータブロック)は実行面ではないので触らない。
 * サーバの PDF 経路(`inlineDocScripts.ts`)と web のプレビュー(`previewSelfContain.ts`)が同じ
 * 集合を使う。片方だけ広げると、PDF とプレビューで展開する script が割れる。
 */
export const INLINEABLE_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
]);
