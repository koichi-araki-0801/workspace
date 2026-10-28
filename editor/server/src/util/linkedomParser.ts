// =============================================================================
// linkedomParser.ts — サーバで HTML を Document へ読むパーサ(承認の確定の差分用)
// =============================================================================
// edit 申請の最終確定は、承認画面と同じ差分(shared の `htmlDiff.ts`)で判定を検査する。画面の
// Worker と同じ linkedom を使い、完全文書でない入力の包み方も shared の `linkedomDocumentHtml` で
// 揃える(包み方が違うと、同じ申請でもパーツの数え方が画面とずれる)。shared の差分は DOM の型で
// 書かれているので、この実装ファイルにも DOM の型を読み込む(server の `lib` は変えない)。
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { type HtmlParser, linkedomDocumentHtml } from '@editor/shared';
import { parseHTML } from 'linkedom';

/** linkedom の `parseHTML` を `HtmlParser` として包む。型は構造的に異なるため明示キャストする。 */
export const linkedomParser: HtmlParser = (html) =>
  parseHTML(linkedomDocumentHtml(html)).document as unknown as Document;
