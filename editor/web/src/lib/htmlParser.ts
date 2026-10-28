// =============================================================================
// htmlParser.ts — HTML 文字列を Document へパースする実装の抽象(DOM 実装の注入用)
// =============================================================================
// 型と linkedom 向けの包み方は shared の `htmlParser.ts`(承認の確定を検査するサーバも同じ差分を
// 使う)。ここは web のメインスレッドとテストが使う既定のパーサを持つ。
export type { HtmlParser } from '@editor/shared';

import type { HtmlParser } from '@editor/shared';

/** 既定パーサ: browser・jsdom の `DOMParser`(メインスレッド / vitest jsdom 用)。 */
export const defaultHtmlParser: HtmlParser = (html) =>
  new DOMParser().parseFromString(html, 'text/html');
