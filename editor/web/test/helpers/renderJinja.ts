// =============================================================================
// renderJinja.ts — テスト専用の Jinja 描画(nunjucks をアプリのバンドルへ入れない)
// =============================================================================
import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';
import type { RenderResult } from '../../src/lib/nunjucksRender';

/**
 * 生 Jinja2 テンプレートを sample data で描画する。本番の描画は隔離 iframe
 * (`lib/renderHostClient.ts` の `renderJinjaIsolated`)が行い、アプリのコードは nunjucks を
 * 持たない(`ssti.guard.test.ts`)。テストは隔離を介さず、同じ設定の Environment で直に描画する。
 *
 * `autoescape` / `throwOnUndefined` は、隔離側(`server/src/render/renderHost.ts` のブート
 * スクリプト)が同じ値で Environment を作る。描画結果を揃えるため、片方だけ変えない。
 */
const env = new nunjucks.Environment(undefined, {
  autoescape: true,
  throwOnUndefined: false,
});

export function renderJinja(template: string, data: SampleData): RenderResult {
  try {
    return { html: env.renderString(template, data as object), error: null };
  } catch (e) {
    // nunjucks は同期描画の失敗を必ず `TemplateError`(Error 派生)に包んで投げるので、
    // 非 Error 側は型の上で到達不能。
    return { html: '', error: (e as Error).message };
  }
}
