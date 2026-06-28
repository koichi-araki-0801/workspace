// =============================================================================
// workers/index.ts — メインから使う HTML Worker のプロキシ
// =============================================================================
// 本番ブラウザでは重い diff/mask/render を Worker(linkedom)へオフロードしメインスレッド
// を解放する。Worker 非対応環境(vitest/jsdom・SSR・古ブラウザ)では browser/jsdom の
// `DOMParser` を使うメインスレッド実行へフォールバックする。どちらも同じ非同期 API
// (`AsyncHtmlWorker`)を満たすので、呼び出し側は常に `await` で扱える。
import type { SampleData } from '@editor/shared';
import * as Comlink from 'comlink';
import {
  buildHtmlDiff as buildHtmlDiffCore,
  type HtmlDiff,
} from '@/features/compare/htmlBlockDiff';
import { toFilled as toFilledCore } from '@/lib/fillJinja';
import { type ToTemplateOptions, toTemplate as toTemplateCore } from '@/lib/jinjaMask';
import { type RenderResult, renderJinja as renderJinjaCore } from '@/lib/nunjucksRender';
import type { HtmlWorkerApi } from './htmlWorkerImpl';

/** メインが `await` で使う非同期 API(Comlink の `Remote<HtmlWorkerApi>` と構造的に同一)。 */
export interface AsyncHtmlWorker {
  buildHtmlDiff(
    before: string,
    after: string,
    cssBefore?: string,
    cssAfter?: string,
  ): Promise<HtmlDiff>;
  toTemplate(editable: string, opts?: ToTemplateOptions): Promise<string>;
  toFilled(raw: string, sample: SampleData): Promise<string>;
  renderJinja(template: string, data: SampleData): Promise<RenderResult>;
}

// Worker が無い環境では browser/jsdom の DOMParser でメイン実行(core 関数は既定パーサを使う)。
const mainThreadFallback: AsyncHtmlWorker = {
  async buildHtmlDiff(before, after, cssBefore, cssAfter) {
    return buildHtmlDiffCore(before, after, cssBefore, cssAfter);
  },
  async toTemplate(editable, opts) {
    return toTemplateCore(editable, opts);
  },
  async toFilled(raw, sample) {
    return toFilledCore(raw, sample);
  },
  async renderJinja(template, data) {
    return renderJinjaCore(template, data);
  },
};

function createHtmlWorker(): AsyncHtmlWorker {
  if (typeof Worker === 'undefined') return mainThreadFallback;
  // Vite 標準の module worker(本番ビルドで worker チャンクへ自動分割)。
  const worker = new Worker(new URL('./htmlWorker.ts', import.meta.url), { type: 'module' });
  return Comlink.wrap<HtmlWorkerApi>(worker) as unknown as AsyncHtmlWorker;
}

/** メインから呼ぶ HTML 重処理のプロキシ(本番=Worker / テスト等=メインフォールバック)。 */
export const htmlWorker: AsyncHtmlWorker = createHtmlWorker();
