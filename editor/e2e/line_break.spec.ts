// =============================================================================
// line_break.spec.ts — アプリの文言の改行規則(禁則と文節)が効き、紙面には効かないこと
// =============================================================================
// `index.css` の `body` に置いた `line-break: strict` / `word-break: auto-phrase` の宣言を
// 実機で固定する。紙面(canvas・プレビュー・承認の紙面)は別文書の iframe なので宣言は
// 届かない。PDF と同じ見えを保つため、届かないことも検査する。
// `auto-phrase` は Chromium 119+ の機能で、非対応の版では宣言が無視され禁則だけが効く。
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { login, openEditor } from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';

// 全申請一覧が空のときの案内文(`ReviewTabView.vue` の `EmptyState` の hint)。長い日本語の
// 文で、句読点・括弧・長音を含む。Task 9b のあとは右欄の説明文へ差し替える。
const HINT = '編集画面のプレビューから「確定保存を申請」すると、申請がここに並びます。';
// 対象文に確実に含まれ、どの版の BudouX でも 1 つの文節として扱われる語。
const PHRASE = 'プレビュー';
// 最長の文節が 1 行に入る幅。これより狭くすると文節そのものが割れて当然になる。
const NARROW_WIDTH = '12em';
const NO_AUTO_PHRASE_NOTE = 'この版の Chromium は auto-phrase に対応していない（禁則だけ効く）';
const LINE_START_FORBIDDEN = '、。）」ゃゅょっー';

test.use({ viewport: { width: 1440, height: 900 } });

async function supportsAutoPhrase(page: Page): Promise<boolean> {
  return page.evaluate(() => CSS.supports('word-break', 'auto-phrase'));
}

/** 案内文の要素を絞った幅にして、行ごとの文字列を返す(1 文字ずつの Range の top で行を分ける)。 */
async function narrowedLines(page: Page): Promise<string[]> {
  const hint = page.getByText(HINT);
  await expect(hint).toBeVisible();
  return hint.evaluate((el, width) => {
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

async function openHint(page: Page): Promise<void> {
  await login(page, 'approver');
  await page.goto('/reviews');
}

test('アプリの body には禁則と文節の改行の宣言が効き、紙面の iframe には効かない', async ({
  page,
}) => {
  await openHint(page);
  await expect(page.getByText(HINT)).toBeVisible();
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
  await openHint(page);
  const lines = await narrowedLines(page);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(LINE_START_FORBIDDEN).not.toContain(line[0]);
  }
});

test('文節の途中で改行しない(auto-phrase が効く版のとき)', async ({ page }) => {
  await openHint(page);
  test.skip(!(await supportsAutoPhrase(page)), NO_AUTO_PHRASE_NOTE);
  const lines = await narrowedLines(page);
  // 語が行をまたぐなら、どの行にも語が丸ごとは入らず、行末と次行頭に分かれて現れる。
  expect(lines.some((l) => l.includes(PHRASE))).toBe(true);
});
