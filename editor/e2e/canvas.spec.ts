// =============================================================================
// canvas.spec.ts — GrapesJS canvas 統合の E2E(2 系統ハイライト / ズーム / ページ境界)
// =============================================================================
// `useGrapes.ts` の composable 分割(リファクタ)に先行して、単体テストが届かない
// GrapesJS 統合部の実画面挙動を固定する。2 系統の出し分けは `twoSystems.guard.test.ts`
// (単体)の実画面版 — canvas body の `jinja-vars-highlight` クラスまで確認する。
// 末尾は変更の目印(確定版から変わったパーツの丸数字。`useChangeNumbers.ts`・`EditorView.vue`)。

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  commentInput,
  login,
  openEditor as openEditorAt,
  partLocator,
  readDraft,
  selectPart,
} from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';

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
  await partLocator(frame)
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
  await partLocator(frame)
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

  // autosave 済みの draft(サーバの `drafts/`)に装飾が一切無い。文言そのものは
  // 2xl 未満の幅では隠れる(`EditorTopBar.vue`)ので、待つのは可視ではなく全文を持つ
  // `title` 属性にする(`smoke.spec.ts` と同じ理由)。
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  const draft = await readDraft(page, SEED_ID);
  const leaked = draft?.html.includes('data-redline') ?? false;
  expect(leaked).toBe(false);
  // Undo ミラー(`:v2`)と確定版正規形は rest でも localStorage に残るので、下書き(サーバ)と
  // 端末側の両方を見る(設計正典「モデルには載せない」)。
  const leakedLocal = await page.evaluate(() =>
    Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('data-redline')),
  );
  expect(leakedLocal).toBe(false);
});

test('赤入れ: 作成経路(?created=1)ではトグルを出さない', async ({ page }) => {
  await login(page);
  await openEditor(page, '?created=1');
  await expect(page.getByRole('button', { name: /赤入れ/ })).toHaveCount(0);
  // 編集経路では出る
  await openEditor(page);
  await expect(page.getByRole('button', { name: /赤入れ/ })).toHaveCount(1, { timeout: 15_000 });
});

