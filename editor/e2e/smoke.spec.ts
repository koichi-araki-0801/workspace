// =============================================================================
// smoke.spec.ts — 認証フローの E2E スモークテスト (Playwright)
// =============================================================================
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { partLocator } from './helpers';

// 各テストはセッション cookie を捨て、古い session が実行間で漏れないようにする。
test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('unauthenticated visit is redirected to the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'RET' })).toBeVisible();
});

test('demo login lands the user on the edit tab', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // ログイン成功後、router がリダイレクトを解決して編集タブへ遷移する。
  await expect(page).toHaveURL(/\/edit/);
});

// プレビュー可視化の退行ガード。ホストページ CSP の connect-src に data: が無いと、
// 表を含む帳票の直接遷移は 5/5 の再現率(実測)で「組版が loading のまま止まり
// ページが永久 hidden」になる — @vivliostyle/core が表セル・脚注用の内蔵 user-agent.xml を
// `data:application/xml,…` の XHR で読む経路が塞がれて文書ロードが中断するため
// (previewHost.ts の PREVIEW_HOST_CSP コメントを見よ)。seed テンプレは表を含むので、
// この直行導線が green であること自体が data: 許可の退行検知になる。マウント直後の
// リサイズ連打は再現プローブの形をそのまま使い、resize 起因の退行(core の resize
// 再レンダ・COMPLETE 前の setOptions)もまとめて網に掛ける。
test('direct preview navigation survives early viewport resizes', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);

  await page.goto(`/preview/${encodeURIComponent('XX01_950037_20240710_交付版')}`);
  for (let i = 0; i < 20; i++) {
    await page.setViewportSize({ width: 1280 + (i % 2 === 0 ? 16 : -16), height: 720 });
    await page.waitForTimeout(100);
  }
  await expect(
    page
      .frameLocator('iframe[title="プレビュー"]')
      .locator('[data-vivliostyle-page-container]:visible')
      .first(),
  ).toBeVisible({ timeout: 60_000 });
});

// 編集(autosave で draft 生成)後のプレビュー可視化の退行ガード。draft は GrapesJS の
// `getHtml()` が返す「`<html>` 無し・`<body>` ラッパ」形で保存され、プレビューはそれを
// Worker(linkedom)の `toTemplate` で復元する。linkedom はこの形の入力を誤パースしうる
// (`htmlWorkerImpl.ts` の `linkedomParse` を見よ)ため、復元が壊れると**プレビューが
// トンボだけの白紙**になり、同じ復元結果を使う PDF 出力・確定保存申請も本文を失う。
// draft 無しの直行プレビュー(上のテスト)はこの経路を通らないので、編集を挟む本テストが
// 唯一の実画面検知網になる。
test('preview shows the edited body after an autosaved draft exists', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);

  const id = encodeURIComponent('XX01_950037_20240710_交付版');
  await page.goto(`/edit/${id}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await partLocator(frame).first().waitFor({ state: 'visible', timeout: 30_000 });

  // 編集を許可 → 地のテキスト(chip でない段落)へ 1 語追記 → canvas 外クリックで確定。
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  const para = frame.getByText('受益者のみなさまへ').first();
  await para.click();
  // RTE の活性化は dblclick だが、Playwright の合成ダブルクリックは選択後に出る GrapesJS の
  // オーバーレイ(バッジ/ツールバー)に 2 打目を吸われて発火しない(実測)。canvas 文書へ
  // 直接 dblclick を配送して RTE を開き、contenteditable の付与を待って追記する。
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes('受益者のみなさまへ'),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el) => {
    el.append('E2E追記');
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await partLocator(frame)
    .first()
    .click({ position: { x: 5, y: 5 } });
  // 追記が canvas モデルへ入ったことを先に確かめる(ここで落ちたら編集操作自体の問題で、
  // プレビュー復元の退行ではない — 切り分けのための中間アサーション)。
  await expect(frame.getByText('E2E追記').first()).toBeVisible({ timeout: 10_000 });

  // autosave(debounce)の完了を保存状態の表示で待ってからプレビューへ。draft が無いと
  // 本テストは上の直行テストと同じ経路になり、退行を検知できない。文言そのものは 2xl 未満の
  // 幅では隠れる(`EditorTopBar.vue` — ヘッダを 1 行に保つため)ので、待つのは可視ではなく
  // 全文を持つ `title` 属性にする。
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
  // dirty な編集画面は閉じる前の警告(`beforeunload`)を出す。Playwright の既定 dismiss は
  // 「ページに留まる」なので、accept してプレビューへ進める。
  page.on('dialog', (d) => void d.accept());
  await page.goto(`/preview/${id}`, { waitUntil: 'commit' });
  const preview = page.frameLocator('iframe[title="プレビュー"]');
  await expect(preview.getByText('E2E追記').first()).toBeVisible({ timeout: 60_000 });
});

// ── 承認タブの紙面の目印(ホストの直行テスト) ──
// ホストページを最上位で開き、親の代わりに自分で postMessage する。最上位では
// `parent === window` なのでホストの発信元検査を通り、子 → 親のメッセージも同じ window に届く。
// 自分が送った doc / cmd / marks も同じリスナに来るので、子が送る種別だけを集める。

/** 改ページで 2 ページ以上に割れる表(`data-review-no="3"`)の行。 */
const LONG_ROWS = Array.from({ length: 80 }, (_, i) => `<tr><td>行 ${i}</td><td>値</td></tr>`).join(
  '',
);

/** 承認タブの右面を模した文書。表は 2 ページ目から始まって割れる。 */
function reviewDoc(css = '', extra = ''): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page{size:A5;margin:10mm} table.long{break-before:page} ${css}
</style></head><body>
<p data-review-no="1">パーツ1 <span class="cmp-ins">足した語</span></p>
<div data-review-ghost="added">（なし・新規追加）</div>
<p data-review-keep="">却下した段落 <span class="cmp-del">消した語</span></p>
<p data-review-no="2">パーツ2</p>
${extra}<table class="long" data-review-no="3">${LONG_ROWS}</table>
</body></html>`;
}

