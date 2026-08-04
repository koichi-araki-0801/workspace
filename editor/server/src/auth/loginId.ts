// =============================================================================
// loginId.ts — ログインID の正規形(レート制限キーと DB 引数の共通形)
// =============================================================================
// DB 側の `ログインID` は `NVARCHAR(64) COLLATE Japanese_CI_AS` で、大小文字・全角半角を
// 区別せず、末尾空白を無視して `=` 比較する。JS 側でこの照合順序を「再現」しようとすると
// 必ず漏れが出る(かな種・合成濁点・`_AS` の相互作用)。そこで再現はあきらめ、
// **入力域そのものを狭めた 1 つの正規形**を作り、レート制限キーにも sproc の引数にも
// 同じ文字列を渡す。同じ値を両方へ渡す以上「JS と DB で別のものを指す」事象が定義上
// 起こり得なくなる(片方だけに使うと、1 アカウントに対して独立した失敗カウンタを
// いくつでも作れる穴が再来する)。
//
// NFKC を掛ける理由: `Japanese_CI_AS` は width-insensitive なので `ａｄｍｉｎ` は
// `admin` 行にヒットする。NFKC を落とすと DB では同一行・JS では別キーになり、
// 全角で書くだけでレート制限を割れる。かな種の畳み込み(ひらがな↔カタカナ)は NFKC では
// 届かないが、ログインID の運用規約(`USERNAME_PATTERN` = ASCII 英数字 + `_`)に
// かなは含まれないため、非適合 ID の棚卸しでカバーする運用判断とする。

/** DB の `ログインID NVARCHAR(64)` に由来する上限。ここを超える分は DB 側でも切り詰められる。 */
export const LOGIN_ID_MAX_LENGTH = 64;

/**
 * ログインID の正規形。**レート制限キーと sproc パラメータの両方へ同じ戻り値を渡すこと。**
 *
 * 正規化の前に生入力を上限長でクリップするのは、`normalize` / `toLowerCase` のコストを
 * 入力長から切り離すため。`LoginRequest.username` に長さ制約が無い構成では、ボディ上限
 * (8MB)ぶんの文字列がそのままイベントループ上の同期処理になる。
 */
export function canonicalLoginId(raw: string): string {
  const clipped = raw.length > LOGIN_ID_MAX_LENGTH ? raw.slice(0, LOGIN_ID_MAX_LENGTH) : raw;
  // NFKC は合字の展開で長くなりうるので、畳んだ後にもう一度上限で切る。
  return clipped.normalize('NFKC').trimEnd().slice(0, LOGIN_ID_MAX_LENGTH).toLowerCase();
}
