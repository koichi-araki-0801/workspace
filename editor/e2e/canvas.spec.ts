// =============================================================================
// canvas.spec.ts — GrapesJS canvas 統合の E2E(2 系統ハイライト / ズーム / ページ境界)
// =============================================================================
// `useGrapes.ts` の composable 分割(リファクタ)に先行して、単体テストが届かない
// GrapesJS 統合部の実画面挙動を固定する。2 系統の出し分けは `twoSystems.guard.test.ts`
// (単体)の実画面版 — canvas body の `jinja-vars-highlight` クラスまで確認する。

import { expect, type Page, test } from '@playwright/test';
import { login, openEditor as openEditorAt, selectPart } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

/** このファイルは常に seed テンプレを開くので、id を省略できる薄いラッパーに保つ。 */
const openEditor = (page: Page, query = '') => openEditorAt(page, SEED_ID, query);

test('編集 2 系統: 編集タブはハイライト無し / 作成経路(?created=1)は有り', async ({ page }) => {
  await login(page);

  // 編集経路(query なし) = per-fund 実値。差し込み値ハイライトは出さない。
  const editFrame = await openEditor(page);
  // 状態はマウント後の rAF で決まるので、固定待ちではなく条件が満たされるまで待つ。
  await expect(editFrame.locator('body')).not.toHaveClass(/jinja-vars-highlight/, {
    timeout: 15_000,
  });

  // 作成経路(?created=1) = 共通 sample の表示のみ値入り。ハイライトを出す。
  const createFrame = await openEditor(page, '?created=1');
  await expect(createFrame.locator('body')).toHaveClass(/jinja-vars-highlight/, {
    timeout: 15_000,
  });
});

test('ズーム: 起動時は 100%(A4 実寸)で、拡大と「画面に合わせる」は手動でだけ効く', async ({
  page,
}) => {
  await login(page);
  await openEditor(page);
  // A4 の紙面は 210mm = 794px。起動時は画面に合わせず 100% で開く(1440x900 では縦が
  // 収まらないので、フィットさせると 794 より小さくなる = 100% と区別できる)。
  const widthOf = async () => (await page.locator('iframe.gjs-frame').boundingBox())?.width ?? 0;
  await expect
    .poll(async () => Math.abs((await widthOf()) - 794), { timeout: 15_000 })
    .toBeLessThan(2);
  await page.getByRole('button', { name: '拡大' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 + 10);
  await page.getByRole('button', { name: '画面に合わせる' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeLessThan(794 - 10);
});

test('ページ境界 guide: 全ページ連続表示で「ここまで N ページ目」線が出る', async ({ page }) => {
  await login(page);
  await openEditor(page);

  // 既定は 1 ページ表示で guide は出ない
  await expect(page.locator('.pg-line')).toHaveCount(0);

  // 全ページ連続表示へ切替えると、page break 位置に guide 線が引かれる
  // (guide は setSinglePageMode の rAF → refreshPageGuides で非同期に測られるため長めに待つ)
  await page.getByRole('button', { name: '全ページを連続表示' }).click();
  const lines = page.locator('.pg-line');
  await expect(lines.first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('ここまで 1ページ目')).toBeVisible();

  // 上部バーからページ境界を隠すと guide が消える
  await page.getByRole('button', { name: 'ページ境界を隠す' }).click();
  await expect(page.locator('.pg-line')).toHaveCount(0);
});

/**
 * canvas 文書へ直接 dblclick を配送して RTE を開き、末尾へ文字列を追記して確定する。
 * Playwright の合成ダブルクリックは選択後に出る GrapesJS のオーバーレイに 2 打目を吸われて
 * 発火しない(`smoke.spec.ts` と同じ理由)。
 */
async function appendToParagraph(
  page: Page,
  frame: ReturnType<Page['frameLocator']>,
  needle: string,
  text: string,
) {
  await frame.getByText(needle).first().click();
  await page.evaluate((n) => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes(n),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, needle);
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, t) => {
    el.append(t);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, text);
  await frame
    .locator('.page')
    .first()
    .click({ position: { x: 5, y: 5 } });
}

test('赤入れ: 文言を編集すると旧文言が取り消し線で出て、トグルで隠せ、draft には混入しない', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);

  // 変更前は装飾なし(draft も無い)
  await expect(frame.locator('[data-redline]')).toHaveCount(0);

  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  // 赤入れは既定 OFF。ボタンで明示したときだけ差分を出す。
  await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
  await appendToParagraph(page, frame, '受益者のみなさまへ', 'E2E赤入れ');

  // 追記が canvas に入り、語句差分の結果として挿入語句の直前には旧文言の del は出ない
  // (純追記なので del は無し)。次に 1 語を置換して del を出す。
  await expect(frame.getByText('E2E赤入れ').first()).toBeVisible({ timeout: 10_000 });
  await frame.getByText('E2E赤入れ').first().click();
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes('E2E赤入れ'),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el) => {
    // 「みなさま」→「皆様」に置換(旧文言 = みなさま が del として出るはず)
    for (const t of Array.from(el.childNodes)) {
      if (t.nodeType === Node.TEXT_NODE && (t.textContent ?? '').includes('みなさま')) {
        t.textContent = (t.textContent ?? '').replace('みなさま', '皆様');
      }
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await frame
    .locator('.page')
    .first()
    .click({ position: { x: 5, y: 5 } });

  // 旧文言が取り消し線 del として出る(再計算は 300ms debounce)
  const del = frame.locator('del[data-redline]', { hasText: 'みなさま' }).first();
  await expect(del).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator('body')).toHaveClass(/redline-on/);

  // トグル OFF で消える(DOM からも外れる)
  await page.getByRole('button', { name: '変更箇所の赤入れを隠す' }).click();
  await expect(frame.locator('[data-redline]')).toHaveCount(0, { timeout: 10_000 });
  await expect(frame.locator('body')).not.toHaveClass(/redline-on/);
  await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
  await expect(frame.locator('del[data-redline]', { hasText: 'みなさま' }).first()).toBeVisible({
    timeout: 15_000,
  });

  // 選択すると当該パーツの装飾が外れる(RTE の再取込に巻き込まない安全弁)
  await frame.getByText('皆様').first().click();
  await expect(frame.locator('del[data-redline]', { hasText: 'みなさま' })).toHaveCount(0, {
    timeout: 10_000,
  });

  // autosave 済みの draft(local モードは localStorage)に装飾が一切無い。文言そのものは
  // 2xl 未満の幅では隠れる(`EditorTopBar.vue`)ので、待つのは可視ではなく全文を持つ
  // `title` 属性にする(`smoke.spec.ts` と同じ理由)。
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  const leaked = await page.evaluate(() =>
    Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('data-redline')),
  );
  expect(leaked).toBe(false);
});

