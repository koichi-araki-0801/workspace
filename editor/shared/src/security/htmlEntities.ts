// =============================================================================
// htmlEntities.ts — HTML 属性値をブラウザと同じ形へ正規化してから判定するための復号器
// =============================================================================
// 検査器がタグを自前走査する以上、属性値は**引用符を外しただけの原文**で手に入る
// (`server/src/vivliostyle/inlineCss.ts` の `TagSpan.attrs` がそう明記している)。
// 一方ブラウザは属性値の文字参照を HTML パーサが解いてから URL パーサへ渡し、URL パーサは
// TAB / LF / CR を位置を問わず除去し、前後の C0 制御文字と空白を捨てる。
// **この差が丸ごと迂回路になる。**
//
// 実測: `<img src="&#104;ttps://evil/x">` も、URL の途中に改行を挟んだ `htt<LF>ps://evil/x`
// も、生値のまま `isSelfContainedUrl` へ掛けると「相対参照」= 外部参照 0 件で 400 ゲートを
// 通り抜けた。前者は `#` が最初の `[/?#]` に当たって slash<colon 分岐へ落ち、後者は改行で
// scheme 正規表現に当たらないためである。届く先のブラウザはどちらも `https://evil/x` を取る。
//
// よって「**判定の前に必ずここを通す**」を規約にする。復号しすぎても害は無い — 判定は
// 「外部を指す形か」だけを見るので、余計に解けた値は誤検知(= fail closed)側へ倒れる。
//
// 置き場が `shared` なのは、サーバの関門(`server/src/security/externalRefs.ts`)と web の
// 早期フィードバック(`web/src/lib/pdfDocument.ts`)と不変性照合
// (`server/src/security/templateScripts.ts`)が**同じ復号器**を使うため。別実装を持つと
// 「片方だけ解かない」形の穴が必ず生まれる(このファイルが生まれた原因がそれである)。

import { stripUrlIgnoredChars } from './cssExternalRefs.js';

const CHAR_TAB = String.fromCharCode(0x09);
const CHAR_LF = String.fromCharCode(0x0a);
const CHAR_NBSP = String.fromCharCode(0xa0);

/**
 * 名前つき実体参照の最小表。ここに無い名前は解かずに原文のまま残す。
 *
 * 全表(2000 件超)を持たないのは、**解けない名前があっても安全側へ倒れる**ため —
 * 解けなければ scheme の形にならず「外部参照」と判定されるか、判定に影響しないかの
 * どちらかである。逆に URL の scheme や区切りを作れる文字だけは必ず解く必要があるので、
 * `colon` `sol` `Tab` `NewLine` は落とせない。
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  Tab: CHAR_TAB,
  NewLine: CHAR_LF,
  sol: '/',
  nbsp: CHAR_NBSP,
  period: '.',
  lpar: '(',
  rpar: ')',
  semi: ';',
  num: '#',
  quest: '?',
};

/**
 * HTML の文字参照を解く。セミコロン省略形(`&#104ttp`)も受けるのは、ブラウザの属性値
 * パーサが**名前つき参照の一部**についてセミコロン無しを受けるためである。
 * 受けすぎる方向の誤りは誤検知(fail closed)にしかならない。
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, body) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * HTML 属性から取り出した URL 値を、ブラウザが実際に取りに行く形へ寄せる。
 * 順序が重要で、**復号が先**でなければならない — `&Tab;` を先に解かないと除去できない。
 *
 * 戻り値をそのまま `isSelfContainedUrl` / `resolveServedAssetPath` へ渡すこと。
 * URL パーサが外す文字の除去(`stripUrlIgnoredChars`)は `isSelfContainedUrl` も自分で行う
 * (CSS の値はエスケープを解いた後に同じ文字が残りうる)。ここで先に外すのは、判定だけでなく
 * 資産のパス解決にも外した後の値を使うため。
 */
export function normalizeHtmlUrlValue(value: string): string {
  return stripUrlIgnoredChars(decodeHtmlEntities(value));
}
