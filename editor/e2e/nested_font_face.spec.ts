// =============================================================================
// nested_font_face.spec.ts — 入れ子の @font-face を持つテンプレを編集して保存しても原文のまま残る
// =============================================================================
// Chromium の CSSOM を通すと GrapesJS 0.23.6 は `@media` の中の `@font-face` を
// `@media print{font-family:…}` の形に崩す。編集画面はその規則を GrapesJS に通さず運ぶので、
// 下書きの CSS には原文(外側の前置きで包み直したもの)が残る。jsdom では崩れが起きないので、
// 実ブラウザで確かめる。テンプレの CSS は `page.route` で差し替える(fixture は増やさない)。
import { expect, test } from './fixtures';
import { login, openEditor, readDraft, selectPart } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';
const FACE = '@font-face{font-family:"E2E Nested";src:url(fonts/none.woff2) format("woff2")}';
const CSS = `.pagebreak { break-after: page; }\n@media print{${FACE}.part-a{color:#123456}}`;
const BODY = '<p class="part-a">A</p><p class="part-b">B</p>';

test('入れ子の @font-face は編集して保存しても下書きの CSS に原文のまま残る', async ({ page }) => {
  test.setTimeout(120_000);
  const templatePath = `/api/templates/${encodeURIComponent(SEED_ID)}`;
  const swap = (doc: string) =>
    doc.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/, (_m, open, close) => `${open}${BODY}${close}`);
  await page.route(
    (url) => url.pathname === templatePath,
    async (route) => {
      const res = await route.fetch();
      const tpl = (await res.json()) as { html: string; css: string; filled?: string };
      tpl.css = CSS;
      tpl.html = swap(tpl.html);
      if (tpl.filled) tpl.filled = swap(tpl.filled);
      await route.fulfill({ response: res, json: tpl });
    },
  );
  await login(page);
  const frame = await openEditor(page, SEED_ID);
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await selectPart(frame, frame.getByText('B', { exact: true }));
  await page.keyboard.press('Delete');
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  const draft = await readDraft(page, SEED_ID);
  expect(draft?.css).toContain(`@media print{${FACE}}`);
  expect(draft?.css).not.toMatch(/@media print\s*\{\s*font-family/);
  expect(draft?.css).toMatch(/\.part-a\s*\{/);
});
