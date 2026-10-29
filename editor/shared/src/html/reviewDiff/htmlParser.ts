// =============================================================================
// htmlParser.ts — HTML 文字列を Document へパースする実装の抽象(DOM 実装の注入用)
// =============================================================================
// 画面のメインスレッドとテストは browser・jsdom の `DOMParser` を、Worker とサーバは linkedom の
// `parseHTML` を使えるよう、パーサを関数として注入する。DOM に依存する差分(`htmlDiff.ts`)を
// 1 実装のまま画面・Worker・サーバで共有するため(実装が分かれると数え方が食い違う)。
/// <reference lib="dom" />

export type HtmlParser = (html: string) => Document;

/**
 * linkedom の `parseHTML` へ渡す形。linkedom は HTML 仕様の tree construction 補正を行わないため、
 * 完全文書でない入力はブラウザの `DOMParser` と同じ木にならない。入力の形ごとにラップして差を
 * 吸収する:
 * - 完全文書(`<html>` か doctype を持つ)はそのまま。
 * - `<body>` ラッパ断片(GrapesJS の `getHtml()` が返す draft の形)は **`<html>` でだけ**包む。
 *   素通しすると中身が `doc.body` の外に置かれ本文が空になり、`<html><body>` の二重ラップは
 *   `body.innerHTML` に `<body>` の入れ子が残る。どちらも不可で、`<html>` 単独ラップだけが
 *   ブラウザと同じ「入力の `<body>` が文書の body になる」木を与える。
 * - それ以外の断片(body inner)は `<body>` ごと包む(browser の DOMParser は断片を body へ
 *   入れるのでこの差を吸収する)。
 *
 * web の Worker(`htmlWorkerImpl.ts`)とサーバ(`linkedomParser.ts`)が同じ包み方を使うよう、
 * linkedom を持たない shared にはこの文字列の組み立てだけを置く。
 */
export function linkedomDocumentHtml(html: string): string {
  return /<html[\s>]|^\s*<!doctype/i.test(html)
    ? html
    : /<body[\s>]/i.test(html)
      ? `<!doctype html><html>${html}</html>`
      : `<!doctype html><html><body>${html}</body></html>`;
}