test('プレビュー往復で編集許可・赤入れ表示・右ペインのタブ・倍率・ページ表示・選択が残る', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  const widthOf = async () => (await page.locator('iframe.gjs-frame').boundingBox())?.width ?? 0;
  await page.getByRole('button', { name: '拡大' }).click();
  await page.getByRole('button', { name: '拡大' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 * 1.2 - 2);
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
  await page.locator('[data-pane-tab="comments"]').click();
  await page.getByRole('button', { name: '全ページを連続表示' }).click();
  await page.getByRole('button', { name: 'ページ境界を隠す' }).click();
  await selectPart(frame, partLocator(frame).nth(1));

  await page.getByRole('button', { name: 'プレビュー' }).click();
  await page.waitForURL(/\/preview\//);
  await page.getByRole('button', { name: 'エディターに戻る' }).click();
  await page.waitForURL(/\/edit\//);
  const back = page.frameLocator('iframe.gjs-frame');
  await partLocator(back).first().waitFor({ state: 'visible', timeout: 30_000 });

  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 * 1.2 - 2);
  await expect(
    page.getByRole('button', { name: '編集中(クリックで閲覧のみに戻す)' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '変更箇所の赤入れを隠す' })).toBeVisible();
  await expect(page.locator('[data-pane-tab="comments"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1 ページ（区切り単位）だけ表示' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ページ境界を表示' })).toBeVisible();
  await expect(back.locator('.gjs-selected')).toHaveCount(1, { timeout: 15_000 });

  // リロードでは倍率・表示系は残り、編集許可と選択は既定へ戻る
  await page.reload({ waitUntil: 'commit' });
  const re = page.frameLocator('iframe.gjs-frame');
  await partLocator(re).first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(794 * 1.2 - 2);
  await expect(page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' })).toBeVisible();
  await expect(re.locator('.gjs-selected')).toHaveCount(0);
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
  await selectPart(frame, partLocator(frame).nth(1));
  await selectPart(frame, partLocator(frame).nth(0));
  await page.waitForTimeout(2_000);
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible();
  expect(await readDraft(page, SEED_ID)).toBeNull();

  // コメントを付け(選択が要る)、別パーツを 1 語置換
  await selectPart(frame, partLocator(frame).nth(1));
  await page.locator('[data-pane-tab="comments"]').click();
  await commentInput(page).fill('往復テスト');
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
  await partLocator(back).first().waitFor({ state: 'visible', timeout: 30_000 });
  // 赤入れ ON・編集許可は編集セッションの UI 状態としてプレビュー往復を跨いで保持される。
  await expect(page.getByRole('button', { name: '変更箇所の赤入れを隠す' })).toBeVisible();
  await expect(back.locator('del[data-redline]', { hasText: 'みなさま' })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(back.locator('[data-redline]')).toHaveCount(1);
  await expect(page.locator('.note-marker')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('[data-pane-tab="comments"]').click();
  await expect(page.locator('[data-comment-row]', { hasText: '削除済み' })).toHaveCount(0);

  // Undo で確定版と同じ内容に戻れば「変更なし」、draft も消える(編集許可は往復で ON のまま)。
  await expect(
    page.getByRole('button', { name: '編集中(クリックで閲覧のみに戻す)' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '元に戻す' }).first().click();
  await expect(back.getByText('皆様')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(back.locator('[data-redline]')).toHaveCount(0);
  await expect.poll(() => readDraft(page, SEED_ID), { timeout: 15_000 }).toBeNull();
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
  await partLocator(frame)
    .first()
    .click({ position: { x: 5, y: 5 } });
}

// ハンドルは canvas(iframe)の上にある。ハンドルの外へ出ると、捕まえていない限り移動と離す操作は
// iframe の文書へ届き、drag が追随しないまま、離しても終わらない。
test('余白のハンドルは canvas の上まで動かしても追随し、canvas の上で離すと止まる', async ({
  page,
}) => {
  await login(page);
  const frame = await openEditor(page);
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  const part = partLocator(frame).first();
  await selectPart(frame, part);
  const box = await page.getByTitle('下の余白をドラッグ').boundingBox();
  if (!box) throw new Error('下の余白のハンドルが見えない');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 100, { steps: 10 });
  const label = page.locator('.ret-drag-label');
  const mm = Number((await label.textContent())?.match(/(\d+)mm/)?.[1] ?? 0);
  expect(mm).toBeGreaterThanOrEqual(15);
  await page.mouse.up();
  await expect(label).toHaveCount(0);
  const marginAfterUp = await part.evaluate((e) => getComputedStyle(e).marginBottom);
  await page.mouse.move(x, y + 200, { steps: 5 });
  expect(await part.evaluate((e) => getComputedStyle(e).marginBottom)).toBe(marginAfterUp);
});

// ── 変更の目印(確定版から変わったパーツの丸数字) ──
// 番号は承認タブと同じ差分の仕組みで振り(`useChangeNumbers.ts`)、目印は overlay にだけ描く
// (canvas の DOM・保存内容には載せない)。計算は本文が変わったときだけ、1,000ms の予約のあとで行う。

/** 変更の目印(`EditorView.vue` の `data-change-marker`)。 */
const changeMarkers = (page: Page): Locator => page.locator('[data-change-marker]');

/** 編集を許可し、「受益者のみなさまへ」の 1 語を直して目印が 1 つ出るまで待つ。 */
async function editOneWord(page: Page, frame: ReturnType<Page['frameLocator']>): Promise<void> {
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await replaceWord(page, frame, '受益者のみなさまへ', 'みなさま', '皆様');
  await expect(changeMarkers(page)).toHaveCount(1, { timeout: 30_000 });
}

test('文字を変えたパーツに①が付き、押すと修正履歴がそのパーツで開く', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  // 未編集の帳票には目印が出ない(切替は既定で ON)。
  await expect(page.locator('.chg-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(changeMarkers(page)).toHaveCount(0);

  await editOneWord(page, frame);
  const mark = changeMarkers(page);
  await expect(mark).toHaveText('1');
  // 目印は変えたパーツの左上隅に重なる。
  const changed = partLocator(frame).filter({ hasText: '皆様' });
  const [markBox, partBox] = await Promise.all([mark.boundingBox(), changed.boundingBox()]);
  expect(Math.abs((markBox?.x ?? 0) - (partBox?.x ?? 0))).toBeLessThan(8);
  expect(Math.abs((markBox?.y ?? 0) - (partBox?.y ?? 0))).toBeLessThan(8);

  // 変えたパーツを選んだときの、目印と選択のつまみ(`.pg-move`)の重なりを記録する(目視用)。
  await selectPart(frame, changed);
  if (markBox) {
    const shot = test.info().outputPath('change-mark-and-grip.png');
    await page.screenshot({
      path: shot,
      clip: {
        x: Math.max(0, markBox.x - 160),
        y: Math.max(0, markBox.y - 60),
        width: 520,
        height: 160,
      },
    });
    await test.info().attach('change-mark-and-grip', { path: shot, contentType: 'image/png' });
  }

  // 別のパーツを選び、右ペインをコメントにしてから目印を押すと、そのパーツが選ばれ、右ペインは
  // プロパティ(修正履歴のある面)へ戻り、番号つきの見出しと修正履歴が出る。
  await selectPart(frame, partLocator(frame).first());
  await page.locator('[data-pane-tab="comments"]').click();
  await mark.click();
  await expect(frame.locator('.gjs-selected')).toContainText('皆様');
  await expect(page.locator('[data-pane-tab="props"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-selected-part] .no-pill')).toHaveText('1');
  await expect(page.getByRole('button', { name: /^修正履歴 \d+ 件$/ })).toBeVisible();
});

test('変更の目印を切ると丸数字が消え、再読み込みしても切ったまま', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  await editOneWord(page, frame);
  // 下書きに直しが残るまで待つ(再読み込みのあとも番号の元がある)。
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });

  const toggle = page.locator('.chg-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(changeMarkers(page)).toHaveCount(0);

  page.on('dialog', (d) => void d.accept());
  await page.reload({ waitUntil: 'commit' });
  const re = page.frameLocator('iframe.gjs-frame');
  await partLocator(re).first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator('.chg-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(changeMarkers(page)).toHaveCount(0);
  // 切っている間も番号は数えている(入れ直すとすぐ出る)。0 件が計算前の空振りでないことの確認。
  await page.locator('.chg-toggle').click();
  await expect(changeMarkers(page)).toHaveCount(1, { timeout: 30_000 });
});

test('目印は保存内容に載らない', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  await editOneWord(page, frame);
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  // 目印は親画面の overlay にあり、canvas の文書には無い。
  await expect(frame.locator('.chg-mark, [data-change-marker]')).toHaveCount(0);
  // 下書き(`getHtml` の書き出し)にも端末側の保存にも載らない。
  const draft = await readDraft(page, SEED_ID);
  expect(draft?.html).toContain('皆様');
  expect(draft?.html).not.toContain('chg-mark');
  expect(draft?.html).not.toContain('data-change-marker');
  const leakedLocal = await page.evaluate(() =>
    Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('chg-mark')),
  );
  expect(leakedLocal).toBe(false);
});

interface DiffRun {
  start: number;
  end?: number;
}

/**
 * 番号の計算(worker の `buildHtmlDiff`。Comlink の要求に `path` が載る)の開始・終了の時刻と、
 * 変更の目印が画面に現れた時刻を、ページの `performance.now()` で記録する。アプリの外から測る
 * ので、アプリに計測用のコードを足さない。
 */
async function trackChangeNumberRuns(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const w = window as unknown as { __diffRuns: DiffRun[]; __markerAt: number[] };
    w.__diffRuns = [];
    w.__markerAt = [];
    const byId = new Map<unknown, DiffRun>();
    const hooked = new WeakSet<Worker>();
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
      const m = msg as { id?: unknown; path?: unknown } | null;
      if (m && Array.isArray(m.path) && m.path.includes('buildHtmlDiff')) {
        const run: DiffRun = { start: performance.now() };
        w.__diffRuns.push(run);
        byId.set(m.id, run);
        if (!hooked.has(this)) {
          hooked.add(this);
          this.addEventListener('message', (e) => {
            const id = (e.data as { id?: unknown } | null)?.id;
            const r = byId.get(id);
            if (!r) return;
            r.end = performance.now();
            byId.delete(id);
          });
        }
      }
      return (post as (...a: unknown[]) => void).call(this, msg, ...rest);
    } as typeof Worker.prototype.postMessage;
    let had = false;
    new MutationObserver(() => {
      const has = document.querySelector('[data-change-marker]') !== null;
      if (has && !had) w.__markerAt.push(performance.now());
      had = has;
    }).observe(document, { childList: true, subtree: true });
  });
}

async function changeNumberRuns(page: Page): Promise<{ runs: DiffRun[]; markerAt: number[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __diffRuns: DiffRun[]; __markerAt: number[] };
    return { runs: w.__diffRuns, markerAt: w.__markerAt };
  });
}

/** 走っている番号の計算が無く、少なくとも 1 回終わっている。 */
async function changeNumbersSettled(page: Page): Promise<boolean> {
  const { runs } = await changeNumberRuns(page);
  return runs.length > 0 && runs.every((r) => r.end !== undefined);
}

/** 帳票の本文を `copies` 回くり返した値入り HTML を返す(fixture は増やさない)。 */
async function serveRepeatedBody(page: Page, copies: number): Promise<void> {
  const templatePath = `/api/templates/${encodeURIComponent(SEED_ID)}`;
  await page.route(
    (url) => url.pathname === templatePath,
    async (route) => {
      const res = await route.fetch();
      const tpl = (await res.json()) as { filled?: string };
      if (tpl.filled) {
        tpl.filled = tpl.filled.replace(
          /(<body[^>]*>)([\s\S]*)(<\/body>)/,
          (_m, open, body, close) =>
            `${open}${Array.from({ length: copies }, () => body).join('<div class="pagebreak"></div>')}${close}`,
        );
      }
      await route.fulfill({ response: res, json: tpl });
    },
  );
}

/** 所要時間の基準(計画で決めたこと。予約の 1,000ms は含めない)。超えたら直さずに止めて相談する。 */
const RECOMPUTE_BUDGET_MS = 1_500;

test('大きい帳票でも番号の再計算が 1 回 1,500ms 以内', async ({ page }) => {
  test.setTimeout(300_000);
  // fixture の帳票はどれも 10 パーツ前後なので、本文を 34 回くり返して 300 パーツ程度にする。
  await serveRepeatedBody(page, 34);
  await trackChangeNumberRuns(page);
  await login(page);
  const frame = await openEditor(page);
  const parts = await partLocator(frame).count();
  expect(parts).toBeGreaterThanOrEqual(300);
  // 開いた直後の計算(未編集なので目印は出ない)が終わるのを待つ。
  await expect.poll(() => changeNumbersSettled(page), { timeout: 120_000 }).toBe(true);
  const opened = (await changeNumberRuns(page)).runs.at(-1);
  const t0 = await page.evaluate(() => performance.now());

  await editOneWord(page, frame);
  await expect.poll(() => changeNumbersSettled(page), { timeout: 60_000 }).toBe(true);
  const { runs, markerAt } = await changeNumberRuns(page);
  const shownAt = markerAt.find((t) => t > t0);
  if (shownAt === undefined) throw new Error('目印の出現の時刻が記録されていない');
  const run = runs.filter((r) => r.start > t0 && r.start < shownAt).at(-1);
  if (!run || run.end === undefined) throw new Error('編集のあとの番号の計算が記録されていない');
  const elapsed = shownAt - run.start;
  const summary =
    `parts=${parts} runsAfterEdit=${runs.filter((r) => r.start > t0).length} ` +
    `openedWorker=${Math.round((opened?.end ?? 0) - (opened?.start ?? 0))}ms ` +
    `editWorker=${Math.round(run.end - run.start)}ms editStartToMarker=${Math.round(elapsed)}ms`;
  console.log(`[change-numbers] ${summary}`);
  test.info().annotations.push({ type: 'change-numbers', description: summary });
  expect(elapsed).toBeLessThan(RECOMPUTE_BUDGET_MS);
});

test('本文が変わらない変更では番号を計算し直さず、目印も出ない', async ({ page }) => {
  test.setTimeout(120_000);
  await trackChangeNumberRuns(page);
  await login(page);
  const frame = await openEditor(page);
  await expect.poll(() => changeNumbersSettled(page), { timeout: 60_000 }).toBe(true);
  const before = (await changeNumberRuns(page)).runs.length;

  // 余白を 1 つ増やしてすぐ戻す。変更の通知は 2 回来るが、本文を読みに行く 300ms の待ちの
  // うちに元へ戻るので、本文は開いたときと同じ(保存内容の変わらない通知)。
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await selectPart(frame, partLocator(frame).first());
  await page.getByRole('button', { name: '下の余白を増やす' }).click();
  await page.getByRole('button', { name: '下の余白を減らす' }).click();
  // 予約(300ms の待ち + 1,000ms)が過ぎるまで待ち、計算が増えていないことを見る。何も起きない
  // ことの確認なので、待つ条件が無い。
  await page.waitForTimeout(2_500);
  expect((await changeNumberRuns(page)).runs.length).toBe(before);
  await expect(changeMarkers(page)).toHaveCount(0);
});
