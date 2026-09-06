// =============================================================================
// helpers.ts — e2e spec 間で重複していたログイン・canvas 初期化待ちの集約
// =============================================================================
// ログイン(8 spec に 3 変種)・GrapesJS canvas 初期化待ち・スクリーンショット用の寸法安定待ちは
// spec ごとにわずかに異なる実装で重複していた。fixtures の運用(ログインID = パスワード)は
// 全 spec で共通なので、ユーザー名だけ渡せば足りる形にまとめる。
import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';

/**
 * ログイン(fixtures はログインID = パスワード運用: `admin`/`admin` 等)。`clearSession` は
 * 同一テスト内で別ユーザーへ入り直す(承認タブの精査等)ときに使う — 認証済みのまま
 * `/login` へ行くと router guard がアプリへ押し戻すため、先にセッションを捨てる。
 * 未認証の初回ログインでも no-op になる(`/` が `/login` へリダイレクトし、
 * `localStorage.removeItem` は何も無くても安全)ため、既定で有効にしておく。
 */
export async function login(
  page: Page,
  user = 'admin',
  { clearSession = true }: { clearSession?: boolean } = {},
): Promise<void> {
  if (clearSession) {
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/(login|edit|reviews)/);
    await page.evaluate(() => localStorage.removeItem('editor:session'));
  }
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(user);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  // `nav` はロール非依存で全ロールに出るアプリヘッダの一部(`MainLayout.vue`)。着地後の
  // レンダリングを待つのに固定待ちより確実。
  await page.locator('header nav a').first().waitFor();
}

/**
 * ロード中のスケルトンが消えるまで待つ。`animate-pulse` を持つのは `Skeleton.vue` だけなので、
 * 0 件 = 実データの描画完了。**画面遷移直後にそのまま呼ぶと、スケルトンがまだ 1 度も
 * 描画されていない瞬間を「0 件 = 完了」と誤認しうる**(`useAsyncResult` の `loading` は
 * 参照カウント式で初期値 false、スケルトン表示は `onMounted` の非同期処理が実際に走ってから)。
 * その画面固有の実データ要素を先に待ってから呼ぶこと(呼び出し側の責務)。
 */
export async function waitForLoaded(page: Page): Promise<void> {
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
}

/**
 * 編集画面を開き、GrapesJS canvas のページ描画まで待つ。`goto` の完了条件は `'commit'` にする。
 * 既定の `'load'` は全サブリソースの読み込み完了まで待つため、SPA が起動時に出す認証確認や
 * router のリダイレクトが割り込むと `net::ERR_ABORTED` で goto 自体が失敗する(負荷の高い CI で
 * 実際に踏んだ)。本当に待ちたいのは「canvas にページが描かれたか」で、それは下の `waitFor` が
 * 直接見ている。
 */
export async function openEditor(page: Page, id: string, query = ''): Promise<FrameLocator> {
  await page.goto(`/edit/${encodeURIComponent(id)}${query}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  return frame;
}

/**
 * 要素の寸法が落ち着くまで待ち、その boundingBox を返す。可視化を待つだけでは足りない:
 * canvas のフォントが載る前は行の高さが確定せず、その寸法で `clip` を取ると内容が途中で
 * 切れた画像になる(CI の並列実行下で実際に起きた。単独実行では再現しない)。連続 2 回
 * 同じ寸法になったところを確定と見なす。ポーリングは `expect.poll` の retry 機構に委ね、
 * 固定間隔の手書きループは持たない。`page` は他の待ち系関数(`openEditor` 等)と引数順を
 * 揃えるためだけに残し、本体では使わない。
 */
export async function waitForStableBox(
  _page: Page,
  locator: Locator,
  timeout = 20_000,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  let previousKey = '';
  let lastBox: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(
      async () => {
        lastBox = await locator.boundingBox();
        const key = lastBox ? `${Math.round(lastBox.width)}x${Math.round(lastBox.height)}` : '';
        const stable = key !== '' && key === previousKey;
        previousKey = key;
        return stable;
      },
      { timeout, intervals: [300] },
    )
    .toBe(true);
  return lastBox;
}

/**
 * canvas 内でパーツが選択状態になったことを待つ。`.gjs-selected` は GrapesJS が選択中の
 * component の DOM 要素へ自動で付与する既定クラス(アプリ側の改修不要)で、固定待ちより
 * 選択の完了を確実に検知できる。
 */
export async function expectSelectedPart(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('.gjs-selected')).toBeVisible({ timeout: 10_000 });
}

/**
 * プレビュー画面から確定保存を申請する(`review_tab.spec.ts` と `capture_docs.spec.ts` の
 * 重複実装を集約)。トースト「確定保存を申請しました」の出現を申請完了の合図にする。
 */
export async function submitOnce(page: Page, id: string): Promise<void> {
  await page.goto(`/preview/${encodeURIComponent(id)}`);
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
  ).toBeVisible();
}
