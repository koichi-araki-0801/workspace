// =============================================================================
// cssCarry.ts — GrapesJS のパーサに通すと崩れる入れ子の @font-face を、原文のまま運ぶために取り出す
// =============================================================================
// GrapesJS 0.23.6 のパーサは、`@media` / `@supports` の中に入れ子にした `@font-face` を
// `@media screen{font-family:…;src:…}` の形に崩す。崩れた形は `getCss` から下書き・申請・確定 CSS
// へ書かれるので、その `@font-face` は `setStyle` へ渡さず、外側の前置きで包み直した原文の文字列の
// まま持ち、保存の `getCss` の末尾へ戻す(`useGrapes.ts`)。本文の `<style>` を原文のまま運ぶ置き場
// (`bodyStyle.ts`)と同じ考え方。
//
// 取り出すのは `@font-face` の規則だけで、外側のブロックの普通の規則は GrapesJS に残す。
// ブロックごと末尾へ動かすと、中の普通の規則のカスケード上の位置が変わり、後ろの同じ詳細度の規則に勝つように
// なって PDF の見た目が変わるため。`@font-face` の位置は書体の宣言の順にしか効かず、GrapesJS も
// 最上位の `@font-face` を末尾へ動かす。
//
// 字句は外部参照の検査と同じ走査器(`collectCssStructure`)から取り、文字列・コメントの中の `{` `}`
// `@` に騙されない。閉じていない `@font-face` は範囲が決まらないので取り出さない。

import { asciiLower, collectCssStructure, firstSignificant } from '@editor/shared';

/** `@font-face` を取り出す外側の at-rule(名前は小文字)。 */
const CARRIED_GROUP_AT_RULES = new Set(['media', 'supports']);

/** `splitNestedFontFaces` の結果。 */
interface CarriedCss {
  /** 取り出した `@font-face` を除いた CSS(GrapesJS へ渡す)。 */
  rest: string;
  /** 取り出した `@font-face` を外側の前置きで包み直した原文(出現順)。 */
  carried: string[];
}

/** 開いているブロック 1 つ。 */
interface OpenBlock {
  /** `@media` / `@supports` のブロックか。 */
  group: boolean;
  /** ブロックの前置きの原文(`@` から `{` の手前まで)。at-rule でなければ空。 */
  prelude: string;
  /** 取り出す `@font-face` なら、その `@` の位置。 */
  fontFaceAt: number | null;
}

/**
 * `@media` / `@supports` の中(何段の入れ子でも、外側がすべてこの 2 つ)にある `@font-face` を
 * 取り出す。
 * 最上位の `@font-face` は GrapesJS が崩さないので取り出さない。
 */
export function splitNestedFontFaces(css: string): CarriedCss {
  const { punct, comments, atRules } = collectCssStructure(css);
  const commentEnd = new Map(comments.map((c) => [c.start, c.end]));
  const stack: OpenBlock[] = [];
  const found: Array<{ start: number; end: number; text: string }> = [];
  /** 今の文の頭(直前の `{` `}` `;` の直後)。 */
  let stmtStart = 0;
  for (const p of punct) {
    if (p.ch === '{') {
      // ブロックの頭(文の頭から空白・コメントを除いた最初の字)が at-rule の `@` なら、その at-rule。
      // 文の頭は単調に進むので、走査は全体で入力長に線形になる。
      const first = firstSignificant(css, commentEnd, stmtStart, p.at);
      const head = first !== undefined && atRules.has(first) ? first : undefined;
      const name = head === undefined ? '' : asciiLower(atRules.get(head) ?? '');
      const nested = stack.length > 0 && stack.every((o) => o.group);
      stack.push({
        group: CARRIED_GROUP_AT_RULES.has(name),
        prelude: head === undefined ? '' : css.slice(head, p.at),
        fontFaceAt: head !== undefined && name === 'font-face' && nested ? head : null,
      });
    } else if (p.ch === '}') {
      const block = stack.pop();
      if (block?.fontFaceAt != null) {
        const chain = stack.map((o) => o.prelude);
        const rule = css.slice(block.fontFaceAt, p.at + 1);
        found.push({
          start: block.fontFaceAt,
          end: p.at + 1,
          text: `${chain.map((pre) => `${pre}{`).join('')}${rule}${'}'.repeat(chain.length)}`,
        });
      }
    }
    stmtStart = p.at + 1;
  }
  if (found.length === 0) return { rest: css, carried: [] };
  let rest = '';
  let pos = 0;
  for (const f of found) {
    rest += css.slice(pos, f.start);
    pos = f.end;
  }
  rest += css.slice(pos);
  return { rest, carried: found.map((f) => f.text) };
}
