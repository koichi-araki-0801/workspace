// =============================================================================
// workers/index.ts — メインから使う HTML Worker のプロキシ
// =============================================================================
// 本番ブラウザでは重い diff/mask を Worker(linkedom)へオフロードしメインスレッド
// を解放する。Worker 非対応環境(vitest/jsdom・SSR・古ブラウザ)では browser/jsdom の
// `DOMParser` を使うメインスレッド実行へフォールバックする。どちらも同じ非同期 API
// (`AsyncHtmlWorker`)を満たすので、呼び出し側は常に `await` で扱える。
//
// ⚠ **Jinja の描画(`renderJinja`)はここへ戻さない。** Worker はアプリと**同一オリジン**で
// 動き、cookie 付きの `fetch` がそのまま通る = 他人が書いたテンプレを nunjucks
// (サンドボックスではなく**コンパイラ**)へ通す場所としては何も守っていない。Worker が
// 与えるのは「メインスレッドを塞がない」だけで、この脅威とは無関係である。描画は
// opaque オリジンの iframe(`lib/renderHostClient.ts`)が担う。ここに残す diff/mask は
// **描画済み文字列**に対する処理で、テンプレ式の評価を伴わない。
import { type SampleData, unexpected } from '@editor/shared';
import * as Comlink from 'comlink';
import {
  buildHtmlDiffAligned as buildHtmlDiffAlignedCore,
  buildHtmlDiff as buildHtmlDiffCore,
  type HtmlDiff,
  type PagePair,
} from '@/features/compare/htmlBlockDiff';
import { logError } from '@/lib/appError';
import { toFilled as toFilledCore } from '@/lib/fillJinja';
import { type ToTemplateOptions, toTemplate as toTemplateCore } from '@/lib/jinjaMask';
import { createFallbackWorker } from './fallback';
import type { HtmlWorkerApi } from './htmlWorkerImpl';

/** メインが `await` で使う非同期 API(Comlink の `Remote<HtmlWorkerApi>` と構造的に同一)。 */
export interface AsyncHtmlWorker {
  buildHtmlDiff(
    before: string,
    after: string,
    cssBefore?: string,
    cssAfter?: string,
  ): Promise<HtmlDiff>;
  buildHtmlDiffAligned(
    before: string,
    after: string,
    cssBefore: string | undefined,
    cssAfter: string | undefined,
    pairs: PagePair[],
  ): Promise<HtmlDiff>;
  toTemplate(editable: string, opts?: ToTemplateOptions): Promise<string>;
  toFilled(raw: string, sample: SampleData): Promise<string>;
}

// Worker が無い環境では browser/jsdom の DOMParser でメイン実行(core 関数は既定パーサを使う)。
const mainThreadFallback: AsyncHtmlWorker = {
  async buildHtmlDiff(before, after, cssBefore, cssAfter) {
    return buildHtmlDiffCore(before, after, cssBefore, cssAfter);
  },
  async buildHtmlDiffAligned(before, after, cssBefore, cssAfter, pairs) {
    return buildHtmlDiffAlignedCore(before, after, cssBefore, cssAfter, pairs);
  },
  async toTemplate(editable, opts) {
    return toTemplateCore(editable, opts);
  },
  async toFilled(raw, sample) {
    return toFilledCore(raw, sample);
  },
};

/**
 * Worker を構築し、失敗・実行時エラー・ハングのいずれでも `mainThreadFallback` へ倒すプロキシを
 * 返す。判断ロジック本体は `createFallbackWorker`(`./fallback`)に切り出してある。
 */
function createHtmlWorker(): AsyncHtmlWorker {
  if (typeof Worker === 'undefined') return mainThreadFallback;

  try {
    // Vite 標準の module worker(本番ビルドで worker チャンクへ自動分割)。
    const worker = new Worker(new URL('./htmlWorker.ts', import.meta.url), { type: 'module' });
    const remote = Comlink.wrap<HtmlWorkerApi>(worker) as unknown as AsyncHtmlWorker;
    const { worker: proxy, markBroken } = createFallbackWorker(remote, mainThreadFallback);
    // Worker 側の致命エラー(チャンク読込失敗・スクリプト実行例外)は Comlink の message として
    // 返らず、RPC が永久に解決しない。error イベントを捕捉して以降をフォールバックへ倒す。
    worker.onerror = (e) => {
      markBroken(unexpected('html worker error', { cause: e.message }));
    };
    worker.onmessageerror = () => {
      markBroken(unexpected('html worker message error'));
    };
    return proxy;
  } catch (e) {
    // 構築自体に失敗(module worker 非対応・チャンク URL 解決失敗等)。main-thread で動かす。
    logError(unexpected('html worker init failed; using main thread', { cause: e }));
    return mainThreadFallback;
  }
}

/** メインから呼ぶ HTML 重処理のプロキシ(本番=Worker / テスト等=メインフォールバック)。 */
export const htmlWorker: AsyncHtmlWorker = createHtmlWorker();
