// =============================================================================
// page_breaks.spec.ts — 編集画面のページ分けが Vivliostyle の改ページと合うことと、区切りの見え方
// =============================================================================
// 編集画面のページは `web/src/lib/pageBreaks.ts` の `splitPages` が DOM だけで決める(根の直下の
// `div.pagebreak` と inline の改ページ)。紙のページはプレビュー(Vivliostyle)が決めるので、
// 中身が 1 ページに収まる文書なら両者のページ数と各ページの先頭が一致するはずで、ここで
// 突き合わせる。白紙のページの数え方(先頭・連続・inline の after の直後の区切り、左右の指定)と、
// 効かない inline の `page-break-*` も、形ごとに編集画面とプレビューの両方の期待値を固定する。
// どちらかの側の振る舞いが変わると、その形のテストが落ちて知らせる。
//
// 後半は、単体テスト(jsdom)では確かめられない canvas の実表示を押さえる: 1 ページ表示で見える
// パーツと区切りの帯、帯とページ線の位置、詳細度で帯が隠れること、パーツの挿入先、赤入れの
// 削除要素のページ、本文全体を固めた作成タブのページ送り、閲覧のみでの帯の削除の禁止。
//
// 文書は `page.route` でテンプレの取得の応答を差し替えて渡す(fixture は増やさない)。
import type { FrameLocator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { login, openEditor, pagePartLocator, readDraft, selectPart } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

/** 実テンプレと同じ `.pagebreak` の書き方。中身は A4 に余裕で収まる量にし、あふれを起こさない。 */
const CSS = `@page { size: A4; margin: 14mm 13mm; }
body { margin: 0; font-size: 10.5pt; }
.pagebreak { break-after: page; }`;

const PB = '<div class="pagebreak"></div>';

/** 先頭の文言を `text` にしたパーツ(`section`)。 */
function sec(text: string, style?: string): string {
  return `<section${style ? ` style="${style}"` : ''}><p>${text}</p><p>本文</p></section>`;
}

/**
 * テンプレの取得の応答の本文と CSS を差し替える。編集画面は値入り HTML(`filled`)があればそれを
 * 描く。`templateBody` を渡すと `filled` を外し、Jinja の本文(`html`)をサンプルで描かせる
 * (作成タブと同じ経路)。`css` を渡すとテンプレの CSS をそれに替える。
 */
async function serveDoc(
  page: Page,
  body: string,
  templateBody?: string,
  css: string = CSS,
): Promise<void> {
  const templatePath = `/api/templates/${encodeURIComponent(SEED_ID)}`;
  const swap = (doc: string, inner: string) =>
    doc.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/, (_m, open, close) => `${open}${inner}${close}`);
  await page.route(
    (url) => url.pathname === templatePath,
    async (route) => {
      const res = await route.fetch();
      const tpl = (await res.json()) as { html: string; css: string; filled?: string };
      tpl.css = css;
      tpl.html = swap(tpl.html, templateBody ?? body);
      if (templateBody !== undefined) delete tpl.filled;
      else if (tpl.filled) tpl.filled = swap(tpl.filled, body);
      await route.fulfill({ response: res, json: tpl });
    },
  );
}

/**
 * ページ送り(`PageNav`)の総ページ数。表示の文字(`/ N`)ではなく `data-page-count` を読む。
 * 1 ページ以下では出ないので、出るまで待つ。
 */
async function navTotal(page: Page): Promise<number> {
  const nav = page.locator('[data-page-count]').first();
  await expect(nav).toBeVisible({ timeout: 60_000 });
  return Number(await nav.getAttribute('data-page-count'));
}

/** canvas で今見えている(`display:none` でない)パーツの、ページ番号と先頭の文言。 */
async function visibleParts(frame: FrameLocator): Promise<Array<{ idx: string; text: string }>> {
  return frame.locator('body').evaluate((body) => {
    const firstText = (el: Element): string => {
      const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? '').trim();
        if (t) return t;
      }
      return '';
    };
    return Array.from(body.querySelectorAll('[data-pv-idx]'))
      .filter(
        (el) =>
          !el.classList.contains('pagebreak') &&
          !el.hasAttribute('data-redline') &&
          getComputedStyle(el).display !== 'none',
      )
      .map((el) => ({ idx: el.getAttribute('data-pv-idx') ?? '', text: firstText(el) }));
  });
}

