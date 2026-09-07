// =============================================================================
// users.rest.spec.ts — rest 経路の管理者ユーザー作成 → 初回パスワード変更の実機検証
// =============================================================================
// `E2E_REST=1` のときだけ走る project `rest` 専用 spec。一時パスワードはサーバが払い出しの
// 1 回だけ平文で返す値で、以後どこにも残らない。この「1 回だけ」は画面の表示と実際に
// ログインできる資格情報の両方が揃って初めて確かめられるため、local project(localStorage +
// fixtures)では検証できない。
//
// 新規ユーザーは `要パスワード変更` が立った状態で作られる。router guard は保護ルートへの
// 直 URL 入場も `/password-init` へ押し戻すので、ログイン画面の誘導だけでなく guard 自体が
// 効いていることも見る。
//
// ユーザー切替は `test()` を分けて行う。Playwright は `test()` ごとに cookie 空の
// `BrowserContext` を払い出すので、セッション cookie 方式の rest ではこれが最も素直な
// 切替手段になる。
import { expect, test } from '@playwright/test';
import { login } from './helpers';

const NEW_USERNAME = 'e2erest';
const NEW_DISPLAY_NAME = 'rest e2e 一時ユーザー';
const NEW_PASSWORD = 'RestE2ePass1';

/** 払い出された一時パスワード。表示は 1 回きりなので、後続の test へはここで引き渡す。 */
let issuedTempPassword = '';

// 後続 2 件は 1 件目が払い出した資格情報に依存する。依存を実行順序として明示する。
test.describe.configure({ mode: 'serial' });

test('admin がユーザーを追加すると一時パスワードが 1 回だけ表示される', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/admin', { waitUntil: 'commit' });
  // 一覧が実データで描かれてから操作する。seed の `admin` 行は必ず出る。
  await expect(page.locator('table tr', { hasText: '管理 次郎' })).toBeVisible({ timeout: 30_000 });

  await page.locator('#new-username').fill(NEW_USERNAME);
  await page.locator('#new-displayname').fill(NEW_DISPLAY_NAME);
  await page.getByRole('button', { name: '追加' }).click();

  // 払い出しカードの一時パスワードは `.mono.select-all`(`AdminView.vue`)。ここでしか
  // 平文を取得できないので、値を控えてから表示の消失を確かめる。
  const passwordEl = page.locator('.mono.select-all');
  await expect(passwordEl).toBeVisible({ timeout: 30_000 });
  issuedTempPassword = (await passwordEl.textContent())?.trim() ?? '';
  expect(issuedTempPassword.length).toBeGreaterThan(0);

  // 再読み込みすると二度と表示されない。追加した行が描かれるまで待ってから不在を見る
  // (描画前の空ページを「消えた」と誤認しないため)。
  await page.reload();
  await expect(page.locator('table tr', { hasText: NEW_DISPLAY_NAME })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.mono.select-all')).toHaveCount(0);
  await expect(page.getByText(issuedTempPassword)).toHaveCount(0);
});

test('新規ユーザーは初回ログインでパスワード変更を強制され、完了後に編集タブへ進む', async ({
  page,
}) => {
  expect(issuedTempPassword).not.toBe('');
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(NEW_USERNAME);
  await page.locator('#p').fill(issuedTempPassword);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL((url) => url.pathname === '/password-init');

  // 保護ルートへ直に入っても router guard が押し戻す。ログイン画面の誘導を消しただけでは
  // 初期化を回避できてしまうため、guard が効いていることをここで押さえる。URL の判定を
  // pathname で行うのは、guard が付ける `redirect` クエリに `/edit` の字面が入るため。
  await page.goto('/edit', { waitUntil: 'commit' });
  await page.waitForURL((url) => url.pathname === '/password-init');

  await page.locator('#c').fill(issuedTempPassword);
  await page.locator('#n').fill(NEW_PASSWORD);
  await page.locator('#cf').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: '設定する' }).click();

  // 変更後は `要パスワード変更` が下り、guard が持っていた `redirect` 先へ着地する。
  await page.waitForURL((url) => url.pathname === '/edit');
  await page.locator('header nav a').first().waitFor();
});

test('旧一時パスワードは失効し、変更後のパスワードでログインできる', async ({ page }) => {
  expect(issuedTempPassword).not.toBe('');
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(NEW_USERNAME);
  await page.locator('#p').fill(issuedTempPassword);
  await page.getByRole('button', { name: 'ログイン' }).click();
  // 失敗の表示はフォーム内の `role="alert"` に限定して見る。トーストも error は同じロールを
  // 持つため、ロールだけで引くと 2 件に当たる。
  await expect(page.locator('form [role="alert"]')).toContainText(
    'ユーザーIDまたはパスワードが違います',
  );
  expect(new URL(page.url()).pathname).toBe('/login');

  // 失敗は 1 回だけに留める。`loginRateLimit` は (IP, ログインID) ごとに数えるので、
  // 誤りを繰り返すと後続の正しいログインまで拒否される。
  await page.locator('#p').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL((url) => url.pathname === '/edit');
  await page.locator('header nav a').first().waitFor();
});
