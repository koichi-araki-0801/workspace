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

import { collectCssStructure } from '@editor/shared';

/** `@font-face` を取り出す外側の at-rule(名前は小文字)。 */
const CARRIED_GROUP_AT_RULES = new Set(['media', 'supports']);

/** `splitNestedFontFaces` の結果。 */
export interface CarriedCss {
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

/** ASCII の英大文字だけを小文字にする(CSS の at-rule 名は ASCII の範囲だけ大文字小文字を区別しない)。 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * `css` の `[from, to)` が空白とコメントだけかを返す判定器。`comments` は位置順で、呼び出しは
 * `from` が単調に増える順に限る。コメントの添字を呼び出しをまたいで進めるので、全体で入力長に
 * 線形になる。
 */
function triviaChecker(
  css: string,
  comments: ReadonlyArray<{ start: number; end: number }>,
): (from: number, to: number) => boolean {
  let k = 0;
  return (from, to) => {
    let i = from;
    while (i < to) {
      while (k < comments.length && comments[k].end <= i) k++;
      const c = comments[k];
      if (c !== undefined && c.start <= i) {
        i = c.end;
        continue;
      }
      if (!/\s/.test(css[i] ?? '')) return false;
      i++;
    }
    return true;
  };
}

/**
 * `@media` / `@supports` の中(何段の入れ子でも、外側がすべてこの 2 つ)にある `@font-face` を
 * 取り出す。
 * 最上位の `@font-face` は GrapesJS が崩さないので取り出さない。
 */
export function splitNestedFontFaces(css: string): CarriedCss {
  const { punct, comments, atRules } = collectCssStructure(css);
  const ats = [...atRules.entries()].sort((a, b) => a[0] - b[0]);
  const onlyTrivia = triviaChecker(css, comments);
  const stack: OpenBlock[] = [];
  const found: Array<{ start: number; end: number; text: string }> = [];
  /** 今の文の頭(直前の `{` `}` `;` の直後)。 */
  let stmtStart = 0;
  let ai = 0;
  for (const p of punct) {
    if (p.ch === '{') {
      while (ai < ats.length && ats[ai][0] < stmtStart) ai++;
      const cand = ats[ai];
      const head =
        cand !== undefined && cand[0] < p.at && onlyTrivia(stmtStart, cand[0]) ? cand : undefined;
      const name = head ? asciiLower(head[1]) : '';
      const nested = stack.length > 0 && stack.every((o) => o.group);
      stack.push({
        group: CARRIED_GROUP_AT_RULES.has(name),
        prelude: head ? css.slice(head[0], p.at) : '',
        fontFaceAt: head && name === 'font-face' && nested ? head[0] : null,
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
