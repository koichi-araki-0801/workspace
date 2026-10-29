// =============================================================================
// htmlWorkerImpl.ts — Worker 内で動く重処理の実体(linkedom で DOM を供給)
// =============================================================================
// ⚠ Jinja の描画はここに置かない(理由は `workers/index.ts` 冒頭 — Worker は同一オリジンで
// 隔離にならない)。ここが扱うのは**描画済み文字列**の DOM 処理だけである。
//
// Worker には browser の `DOMParser`/`Node` が無いため、linkedom の `parseHTML` を
// `HtmlParser`(`lib/htmlParser.ts`)として注入する。これによりメインと同一の diff/mask
// ロジックを 1 実装のまま共有する。Comlink シェル(`htmlWorker.ts`)が `expose` する。
// テストはこのモジュールを直接 import し、Comlink/Worker を介さず linkedom 経路を検証する。
import { linkedomDocumentHtml } from '@editor/shared';
import { parseHTML } from 'linkedom';
import type { HtmlParser } from '@/lib/htmlParser';
import { createHtmlApi } from './htmlApi';

// linkedom の Document を browser 互換の `Document` として供給する。diff/mask が使う DOM
// API(`querySelectorAll`/`cloneNode`/`outerHTML`/`matches`/`classList` 等)は linkedom が
// 実装済み。型は構造的に異なるため明示キャストする。完全文書でない入力の包み方は、承認の確定で
// 同じ linkedom を使うサーバと揃えるため shared の `htmlParser.ts` の `linkedomDocumentHtml` に置く。
export const linkedomParser: HtmlParser = (html) =>
  parseHTML(linkedomDocumentHtml(html)).document as unknown as Document;

// Comlink へ公開する API。メインのフォールバックと同じ実装に、linkedom のパーサを注入する。
export const htmlWorkerImpl = createHtmlApi(linkedomParser);
