// =============================================================================
// filter_bar_layout.spec.ts — 絞り込みバーの placeholder が入力欄に収まること
// =============================================================================
// `FormField` の幅は離散トークンで、`SearchFilters` の placeholder は項目名を含む
// (「委託会社コードを入力/選択」)。トークンが足りないと入力欄の中で文字が見切れ、
// 「委託会社コードを入力/選」のように読めなくなる。列数の一番多い比較タブ(5 列)は
// 同時に「フィールド行が折り返さない」ことも確かめる。
import { expect, type Page, test } from '@playwright/test';
import { login } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * placeholder の描画幅と入力欄の実幅の組。`scrollWidth` は placeholder を勘定しないので、
 * 同じフォントで組んだ計測用 span の幅と比べる。
 */
async function placeholderFits(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
    document.body.appendChild(probe);
    const out = Array.from(document.querySelectorAll('input[placeholder]'))
      .filter((el): el is HTMLInputElement => (el as HTMLInputElement).placeholder.includes('入力'))
      .map((el) => {
        probe.style.font = getComputedStyle(el).font;
        probe.textContent = el.placeholder;
        return {
          placeholder: el.placeholder,
          need: Math.round(probe.getBoundingClientRect().width),
          have: Math.round(el.getBoundingClientRect().width),
        };
      });
    probe.remove();
    return out;
  });
}

test('編集タブ: placeholder が入力欄に収まる', async ({ page }) => {
  await login(page);
  await page.goto('/edit', { waitUntil: 'commit' });
  await page.getByText('委託会社コード').first().waitFor();
  const fields = await placeholderFits(page);
  expect(fields.length).toBeGreaterThanOrEqual(2);
  for (const f of fields)
    expect(f.need, `${f.placeholder} が入力欄に収まらない`).toBeLessThanOrEqual(f.have);
});

test('比較タブ: 5 列でも placeholder が収まり、フィールド行が折り返さない', async ({ page }) => {
  await login(page);
  await page.goto('/compare', { waitUntil: 'commit' });
  await page.getByText('委託会社コード').first().waitFor();

  const fields = await placeholderFits(page);
  expect(fields.length).toBeGreaterThanOrEqual(2);
  for (const f of fields)
    expect(f.need, `${f.placeholder} が入力欄に収まらない`).toBeLessThanOrEqual(f.have);

  // 比較タブの絞り込みバーはフィールド 5 列 + `basis-full` のボタン行。フィールドどうしが
  // 折り返していないこと(= 上端が 1 種類)を見る。ボタン行は常に次行なので除く。
  const rows = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const target = labels.find((l) => (l.textContent ?? '').includes('委託会社コード'));
    const row = target?.closest('div')?.parentElement;
    if (!row) return -1;
    const tops = Array.from(row.children)
      .filter((c) => c.querySelector('input, [role="combobox"], button[aria-haspopup]'))
      .map((c) => Math.round(c.getBoundingClientRect().top));
    return new Set(tops).size;
  });
  expect(rows).toBe(1);
});

// 絞り込みの操作(検索・クリア)は条件フィールドと同じ行に置く。行幅が足りないと
// `flex-wrap` でボタン群だけが次行へ落ち、条件の右に何も無い間延びした行になる。
test('編集タブ: 検索・クリアがフィールドと同じ行に並ぶ', async ({ page }) => {
  await login(page);
  await page.goto('/edit', { waitUntil: 'commit' });
  await page.getByText('委託会社コード').first().waitFor();
  const sameRow = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '検索',
    );
    const field = document.querySelector('input[placeholder*="入力"]');
    if (!button || !field) return null;
    const dy = button.getBoundingClientRect().top - field.getBoundingClientRect().top;
    return Math.abs(dy) < 20;
  });
  expect(sameRow).toBe(true);
});