/**
 * 編集画面の 1 ページ表示を先頭から送り、各ページの先頭の文言を集める(白紙のページは '')。
 * 各ページで、見えているパーツがすべてそのページのものであることも確かめる。
 */
async function editorPages(page: Page, frame: FrameLocator): Promise<string[]> {
  const total = await navTotal(page);
  const firsts: string[] = [];
  for (let i = 0; i < total; i++) {
    if (i > 0) await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue(String(i + 1));
    let parts: Array<{ idx: string; text: string }> = [];
    await expect
      .poll(async () => {
        parts = await visibleParts(frame);
        return parts.every((p) => p.idx === String(i));
      })
      .toBe(true);
    firsts.push(parts[0]?.text ?? '');
  }
  return firsts;
}

/**
 * プレビュー(Vivliostyle)の各ページの先頭の文言。全ページを組む設定なので、組み終わると全ページが
 * DOM にある。ページ送りは 2 ページ以上でだけ出るので、出ていればその総数とも突き合わせる。
 */
async function previewPages(page: Page): Promise<string[]> {
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe[title="プレビュー"]');
  const pages = frame.locator('[data-vivliostyle-page-container]');
  await pages.first().waitFor({ state: 'attached', timeout: 60_000 });
  await expect(page.getByText('プレビューを生成中…')).toHaveCount(0, { timeout: 60_000 });
  const count = await pages.count();
  if (count > 1) expect(await navTotal(page)).toBe(count);
  return pages.evaluateAll((els) =>
    els.map((el) => {
      const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? '').trim();
        if (t) return t;
      }
      return '';
    }),
  );
}

/** 編集画面とプレビューのページを集め、両方が `expected` に一致することを確かめる。 */
async function expectSamePages(page: Page, expected: string[]): Promise<void> {
  await login(page);
  const frame = await openEditor(page, SEED_ID);
  const edit = await editorPages(page, frame);
  const preview = await previewPages(page);
  expect({ edit, preview }).toEqual({ edit: expected, preview: expected });
}

test.describe('編集画面のページと Vivliostyle のページが一致する', () => {
  test.setTimeout(120_000);

  test('区切り 2 つで 3 ページ', async ({ page }) => {
    await serveDoc(page, sec('P1-A') + sec('P1-B') + PB + sec('P2-A') + PB + sec('P3-A'));
    await expectSamePages(page, ['P1-A', 'P2-A', 'P3-A']);
  });

  test('末尾の区切りは空のページを作らない', async ({ page }) => {
    await serveDoc(page, sec('P1-A') + PB + sec('P2-A') + PB);
    await expectSamePages(page, ['P1-A', 'P2-A']);
  });

  test('根の直下の要素の inline の break-before:page', async ({ page }) => {
    await serveDoc(page, sec('P1-A') + sec('P2-A', 'break-before:page') + sec('P2-B'));
    await expectSamePages(page, ['P1-A', 'P2-A']);
  });

  // 強制改ページの間に中身が無ければ、Vivliostyle は白紙のページを作る。編集画面も同じく数え、
  // 白紙のページの先頭の文言は ''。
  test('先頭の区切りは白紙の 1 ページ目を作る', async ({ page }) => {
    await serveDoc(page, PB + sec('P2-A') + PB + sec('P3-A'));
    await expectSamePages(page, ['', 'P2-A', 'P3-A']);
  });

  test('連続した区切りは間に白紙のページを作る', async ({ page }) => {
    await serveDoc(page, sec('P1-A') + PB + PB + sec('P3-A'));
    await expectSamePages(page, ['P1-A', '', 'P3-A']);
  });

  test('inline の break-after:page の直後の区切りは白紙のページを作る', async ({ page }) => {
    await serveDoc(page, sec('P1-A', 'break-after:page') + PB + sec('P3-A'));
    await expectSamePages(page, ['P1-A', '', 'P3-A']);
  });

  test('inline の break-before:right は左のページを白紙にして右のページから始める', async ({
    page,
  }) => {
    await serveDoc(page, sec('P1-A') + sec('P3-A', 'break-before:right'));
    await expectSamePages(page, ['P1-A', '', 'P3-A']);
  });

  // style 属性の `page-break-before/after:always`(旧来の別名)を Vivliostyle は効かせない(同じ
  // 意味の `break-before:page` は効く)。編集画面も数えず、警告欄で区切りへの置き換えを促す。
  test('inline の page-break-before/after:always は改ページしない', async ({ page }) => {
    await serveDoc(
      page,
      sec('P1-A', 'page-break-after:always') +
        sec('P1-B', 'page-break-before:always') +
        PB +
        sec('P2-A'),
    );
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    await expect(page.getByText('印刷では改ページされない指定が 2 か所あります')).toBeVisible();
    const edit = await editorPages(page, frame);
    const preview = await previewPages(page);
    expect({ edit, preview }).toEqual({ edit: ['P1-A', 'P2-A'], preview: ['P1-A', 'P2-A'] });
  });
});