type HostMsg = { type: string; [k: string]: unknown };

async function openHost(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);
  await page.goto('/api/preview-host/index.html');
  await page.evaluate(() => {
    const w = window as unknown as { __msgs: HostMsg[] };
    w.__msgs = [];
    const kinds = [
      'editor:preview-part-click',
      'editor:preview-part-pages',
      'editor:preview-state',
    ];
    window.addEventListener('message', (e) => {
      const d = e.data as HostMsg | null;
      if (d && kinds.includes(d.type)) w.__msgs.push(d);
    });
  });
}

async function hostMsgs(page: Page): Promise<HostMsg[]> {
  return page.evaluate(() => (window as unknown as { __msgs: HostMsg[] }).__msgs);
}

/** 文書を送り、組版が終わる(state.ready)まで待つ。 */
async function sendDoc(page: Page, html: string, review = true): Promise<void> {
  await page.evaluate(
    ([h, r]) => {
      (window as unknown as { __msgs: HostMsg[] }).__msgs = [];
      window.postMessage({ type: 'editor:preview-doc', html: h, review: r }, '*');
    },
    [html, review] as const,
  );
  await expect
    .poll(
      async () =>
        (await hostMsgs(page)).some(
          (m) => m.type === 'editor:preview-state' && (m.state as { ready: boolean }).ready,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function post(page: Page, msg: HostMsg): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

/** ホストが作った札(page container の直下)。申請者の要素が同じ属性を持っていても数えない。 */
const OWN_BADGES = '#vp [data-vivliostyle-page-container] > [data-review-badge]';
const badge = (page: Page, no: string) =>
  page.locator(`${OWN_BADGES}[data-review-badge="no"][data-review-for="${no}"]`);
const ownBadges = (page: Page, kinds: readonly string[]) =>
  page.locator(kinds.map((k) => `${OWN_BADGES}[data-review-badge="${k}"]`).join(', '));

/** 札から祖先をたどった opacity の積と、札自身の visibility(祖先の opacity は子で打ち消せない)。 */
async function effectiveLook(loc: Locator): Promise<{ opacity: number; visibility: string }> {
  return loc.evaluate((el) => {
    let opacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) {
      opacity *= Number(getComputedStyle(n).opacity);
    }
    return { opacity, visibility: getComputedStyle(el).visibility };
  });
}

/** 表示中のページの、目印に関わる要素の位置と高さ(組版が動いていないことの物差し)。 */
async function fragmentBoxes(page: Page): Promise<number[][]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '#vp [data-review-no], #vp [data-review-ghost], #vp [data-review-keep]',
      ),
    ]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .map((r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10)),
  );
}

