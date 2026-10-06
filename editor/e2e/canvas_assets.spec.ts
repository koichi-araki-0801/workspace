// =============================================================================
// canvas_assets.spec.ts — 編集画面の canvas の画像差し替えとフォントの取得先
// =============================================================================
// Chromium は読み込みに失敗した `<img>` を代替表示のインライン要素として扱い、`width:100%` が
// 効かない。`fundImageCss`(`web/src/features/editor/fundImages.ts`)は `:where(...)` で
// `display:inline-block` を詳細度 0 で足してこれを避ける。アプリの画面は使わず、`setContent`
// で同じ状況を作る(canvas の文書は標準モードなので doctype を付ける。無いと quirks モードで
// 現象が出ない)。フォントの取得先は実際の編集画面で確かめる(下の `編集画面のフォント`)。
import { expect, test } from './fixtures';
import { login, openEditor } from './helpers';

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

// 編集画面の canvas(GrapesJS の iframe)は相対 URL をアプリの URL 基準で解く。テンプレの元の
// `@font-face` が `url(fonts/x.woff2)` を `/edit/fonts/x.woff2` で取りに行くと、開発時は Vite の
// fallback の `index.html` を受け取り、コンソールにフォントの解読エラーが出る。表示は canvas 用の
// 複製(`canvasCssAssets.ts`)が配信 URL で担うので、元の規則には取りに行かせない。
// 複製の取得には中身がフォントでない本文を返す。Chromium は記述子の同じ `@font-face` を 1 つの
// 書体にまとめ、複製の読み込みに失敗すると元の規則へ取りに行くので、その場合でも 0 件であることを
// 確かめる。
test.describe('編集画面のフォント', () => {
  const SEED_ID = 'AM01_510037_20240710_交付版';
  const TEMPLATE_CSS_FONT =
    '@font-face{font-family:E2EFont;src:url(fonts/e2e.woff2)} body{font-family:E2EFont}';
  const BODY_STYLE =
    '<style>@font-face{font-family:E2EBody;src:url(../css/fonts/e2e-body.woff2)} p{font-family:E2EBody}</style>';
  const FONT_EXT = /\.(woff2?|ttf|otf)$/i;

  test('元の @font-face はアプリの URL へ取りに行かず、複製が配信 URL へ取りに行く', async ({
    page,
  }) => {
    // アプリ自身の画面のフォント(親の文書が取る)は数えない。canvas の iframe の要求だけを見る。
    const fontPaths: string[] = [];
    page.on('request', (req) => {
      const { pathname } = new URL(req.url());
      if (FONT_EXT.test(pathname) && req.frame() !== page.mainFrame()) fontPaths.push(pathname);
    });
    await page.route('**/api/preview-host/css/fonts/*', (route) =>
      route.fulfill({ status: 200, contentType: 'font/woff2', body: 'e2e' }),
    );
    // テンプレの取得の応答に、テンプレの CSS の `@font-face` と本文の `<style>` を足す。編集タブは
    // 値入り HTML(`filled`)があればそれを、無ければ `html` を描画するので両方に足す。テンプレの
    // CSS は末尾に足す(先頭だと seed の `body{font-family:…}` に負け、書体が使われず取得も起きない)。
    const templatePath = `/api/templates/${encodeURIComponent(SEED_ID)}`;
    await page.route(
      (url) => url.pathname === templatePath,
      async (route) => {
        const res = await route.fetch();
        const tpl = (await res.json()) as { html: string; css: string; filled?: string };
        const addStyle = (html: string) => html.replace(/<body([^>]*)>/, `<body$1>${BODY_STYLE}`);
        tpl.css = `${tpl.css}\n${TEMPLATE_CSS_FONT}`;
        tpl.html = addStyle(tpl.html);
        if (tpl.filled) tpl.filled = addStyle(tpl.filled);
        await route.fulfill({ response: res, json: tpl });
      },
    );

    await login(page);
    const frame = await openEditor(page, SEED_ID);
    // 複製が置かれ、両方の書体の取得が出るまで待つ(数えるのはその後)。
    await expect(frame.locator('style[data-canvas-css-assets]')).toHaveCount(1);
    await expect
      .poll(() => fontPaths.filter((p) => p.startsWith('/api/preview-host/css/fonts/')).sort(), {
        timeout: 15_000,
      })
      .toEqual(
        expect.arrayContaining([
          '/api/preview-host/css/fonts/e2e-body.woff2',
          '/api/preview-host/css/fonts/e2e.woff2',
        ]),
      );
    await frame.locator('body').evaluate(() => document.fonts.ready);

    expect(fontPaths.filter((p) => !p.startsWith('/api/'))).toEqual([]);
    expect(fontPaths).toContain('/api/preview-host/css/fonts/e2e.woff2');
    expect(fontPaths).toContain('/api/preview-host/css/fonts/e2e-body.woff2');
  });
});
