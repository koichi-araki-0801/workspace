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
  CHANGE_MARK_CLASS,
  commentInput,
  login,
  NUMBER_PILL_CLASS,
  openEditor as openEditorAt,
  partLocator,
  readDraft,
  reportMeasure,
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

/**
 * RTE でパラグラフ内の 1 語を置換する。返り値は入力(`input`)を送った直後の時刻で、親画面の
 * `performance.now()`(canvas の iframe は時計の起点が違うので、親の時計で読む)。
 */
async function replaceWord(
  page: Page,
  frame: ReturnType<Page['frameLocator']>,
  needle: string,
  from: string,
  to: string,
): Promise<number> {
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
  const inputAt = await editing.evaluate(
    (el, [f, t]) => {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(f))
          n.textContent = (n.textContent ?? '').replace(f, t);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return window.parent.performance.now();
    },
    [from, to],
  );
  await partLocator(frame)
    .first()
    .click({ position: { x: 5, y: 5 } });
  return inputAt;
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
  expect(markBox).not.toBeNull();
  expect(partBox).not.toBeNull();
  if (!markBox || !partBox) throw new Error('目印かパーツの矩形が取れない');
  expect(Math.abs(markBox.x - partBox.x)).toBeLessThan(8);
  expect(Math.abs(markBox.y - partBox.y)).toBeLessThan(8);

  // 変えたパーツを選ぶと、左上に選択のつまみ(`.pg-move`。並べ替えのドラッグ)が出る。つまみは
  // パーツの上の縁の外側(`translate(-50%, -110%)`)、目印は内側の左上に置くので、互いに覆わない。
  await selectPart(frame, changed);
  const gripBox = await page.locator('.pg-move').boundingBox();
  const markOnSelected = await mark.boundingBox();
  expect(gripBox).not.toBeNull();
  expect(markOnSelected).not.toBeNull();
  if (!gripBox || !markOnSelected) throw new Error('つまみか目印の矩形が取れない');
  const intersects =
    gripBox.x < markOnSelected.x + markOnSelected.width &&
    markOnSelected.x < gripBox.x + gripBox.width &&
    gripBox.y < markOnSelected.y + markOnSelected.height &&
    markOnSelected.y < gripBox.y + gripBox.height;
  expect(intersects, `grip=${JSON.stringify(gripBox)} mark=${JSON.stringify(markOnSelected)}`).toBe(
    false,
  );
  // 目印は押せる(つまみの下に隠れない): 目印の中心で一番上にある要素が目印そのもの。
  const topmostIsMark = await mark.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  });
  expect(topmostIsMark).toBe(true);

  // 別のパーツを選び、右ペインをコメントにしてから目印を押すと、そのパーツが選ばれ、右ペインは
  // プロパティ(修正履歴のある面)へ戻り、番号つきの見出しと修正履歴が出る。
  await selectPart(frame, partLocator(frame).first());
  await page.locator('[data-pane-tab="comments"]').click();
  await mark.click();
  await expect(frame.locator('.gjs-selected')).toContainText('皆様');
  await expect(page.locator('[data-pane-tab="props"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-selected-part] .${NUMBER_PILL_CLASS}`)).toHaveText('1');
  await expect(page.getByRole('button', { name: /^修正履歴 \d+ 件$/ })).toBeVisible();
});

test('右ペインの読み上げ用の文字は、はみ出しを切る枠の中の要素に位置を決められる(文書の高さを伸ばさない)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  await editOneWord(page, frame);
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  // 未選択の修正履歴の見出しと、選択中のパーツの枠の両方に番号の読み上げ用の文字が出る。選択は
  // 再読み込みで外れる(`capture_docs.spec.ts` と同じ)。
  page.on('dialog', (d) => void d.accept());
  await page.reload({ waitUntil: 'commit' });
  const reloaded = page.frameLocator('iframe.gjs-frame');
  await partLocator(reloaded).first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator(`aside [data-history-heading] .${NUMBER_PILL_CLASS}`)).toHaveCount(1, {
    timeout: 30_000,
  });
  const where = async () =>
    page.locator('aside .sr-only').evaluateAll((els) =>
      els.map((el) => {
        // いちばん近い、はみ出しを切る祖先(右ペインのスクロール枠・右ペインそのもの)。absolute の
        // 位置の基準(offsetParent)がその中に無いと、枠の外の静的位置に置かれて文書を伸ばしうる。
        let clip = el.parentElement;
        while (clip && getComputedStyle(clip).overflowY === 'visible') clip = clip.parentElement;
        const parent = (el as HTMLElement).offsetParent;
        return { text: el.textContent, inside: parent !== null && clip?.contains(parent) === true };
      }),
    );
  const unselected = await where();
  expect(unselected.length).toBeGreaterThan(0);
  for (const w of unselected) expect(w, JSON.stringify(unselected)).toMatchObject({ inside: true });

  await selectPart(reloaded, partLocator(reloaded).filter({ hasText: '皆様' }));
  await expect(page.locator(`[data-selected-part] .${NUMBER_PILL_CLASS}`)).toHaveText('1');
  const selected = await where();
  expect(selected.some((w) => w.text?.startsWith('変更 1'))).toBe(true);
  for (const w of selected) expect(w, JSON.stringify(selected)).toMatchObject({ inside: true });
});

