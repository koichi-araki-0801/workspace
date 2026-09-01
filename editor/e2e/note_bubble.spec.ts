// =============================================================================
// note_bubble.spec.ts — メモ吹き出しが「見えるだけでなく操作できる」ことの回帰網
// =============================================================================
// 吹き出しは canvas の overlay 層に置く。この層は `pointer-events: none` で、操作を受ける
// 要素だけが `pointer-events: auto` で復帰させる約束になっている(`EditorView.vue` のハンドル
// 類と同じ)。復帰を書き忘れると、吹き出しは**表示も位置も正しいのにクリックだけが素通りして**
// canvas の iframe に当たり、閉じる・編集・削除のどれも押せなくなる。見た目のスクリーンショット
// でも単体テストでも捕まらず、実機で触って初めて分かる形なので、ここで押さえる。
//
// 併せて、右ペインの下書きが別パーツへ持ち越されないこと(別パーツにメモが付く事故)と、
// 閉じた吹き出しが投稿の追加で開き直すこと(件数だけ増えて何も見えない事故)も固定する。
import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page): Promise<void> {
  // `waitUntil: 'commit'` は `canvas.spec.ts` の `openEditor` と同じ理由: 既定の 'load' は
  // 全サブリソースを待つので、SPA が起動時に出す認証確認や router のリダイレクトが割り込むと
  // `net::ERR_ABORTED` で goto 自体が落ちる。さらに、その遷移が終わる前に `evaluate` を投げると
  // 実行コンテキストごと壊れるため、URL が落ち着くまで待ってから localStorage を触る
  // (どちらも 4 並列の pre-push CI で実際に踏んだ)。
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  await page.waitForTimeout(800);
}

test('メモ吹き出しは閉じる・編集・削除を実際に受け付ける', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await login(page);
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  // GrapesJS の初期化とキャンバス描画を待つ(`capture_docs.spec.ts` と同じ理由)。
  await page.waitForTimeout(3000);

  const frame = page.frameLocator('iframe.gjs-frame');
  const draft = page.getByPlaceholder('このパーツへのメモを書く');
  const addButton = page.getByRole('button', { name: '追加', exact: true });
  const bubble = page.locator('.note-bubble');

  // パーツ A へ 2 件書く。吹き出しはこの時点で開く。
  const partA = frame.locator('.page > *').nth(4);
  await partA.waitFor({ state: 'visible', timeout: 30_000 });
  await partA.click();
  await page.waitForTimeout(600);
  await draft.fill('1 件目のメモ。');
  await addButton.click();
  await page.waitForTimeout(800);
  await draft.fill('2 件目のメモ。');
  await addButton.click();
  await page.waitForTimeout(1000);
  await expect(bubble.locator('.note-entry-body')).toHaveCount(2);

  // 書きかけの下書きは、別パーツを選んだ時点で捨てる(次のパーツへ付けない)。
  await draft.fill('書きかけの下書き');
  await frame.locator('.page > *').nth(2).click();
  await page.waitForTimeout(1500);
  await expect(draft).toHaveValue('');

  // 閉じた吹き出しは、投稿を足したら開き直す(件数だけ増えて何も見えない状態を作らない)。
  await partA.click();
  await page.waitForTimeout(1500);
  await bubble.getByRole('button', { name: 'メモを閉じる' }).click();
  await page.waitForTimeout(400);
  await expect(bubble).toHaveCount(0);
  await draft.fill('閉じた状態で足したメモ。');
  await addButton.click();
  await page.waitForTimeout(1200);
  await expect(bubble).toHaveCount(1);

  // 編集: 吹き出しの中で本文を書き換えて保存できる。
  await bubble.getByRole('button', { name: 'このメモを編集' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.note-entry-input').fill('編集後の本文。');
  await bubble.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(bubble.getByText('編集後の本文。')).toHaveCount(1);

  // 削除: 共通の確認ダイアログを経て 1 件減る。
  const before = await bubble.locator('.note-entry-body').count();
  await bubble.getByRole('button', { name: 'このメモを削除' }).first().click();
  await page.getByRole('button', { name: '削除する' }).click();
  await page.waitForTimeout(1200);
  await expect(bubble.locator('.note-entry-body')).toHaveCount(before - 1);

  expect(errors).toEqual([]);
});
