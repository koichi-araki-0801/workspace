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
import { expect, test } from '@playwright/test';
import { expectSelectedPart, login, openEditor, selectPart } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

test('メモ吹き出しは閉じる・編集・削除を実際に受け付ける', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await login(page);
  const frame = await openEditor(page, SEED_ID);
  const draft = page.getByPlaceholder('このパーツへのコメントを書く');
  const addButton = page.locator('button[data-add-submit]');
  const bubble = page.locator('.note-bubble');

  // パーツ A へ 2 件書く。吹き出しはこの時点で開く。
  const partA = frame.locator('.page > *').nth(4);
  await partA.waitFor({ state: 'visible', timeout: 30_000 });
  await selectPart(frame, partA);
  await page.locator('[data-pane-tab="comments"]').click();
  await draft.fill('1 件目のメモ。');
  await addButton.click();
  await expect(bubble.locator('.note-entry-body')).toHaveCount(1);
  await draft.fill('2 件目のメモ。');
  await addButton.click();
  await expect(bubble.locator('.note-entry-body')).toHaveCount(2);

  // 書きかけの下書きは、別パーツを選んだ時点で捨てる(次のパーツへ付けない)。
  await draft.fill('書きかけの下書き');
  await frame.locator('.page > *').nth(2).click();
  await expect(draft).toHaveValue('');

  // 閉じた吹き出しは、投稿を足したら開き直す(件数だけ増えて何も見えない状態を作らない)。
  // この canvas では直前に選択操作(`selectPart`)が済んでおり GrapesJS の選択配線は
  // 既に確立しているため、`selectPart` の再試行クリックは不要で単純な待ちで足りる。
  await partA.click();
  await expectSelectedPart(frame);
  await bubble.getByRole('button', { name: 'コメントを閉じる' }).click();
  await expect(bubble).toHaveCount(0);
  await draft.fill('閉じた状態で足したメモ。');
  await addButton.click();
  await expect(bubble).toHaveCount(1);

  // 編集: 吹き出しの中で本文を書き換えて保存できる。
  await bubble.getByRole('button', { name: 'このコメントを編集' }).first().click();
  await page.locator('.note-entry-input').fill('編集後の本文。');
  await bubble.getByRole('button', { name: '保存', exact: true }).click();
  await expect(bubble.getByText('編集後の本文。')).toHaveCount(1);

  // 削除: 共通の確認ダイアログを経て 1 件減る。
  const before = await bubble.locator('.note-entry-body').count();
  await bubble.getByRole('button', { name: 'このコメントを削除' }).first().click();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(bubble.locator('.note-entry-body')).toHaveCount(before - 1);

  expect(errors).toEqual([]);
});

test('吹き出しから返信と解決ができ、マーカーが灰色になる', async ({ page }) => {
  await login(page);
  const frame = await openEditor(page, SEED_ID);
  const part = frame.locator('.page > *').nth(4);
  await part.waitFor({ state: 'visible', timeout: 30_000 });
  await selectPart(frame, part);
  await page.locator('[data-pane-tab="comments"]').click();
  await page.getByPlaceholder('このパーツへのコメントを書く').fill('親コメント');
  await page.locator('button[data-add-submit]').click();

  const bubble = page.locator('.note-bubble');
  await expect(bubble).toBeVisible();
  await bubble.getByRole('button', { name: '返信する' }).click();
  await bubble.locator('[data-bubble-reply]').fill('返信です');
  await bubble.getByRole('button', { name: '返信', exact: true }).click();
  await expect(bubble.locator('[data-note-reply]')).toHaveCount(1);

  await bubble.getByRole('button', { name: '解決にする' }).click();
  await expect(page.locator('.note-marker.note-marker-resolved')).toHaveCount(1);
  await expect(bubble.getByRole('button', { name: '未対応に戻す' })).toBeVisible();
});