test('編集を元に戻して確定版と同じになれば、再読み込みで離脱の確認が出ない', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  await editOneWord(page, frame);
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  // 元に戻すと確定版と同じになり、未確定が下りて下書きも消える。
  await page.getByRole('button', { name: '元に戻す' }).first().click();
  await expect(page.getByText('変更なし', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readDraft(page, SEED_ID), { timeout: 15_000 }).toBeNull();
  // 確認を受け入れずに記録だけする(出たら落ちる)。GrapesJS の離脱確認が残っていると、変更の数が
  // 0 に戻らないので、ここで確認が出る。
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  // 確認を断ると再読み込みは止まり、reload は時間切れになる。先に確認の有無で落とす。
  const reloadError = await page
    .reload({ waitUntil: 'commit', timeout: 15_000 })
    .then(() => null)
    .catch((e: unknown) => e);
  expect(dialogs, '再読み込みで離脱の確認が出た').toEqual([]);
  if (reloadError) throw reloadError;
  const reloaded = page.frameLocator('iframe.gjs-frame');
  await partLocator(reloaded).first().waitFor({ state: 'visible', timeout: 30_000 });
});

test('未確定の編集が残ったまま再読み込みすると、離脱の確認がちょうど 1 回出る', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);
  await editOneWord(page, frame);
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  await expect(page.getByText('未確定', { exact: true })).toBeVisible();
  // 「出ない」テストの対。確認はアプリの `beforeunload`(未確定のときだけ)が出す。受け入れて
  // 再読み込みを進め、出た回数を数える(GrapesJS の離脱確認は切ってあるので重ならない)。
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  await page.reload({ waitUntil: 'commit', timeout: 15_000 });
  const reloaded = page.frameLocator('iframe.gjs-frame');
  await partLocator(reloaded).first().waitFor({ state: 'visible', timeout: 30_000 });
  expect(dialogs).toEqual(['beforeunload']);
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
  await expect(frame.locator(`.${CHANGE_MARK_CLASS}, [data-change-marker]`)).toHaveCount(0);
  // 下書き(`getHtml` の書き出し)にも端末側の保存にも載らない。
  const draft = await readDraft(page, SEED_ID);
  expect(draft?.html).toContain('皆様');
  expect(draft?.html).not.toContain(CHANGE_MARK_CLASS);
  expect(draft?.html).not.toContain('data-change-marker');
  const leakedLocal = await page.evaluate(
    (cls) => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes(cls)),
    CHANGE_MARK_CLASS,
  );
  expect(leakedLocal).toBe(false);
});

interface DiffRun {
  start: number;
  end?: number;
}

/**
 * アプリが打つ時刻の目印(`useChangeNumbers.ts` の `CHANGE_NOTIFY_MARK`・`CHANGE_RUN_MARK`)。
 * 通知を受けた時刻と、予約が満了した時刻(計算中なら、その計算が終わってから番号の計算を始める)。
 * アプリは打つたびに前の目印を消すので、`PerformanceObserver` で打たれるたびに受け取る。
 */
const CHANGE_MARKS = { notify: 'change-numbers:notify', run: 'change-numbers:run' } as const;

/**
 * 番号の計算(worker の `buildHtmlDiff`。Comlink の要求に `path` が載る)の開始・終了の時刻と、
 * 変更の通知・予約が満了した時刻(アプリが打つ `performance.mark`)と、変更の目印が画面に現れた
 * 時刻を、ページの `performance.now()` で記録する。
 */
