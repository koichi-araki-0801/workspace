// =============================================================================
// helpers.ts — e2e spec 間で重複していたログイン・canvas 初期化待ちの集約
// =============================================================================
// ログイン(8 spec に 3 変種)・GrapesJS canvas 初期化待ち・スクリーンショット用の寸法安定待ちは
// spec ごとにわずかに異なる実装で重複していた。fixtures の運用(ログインID = パスワード)は
// 全 spec で共通なので、ユーザー名だけ渡せば足りる形にまとめる。
import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  type Response,
  test,
} from '@playwright/test';
import { PREVIEW_MARK_COLORS, type PreviewMarkState } from '../shared/src/index';

/** 編集画面の変更の目印(紙面の丸数字)の class(`EditorView.vue` の `.chg-mark`)。 */
export const CHANGE_MARK_CLASS = 'chg-mark';
/** 右ペインの変更の番号の丸の class(`Inspector.vue` の `.no-pill`)。 */
export const NUMBER_PILL_CLASS = 'no-pill';

/**
 * 判定の状態の色(shared の `PREVIEW_MARK_COLORS`。紙面の札と右欄の番号)を、`getComputedStyle` が
 * 返す `rgb(r, g, b)` の形にする。e2e に RGB を直に書くと、色を変えたときに片方だけ残る。
 */
export function markColorRgb(state: PreviewMarkState): string {
  const hex = PREVIEW_MARK_COLORS[state].replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** 静かに保つことを確かめる間に、値を読み直す間隔(ms)。 */
const STAY_INTERVAL_MS = 100;

/**
 * `ms` の間、`read()` が `expected` のまま動かないこと。短い間隔で毎回 `toEqual` で比べるので、
 * 動いたらその場で落ちる(最後にまとめて比べると、動いて戻った値を見逃す)。
 */
export async function expectStays<T>(
  page: Page,
  read: () => Promise<T>,
  expected: T,
  ms: number,
  message?: string,
): Promise<void> {
  const until = Date.now() + ms;
  do {
    expect((await read()) as unknown, message).toEqual(expected);
    await page.waitForTimeout(STAY_INTERVAL_MS);
  } while (Date.now() < until);
  expect((await read()) as unknown, message).toEqual(expected);
}

/**
 * 手で作るブラウザコンテキスト(`browser.newContext`)へ、project の `use` のうちコンテキストの
 * 設定(baseURL・画面の幅・端末・言語・時間帯など)を引き継ぐ。手で作るコンテキストには config の
 * `use` が付かない。
 */
export function contextOptionsOf(use: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'baseURL',
    'viewport',
    'userAgent',
    'deviceScaleFactor',
    'isMobile',
    'hasTouch',
    'locale',
    'timezoneId',
    'colorScheme',
    'extraHTTPHeaders',
    'ignoreHTTPSErrors',
    'javaScriptEnabled',
    'permissions',
    'geolocation',
  ];
  return Object.fromEntries(keys.filter((k) => use[k] !== undefined).map((k) => [k, use[k]]));
}

/**
 * 測った値を残す。HTML レポートの annotation と、実行ログ(`console.log`。独立プロセスのログで
 * 読む)の両方へ同じ文字列を 1 回で出す。
 */
