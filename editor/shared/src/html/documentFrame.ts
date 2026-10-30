// =============================================================================
// documentFrame.ts — 本文の外側(head・html と body の開始タグ・`</body>` の後ろ)を基準に固定する
// =============================================================================
// 承認画面は紙面も差分も body の中だけで組む。本文の外側は承認者の目に入らないので、両経路(編集・作成)の
// 受付と承認で、外側を基準(確定版・生成物)とバイト列で同じにさせる。本文の中に骨格のタグ
// (`<body style>`・`<html class>` など)を書くと、ブラウザは既存の要素へ属性を足すので、それも止める。
// 外側の範囲は shared の `reviewParts.ts`(`documentBodyRange`。`extractBodyUnits` と同じ走査器)で、
// 本文の中の骨格のタグは作成経路の骨格の検査と同じ字句の規則(`reviewableSource.ts` の
// `findSkeletonTagInBody`)で数える。server の `reviewRepo.ts` が受付(400)と承認(409)で使う。

import { findSkeletonTagInBody, stripLeadingBom } from '../jinja/reviewableSource.js';
import { documentBodyRange } from './reviewParts.js';

/** 本文の外側。`before` は先頭〜最初の `<body …>` の `>`、`after` は最後の `</body>`〜末尾。 */
export interface DocumentFrame {
  before: string;
  after: string;
  /** 本文の範囲(先頭の BOM を外した文字列での位置)。 */
  from: number;
  to: number;
  /** `<body …>` と `</body>` がそろっているか(無い断片は外側が空で、範囲は入力全体)。 */
  hasBody: boolean;
}

/**
 * 改行を揃える。確定ファイルが CRLF で、編集画面を通った申請が LF になる(またはその逆)だけで
 * 止めない。
 */
const normalizeNewlines = (s: string) => s.replace(/\r\n/g, '\n');

/**
 * 本文の外側を取り出す。先頭の BOM を 1 文字外し、改行を LF に揃える(位置は BOM を外した文字列の
 * もの)。body の無い断片は外側が空。境界を読めない入力は `validation` を投げる。
 */
export function documentFrameOf(html: string): DocumentFrame {
  const src = stripLeadingBom(html);
  const { from, to, hasBody } = documentBodyRange(src);
  return {
    before: normalizeNewlines(src.slice(0, from)),
    after: normalizeNewlines(src.slice(to)),
    from,
    to,
    hasBody,
  };
}

/** 2 つの文書の本文の外側が同じか。どちらかの境界を読めなければ false。 */
export function sameDocumentFrame(a: string, b: string): boolean {
  try {
    const fa = documentFrameOf(a);
    const fb = documentFrameOf(b);
    return fa.before === fb.before && fa.after === fb.after;
  } catch {
    return false;
  }
}

/**
 * 本文の外側の違反。`no-body` は body の無い断片(`requireBody` のときだけ)、`skeleton-in-body` は本文の
 * 中の骨格のタグ、`frame-changed` は外側が基準と違う。
 */
export type DocumentFrameIssue =
  | { readonly code: 'no-body' }
  | { readonly code: 'skeleton-in-body'; readonly at: number }
  | { readonly code: 'frame-changed' };

/**
 * `html` の本文の外側が `baselineHtml` と同じか、本文の中に骨格のタグが無いかを確かめ、最初の違反を
 * 返す(無ければ null)。本文の中の骨格のタグを先に見る(外側の違いより何を直すかが分かりやすい)。
 * `jinja` は作成経路の原文か(Jinja のトークンの中の `<body>` を数えない)。`requireBody` は body の無い
 * 断片を止めるか(編集経路)。body の無い断片どうしは外側が空で一致してしまい、断片の先頭に置いた
 * style・link・meta・base は DOMParser が head へ移すので、紙面に出ないまま効く。作成経路は骨格の検査
 * (`findReviewableIssues` の document)が body を求めるので付けない。境界を読めない入力(`html` でも
 * 基準でも)は `validation` を投げる。
 */
export function findDocumentFrameIssue(
  html: string,
  baselineHtml: string,
  opts: { jinja: boolean; requireBody: boolean },
): DocumentFrameIssue | null {
  const frame = documentFrameOf(html);
  if (opts.requireBody && !frame.hasBody) return { code: 'no-body' };
  const at = findSkeletonTagInBody(stripLeadingBom(html), frame, opts);
  if (at !== null) return { code: 'skeleton-in-body', at };
  const base = documentFrameOf(baselineHtml);
  if (frame.before !== base.before || frame.after !== base.after) return { code: 'frame-changed' };
  return null;
}

/** 受付(400)の文言。 */
export const DOCUMENT_FRAME_MESSAGES: Readonly<Record<DocumentFrameIssue['code'], string>> = {
  'no-body':
    '本文（<body>）の無い HTML は申請できません。<body> と </body> のそろった文書で申請してください',
  'skeleton-in-body':
    '本文の中に <html>・<head>・<body> の開始タグや </head>・</body>・</html> を書くことは' +
    'できません（承認画面に出ないため）。取り除いてください',
  'frame-changed':
    '本文（<body> の中）の外側（<head> の中身、<html>・<body> の属性、</body> の後ろ）は変更' +
    'できません（承認画面に出ないため）。変更が必要なら開発者へ依頼してください',
};
