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
import { parseHTML } from 'linkedom';
import type { HtmlParser } from '@/lib/htmlParser';
import { createHtmlApi } from './htmlApi';

// linkedom の Document を browser 互換の `Document` として供給する。diff/mask が使う DOM
// API(`querySelectorAll`/`cloneNode`/`outerHTML`/`matches`/`classList` 等)は linkedom が
// 実装済み。型は構造的に異なるため明示キャストする。
//
// linkedom の `parseHTML` は HTML 仕様の tree construction 補正を行わないため、完全文書で
// ない入力はブラウザの `DOMParser` と同じ木にならない。入力の形ごとにラップして差を吸収する:
// - 完全文書(`<html>` か doctype を持つ)はそのまま。
// - `<body>` ラッパ断片(GrapesJS の `getHtml()` が返す draft の形)は **`<html>` でだけ**包む。
//   素通しすると中身が `doc.body` の外に置かれ本文が空になり、`<html><body>` の二重ラップは
//   `body.innerHTML` に `<body>` の入れ子が残る。どちらも不可で、`<html>` 単独ラップだけが
//   ブラウザと同じ「入力の `<body>` が文書の body になる」木を与える。
// - それ以外の断片(body inner)は `<body>` ごと包む(browser の DOMParser は断片を body へ
//   入れるのでこの差を吸収する)。
export const linkedomParser: HtmlParser = (html) => {
  const full = /<html[\s>]|^\s*<!doctype/i.test(html)
    ? html
    : /<body[\s>]/i.test(html)
      ? `<!doctype html><html>${html}</html>`
      : `<!doctype html><html><body>${html}</body></html>`;
  return parseHTML(full).document as unknown as Document;
};

// Comlink へ公開する API。メインのフォールバックと同じ実装に、linkedom のパーサを注入する。
export const htmlWorkerImpl = createHtmlApi(linkedomParser);