export function reportMeasure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[${type}] ${description}`);
}

/**
 * ログイン(fixtures はログインID = パスワード運用: `admin`/`admin` 等)。`clearSession` は
 * 同一テスト内で別ユーザーへ入り直す(承認タブの精査等)ときに使う — 認証済みのまま
 * `/login` へ行くと router guard がアプリへ押し戻すため、先にセッション cookie を捨てる。
 * 未認証の初回ログインでも no-op になる(cookie が無い状態で捨てても安全)ため、既定で
 * 有効にしておく。
 */
export async function login(
  page: Page,
  user = 'admin',
  { clearSession = true }: { clearSession?: boolean } = {},
): Promise<void> {
  if (clearSession) {
    // rest のセッションはサーバ発行の cookie。同じコンテキストでユーザーを切り替える
    // (admin で申請 → approver で承認)ときは cookie を捨ててからログイン画面へ行く。
    // ログイン画面は認証済みだと router guard がアプリへ押し戻すため、先に捨てる。
    await page.context().clearCookies();
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/login/);
  }
  await page.goto('/login', { waitUntil: 'commit' });
  // 全体 CI ではカバレッジ段の直後に走るため、SPA の初期化が既定の 30 秒に収まらないことがある。
  // 待つのは「入力欄が DOM に出た」ではなく「ログイン画面として操作できる」状態にする。
  await page.locator('#u').waitFor({ state: 'visible', timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'ログイン' })).toBeEnabled({ timeout: 60_000 });
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(user);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  // `nav` はロール非依存で全ロールに出るアプリヘッダの一部(`MainLayout.vue`)。着地後の
  // レンダリングを待つのに固定待ちより確実。
  await page.locator('header nav a').first().waitFor();
}

/**
 * ロード中の表示が消えるまで待つ。`animate-pulse` を持つのは `Skeleton.vue` だけ、
 * `animate-spin` を持つのは各画面のローディングスピナーだけなので、両方 0 件 = 実データの
 * 描画完了。**画面遷移直後にそのまま呼ぶと、スケルトンがまだ 1 度も描画されていない瞬間を
 * 「0 件 = 完了」と誤認しうる**(`useAsyncResult` の `loading` は参照カウント式で初期値 false、
 * スケルトン表示は `onMounted` の非同期処理が実際に走ってから)。その画面固有の実データ要素を
 * 先に待ってから呼ぶこと(呼び出し側の責務)。
 */
export async function waitForLoaded(page: Page): Promise<void> {
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.animate-spin')).toHaveCount(0, { timeout: 15_000 });
}

/**
 * canvas の根の直下のパーツ(改ページの区切り `div.pagebreak` を除く)。テンプレは `.page` で
 * 包まず、パーツを根の直下に並べて区切りでページを分ける(`web/src/lib/pageBreaks.ts`)。
 * 1 ページ表示では他ページのパーツも DOM に残り `display:none` になるので、`nth` で選ぶときは
 * 現在ページ(既定は 1 ページ目)のパーツを指す index にする。
 */
export function partLocator(frame: FrameLocator): Locator {
  return frame.locator('[data-gjs-type=wrapper] > :not(.pagebreak)');
}

/**
 * canvas の `pageIndex` ページ目(0 起点)の根の直下の要素のうち、区切りを除いたもの。ページの番号は
 * canvas が生 DOM へ付ける `data-pv-idx`(`web/src/features/editor/pageView.ts` の `PV_ATTR`)で
 * 読む。区切りにも置かれたページ(区切りはそのページの末尾にある)の番号が付くので除く。パーツに
 * 数えない要素(本文の `<style>` の置き場・赤入れの削除要素)にも隣のページの番号が付き、ここに
 * 含まれる。固めた範囲の包みの中身は根の直下ではないので含まない。
 */
export function pagePartLocator(frame: FrameLocator, pageIndex: number): Locator {
  return frame.locator(`[data-gjs-type=wrapper] > [data-pv-idx="${pageIndex}"]:not(.pagebreak)`);
}

/**
 * 編集画面を開き、GrapesJS canvas のページ描画まで待つ。`goto` の完了条件は `'commit'` にする。
 * 既定の `'load'` は全サブリソースの読み込み完了まで待つため、SPA が起動時に出す認証確認や
 * router のリダイレクトが割り込むと `net::ERR_ABORTED` で goto 自体が失敗する(負荷の高い CI で
 * 実際に踏んだ)。本当に待ちたいのは「canvas にページが描かれたか」で、それは下の `waitFor` が
 * 直接見ている。待つのは根の直下で見えている最初の要素(パーツか区切りの帯)。1 ページ目が
 * 白紙のページ(先頭の区切り)なら、見えるのは帯だけになる。
 */
export async function openEditor(page: Page, id: string, query = ''): Promise<FrameLocator> {
  await page.goto(`/edit/${encodeURIComponent(id)}${query}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame
    .locator('[data-gjs-type=wrapper] > :visible')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  return frame;
}

