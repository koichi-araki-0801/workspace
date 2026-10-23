// =============================================================================
// htmlApi.ts — HTML 重処理の API(Worker 内・メインスレッドで共有)と、その非同期の形
// =============================================================================
// Worker(`htmlWorkerImpl.ts`)とメインスレッドのフォールバック(`index.ts`)は同じ 4 メソッドを
// 持つ。linkedom を取り込まないこのファイルに 1 本だけ置き、パーサだけを差し替える
// (Worker は linkedom、メインは既定の `DOMParser`)。

import type { SampleData } from '@editor/shared';
import {
  buildHtmlDiffAligned as buildHtmlDiffAlignedCore,
  buildHtmlDiff as buildHtmlDiffCore,
  type HtmlDiff,
  type PagePair,
} from '@/features/compare/htmlBlockDiff';
import { toFilled as toFilledCore } from '@/lib/fillJinja';
import type { HtmlParser } from '@/lib/htmlParser';
import { type ToTemplateOptions, toTemplate as toTemplateCore } from '@/lib/jinjaMask';

/** `parser` を省くと各 core 関数の既定(`DOMParser`)を使う。戻り値はすべて構造化複製可能。 */
export function createHtmlApi(parser?: HtmlParser) {
  return {
    buildHtmlDiff(
      beforeHtml: string,
      afterHtml: string,
      cssBefore?: string,
      cssAfter?: string,
    ): HtmlDiff {
      return buildHtmlDiffCore(beforeHtml, afterHtml, cssBefore, cssAfter, parser);
    },
    buildHtmlDiffAligned(
      beforeHtml: string,
      afterHtml: string,
      cssBefore: string | undefined,
      cssAfter: string | undefined,
      pairs: PagePair[],
    ): HtmlDiff {
      return buildHtmlDiffAlignedCore(beforeHtml, afterHtml, cssBefore, cssAfter, pairs, parser);
    },
    toTemplate(editable: string, opts?: ToTemplateOptions): string {
      return toTemplateCore(editable, opts, parser);
    },
    toFilled(raw: string, sample: SampleData): string {
      return toFilledCore(raw, sample, parser);
    },
  };
}

type HtmlApi = ReturnType<typeof createHtmlApi>;

/** メインが `await` で使う非同期 API(Comlink の `Remote` が返す形と同じ)。 */
export type AsyncHtmlWorker = {
  [K in keyof HtmlApi]: (...args: Parameters<HtmlApi[K]>) => Promise<ReturnType<HtmlApi[K]>>;
};

/** 同期の API を、Worker の RPC と同じ非同期の形に包む(メインスレッドで実行する)。 */
export function toAsyncApi(api: HtmlApi): AsyncHtmlWorker {
  return {
    buildHtmlDiff: async (...a) => api.buildHtmlDiff(...a),
    buildHtmlDiffAligned: async (...a) => api.buildHtmlDiffAligned(...a),
    toTemplate: async (...a) => api.toTemplate(...a),
    toFilled: async (...a) => api.toFilled(...a),
  };
}
