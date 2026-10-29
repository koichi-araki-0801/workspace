// =============================================================================
// line_break.spec.ts — アプリの文言の改行規則(禁則と文節)が効き、紙面には効かないこと
// =============================================================================
// `index.css` の `body` に置いた `line-break: strict` / `word-break: auto-phrase` の宣言を
// 実機で固定する。対象は承認タブの申請カードの長い説明文(句読点・長音を含む)。紙面(canvas・
// プレビュー・承認の紙面)は別文書の iframe なので宣言は届かない。PDF と同じ見えを保つため、
// 届かないことも検査する。
// `auto-phrase` は Chromium 119+ の機能で、非対応の版では宣言が無視され禁則だけが効く。
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import { login, openEditor, openReviewDetail } from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';
const EDIT_FROM = '受益者のみなさまへ';
const EDIT_TO = '受益者の皆様へ';

/**
 * 検査する文言と、その文に確実に含まれ、どの版の BudouX でも 1 つの文節として扱われる語。
 * 承認タブの申請カードの右欄の説明文(`ReviewDecisionList.vue`)と、判定バーの説明文
 * (`reviewDecisionState.ts` の `finalizeHint`。未判定の件数は申請で変わるので要素で指す)。
 */
const SIDE_TEXT =
  '文字の変更は、申請者のスタイルに影響されない本文の照合です。確定・保存されるのはこの差分です。';
const TARGETS = [
  {
    name: '右欄の説明文',
    locate: (page: Page) => page.getByText(SIDE_TEXT),
    phrases: ['申請者の', '照合です'],
  },
  {
    name: '判定バーの説明文',
    locate: (page: Page) => page.locator('[data-finalize-hint]').filter({ hasText: '未判定が' }),
    phrases: ['判定すると'],
  },
] as const;
// 最長の文節が 1 行に入る幅。これより狭くすると文節そのものが割れて当然になる。
const NARROW_WIDTH = '12em';
const NO_AUTO_PHRASE_NOTE = 'この版の Chromium は auto-phrase に対応していない（禁則だけ効く）';
const LINE_START_FORBIDDEN = '、。）」ゃゅょっー';

test.use({ viewport: { width: 1440, height: 900 } });
// 申請を作って開く重いテスト(紙面 2 面の組版)なので、ほかの承認系 spec と同じ 120s にする。
test.describe.configure({ timeout: 120_000 });

async function supportsAutoPhrase(page: Page): Promise<boolean> {
  return page.evaluate(() => CSS.supports('word-break', 'auto-phrase'));
}

/** 文言の要素を絞った幅にして、行ごとの文字列を返す(1 文字ずつの Range の top で行を分ける)。 */
async function narrowedLines(target: Locator): Promise<string[]> {
  await expect(target).toBeVisible();
  return target.evaluate((el, width) => {
    (el as HTMLElement).style.width = width;
    const lines: string[] = [];
    let lastTop = Number.NaN;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      for (let i = 0; i < text.length; i++) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const top = r.getClientRects()[0]?.top;
        if (top === undefined) continue;
        if (top !== lastTop) {
          lines.push('');
          lastTop = top;
        }
        lines[lines.length - 1] += text[i];
      }
    }
    return lines;
  }, NARROW_WIDTH);
}

/** `phrase` の出現のうち、行をまたぐものの数(行は `lines` の順につなげた文字列で数える)。 */
function splitOccurrences(lines: readonly string[], phrase: string): number {
  const text = lines.join('');
  const ends: number[] = [];
  let sum = 0;
  for (const l of lines) {
    sum += l.length;
    ends.push(sum);
  }
  let split = 0;
  for (let i = text.indexOf(phrase); i >= 0; i = text.indexOf(phrase, i + 1)) {
    const last = i + phrase.length;
    if (ends.some((e) => e > i && e < last)) split++;
  }
  return split;
}

/**
 * 編集タブの申請を API で出し(地の文を 1 語直す)、承認者で申請カードを開く。右欄の説明文と、
 * 未判定が残る間の判定バーの説明文が出る。
 */
async function openPendingReview(page: Page): Promise<void> {
  const html = fs.readFileSync(path.join(E2E_REST_DATA_ROOT, 'filled', `${SEED_ID}.html`), 'utf8');
  const css = fs.readFileSync(
    path.join(E2E_REST_DATA_ROOT, 'css', 'XX01_950037_交付版.css'),
    'utf8',
  );
  expect(html).toContain(EDIT_FROM);
  await login(page, 'editor');
  const res = await page.request.post('/api/review-requests', {
    data: { templateId: SEED_ID, html: html.replace(EDIT_FROM, EDIT_TO), css, origin: 'edit' },
  });
  expect(res.ok(), `POST review-requests ${res.status()}`).toBeTruthy();
  await login(page, 'approver');
  await page.goto('/reviews');
  await openReviewDetail(page, SEED_ID);
  for (const t of TARGETS) await expect(t.locate(page)).toBeVisible({ timeout: 60_000 });
}

test('アプリの body には禁則と文節の改行の宣言が効き、紙面の iframe には効かない', async ({
  page,
}) => {
  await openPendingReview(page);
  const app = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { lineBreak: s.lineBreak, wordBreak: s.wordBreak };
  });
  expect(app.lineBreak).toBe('strict');
  if (await supportsAutoPhrase(page)) {
    expect(app.wordBreak).toBe('auto-phrase');
  } else {
    test.info().annotations.push({ type: 'note', description: NO_AUTO_PHRASE_NOTE });
  }

  // 紙面(canvas の iframe)は別文書で、宣言が届かない。
  const frame = await openEditor(page, SEED_ID);
  const paper = await frame.locator('body').evaluate((body) => {
    const s = getComputedStyle(body);
    return { lineBreak: s.lineBreak, wordBreak: s.wordBreak };
  });
  expect(paper.lineBreak).not.toBe('strict');
  expect(paper.wordBreak).not.toBe('auto-phrase');
});

test('アプリの文言は句読点・閉じ括弧・小さい仮名を行頭に置かない', async ({ page }) => {
  await openPendingReview(page);
  for (const t of TARGETS) {
    const lines = await narrowedLines(t.locate(page));
    expect(lines.length, t.name).toBeGreaterThan(1);
    for (const line of lines) {
      expect(LINE_START_FORBIDDEN, `${t.name}: ${lines.join(' / ')}`).not.toContain(line[0]);
    }
  }
});

test('文節の途中で改行しない(auto-phrase が効く版のとき)', async ({ page }) => {
  await openPendingReview(page);
  test.skip(!(await supportsAutoPhrase(page)), NO_AUTO_PHRASE_NOTE);
  for (const t of TARGETS) {
    const lines = await narrowedLines(t.locate(page));
    // 折り返していなければ、文節を割らないことを確かめたことにならない。
    expect(lines.length, t.name).toBeGreaterThan(1);
    for (const phrase of t.phrases) {
      const where = `${t.name}「${phrase}」: ${lines.join(' / ')}`;
      expect(lines.join(''), where).toContain(phrase);
      expect(splitOccurrences(lines, phrase), where).toBe(0);
    }
  }
});
