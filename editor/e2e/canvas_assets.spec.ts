// =============================================================================
// canvas_assets.spec.ts — 404 の img へ content:url() を当てても、テンプレの幅が効くこと
// =============================================================================
// Chromium は読み込みに失敗した `<img>` を代替表示のインライン要素として扱い、`width:100%` が
// 効かない。`fundImageCss`(`web/src/features/editor/fundImages.ts`)は `:where(...)` で
// `display:inline-block` を詳細度 0 で足してこれを避ける。アプリの画面は使わず、`setContent`
// で同じ状況を作る(canvas の文書は標準モードなので doctype を付ける。無いと quirks モードで
// 現象が出ない)。
import { expect, test } from './fixtures';

const SRC = '../images/x.svg';
const URL_SERVED = '/api/fund-assets/images/x.svg';

// `fundImageCss` が 1 つの src から作る 2 行と同じ文字列。単体テスト
// (`web/test/fundImages.test.ts`)が同じ形を確かめている。
const REPLACE_RULE = `img[src="${SRC}"]{content:url("${URL_SERVED}")}`;
const DISPLAY_RULE = `:where(img[src="${SRC}"]){display:inline-block}`;

const SVG_10 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

async function imgWidth(
  page: import('@playwright/test').Page,
  css: string,
): Promise<number | undefined> {
  // 元の src は 404、配信 URL は 10×10 の SVG。
  await page.route('**/images/x.svg', (route) => {
    const url = route.request().url();
    if (url.includes('/api/fund-assets/')) {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG_10 });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('/');
  await page.setContent(
    `<!doctype html><style>${css}</style><div style="width:400px"><img src="${SRC}" style="width:100%"></div>`,
  );
  await page.waitForLoadState('load');
  return (await page.locator('img').boundingBox())?.width;
}

test.describe('canvas の画像差し替え', () => {
  test('404 の img に content:url() と :where の display を当てると、width:100% が効く', async ({
    page,
  }) => {
    expect(await imgWidth(page, `${REPLACE_RULE}\n${DISPLAY_RULE}`)).toBe(400);
  });

  // 将来 Chromium の挙動が変わってこの対照が落ちたら、対照だけ外す。
  test('対照: :where の行が無いと 400px にならない', async ({ page }) => {
    expect(await imgWidth(page, REPLACE_RULE)).not.toBe(400);
  });
});
