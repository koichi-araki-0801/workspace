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
import type { SampleData } from '@editor/shared';
import { parseHTML } from 'linkedom';
import {
  buildHtmlDiffAligned as buildHtmlDiffAlignedCore,
  buildHtmlDiff as buildHtmlDiffCore,
  type HtmlDiff,
  type PagePair,
} from '@/features/compare/htmlBlockDiff';
import { toFilled as toFilledCore } from '@/lib/fillJinja';
import type { HtmlParser } from '@/lib/htmlParser';
import { type ToTemplateOptions, toTemplate as toTemplateCore } from '@/lib/jinjaMask';

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
const linkedomParse: HtmlParser = (html) => {
  const full = /<html[\s>]|^\s*<!doctype/i.test(html)
    ? html
    : /<body[\s>]/i.test(html)
      ? `<!doctype html><html>${html}</html>`
      : `<!doctype html><html><body>${html}</body></html>`;
  return parseHTML(full).document as unknown as Document;
};

// ── Comlink へ公開する API(戻り値はすべて構造化複製可能) ──
export const htmlWorkerImpl = {
  buildHtmlDiff(
    beforeHtml: string,
    afterHtml: string,
    cssBefore?: string,
    cssAfter?: string,
  ): HtmlDiff {
    return buildHtmlDiffCore(beforeHtml, afterHtml, cssBefore, cssAfter, linkedomParse);
  },
  buildHtmlDiffAligned(
    beforeHtml: string,
    afterHtml: string,
    cssBefore: string | undefined,
    cssAfter: string | undefined,
    pairs: PagePair[],
  ): HtmlDiff {
    return buildHtmlDiffAlignedCore(
      beforeHtml,
      afterHtml,
      cssBefore,
      cssAfter,
      pairs,
      linkedomParse,
    );
  },
  toTemplate(editable: string, opts?: ToTemplateOptions): string {
    return toTemplateCore(editable, opts, linkedomParse);
  },
  toFilled(raw: string, sample: SampleData): string {
    return toFilledCore(raw, sample);
  },
};

export type HtmlWorkerApi = typeof htmlWorkerImpl;
