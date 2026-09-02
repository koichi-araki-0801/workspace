// =============================================================================
// smoke.spec.ts — 認証フローの E2E スモークテスト (Playwright)
// =============================================================================
import { expect, test } from '@playwright/test';

// 各テストは localStorage をクリーンにし、古い session が実行間で漏れないようにする。
test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('unauthenticated visit is redirected to the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'RET' })).toBeVisible();
});

test('demo login lands the user on the edit tab', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // ログイン成功後、router がリダイレクトを解決して編集タブへ遷移する。
  await expect(page).toHaveURL(/\/edit/);
});

// プレビュー可視化の退行ガード。ホストページ CSP の connect-src に data: が無いと、
// 表を含む帳票の直接遷移は 5/5 の再現率(実測)で「組版が loading のまま止まり
// ページが永久 hidden」になる — @vivliostyle/core が表セル・脚注用の内蔵 user-agent.xml を
// `data:application/xml,…` の XHR で読む経路が塞がれて文書ロードが中断するため
// (previewHost.ts の PREVIEW_HOST_CSP コメントを見よ)。seed テンプレは表を含むので、
// この直行導線が green であること自体が data: 許可の退行検知になる。マウント直後の
// リサイズ連打は再現プローブの形をそのまま使い、resize 起因の退行(core の resize
// 再レンダ・COMPLETE 前の setOptions)もまとめて網に掛ける。
test('direct preview navigation survives early viewport resizes', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);

  await page.goto(`/preview/${encodeURIComponent('AM01_510037_20240710_交付版')}`);
  for (let i = 0; i < 20; i++) {
    await page.setViewportSize({ width: 1280 + (i % 2 === 0 ? 16 : -16), height: 720 });
    await page.waitForTimeout(100);
  }
  await expect(
    page
      .frameLocator('iframe[title="プレビュー"]')
      .locator('[data-vivliostyle-page-container]:visible')
      .first(),
  ).toBeVisible({ timeout: 60_000 });
});

// 編集(autosave で draft 生成)後のプレビュー可視化の退行ガード。draft は GrapesJS の
// `getHtml()` が返す「`<html>` 無し・`<body>` ラッパ」形で保存され、プレビューはそれを
// Worker(linkedom)の `toTemplate` で復元する。linkedom はこの形の入力を誤パースしうる
// (`htmlWorkerImpl.ts` の `linkedomParse` を見よ)ため、復元が壊れると**プレビューが
// トンボだけの白紙**になり、同じ復元結果を使う PDF 出力・確定保存申請も本文を失う。
// draft 無しの直行プレビュー(上のテスト)はこの経路を通らないので、編集を挟む本テストが
// 唯一の実画面検知網になる。
test('preview shows the edited body after an autosaved draft exists', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);

  const id = encodeURIComponent('AM01_510037_20240710_交付版');
  await page.goto(`/edit/${id}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });

  // 編集を許可 → 地のテキスト(chip でない段落)へ 1 語追記 → canvas 外クリックで確定。
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  const para = frame.getByText('受益者のみなさまへ').first();
  await para.click();
  // RTE の活性化は dblclick だが、Playwright の合成ダブルクリックは選択後に出る GrapesJS の
  // オーバーレイ(バッジ/ツールバー)に 2 打目を吸われて発火しない(実測)。canvas 文書へ
  // 直接 dblclick を配送して RTE を開き、contenteditable の付与を待って追記する。
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes('受益者のみなさまへ'),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el) => {
    el.append('E2E追記');
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await frame
    .locator('.page')
    .first()
    .click({ position: { x: 5, y: 5 } });
  // 追記が canvas モデルへ入ったことを先に確かめる(ここで落ちたら編集操作自体の問題で、
  // プレビュー復元の退行ではない — 切り分けのための中間アサーション)。
  await expect(frame.getByText('E2E追記').first()).toBeVisible({ timeout: 10_000 });

  // autosave(debounce)の完了を保存状態の表示で待ってからプレビューへ。draft が無いと
  // 本テストは上の直行テストと同じ経路になり、退行を検知できない。文言そのものは 2xl 未満の
  // 幅では隠れる(`EditorTopBar.vue` — ヘッダを 1 行に保つため)ので、待つのは可視ではなく
  // 全文を持つ `title` 属性にする。
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  // dirty な編集画面は閉じる前の警告(`beforeunload`)を出す。Playwright の既定 dismiss は
  // 「ページに留まる」なので、accept してプレビューへ進める。
  page.on('dialog', (d) => void d.accept());
  await page.goto(`/preview/${id}`, { waitUntil: 'commit' });
  const preview = page.frameLocator('iframe[title="プレビュー"]');
  await expect(preview.getByText('E2E追記').first()).toBeVisible({ timeout: 60_000 });
});

test('wrong credentials show an error and stay on login', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // フォームにインラインエラーが出る (role="alert" の toast も出るため、locator を
  // 一意に保つようアサーションを form 内へ絞る)。
  await expect(
    page.locator('form').getByText('ユーザーIDまたはパスワードが違います'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
