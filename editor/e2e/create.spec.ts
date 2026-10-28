// =============================================================================
// create.spec.ts — 作成タブの属性選択から ?created=1 の編集画面へ到達することの回帰網
// =============================================================================
// 「属性から新規作成」は `POST /api/generate`(Python 生成器。テスト用の偽物 `server/scripts/fake_generate_template.py`)
// を経て、作る版を `pending/` に置く。版種を選べばその版だけを作って編集画面へ遷移し、選ばなければ
// 作成済み・申請中でない版をすべて作る(両版ができたら開く版をカードで選ばせ、片版だけならその版へ
// 遷移する)。作成経路(?created=1)= 差し込み値ハイライト有りであることを実画面で固定する(設計正典
// 「編集 2 系統」)。編集画面へは作成の操作で遷移するので、`openEditor`(URL を開く)へは委ねず
// 遷移先で直接 canvas を待つ。
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import { login } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const pendingDir = path.join(E2E_REST_DATA_ROOT, 'pending');

/** 作成タブで XX01 / 950037 を選ぶ。`edition` を渡したときだけ版種も選ぶ。 */
async function selectFund950037(page: Page, edition?: '交付版' | '全体版'): Promise<void> {
  await login(page);
  await page.goto('/create', { waitUntil: 'commit' });
  await page.getByText('作成するファンドを指定').first().waitFor();

  // 委託会社の候補は「略称（Rep1 の委託会社コード）」(値はファイル名の会社コード XX01)。
  await page.getByPlaceholder('委託会社を入力/選択').click();
  await page.getByRole('option', { name: /^XX01（/ }).click();
  await page.getByPlaceholder('ファンドを入力/選択').click();
  await page.getByRole('option', { name: /^950037/ }).click();
  if (edition !== undefined) {
    // Select トリガの accessible name は表示中の選択肢の span に付かないため
    // (`getByRole('combobox', { name: ... })` は空名でマッチしない)、表示文字列での絞り込みにする。
    // 未選択のトリガには「選ばない（両版を作る）」が出ている。
    await page.getByRole('combobox').filter({ hasText: '選ばない（両版を作る）' }).click();
    await page.getByRole('option', { name: edition, exact: true }).click();
  }
}

/** 作成タブで XX01 / 950037 (と版種) を選び、「属性から新規作成」を押す。 */
async function createFund950037(page: Page, edition?: '交付版' | '全体版'): Promise<void> {
  await selectFund950037(page, edition);
  // 作成済みの判定は templates/ の 3 つ区切りのファイルだけ。e2e の seed は templates/ を空で始めるので注意は出ない。
  await expect(page.getByText('テンプレートは作成済みです')).toHaveCount(0);
  await page.getByRole('button', { name: '属性から新規作成' }).click();
}

/** 遷移先の編集画面が作成経路(差し込み値のハイライトあり)で描画されたことを待つ。 */
async function expectCreatedEditor(page: Page, id: string): Promise<void> {
  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(`/edit/${id}`);
  // 生成器のスケルトンは最小の帳票 1 枚(`fake_generate_template.py`)なので、canvas の描画完了は
  // 見出し要素で待つ。
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.report-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
}

test('作成タブ: 版種を選ばずに作ると両版ができ、「交付版を開く」で ?created=1 の編集画面が開きハイライトが出る', async ({
  page,
}) => {
  await createFund950037(page);

  // 両版ができたら編集画面へは移らず、成功の帯と開く版のカードを出す。
  await expect(
    page.getByText(
      '交付版と全体版を作成しました。どちらを開くか選んでください。開かなかった版は、作成中のテンプレートから開けます。',
    ),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/create');

  // 1 回の作成で両版が pending/ に入る。
  for (const edition of ['交付版', '全体版']) {
    expect(fs.existsSync(path.join(pendingDir, `XX01_950037_${edition}.html`))).toBe(true);
  }

  // 問い合わせ直した作成可否では両版とも作業中になるが、開く入口は成功の帯のカードに 1 本化する(同じ名前のボタンが並ばないように)。
  await expect(page.getByRole('button', { name: '作成中の交付版を開く' })).toHaveCount(0);
  // `exact: true` は「作成中の交付版を開く」などの別ボタンと取り違えないため。
  await page.getByText('交付版を開く', { exact: true }).click();

  await expectCreatedEditor(page, 'XX01_950037_交付版');
});

test('作成タブ: 全体版を選んで作成すると、全体版だけを作り、全体版の編集画面が開く', async ({
  page,
}) => {
  await createFund950037(page, '全体版');

  await expectCreatedEditor(page, 'XX01_950037_全体版');
  expect(fs.existsSync(path.join(pendingDir, 'XX01_950037_全体版.html'))).toBe(true);
  expect(fs.existsSync(path.join(pendingDir, 'XX01_950037_交付版.html'))).toBe(false);
});

test('作成タブ: 作成済みなら「既存のテンプレートを開く」で作成経路の編集画面を開き、基準日を出さない', async ({
  page,
}) => {
  // seed の後に、作成済みのテンプレート(3 つ区切り)を templates/ へ置く。
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(
    path.join(templatesDir, 'XX01_950037_交付版.html'),
    '<html><body><h1 class="report-title">{{ fund.name }}</h1><p>基準日: {{ report.baseDate }}</p></body></html>',
    'utf8',
  );
  await login(page);
  await page.goto(
    `/create?companyCode=XX01&fundCode=950037&editionType=${encodeURIComponent('交付版')}`,
    { waitUntil: 'commit' },
  );
  await expect(page.getByText('テンプレートは作成済みです')).toBeVisible();
  await expect(page.getByRole('button', { name: '属性から新規作成' })).toBeDisabled();
  await page.getByRole('button', { name: '既存のテンプレートを開く' }).click();

  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe('/edit/XX01_950037_交付版');
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.report-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
  // 上部バーの属性チップに基準日が無い(canvas の中の「基準日:」は iframe の中なので数えない)。
  await expect(page.locator('header').getByText('基準日', { exact: true })).toHaveCount(0);
});

test('作成タブ: 版種を選ばず全体版が作成済みなら注記を出し、交付版だけを作ってその編集画面を開く', async ({
  page,
}) => {
  // seed の後に、作成済みの全体版(3 つ区切り)を templates/ へ置く。
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(
    path.join(templatesDir, 'XX01_950037_全体版.html'),
    '<html><body><h1 class="report-title">{{ fund.name }}</h1></body></html>',
    'utf8',
  );
  await selectFund950037(page);

  await expect(page.getByText('全体版は作成済みです。交付版だけを作ります。')).toBeVisible();
  await expect(
    page.getByText(
      'あとで両版のパーツ同期を行うと、作成済みの全体版との差分が競合として出ることがあります。',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: '属性から新規作成' }).click();

  await expectCreatedEditor(page, 'XX01_950037_交付版');
  expect(fs.existsSync(path.join(pendingDir, 'XX01_950037_交付版.html'))).toBe(true);
  expect(fs.existsSync(path.join(pendingDir, 'XX01_950037_全体版.html'))).toBe(false);
});