// 区切りの見え方と操作。パーツは根の直下の `<p>` にし、クリックがそのままパーツの選択になるようにする。
// 赤入れは要素を先頭のクラスで対応づけるので、パーツごとに別のクラスを付ける。
const P = (text: string) => `<p class="part-${text.toLowerCase()}">${text}</p>`;
const THREE_PAGES = P('P1-A') + P('P1-B') + PB + P('P2-A') + P('P2-B') + PB + P('P3-A');

/** 1 ページ表示で今見えている区切り(`display:none` でないもの)。 */
async function visibleBands(frame: FrameLocator): Promise<string[]> {
  return frame
    .locator('[data-gjs-type=wrapper] > div.pagebreak')
    .evaluateAll((els) =>
      els
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => el.getAttribute('data-pv-idx') ?? ''),
    );
}

test.describe('canvas の区切りとページ', () => {
  test.setTimeout(120_000);

  test('1 ページ表示では、そのページのパーツと末尾の帯(破線)だけが見える', async ({ page }) => {
    await serveDoc(page, THREE_PAGES);
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    expect(await navTotal(page)).toBe(3);
    const bands = frame.locator('[data-gjs-type=wrapper] > div.pagebreak');
    await expect(bands).toHaveCount(2);
    // 帯の線は破線。帯の規則は canvas 専用の CSS(`pagebreakCanvas.ts`)。
    const lineStyle = await bands
      .first()
      .evaluate((el) => getComputedStyle(el, '::before').borderTopStyle);
    expect(lineStyle).toBe('dashed');

    const expected = [
      { parts: ['P1-A', 'P1-B'], bands: ['0'] },
      { parts: ['P2-A', 'P2-B'], bands: ['1'] },
      { parts: ['P3-A'], bands: [] },
    ];
    for (const [i, want] of expected.entries()) {
      if (i > 0) await page.getByRole('button', { name: '次のページ' }).click();
      await expect
        .poll(async () => (await visibleParts(frame)).map((p) => p.text))
        .toEqual(want.parts);
      // 他ページの帯は、帯の `!important` の規則より詳細度の高い 1 ページ表示の規則で隠れる。
      expect(await visibleBands(frame)).toEqual(want.bands);
      if (want.bands.length > 0) {
        // 帯はそのページの末尾(最後のパーツの下)にある。
        const band = await bands.nth(i).boundingBox();
        const last = await pagePartLocator(frame, i).last().boundingBox();
        expect(band && last && band.y >= last.y + last.height - 1).toBe(true);
      }
    }
  });

  test('白紙のページ(連続した区切りの間)では、そのページの帯だけが見える', async ({ page }) => {
    await serveDoc(page, P('P1-A') + PB + PB + P('P3-A'));
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    expect(await navTotal(page)).toBe(3);
    await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('2');
    await expect.poll(async () => visibleBands(frame)).toEqual(['1']);
    expect(await visibleParts(frame)).toEqual([]);
  });

  test('全ページ連続表示では、ページ線が帯の上端に 1 本ずつ引かれる', async ({ page }) => {
    await serveDoc(page, THREE_PAGES);
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    await page.getByRole('button', { name: '全ページを連続表示' }).click();
    const lines = page.locator('.pg-line');
    await expect(lines).toHaveCount(2, { timeout: 15_000 });
    // GrapesJS は canvas の位置を覚えておき、窓の大きさが変わるまで測り直さない。開いた直後は
    // canvas より上の表示が落ち着く前の位置で線が引かれることがあるので、ここで測り直させる。
    // 確かめたいのは、線が区切りの帯の上端に寄ることのほう。
    await page.setViewportSize({ width: 1400, height: 900 });
    const bands = frame.locator('[data-gjs-type=wrapper] > div.pagebreak');
    for (const i of [0, 1]) {
      await expect
        .poll(async () => {
          const line = await lines.nth(i).boundingBox();
          const band = await bands.nth(i).boundingBox();
          return line && band ? Math.abs(line.y - band.y) : Number.POSITIVE_INFINITY;
        })
        .toBeLessThan(2);
    }
    await expect(page.getByText('ここまで 1ページ目（区切り単位）')).toBeAttached();
  });

  test('パーツの追加は、現在ページの末尾(次の区切りの直前)へ入る', async ({ page }) => {
    await serveDoc(page, THREE_PAGES);
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('2');

    await page.getByText('パーツを追加', { exact: true }).click();
    await page.getByRole('combobox').filter({ hasText: 'カテゴリを選択' }).click();
    await page.getByRole('option', { name: '注記', exact: true }).click();
    await page.getByRole('button', { name: '選択したパーツを挿入' }).click();

    const inserted = frame.locator('[data-gjs-type=wrapper] > p', {
      hasText: '税制は変更される場合があります。',
    });
    await expect(inserted).toBeVisible({ timeout: 15_000 });
    await expect(inserted).toHaveAttribute('data-pv-idx', '1');
    const around = await inserted.evaluate((el) => ({
      prev: el.previousElementSibling?.textContent ?? '',
      nextIsBreak: el.nextElementSibling?.classList.contains('pagebreak') ?? false,
    }));
    expect(around).toEqual({ prev: 'P2-B', nextIsBreak: true });
  });

  test('赤入れの削除要素は、消したパーツのページでだけ見える', async ({ page }) => {
    await serveDoc(page, THREE_PAGES);
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
    await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
    await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('2');

    await selectPart(frame, frame.getByText('P2-B', { exact: true }));
    await page.keyboard.press('Delete');
    const del = frame.locator('[data-gjs-type=wrapper] > [data-redline]', { hasText: 'P2-B' });
    await expect(del).toBeVisible({ timeout: 15_000 });
    await expect(del).toHaveAttribute('data-pv-idx', '1');

    await page.getByRole('button', { name: '前のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('1');
    await expect(del).toBeHidden();
    await page.getByLabel('ページ番号(Enter でジャンプ)').fill('3');
    await page.getByLabel('ページ番号(Enter でジャンプ)').press('Enter');
    await expect(frame.getByText('P3-A', { exact: true })).toBeVisible();
    await expect(del).toBeHidden();
  });

  test('閲覧のみでは帯を Delete で消せず、編集を許可すると消せる', async ({ page }) => {
    await serveDoc(page, THREE_PAGES);
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    const bands = frame.locator('[data-gjs-type=wrapper] > div.pagebreak');
    await selectPart(frame, bands.first());
    await page.keyboard.press('Delete');
    await expect(bands).toHaveCount(2);
    expect(await navTotal(page)).toBe(3);

    await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
    await selectPart(frame, bands.first());
    await page.keyboard.press('Delete');
    await expect(bands).toHaveCount(1);
    await expect(page.getByText(/^\/ \d+$/).first()).toHaveText('/ 2');
  });

  test('作成タブで本文全体を固めても、ページ数とページ送りは区切りどおり', async ({ page }) => {
    // 閉じていない `{% if %}` は Jinja として読めず、作成タブは本文全体を固めた 1 つの包みで描く。
    // 包みは `display: contents` で、中のパーツと区切りは根の直下にあるものとして数える。
    const broken = `${P('P1-A')}${PB}${P('P2-A')}${PB}<p class="part-p3-a">P3-A {% if fund.name %}</p>`;
    await serveDoc(page, THREE_PAGES, broken);
    await login(page);
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}?created=1`, { waitUntil: 'commit' });
    const frame = page.frameLocator('iframe.gjs-frame');
    await expect(frame.locator('.jinja-frozen-body')).toHaveCount(1, { timeout: 30_000 });
    await expect(frame.getByText('P1-A', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await editorPages(page, frame)).toEqual(['P1-A', 'P2-A', 'P3-A {% if fund.name %}']);
  });

  // キーボードで押すと `mousedown` が出ず、マウスのときのように先にテキスト編集が閉じない。
  // 改ページの前に編集を確定させないと、追記が改ページの 1 手に混ざって単独で戻せなくなる。
  test('テキスト編集中にキーボードで「後で改ページ」を押しても、Undo は改ページ → 追記の順に 1 手ずつ戻す', async ({
    page,
  }) => {
    await serveDoc(page, P('P1-A') + P('P2-A'));
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
    await selectPart(frame, frame.getByText('P1-A', { exact: true }));
    // Playwright の合成ダブルクリックは選択のオーバーレイに 2 打目を吸われるので直接配送する。
    await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
      doc
        ?.querySelector('p.part-p1-a')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    const editing = frame.locator('[contenteditable="true"]');
    await expect(editing).toHaveCount(1, { timeout: 10_000 });
    await editing.evaluate((el) => {
      el.append('追記');
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    const after = page.getByRole('button', { name: /後で改ページ/ });
    await after.focus();
    await page.keyboard.press('Enter');
    const bands = frame.locator('[data-gjs-type=wrapper] > div.pagebreak');
    await expect(bands).toHaveCount(1);
    await expect(editing).toHaveCount(0);
    const appended = frame.getByText('P1-A追記', { exact: true });
    await expect(appended).toHaveCount(1);

    const undo = page.getByRole('button', { name: '元に戻す' }).first();
    await undo.click();
    await expect(bands).toHaveCount(0);
    await expect(appended).toHaveCount(1);
    await undo.click();
    await expect(appended).toHaveCount(0);
    await expect(frame.getByText('P1-A', { exact: true })).toHaveCount(1);
  });

  test('Inspector の「後で改ページ」OFF は区切りを 1 つだけ消し、白紙のページを残す', async ({
    page,
  }) => {
    await serveDoc(page, P('P1-A') + PB + PB + PB + P('P4-A'));
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    expect(await navTotal(page)).toBe(4);
    await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
    await selectPart(frame, frame.getByText('P1-A', { exact: true }));
    const after = page.getByRole('button', { name: /後で改ページ/ });
    await expect(after).toContainText('ON');
    await after.click();
    const bands = frame.locator('[data-gjs-type=wrapper] > div.pagebreak');
    await expect(bands).toHaveCount(2);
    expect(await navTotal(page)).toBe(3);
    await expect(after).toContainText('ON');
    // 白紙のページの帯の印(canvas 専用)は保存内容に出ない。
    await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
      timeout: 15_000,
    });
    const draft = await readDraft(page, SEED_ID);
    expect(draft?.html).not.toContain('data-pv-');
  });

  test('1 ページ表示の区切りだけの白紙のページには、高さのある「白紙のページ」の帯が出る', async ({
    page,
  }) => {
    await serveDoc(page, P('P1-A') + PB + PB + P('P3-A'));
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    expect(await navTotal(page)).toBe(3);
    await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('2');
    const blank = frame.locator('[data-gjs-type=wrapper] > div.pagebreak[data-pv-blank]');
    await expect(blank).toBeVisible();
    const look = await blank.evaluate((el) => ({
      label: getComputedStyle(el, '::after').content,
      height: el.getBoundingClientRect().height,
    }));
    expect(look.label).toContain('白紙のページ');
    expect(look.height).toBeGreaterThanOrEqual(36);
    // 帯は区切りだけのページにだけ出る。前後のページの区切りは、ふつうの区切りのまま見える。
    const breaks = frame.locator('[data-gjs-type=wrapper] > div.pagebreak');
    const visibleBreakLabels = () =>
      breaks.evaluateAll((els) =>
        els
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => getComputedStyle(el, '::after').content),
      );
    for (const n of ['1', '3']) {
      await page.getByLabel('ページ番号(Enter でジャンプ)').fill(n);
      await page.getByLabel('ページ番号(Enter でジャンプ)').press('Enter');
      await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue(n);
      await expect(frame.getByText(`P${n}-A`, { exact: true })).toBeVisible();
      await expect(blank).toBeHidden();
      for (const label of await visibleBreakLabels()) expect(label).not.toContain('白紙');
    }
  });

  test('要素の無い白紙のページ(左右合わせ)は、1 ページ表示でそのページにだけ帯が出る', async ({
    page,
  }) => {
    await serveDoc(page, `${P('P1-A')}<p class="part-p3-a" style="break-before:right">P3-A</p>`);
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    expect(await navTotal(page)).toBe(3);
    const wrapperLabel = () =>
      frame
        .locator('[data-gjs-type=wrapper]')
        .evaluate((el) => getComputedStyle(el, '::before').content);
    expect(await wrapperLabel()).not.toContain('白紙');
    await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('2');
    await expect.poll(wrapperLabel).toContain('白紙のページ');
    expect(await visibleParts(frame)).toEqual([]);
    await page.getByRole('button', { name: '次のページ' }).click();
    await expect(page.getByLabel('ページ番号(Enter でジャンプ)')).toHaveValue('3');
    await expect.poll(wrapperLabel).not.toContain('白紙');
  });

  test('全ページ連続表示で、白紙のページの前後のページ線のラベルが重ならない', async ({ page }) => {
    await serveDoc(
      page,
      `${P('P1-A')}${PB}${PB}${P('P3-A')}<p class="part-p5-a" style="break-before:right">P5-A</p>`,
    );
    await login(page);
    const frame = await openEditor(page, SEED_ID);
    expect(await navTotal(page)).toBe(5);
    await page.getByRole('button', { name: '全ページを連続表示' }).click();
    // ページは「パーツと区切り」「区切りだけ」「パーツ」「要素の無い白紙」「パーツ」の 5 枚。
    // 要素の無い 4 ページ目の前後の線は 1 本にまとまる。
    const lines = page.locator('.pg-line');
    await expect(lines).toHaveCount(3, { timeout: 15_000 });
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(frame.getByText('P5-A', { exact: true })).toBeVisible();
    await expect(
      page.getByText('ここまで 4ページ目（区切り単位。4ページ目は白紙）'),
    ).toBeAttached();
    await expect
      .poll(async () => {
        const boxes = await page.locator('.pg-label').evaluateAll((els) =>
          els
            .map((e) => e.getBoundingClientRect())
            .map((r) => ({ top: r.top, bottom: r.bottom }))
            .sort((a, b) => a.top - b.top),
        );
        return boxes.every((b, i) => i === 0 || b.top >= boxes[i - 1].bottom - 0.5);
      })
      .toBe(true);
  });

  test('次の区切りが固めた範囲の包みの中にあるページでは、パーツの追加ボタンを押せない', async ({
    page,
  }) => {
    const broken = `${P('P1-A')}${PB}${P('P2-A')}${PB}<p class="part-p3-a">P3-A {% if fund.name %}</p>`;
    await serveDoc(page, THREE_PAGES, broken);
    await login(page);
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}?created=1`, { waitUntil: 'commit' });
    const frame = page.frameLocator('iframe.gjs-frame');
    await expect(frame.locator('.jinja-frozen-body')).toHaveCount(1, { timeout: 30_000 });
    await page.getByText('パーツを追加', { exact: true }).click();
    await page.getByRole('combobox').filter({ hasText: 'カテゴリを選択' }).click();
    await page.getByRole('option', { name: '注記', exact: true }).click();
    const insert = page.getByRole('button', { name: '選択したパーツを挿入' });
    await expect(insert).toBeDisabled();
    // 最後のページは境目が無いので末尾に入れられる。
    await page.getByLabel('ページ番号(Enter でジャンプ)').fill('3');
    await page.getByLabel('ページ番号(Enter でジャンプ)').press('Enter');
    await expect(insert).toBeEnabled();
  });
});