async function trackChangeNumberRuns(page: Page): Promise<void> {
  await page.addInitScript((marks) => {
    if (window.top !== window) return;
    const w = window as unknown as {
      __diffRuns: DiffRun[];
      __markerAt: number[];
      __longTasks: [number, number][];
    };
    w.__diffRuns = [];
    w.__markerAt = [];
    // 主スレッドの長いタスク(50ms 超)。所要時間の内訳を見る手がかりにする。
    w.__longTasks = [];
    // 変更の通知の時刻(`createChangeCheckScheduler` の `notify`)と、予約が満了した時刻
    // (`useChangeNumbers` の `schedule`。計算中なら後で始める)。どちらもアプリが
    // `performance.mark` で打つ。
    const tn = window as unknown as { __notifyAt: number[]; __runAt: number[] };
    tn.__notifyAt = [];
    tn.__runAt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntriesByName(marks.notify, 'mark')) tn.__notifyAt.push(e.startTime);
      for (const e of list.getEntriesByName(marks.run, 'mark')) tn.__runAt.push(e.startTime);
    }).observe({ type: 'mark' });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push([e.startTime, e.duration]);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // longtask を観測できない版では内訳を出さないだけ。
    }
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
  }, CHANGE_MARKS);
}

async function changeNumberRuns(
  page: Page,
): Promise<{ runs: DiffRun[]; markerAt: number[]; longTasks: [number, number][] }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __diffRuns: DiffRun[];
      __markerAt: number[];
      __longTasks: [number, number][];
    };
    return { runs: w.__diffRuns, markerAt: w.__markerAt, longTasks: w.__longTasks };
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

/** `[from, to)` に始まった長いタスクの合計と件数。 */
function longTasksIn(tasks: [number, number][], from: number, to: number): string {
  const hit = tasks.filter(([start]) => start >= from && start < to);
  return `${Math.round(hit.reduce((sum, [, d]) => sum + d, 0))}ms/${hit.length}`;
}

/**
 * 所要時間の基準(計画で決め、2026-10-29 に当てる区間を決め直した)。予約が満了した時刻(計算中
 * なら後で始める)から、紙面に目印が出るまで(本文の組み立て・worker の計算・描画)に当てる。
 */
const RECOMPUTE_BUDGET_MS = 1_500;
/** 番号の計算の予約(`useChangeNumbers.ts` の `MIN_DEBOUNCE_MS`)。 */
const CHANGE_NUMBERS_DEBOUNCE_MS = 1_000;
/** 変更の通知から本文を読みに行くまでの待ち(`useChangeNumbers.ts` の `CHANGE_CHECK_WAIT_MS`)。 */
const CHANGE_CHECK_WAIT_MS = 300;

test('大きい帳票でも番号の再計算が 1 回 1,500ms 以内(予約が満了した時刻から目印まで)', async ({
  page,
}) => {
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

  // 基準と比べるのは、入力のあとで予約が満了した時刻(アプリの目印。計算中なら後で始める)から、
  // 目印が画面に現れた時刻まで。通知(GrapesJS が編集の確定で出す。入力そのものでは来ない)から
  // 目印までの全体・入力から通知まで・worker の計算・長いタスクは、記録として annotation に残す。
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  const inputAt = await replaceWord(page, frame, '受益者のみなさまへ', 'みなさま', '皆様');
  await expect(changeMarkers(page)).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => changeNumbersSettled(page), { timeout: 60_000 }).toBe(true);
  const { runs, markerAt, longTasks } = await changeNumberRuns(page);
  const appMarks = await page.evaluate(() => {
    const w = window as unknown as { __notifyAt: number[]; __runAt: number[] };
    return { notifyAt: w.__notifyAt, runAt: w.__runAt };
  });
  const notifyAt = appMarks.notifyAt.find((t) => t > inputAt);
  if (notifyAt === undefined) throw new Error('編集のあとの変更の通知が記録されていない');
  const shownAt = markerAt.find((t) => t > notifyAt);
  if (shownAt === undefined) throw new Error('目印の出現の時刻が記録されていない');
  // 目印を出した計算(worker へ投げた記録)と、予約が満了した時刻の目印を対で選ぶ。目印は予約の
  // 満了で打ち、計算はそのあと(計算中なら後で)投げるので、投げた時刻より前で最後の目印がその対。
  const run = runs.filter((r) => r.start > notifyAt && r.start < shownAt).at(-1);
  if (!run || run.end === undefined) throw new Error('編集のあとの番号の計算が記録されていない');
  const runAt = appMarks.runAt.filter((t) => t > notifyAt && t <= run.start).at(-1);
  if (runAt === undefined) throw new Error('予約が満了した時刻が記録されていない');
  const notifyToMarker = shownAt - notifyAt;
  const measured = shownAt - runAt;
  const summary =
    `parts=${parts} openedWorker=${Math.round((opened?.end ?? 0) - (opened?.start ?? 0))}ms ` +
    `inputToNotify=${Math.round(notifyAt - inputAt)}ms notifyToMarker=${Math.round(notifyToMarker)}ms ` +
    `notifyToRun=${Math.round(runAt - notifyAt)}ms ` +
    `(wait ${CHANGE_CHECK_WAIT_MS}+debounce ${CHANGE_NUMBERS_DEBOUNCE_MS}) ` +
    `measured(run→marker)=${Math.round(measured)}ms editWorker=${Math.round(run.end - run.start)}ms ` +
    `longTasks(notify→marker)=${longTasksIn(longTasks, notifyAt, shownAt)} ` +
    `longTasks(run→marker)=${longTasksIn(longTasks, runAt, shownAt)}`;
  reportMeasure('change-numbers', summary);
  expect(measured).toBeLessThan(RECOMPUTE_BUDGET_MS);
});