/**
 * 要素の寸法が落ち着くまで待ち、その boundingBox を返す。可視化を待つだけでは足りない:
 * canvas のフォントが載る前は行の高さが確定せず、その寸法で `clip` を取ると内容が途中で
 * 切れた画像になる(CI の並列実行下で実際に起きた。単独実行では再現しない)。連続 2 回
 * 同じ寸法になったところを確定と見なす。ポーリングは `expect.poll` の retry 機構に委ね、
 * 固定間隔の手書きループは持たない。`page` は他の待ち系関数(`openEditor` 等)と引数順を
 * 揃えるためだけに残し、本体では使わない。
 */
export async function waitForStableBox(
  _page: Page,
  locator: Locator,
  timeout = 20_000,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  let previousKey = '';
  let lastBox: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(
      async () => {
        lastBox = await locator.boundingBox();
        const key = lastBox ? `${Math.round(lastBox.width)}x${Math.round(lastBox.height)}` : '';
        const stable = key !== '' && key === previousKey;
        previousKey = key;
        return stable;
      },
      { timeout, intervals: [300] },
    )
    .toBe(true);
  return lastBox;
}

/**
 * canvas 内でパーツが選択状態になったことを待つ。`.gjs-selected` は GrapesJS が選択中の
 * component の DOM 要素へ自動で付与する既定クラス(アプリ側の改修不要)で、固定待ちより
 * 選択の完了を確実に検知できる。
 */
export async function expectSelectedPart(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('.gjs-selected')).toBeVisible({ timeout: 10_000 });
}

/**
 * canvas でパーツをクリックし、選択状態になるまで再試行する。1 ページ表示の可視化(スタイル注入)と
 * GrapesJS の選択配線が非同期のため、canvas を開いた直後の最初のクリックは選択されずに
 * 終わることがある(`.gjs-selected` が付かない)。`expectSelectedPart` の単純な待ちでは
 * クリック自体をやり直せないため、選択が付くまでクリックごと再試行する。
 */
