// =============================================================================
// create.spec.ts — 作成タブの属性選択から ?created=1 の編集画面へ到達することの回帰網
// =============================================================================
// 「属性から新規作成」は `POST /api/generate`(Python 生成器。テスト用の偽物 `server/scripts/fake_generate_template.py`)
// を経て `pending/` に置かれ、そのうえで編集画面へ遷移する。作成経路(?created=1)= 差し込み値
// ハイライト有りであることを実画面で固定する(設計正典「編集 2 系統」)。生成器のスケルトンは
// `.page` を持たないので、`openEditor` へは委ねず遷移先で直接 canvas を待つ。
import fs from 'node:fs';
import path from 'node:path';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import { login } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('作成タブ: 属性を選んで新規作成すると ?created=1 の編集画面が開きハイライトが出る', async ({
  page,
}) => {
  await login(page);
  await page.goto('/create', { waitUntil: 'commit' });
  await page.getByText('作成するファンドを指定').first().waitFor();

  // 委託会社の候補は「略称（Rep1 の委託会社コード）」(値はファイル名の会社コード AM01)。
  await page.getByPlaceholder('委託会社を入力/選択').click();
  await page.getByRole('option', { name: /^AM01（/ }).click();
  await page.getByPlaceholder('ファンドを入力/選択').click();
  await page.getByRole('option', { name: /^510037/ }).click();
  // Select トリガの accessible name はプレースホルダ span の中身に付かないため
  // (`getByRole('combobox', { name: ... })` は空名でマッチしない)、表示文字列での絞り込みにする。
  await page.getByRole('combobox').filter({ hasText: '版種を選択' }).click();
  await page.getByRole('option', { name: '交付版', exact: true }).click();

  // 作成済みの判定は templates/ の 3 つ区切りのファイルだけ。e2e の seed は templates/ を空で始めるので注意は出ない。
  await expect(page.getByText('テンプレートは作成済みです')).toHaveCount(0);
  await page.getByRole('button', { name: '属性から新規作成' }).click();

  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  const url = new URL(page.url());
  expect(decodeURIComponent(url.pathname)).toBe('/edit/AM01_510037_交付版');

  // 生成器のスケルトンは `.page` を持たない(最小の帳票 1 枚。`fake_generate_template.py`)ので、
  // canvas の描画完了は見出し要素で待つ。
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.report-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
});

test('作成タブ: 作成済みなら「既存のテンプレートを開く」で作成経路の編集画面を開き、基準日を出さない', async ({
  page,
}) => {
  // seed の後に、作成済みのテンプレート(3 つ区切り)を templates/ へ置く。
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(
    path.join(templatesDir, 'AM01_510037_交付版.html'),
    '<html><body><h1 class="report-title">{{ fund.name }}</h1><p>基準日: {{ report.baseDate }}</p></body></html>',
    'utf8',
  );
  await login(page);
  await page.goto(
    `/create?companyCode=AM01&fundCode=510037&editionType=${encodeURIComponent('交付版')}`,
    { waitUntil: 'commit' },
  );
  await expect(page.getByText('テンプレートは作成済みです')).toBeVisible();
  await expect(page.getByRole('button', { name: '属性から新規作成' })).toBeDisabled();
  await page.getByRole('button', { name: '既存のテンプレートを開く' }).click();

  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe('/edit/AM01_510037_交付版');
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.report-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
  // 上部バーの属性チップに基準日が無い(canvas の中の「基準日:」は iframe の中なので数えない)。
  await expect(page.locator('header').getByText('基準日', { exact: true })).toHaveCount(0);
});
