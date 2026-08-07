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
// 全角で書くだけでレート制限を割れる。
//
// ★ NFKC だけでは足りない。照合順序は**ゼロウェイト文字**(`U+200B` 等)や、かな種の差を
// 無視して等価と見なす一方、NFKC はそれらを残す。つまり `ad<ZWSP>min` は JS では別キー・
// DB では `admin` と同一行になり、1 アカウントへ**無限の失敗カウンタ**を割り当てられる
// (= レート制限の実質無効化)。照合順序を JS で再現する道は取らない — かな種・合成濁点・
// `_AS` の相互作用まで含めて追随し続けるのは無理で、漏れは静かに穴として残る。
// 代わりに **運用アルファベット(`USERNAME_PATTERN`)の外側を資格情報経路の手前で断つ**
// (`isOperationalLoginId`)。アルファベット内には照合順序の差を生む文字が無いので、
// 「正規形が一致 ⇔ DB で同一行」が定義上成り立つ。
import { isValidUsername, USERNAME_MAX_LENGTH } from '@editor/shared';

/** DB の `ログインID NVARCHAR(64)` に由来する上限。ここを超える分は DB 側でも切り詰められる。 */
export const LOGIN_ID_MAX_LENGTH = USERNAME_MAX_LENGTH;

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

/**
 * 正規形が運用アルファベット(`USERNAME_PATTERN` = ASCII 英数字 + `_`)に収まるか。
 *
 * **資格情報経路(login)は、これが false の入力を DB へも KDF へも渡してはならない。**
 * アルファベットの外では「JS の正規形が違う ⇔ DB の行が違う」が保証できず、1 アカウントに
 * 対する失敗カウンタをいくつでも作れる(module 冒頭の ★)。判定はレート制限より**手前**に
 * 置く — レート制限の中でやると、断りたい入力のためにキーを 1 つ作ってしまう。
 *
 * 断り方は「未知 ID・無効アカウント・パスワード誤り」と**全次元で同じ**にすること
 * (文言 = `INVALID_CREDENTIALS_MESSAGE` / 401 / `code` 無し / `applyFailureFloor`)。
 * ここだけ別の応答にすると、逆向きの区別可能性を自分で作ることになる。
 */
export function isOperationalLoginId(loginId: string): boolean {
  return isValidUsername(loginId);
}