export async function selectPart(frame: FrameLocator, part: Locator): Promise<void> {
  await expect(async () => {
    await part.click();
    await expect(frame.locator('.gjs-selected')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * プレビュー画面から確定保存を申請する(`review_tab.spec.ts` と `capture_docs.spec.ts` の
 * 重複実装を集約)。トースト「確定保存を申請しました」の出現を申請完了の合図にする。
 */
export async function submitOnce(page: Page, id: string): Promise<void> {
  await page.goto(`/preview/${encodeURIComponent(id)}`);
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  // 申請は差分要約の計算と隔離描画を挟み、CI の先頭(Vite dev サーバがコールドで依存最適化と
  // worker チャンクの初回変換が重なる)では 30 秒を超える。トーストは完了後に出るため、待ちが
  // 短いと申請そのものと競争になる。トースト待ちは単独で 90 秒あり、直前のプレビュー待ち(60 秒)
  // と合算すると呼び出し元の test timeout(120 秒)を超えうるが、その場合はテスト timeout として
  // 失敗する(ハングはしない)。
  await expect(page.getByRole('status').filter({ hasText: '確定保存を申請しました' })).toBeVisible({
    timeout: 90_000,
  });
}

/**
 * 承認タブ(`?template=` なしの全申請一覧)を開き、先頭の申請行から `id` のテンプレート詳細へ
 * 進む。タブは押すたびに一覧を指す(`MainLayout.vue` の `tabTarget`)ので、編集画面から
 * 押しても詳細には直行しない。一覧の既定の絞り込みは承認待ちで、行は新しい順に並ぶ。
 * 詳細へ移ったことは URL の `?template=` で確かめる。
 */
export async function openReviewDetail(page: Page, id: string): Promise<void> {
  await page.getByRole('link', { name: '承認' }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await page.locator('[data-review-item] [data-review-toggle]').first().click();
  await expect(page).toHaveURL(new RegExp(`[?&]template=${encodeURIComponent(id)}`));
}

/**
 * 承認タブの状態の絞り込みチップ(見出しの行。`ReviewTabView.vue` の `data-review-chip`)の件数。
 * チップの文言は「承認待ち <b>N</b>」で、件数は `b` に入る。
 */
export function chipCount(page: Page, status: 'pending' | 'approved' | 'rejected'): Locator {
  return page.locator(`[data-review-chip="${status}"] b`);
}

/**
 * パーツの判定の保存(`POST /api/review-requests/:reqId/part-decisions`)の応答を待つ約束。
 * 押す操作の前に作り、押したあとで待つ(押してから作ると速い応答を取り逃す)。
 */
export function partDecisionsSaved(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/review-requests\/[^/]+\/part-decisions$/.test(r.url()),
    { timeout: 30_000 },
  );
}

/**
 * 承認タブの申請カード `item` の右欄「変更と判定」で、未判定のパーツをまとめて承認する。
 * 帯の「未判定をすべて選ぶ」で選び、「まとめて承認」を押して保存の応答を待つ。
 */
export async function approvePendingParts(page: Page, item: Locator): Promise<void> {
  await item.locator('[data-review-pick-all]').check();
  const saved = partDecisionsSaved(page);
  await item.locator('[data-review-band]').getByRole('button', { name: 'まとめて承認' }).click();
  await saved;
  await expect(item.locator('[data-review-no][data-decision="pending"]')).toHaveCount(0);
}

/**
 * 承認タブの申請カード `item` で申請を最終確定する。判定バーの「最終確定する」は未判定の
 * パーツが残る間は押せない(`ReviewDecisionBar.vue`)ので、押せることを先に確かめる。確認の
 * ダイアログの確定ボタンも同じ名前なので、ダイアログに絞って押す。
 */
export async function finalizeReview(page: Page, item: Locator): Promise<void> {
  const finalize = item.locator('[data-decision-bar] [data-finalize]');
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await page.getByRole('alertdialog').getByRole('button', { name: '最終確定する' }).click();
}

/**
 * 承認タブの申請カード `item` の左右の紙面(変更前・変更後)。作成経路の 1 面のカードでは
 * `before` を使わない。
 */
export function comparePapers(item: Locator): { before: FrameLocator; after: FrameLocator } {
  return {
    before: item.locator('[data-side="before"]').frameLocator('iframe[title="プレビュー"]'),
    after: item.locator('[data-side="after"]').frameLocator('iframe[title="プレビュー"]'),
  };
}

/** 承認タブの申請カード `item` の左右の紙面が、組版を終えてページを描くまで待つ。 */
export async function waitForComparePapers(item: Locator): Promise<void> {
  const { before, after } = comparePapers(item);
  for (const f of [before, after]) {
    await f
      .locator('[data-vivliostyle-page-container]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
  }
}

/** 承認タブの申請カード `item` の右欄の、番号 `no` の行(`ReviewDecisionRow.vue`)。 */
export function decisionRow(item: Locator, no: number): Locator {
  return item.locator(`[data-review-row-no="${no}"]`);
}

/** 右ペインのコメント一覧の新規投稿の入力欄(`CommentPanel.vue` の `data-add-content`)。 */
export function commentInput(page: Page): Locator {
  return page.locator('textarea[data-add-content]');
}

/**
 * 編集タブの申請を画面を通さず API で出す(本文を細かく作るため)。CSS は dataRoot の確定版の
 * CSS をそのまま付ける。申請者は呼び出し時点のログインユーザー。
 */
export async function submitEditReviewViaApi(
  page: Page,
  input: { templateId: string; html: string; css: string },
): Promise<void> {
  const res = await page.request.post('/api/review-requests', {
    data: { ...input, origin: 'edit' },
  });
  expect(res.ok(), `POST review-requests ${res.status()}`).toBeTruthy();
}

/**
 * 自動保存された下書きをサーバから読む(無ければ null)。下書きの実体は
 * `dataRoot/drafts/` にあり、localStorage には無い。
 */
export async function readDraft(
  page: Page,
  id: string,
): Promise<{ html: string; css: string } | null> {
  // `GET /api/templates/:id/draft` は下書きが無いと JSON の `null` を 200 で返す
  // (`templates.routes.ts` は `getDraft` の戻りをそのまま返す)。
  const res = await page.request.get(`/api/templates/${encodeURIComponent(id)}/draft`);
  expect(res.ok(), `GET draft ${res.status()}`).toBeTruthy();
  return (await res.json()) as { html: string; css: string } | null;
}