test('ホストは data-review-no のパーツへ番号札を描き、押すと part-click を返し、marks で色を変える', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openHost(page);

  // 申請者の要素が札と同じ属性を持っていても、ホストはそれを外さず、押しても番号を返さない。
  const fake = '<p data-review-badge="no" data-review-for="9">偽の札</p>';
  // 目印を描かない経路(review なし)で組んだ位置を、描いたあとと比べる。
  await sendDoc(page, reviewDoc('', fake), false);
  await expect(page.locator(OWN_BADGES)).toHaveCount(0);
  const before = await fragmentBoxes(page);
  expect(before.length).toBeGreaterThan(0);

  await sendDoc(page, reviewDoc('', fake));
  // 描画済みの DOM に番号の属性が残る(残らなければ紙面の目印は成り立たない)。
  await expect(page.locator('#vp [data-review-no="1"]')).toHaveCount(1);
  // 1 ページ目にはパーツ 1・2 の札。表(3)は 2 ページ目から始まる。
  await expect(badge(page, '1')).toHaveCount(1);
  await expect(badge(page, '2')).toHaveCount(1);
  await expect(badge(page, '3')).toHaveCount(0);
  await expect(badge(page, '1')).toHaveCSS('background-color', 'rgb(59, 130, 196)');
  expect(await fragmentBoxes(page)).toEqual(before);
  // 札はパーツの断片の左上に重なる(倍率を掛けた座標で数 px の内側)。
  const [b1, p1] = await page.evaluate(() =>
    ['#vp [data-review-badge="no"][data-review-for="1"]', '#vp [data-review-no="1"]'].map((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return { x: r?.x ?? Number.NaN, y: r?.y ?? Number.NaN };
    }),
  );
  expect(Math.abs((b1?.x ?? 0) - (p1?.x ?? 0))).toBeLessThan(6);
  expect(Math.abs((b1?.y ?? 0) - (p1?.y ?? 0))).toBeLessThan(6);

  // 番号 → 物理ページ。
  await expect
    .poll(
      async () =>
        (await hostMsgs(page)).filter((m) => m.type === 'editor:preview-part-pages').at(-1)?.pages,
    )
    .toEqual({ '1': 0, '2': 0, '3': 1 });

  // 空き枠の文言(札として箱に重ねる)と、却下のため現行版のままの札。文字の差分の色はホストが
  // 描く。空き枠の箱そのもの(場所を取る文書側の要素)は残る。
  await expect(page.locator('#vp [data-review-ghost]')).toHaveCount(1);
  await expect(ownBadges(page, ['ghost'])).toHaveText('（なし・新規追加）');
  await expect(ownBadges(page, ['ghost'])).toBeVisible();
  await expect(ownBadges(page, ['keep'])).toHaveText('却下のため現行版のまま');
  await expect(ownBadges(page, ['keep'])).toBeVisible();
  await expect(page.locator('#vp .cmp-ins')).toHaveCSS('color', 'rgb(21, 128, 61)');
  await expect(page.locator('#vp .cmp-del')).toHaveCSS('color', 'rgb(185, 28, 28)');

  // marks で色が変わり、札は増えない。
  await post(page, {
    type: 'editor:preview-marks',
    marks: { states: { '1': 'approved' }, selected: '2', visible: true },
  });
  await expect(badge(page, '1')).toHaveCSS('background-color', 'rgb(47, 138, 95)');
  await expect(ownBadges(page, ['no'])).toHaveCount(2);
  await expect(page.locator('#vp [data-review-no="1"]')).toHaveCSS(
    'outline-color',
    'rgb(47, 138, 95)',
  );
  expect(await fragmentBoxes(page)).toEqual(before);

  // 偽の札を押しても番号は返らず、描き直しても外されない。
  await page.getByText('偽の札').click();
  // パーツ 2 を押すと番号が返る。
  await page.locator('#vp [data-review-no="2"]').click();
  await expect
    .poll(async () => (await hostMsgs(page)).filter((m) => m.type === 'editor:preview-part-click'))
    .toEqual([{ type: 'editor:preview-part-click', part: '2' }]);
  await expect(page.getByText('偽の札')).toHaveCount(1);

  // 表示を切ると札と枠が消える。戻すと描き直す。
  await post(page, {
    type: 'editor:preview-marks',
    marks: { states: { '1': 'approved' }, selected: null, visible: false },
  });
  await expect(ownBadges(page, ['no', 'keep'])).toHaveCount(0);
  await expect(page.locator('#vp [data-review-no="1"]')).toHaveCSS('outline-style', 'none');
  // 空き枠の文言は判定の目印ではないので残る。
  await expect(ownBadges(page, ['ghost'])).toHaveCount(1);
  await post(page, {
    type: 'editor:preview-marks',
    marks: { states: { '1': 'approved' }, selected: null, visible: true },
  });
  await expect(badge(page, '1')).toHaveCount(1);

  // gotoPart は表の最初の断片のページへ移り、そこで札を描く。割れた表の札は 1 つ。
  await post(page, { type: 'editor:preview-cmd', cmd: 'gotoPart', part: '3' });
  await expect
    .poll(async () => {
      const states = (await hostMsgs(page)).filter((m) => m.type === 'editor:preview-state');
      return (states.at(-1)?.state as { currentPage: number } | undefined)?.currentPage;
    })
    .toBe(2);
  await expect(badge(page, '3')).toHaveCount(1);
  await expect(badge(page, '3')).toBeVisible();
  await post(page, { type: 'editor:preview-cmd', cmd: 'nextPage' });
  await expect
    .poll(async () => {
      const states = (await hostMsgs(page)).filter((m) => m.type === 'editor:preview-state');
      return (states.at(-1)?.state as { currentPage: number } | undefined)?.currentPage;
    })
    .toBe(3);
  // 3 ページ目にも表の断片はあるが、札は最初の断片だけ。
  expect(
    await page
      .locator('#vp [data-vivliostyle-page-container]:visible [data-review-no="3"]')
      .count(),
  ).toBeGreaterThan(0);
  await expect(page.locator(OWN_BADGES)).toHaveCount(0);
  await expect(page.getByText('偽の札')).toHaveCount(1);
});