test('赤入れ: 作成経路(?created=1)ではトグルを出さない', async ({ page }) => {
  await login(page);
  await openEditor(page, '?created=1');
  await expect(page.getByRole('button', { name: /赤入れ/ })).toHaveCount(0);
  // 編集経路では出る
  await openEditor(page);
  await expect(page.getByRole('button', { name: /赤入れ/ })).toHaveCount(1, { timeout: 15_000 });
});

// ③⑥: 選択だけでは未確定にならず、編集後の往復で赤入れは編集箇所だけ、コメントは削除済み扱いに
// ならず、Undo で確定版と同じ内容へ戻れば「変更なし」に戻り draft も消える。
test('往復統合: 選択のみ非 dirty / 往復後の赤入れとコメント / Undo で変更なし', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page);
  const frame = await openEditor(page);

  // 選択しただけでは未確定にならず draft も作られない
  await selectPart(frame, frame.locator('.page > *').nth(4));
  await selectPart(frame, frame.locator('.page > *').nth(2));
  await page.waitForTimeout(2_000);
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('editor:drafts'))).toBeNull();

  // コメントを付け(選択が要る)、別パーツを 1 語置換
  await selectPart(frame, frame.locator('.page > *').nth(4));
  await page.locator('[data-pane-tab="comments"]').click();
  await page.getByPlaceholder('このパーツへのコメントを書く').fill('往復テスト');
  await page.locator('button[data-add-submit]').click();
  await expect(page.locator('[data-comment-row]', { hasText: '往復テスト' })).toBeVisible();
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  // 赤入れは既定 OFF。ボタンで明示したときだけ差分を出す。
  await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
  await replaceWord(page, frame, '受益者のみなさまへ', 'みなさま', '皆様');
  await expect(frame.locator('del[data-redline]', { hasText: 'みなさま' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });

  // プレビューへ行って戻る
  await page.getByRole('button', { name: 'プレビュー' }).click();
  await page.waitForURL(/\/preview\//);
  await page.getByRole('button', { name: 'エディターに戻る' }).click();
  await page.waitForURL(/\/edit\//);
  const back = page.frameLocator('iframe.gjs-frame');
  await back.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  // 表示状態の保持は編集セッションの UI 状態（別タスク）で扱うため、ここでは明示的に ON にし直す。
  await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
  await expect(back.locator('del[data-redline]', { hasText: 'みなさま' })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(back.locator('[data-redline]')).toHaveCount(1);
  await expect(page.locator('.note-marker')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('[data-pane-tab="comments"]').click();
  await expect(page.locator('[data-comment-row]', { hasText: '削除済み' })).toHaveCount(0);

  // Undo で確定版と同じ内容に戻れば「変更なし」、draft も消える
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await page.getByRole('button', { name: '元に戻す' }).first().click();
  await expect(back.getByText('皆様')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(back.locator('[data-redline]')).toHaveCount(0);
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => JSON.parse(localStorage.getItem('editor:drafts') ?? '{}')[id] ?? null,
          SEED_ID,
        ),
      { timeout: 15_000 },
    )
    .toBeNull();
});

/** RTE でパラグラフ内の 1 語を置換する。 */
async function replaceWord(
  page: Page,
  frame: ReturnType<Page['frameLocator']>,
  needle: string,
  from: string,
  to: string,
) {
  await frame.getByText(needle).first().click();
  await page.evaluate((n) => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes(n),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, needle);
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate(
    (el, [f, t]) => {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(f))
          n.textContent = (n.textContent ?? '').replace(f, t);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },
    [from, to],
  );
  await frame
    .locator('.page')
    .first()
    .click({ position: { x: 5, y: 5 } });
}