test('本文が変わらない変更では番号を計算し直さず、目印も出ない', async ({ page }) => {
  test.setTimeout(120_000);
  await trackChangeNumberRuns(page);
  await login(page);
  const frame = await openEditor(page);
  await expect.poll(() => changeNumbersSettled(page), { timeout: 60_000 }).toBe(true);
  const before = (await changeNumberRuns(page)).runs.length;

  // 余白を 1 つ増やしてすぐ戻す。変更の通知は 2 回来るが、本文を読みに行く 300ms の待ちの
  // うちに元へ戻るので、本文は開いたときと同じ(保存内容の変わらない通知)。2 回の押下は
  // ページの中で続けて行い(間は 2 フレーム)、増やした余白が canvas に効いたことも同じ中で測る。
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  const part = partLocator(frame).first();
  await selectPart(frame, part);
  await expect(page.getByRole('button', { name: '下の余白を増やす' })).toBeVisible();
  const stepped = await page.evaluate(async () => {
    const frames = () =>
      new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const el = doc?.querySelector<HTMLElement>('.gjs-selected');
    const margin = () => (el ? getComputedStyle(el).marginBottom : '');
    const button = (name: string) =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    const start = performance.now();
    const m0 = margin();
    button('下の余白を増やす')?.click();
    await frames();
    const m1 = margin();
    button('下の余白を減らす')?.click();
    await frames();
    return { m0, m1, m2: margin(), gap: performance.now() - start, at: performance.now() };
  });
  // 増やした余白が効き(m1)、戻した余白が元と同じ(m2)。2 回の押下は本文を読みに行く待ちより短い間。
  expect(stepped.m1).not.toBe(stepped.m0);
  expect(stepped.m2).toBe(stepped.m0);
  expect(stepped.gap).toBeLessThan(CHANGE_CHECK_WAIT_MS);
  // 押したのは選択中の要素(パーツの中の子が選ばれることもある)なので、同じ要素で測り直す。
  const selectedEl = frame.locator('.gjs-selected');
  await expect
    .poll(() => selectedEl.evaluate((e) => getComputedStyle(e).marginBottom))
    .toBe(stepped.m0);

  // 最後の通知から、本文を読みに行く待ちと予約が過ぎるまで(ページの時計で)待ち、計算が増えて
  // いないことを見る。待ちの長さはアプリの 2 つの待ち(`useChangeNumbers.ts`)に余裕を足したもの。
  // 予約が残っている間に次の編集をすると予約がまとまって見分けられないので、この待ちは省けない。
  const quietUntil = stepped.at + CHANGE_CHECK_WAIT_MS + CHANGE_NUMBERS_DEBOUNCE_MS + 500;
  await expect
    .poll(() => page.evaluate(() => performance.now()), { intervals: [250] })
    .toBeGreaterThan(quietUntil);
  expect((await changeNumberRuns(page)).runs.length).toBe(before);
  await expect(changeMarkers(page)).toHaveCount(0);

  // 陽性対照: 本文を変えると計算が 1 回増えて目印が出る(計算の記録の仕掛けが生きている)。
  await replaceWord(page, frame, '受益者のみなさまへ', 'みなさま', '皆様');
  await expect(changeMarkers(page)).toHaveCount(1, { timeout: 30_000 });
  expect((await changeNumberRuns(page)).runs.length).toBeGreaterThan(before);
});