// 警告欄に出す改ページ・パーツの警告。判定(ページ数)は変えない。
test.describe('警告欄の改ページ・パーツの警告', () => {
  test.setTimeout(120_000);

  test('CSS の規則に書いた区切り以外の改ページ指定を、例のセレクタつきで知らせる', async ({
    page,
  }) => {
    await serveDoc(
      page,
      THREE_PAGES,
      undefined,
      `${CSS}
h2.title { break-before: page; }`,
    );
    await login(page);
    await openEditor(page, SEED_ID);
    await expect(
      page.getByText(
        '書式に、区切り（.pagebreak）以外の改ページの指定があります（例: h2.title）。',
      ),
    ).toBeVisible({ timeout: 30_000 });
    expect(await navTotal(page)).toBe(3);
  });

  test('作成タブで、本文の直下の |safe とアンカーの属性の差し込みを知らせる', async ({ page }) => {
    const body = `${P('P1-A')}{{ fund.name | safe }}<p class="{{ fund.code }}">X</p>${PB}${P('P2-A')}`;
    await serveDoc(page, THREE_PAGES, body);
    await login(page);
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}?created=1`, { waitUntil: 'commit' });
    await expect(
      page.getByText('本文の直下に、描画すると要素になる差し込み（|safe など）があります。', {
        exact: false,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('パーツの名前（data-part-id・id・class）に差し込みがあります。', {
        exact: false,
      }),
    ).toBeVisible();
    // 知らせるだけで、ページの数え方は変えない(チップはパーツに数えず、区切り 1 つで 2 ページ)。
    expect(await navTotal(page)).toBe(2);
  });
});