// Vivliostyle は display:none の要素を描画済みの DOM に出さない(要素ごと無い)。本文の要素を
// display:none で消す CSS は紙面の目印も消せるので、ここで確かめるのは visibility・opacity で
// 隠す形と、空き枠・差分の印だけを狙って消す形。判定の正典は親画面の右欄の文字の差分。
for (const [label, css] of [
  [
    '全体を隠す形',
    '*{visibility:hidden!important;opacity:0!important} [data-review-ghost],div{display:none!important} .cmp-ins,.cmp-del{color:inherit!important;background:none!important}',
  ],
  [
    '本文の要素を狙う形',
    'p,table,div,span{visibility:hidden!important;opacity:0!important} [data-review-ghost]{display:none!important;visibility:hidden!important} [data-review-no]{outline:none!important} .cmp-ins{color:transparent!important;background-color:transparent!important}',
  ],
] as const) {
  test(`申請者 CSS で隠そうとしても番号札・空き枠・却下の札が見える(${label})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openHost(page);
    await sendDoc(page, reviewDoc(css));
    // 対照: 申請者 CSS は本当に効いている(パーツ 1 の申請者の要素は隠れている)。
    const part1 = page.locator('#vp [data-review-no="1"]');
    await expect(part1).toHaveCSS('visibility', 'hidden');
    await expect(part1).toHaveCSS('opacity', '0');
    // 空き枠の箱は display:none の CSS でも残る(場所を取る文書側の要素)。
    await expect(page.locator('#vp [data-review-ghost]')).toHaveCount(1);
    await expect(page.locator('#vp [data-review-ghost]')).not.toHaveCSS('display', 'none');
    for (const loc of [badge(page, '1'), ownBadges(page, ['ghost']), ownBadges(page, ['keep'])]) {
      await expect(loc).toHaveCount(1);
      await expect(loc).not.toHaveCSS('display', 'none');
      await expect(loc).toHaveCSS('visibility', 'visible');
      await expect(loc).toHaveCSS('opacity', '1');
      // 祖先まで含めて見える(申請者の要素の子孫ではない)。
      expect(await effectiveLook(loc)).toEqual({ opacity: 1, visibility: 'visible' });
    }
    await expect(ownBadges(page, ['ghost'])).toHaveText('（なし・新規追加）');
    await expect(page.locator('#vp .cmp-ins')).toHaveCSS('color', 'rgb(21, 128, 61)');
    await expect(page.locator('#vp .cmp-ins')).toHaveCSS(
      'background-color',
      'rgba(22, 163, 74, 0.18)',
    );
    await expect(page.locator('#vp [data-review-no="1"]')).toHaveCSS(
      'outline-color',
      'rgb(59, 130, 196)',
    );
  });
}

test('文書を送り直すと札を描き直し、前の文書の marks は持ち越さない', async ({ page }) => {
  test.setTimeout(120_000);
  await openHost(page);
  await sendDoc(page, reviewDoc());
  await post(page, {
    type: 'editor:preview-marks',
    marks: { states: { '1': 'approved' }, selected: null, visible: true },
  });
  await expect(badge(page, '1')).toHaveCSS('background-color', 'rgb(47, 138, 95)');
  await sendDoc(page, reviewDoc());
  await expect(badge(page, '1')).toHaveCount(1);
  await expect(badge(page, '1')).toHaveCSS('background-color', 'rgb(59, 130, 196)');
});

test('wrong credentials show an error and stay on login', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // フォームにインラインエラーが出る (role="alert" の toast も出るため、locator を
  // 一意に保つようアサーションを form 内へ絞る)。
  await expect(
    page.locator('form').getByText('ユーザーIDまたはパスワードが違います'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
