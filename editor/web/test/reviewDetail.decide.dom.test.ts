// =============================================================================
// reviewDetail.decide.dom.test.ts — 申請カード(紙面・右欄・判定バー・申請ごと却下)の組み立て
// =============================================================================
// 差分の取得(`reviewDiffService`)と REST(`useReviewRepo`)だけを差し替え、`useReviewDiff`・
// `useReviewDecisions`・右欄・判定バー・紙面は本物を組む。紙面の `PreviewPanel` はスタブにし、
// 送った命令と押下の通知だけを見る。選択は紙面・行・次の未判定のどれから来ても 1 つの番号に集まり、
// 紙面と右欄の両方へ届くこと、最終確定・申請ごと却下の失敗を `code` で分けることを固定する。
import {
  type ApproveReviewResult,
  appError,
  err,
  numberChangedParts,
  ok,
  REVIEW_ALREADY_DECIDED,
  type ReviewPartDecision,
  type ReviewRequest,
  type ReviewRequestMeta,
} from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { confirm } from '@/components/ui/confirm';
import { toast, toastError } from '@/components/ui/toast';
import { buildHtmlDiff } from '@/features/compare/htmlBlockDiff';
import ReviewDetail from '@/features/reviews/ReviewDetail.vue';
import type { ReviewChangeRow } from '@/features/reviews/services/reviewDiffService';

// ── 1. 差し替え ──

const { repo, buildDiff, renderPdf, auth, panels } = vi.hoisted(() => ({
  repo: {
    approveReview: vi.fn(),
    rejectReview: vi.fn(),
    updatePartDecisions: vi.fn(),
  },
  buildDiff: vi.fn(),
  renderPdf: vi.fn(),
  auth: { isApprover: true, user: { username: 'boss' } },
  panels: [] as {
    props: { html: string };
    emit: (event: string, ...args: unknown[]) => void;
    api: Record<
      'prevPage' | 'nextPage' | 'goToPage' | 'gotoAnchor' | 'gotoPart',
      ReturnType<typeof vi.fn>
    >;
  }[],
}));

vi.mock('@/components/ui/toast', () => ({
  toast: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/components/ui/confirm', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/lib/appError', () => ({ logError: vi.fn() }));
// 同期結果の文言は `pairSyncText.ts` のテストが固定する。ここでは通知されることだけを見る。
vi.mock('@/lib/pairSyncText', () => ({
  pairSyncResultText: (sync: unknown) => (sync ? { text: '同期の結果', variant: 'error' } : null),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/api/repositories', () => ({ useReviewRepo: () => repo, usePartRepo: () => ({}) }));
vi.mock('@/features/reviews/services/reviewDiffService', () => ({
  useReviewDiffService: () => ({ buildDiff }),
}));
vi.mock('@/features/preview/services/templatePreviewService', () => ({
  useTemplatePreviewService: () => ({ renderPdf }),
}));
vi.mock('@/features/preview/PreviewPanel.vue', () => ({
  default: defineComponent({
    name: 'PreviewPanel',
    props: { html: String, marks: Object, companyCode: String },
    emits: ['state', 'part-click', 'part-pages'],
    setup(props, { emit, expose }) {
      const api = {
        prevPage: vi.fn(),
        nextPage: vi.fn(),
        goToPage: vi.fn(),
        gotoAnchor: vi.fn(),
        gotoPart: vi.fn(),
      };
      panels.push({ props: props as { html: string }, emit, api });
      expose(api);
      return () => h('div', { 'data-stub-panel': '' });
    },
  }),
}));

// jsdom は IntersectionObserver を持たない(右欄の番兵が使う)。
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', NoopObserver);
// jsdom の要素は scrollIntoView を持たない(右欄の `revealNo` が使う)。
Element.prototype.scrollIntoView = vi.fn();

// ── 2. 申請と差分 ──

const pb = '<div class="pagebreak"></div>';
const BEFORE = `<p class="a">古い文</p>${pb}<p class="b">B</p>`;
const AFTER = `<p class="a">新しい文</p>${pb}<p class="b">B</p><p class="c">追加</p>`;
const ALREADY = 'この申請はすでに処理されています。画面を読み直しました。';

const pendingReview: ReviewRequest = {
  id: 'r1',
  templateId: 'XX01_950037_20240710_交付版',
  attributes: {
    companyCode: 'XX01',
    fundCode: '950037',
    baseDate: '20240710',
    editionType: '交付版',
  },
  origin: 'edit',
  status: 'pending',
  submittedBy: 'editor1',
  submittedAt: '2026-10-01T00:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  comment: null,
  baseHash: null,
  baseHtml: BEFORE,
  baseCss: '',
  html: AFTER,
  css: '',
  filledHtml: '',
};

function decision(partKey: string, status: ReviewPartDecision['status']): ReviewPartDecision {
  return {
    partKey,
    status,
    comment: status === 'rejected' ? '理由' : null,
    decidedBy: 'boss',
    decidedAt: '2026-10-02T00:00:00.000Z',
    history: [],
  } as ReviewPartDecision;
}

function data(
  opts: {
    review?: Partial<ReviewRequest>;
    truncated?: boolean;
    pair?: [before: string, after: string];
  } = {},
) {
  const diff = buildHtmlDiff(...(opts.pair ?? [BEFORE, AFTER]));
  const changes: ReviewChangeRow[] = numberChangedParts(diff).map((c) => ({
    ...c,
    name: `名前${c.no}`,
    textOps: [],
  }));
  return {
    review: { ...pendingReview, ...opts.review },
    changes,
    diff,
    summary: { total: changes.length, changed: 1, added: 1, removed: 0 },
    cssBefore: '',
    cssAfter: '.a{}',
    afterBodyHtml: '<p>{{ 描画済みの本文 }}</p>',
    truncated: opts.truncated ?? false,
    cssChanged: false,
    printOnlyCss: false,
  };
}

/** 読み込みのたびに返す差分。`reloads` を足すと 2 回目以降はそれを返す。 */
function serve(first: ReturnType<typeof data>, ...reloads: ReturnType<typeof data>[]) {
  let n = 0;
  buildDiff.mockImplementation(async () => {
    const d = n === 0 ? first : (reloads[Math.min(n - 1, reloads.length - 1)] ?? first);
    n += 1;
    return ok(structuredClone(d));
  });
}

const allApproved = () =>
  data({
    review: {
      partDecisions: numberChangedParts(buildHtmlDiff(BEFORE, AFTER)).map((c) =>
        decision(c.partKey, 'approved'),
      ),
    },
  });

async function mountDetail(opts: { attach?: boolean; slots?: Record<string, unknown> } = {}) {
  const w = mount(ReviewDetail, {
    props: { reqId: 'r1' },
    attachTo: opts.attach ? document.body : undefined,
    slots: opts.slots as never,
  });
  await flushPromises();
  return w;
}

type Detail = Awaited<ReturnType<typeof mountDetail>>;

const row = (w: Detail, no: number) => w.find(`[data-review-row-no="${no}"]`);
const buttonIn = (el: ReturnType<Detail['find']>, text: string) =>
  el.findAll('button').find((b) => b.text() === text);

/** 紙面の組版が終わった通知を両面へ送る(移動はそれまで待たれる)。 */
async function readyPanels() {
  for (const p of panels) {
    p.emit('state', {
      currentPage: 1,
      pageCount: 2,
      atFirst: true,
      atLast: false,
      zoom: 1,
      vivlioReady: true,
      ready: true,
    });
  }
  await flushPromises();
}

beforeEach(() => {
  panels.length = 0;
  auth.isApprover = true;
  vi.mocked(toast).mockClear();
  vi.mocked(toastError).mockClear();
  vi.mocked(confirm).mockClear();
  buildDiff.mockReset();
  renderPdf.mockReset();
  repo.updatePartDecisions.mockReset();
  repo.approveReview.mockReset();
  repo.rejectReview.mockReset();
  repo.updatePartDecisions.mockImplementation(
    async (_id: string, input: { decisions: { partKey: string; status: string }[] }) =>
      ok(input.decisions.map((d) => decision(d.partKey, d.status as ReviewPartDecision['status']))),
  );
  repo.approveReview.mockResolvedValue(
    ok({ meta: {} as ApproveReviewResult['meta'], staleWarning: false }),
  );
  repo.rejectReview.mockImplementation(
    async (_id: string, body: { comment?: string }): Promise<unknown> =>
      ok({
        ...pendingReview,
        status: 'rejected',
        reviewedBy: 'boss',
        reviewedAt: '2026-10-02T00:00:00.000Z',
        comment: body.comment ?? null,
      }),
  );
});

afterEach(() => {
  document.body.innerHTML = '';
});

// ── 3. 判定と選択 ──

describe('ReviewDetail の判定と選択', () => {
  it('行の承認で updatePartDecisions を 1 回呼び、getReview を呼び直さない', async () => {
    serve(data());
    const w = await mountDetail();
    await buttonIn(row(w, 1), '承認')?.trigger('click');
    await flushPromises();
    expect(repo.updatePartDecisions).toHaveBeenCalledTimes(1);
    const [, input] = repo.updatePartDecisions.mock.calls[0] as [string, { decisions: unknown[] }];
    expect(input.decisions).toEqual([{ partKey: expect.any(String), status: 'approved' }]);
    // 差分の取得(= getReview)はマウント時の 1 回だけ。
    expect(buildDiff).toHaveBeenCalledTimes(1);
    expect(row(w, 1).find('[data-review-no]').attributes('data-decision')).toBe('approved');
  });

  it('パーツ判定の保存が REVIEW_ALREADY_DECIDED なら、読み直した決着を親へ伝える(一覧をすぐ直す)', async () => {
    const decidedElsewhere = data({
      review: { status: 'approved', reviewedBy: 'other', reviewedAt: '2026-10-03T00:00:00.000Z' },
    });
    serve(data(), decidedElsewhere);
    repo.updatePartDecisions.mockResolvedValue(
      err(appError('conflict', 'この申請は既に承認済みです', { code: REVIEW_ALREADY_DECIDED })),
    );
    const w = await mountDetail();
    await buttonIn(row(w, 1), '承認')?.trigger('click');
    await flushPromises();
    expect(buildDiff).toHaveBeenCalledTimes(2);
    const decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided).toMatchObject({ status: 'approved', reviewedBy: 'other' });
    expect(decided).not.toHaveProperty('html');
  });

  it('パーツ判定の保存の失敗で読み直しても、承認待ちのままなら決着を伝えない', async () => {
    serve(data());
    repo.updatePartDecisions.mockResolvedValue(err(appError('unexpected', 'x')));
    const w = await mountDetail();
    await buttonIn(row(w, 1), '承認')?.trigger('click');
    await flushPromises();
    expect(buildDiff).toHaveBeenCalledTimes(2);
    expect(w.emitted('decided')).toBeUndefined();
  });

  it('次の未判定で右欄の行と紙面のパーツへ移る', async () => {
    serve(data());
    const w = await mountDetail();
    await readyPanels();
    await w.find('[data-next-pending]').trigger('click');
    await flushPromises();
    expect(row(w, 1).attributes('data-selected')).toBe('true');
    for (const p of panels) expect(p.api.gotoPart).toHaveBeenLastCalledWith('1');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    const [key, no] = w.emitted('select')?.at(-1) ?? [];
    expect(no).toBe(1);
    // 編集経路の宛先は確定版側のキー。
    expect(key).toBe(data().changes[0].beforePartKey);
  });

  it('紙面の part-click で右欄の行が選ばれる', async () => {
    serve(data());
    const w = await mountDetail();
    await readyPanels();
    panels[1].emit('part-click', '2');
    await flushPromises();
    expect(row(w, 2).attributes('data-selected')).toBe('true');
    expect(row(w, 1).attributes('data-selected')).toBe('false');
    // 追加パーツは確定版に無いので、宛先のキーは null。
    expect(w.emitted('select')?.at(-1)).toEqual([null, 2]);
  });

  it('右欄の行を押すと紙面のそのパーツへ移る', async () => {
    serve(data());
    const w = await mountDetail();
    await readyPanels();
    await row(w, 2).find('[data-review-name]').trigger('click');
    await flushPromises();
    for (const p of panels) expect(p.api.gotoPart).toHaveBeenLastCalledWith('2');
  });

  it('選択中のパーツをもう一度押すと選択が外れ、select と slot の selectedKey が null に戻る', async () => {
    serve(data());
    const seen: { selectedNo: number | null; selectedKey: string | null }[] = [];
    const w = await mountDetail({
      slots: {
        comments: (props: { selectedNo: number | null; selectedKey: string | null }) => {
          seen.push(props);
          return h('div');
        },
      },
    });
    await readyPanels();
    panels[1].emit('part-click', '1');
    await flushPromises();
    expect(seen.at(-1)).toMatchObject({
      selectedNo: 1,
      selectedKey: data().changes[0].beforePartKey,
    });

    // 紙面で同じパーツをもう一度押す。
    panels[1].emit('part-click', '1');
    await flushPromises();
    expect(row(w, 1).attributes('data-selected')).toBe('false');
    expect(w.emitted('select')?.at(-1)).toEqual([null, null]);
    expect(seen.at(-1)).toMatchObject({ selectedNo: null, selectedKey: null });

    // 右欄の行でも同じ(選んで、もう一度押すと外れる)。
    await row(w, 1).find('[data-review-name]').trigger('click');
    await row(w, 1).find('[data-review-name]').trigger('click');
    await flushPromises();
    expect(w.emitted('select')?.at(-1)).toEqual([null, null]);

    // 次の未判定は外さない(未判定が同じ番号でも選び直す)。
    await w.find('[data-next-pending]').trigger('click');
    await w.find('[data-next-pending]').trigger('click');
    await flushPromises();
    expect(w.emitted('select')?.at(-1)?.[1]).not.toBeNull();
  });

  it('selectPart は宛先のキーからそのパーツを選ぶ', async () => {
    serve(data());
    const w = await mountDetail();
    const key = data().changes[0].beforePartKey as string;
    (w.vm as unknown as { selectPart(k: string): void }).selectPart(key);
    await flushPromises();
    expect(row(w, 1).attributes('data-selected')).toBe('true');
    (w.vm as unknown as { selectPart(k: string): void }).selectPart('知らないキー');
    await flushPromises();
    expect(row(w, 1).attributes('data-selected')).toBe('true');
  });

  it('保存中は右欄・判定バーのボタンを押せない', async () => {
    serve(allApproved());
    let resolve: (v: unknown) => void = () => {};
    repo.updatePartDecisions.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const w = await mountDetail();
    expect(w.find('[data-finalize]').attributes('disabled')).toBeUndefined();
    await buttonIn(row(w, 1), '判定を取り消す')?.trigger('click');
    await flushPromises();
    expect(w.find('[data-finalize]').attributes('disabled')).toBeDefined();
    expect(buttonIn(row(w, 2), '判定を取り消す')?.attributes('disabled')).toBeDefined();
    resolve(ok([decision(data().changes[0].partKey, 'pending')]));
    await flushPromises();
    expect(buttonIn(row(w, 2), '判定を取り消す')?.attributes('disabled')).toBeUndefined();
  });
});

// ── 4. カードの組み立て ──

describe('ReviewDetail の申請カード', () => {
  it('道具の行(ページ送り・紙面のチェック)は作業域の上のカード全幅の行に出る', async () => {
    serve(data());
    const w = await mountDetail({ attach: true });
    await flushPromises();
    // 外枠は承認タブの区画が持つので、カードには枠を描かない(枠の二重を避ける)。
    expect(w.find('[data-review-card]').classes()).not.toContain('border');
    const tools = w.find('[data-review-tools]');
    expect(tools.find('[data-page-prev]').exists()).toBe(true);
    expect(tools.find('[data-highlight-toggle]').exists()).toBe(true);
    // 作業域(左右の欄)の中には無い。
    expect(w.find('[data-review-work] [data-page-prev]').exists()).toBe(false);
    w.unmount();
  });

  it('道具の行は紙面が出たその描画の内に全幅の行へ移る(紙面の上に一度描かれて見えることは無い)', async () => {
    let resolve!: (v: unknown) => void;
    buildDiff.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const w = mount(ReviewDetail, { props: { reqId: 'r1' }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-review-card]').exists()).toBe(false);
    resolve(ok(structuredClone(data())));
    // マイクロタスクだけを進める(タスクの切れ目 = ブラウザが描く機会を挟まない)。
    for (let i = 0; i < 10 && !w.find('[data-review-card]').exists(); i++) await nextTick();
    expect(w.find('[data-review-card]').exists()).toBe(true);
    // カードが出たのと同じ flush で、もう移っている。
    expect(w.find('[data-review-tools] [data-page-prev]').exists()).toBe(true);
    expect(w.find('[data-review-work] [data-page-prev]').exists()).toBe(false);
    w.unmount();
  });

  it('右欄のタブは「変更と判定｜コメント」で、コメントは slot に番号と名前を渡す', async () => {
    serve(data());
    const seen: Record<string, unknown>[] = [];
    const w = await mountDetail({
      slots: {
        comments: (props: Record<string, unknown>) => {
          seen.push(props);
          return h('div', { 'data-comments-slot': '' });
        },
      },
    });
    const tabs = w.find('[role="tablist"]').findAll('[role="tab"]');
    expect(tabs.map((t) => t.text())).toEqual(['変更と判定', 'コメント']);
    expect(tabs[0].attributes('aria-selected')).toBe('true');
    // タブは自分の中身を aria-controls で指し、中身はタブを aria-labelledby で指す。
    for (const t of tabs) {
      const panel = w.find(`#${t.attributes('aria-controls')}`);
      expect(panel.attributes('role')).toBe('tabpanel');
      expect(panel.attributes('aria-labelledby')).toBe(t.attributes('id'));
    }
    await tabs[1].trigger('click');
    expect(tabs[1].attributes('aria-selected')).toBe('true');
    expect(w.find('[data-comments-slot]').isVisible()).toBe(true);
    const c = data().changes;
    const last = seen.at(-1) as {
      selectedNo: number | null;
      selectedKey: string | null;
      partNumbers: Map<string, number>;
      partNames: Map<string, string>;
    };
    expect(last.selectedNo).toBeNull();
    // 確定版に無い追加パーツは宛先にならない。
    expect([...last.partNumbers]).toEqual([[c[0].beforePartKey, 1]]);
    expect([...last.partNames]).toEqual([[c[0].beforePartKey, '名前1']]);
  });

  it('作成経路は紙面 1 面で「申請内容」', async () => {
    serve(data({ review: { origin: 'create' } }));
    const w = await mountDetail();
    expect(panels).toHaveLength(1);
    expect(w.find('figcaption').text()).toBe('申請内容');
    // 作成経路の宛先は申請版のキー。追加パーツは確定版に無いので宛先にならない。
    await readyPanels();
    panels[0].emit('part-click', '1');
    await flushPromises();
    expect(w.emitted('select')?.at(-1)).toEqual([data().changes[0].partKey, 1]);
    panels[0].emit('part-click', '2');
    await flushPromises();
    expect(w.emitted('select')?.at(-1)).toEqual([null, 2]);
  });

  it('作成経路でも、確定版の別パーツとキーが重なる追加パーツは宛先にしない', async () => {
    // 既存パーツの前に同じタグのパーツを足すと、追加パーツの申請版のキーが確定版の既存パーツの
    // キーと同じになる(ここでは `p#2`。既存の「既存の文」は確定版で `p#2`)。
    const pair: [string, string] = [
      `<p>A</p>${pb}<p>既存の文</p>`,
      `<p>A</p><p>追加した文</p>${pb}<p>既存の文</p>`,
    ];
    const d = data({ review: { origin: 'create' }, pair });
    const added = d.changes.find((c) => c.kind === 'added');
    expect(added?.partKey).toBe('p#2');
    serve(d);
    const seen: { partNumbers: Map<string, number> }[] = [];
    const w = await mountDetail({
      slots: {
        comments: (props: { partNumbers: Map<string, number> }) => {
          seen.push(props);
          return h('div');
        },
      },
    });
    await readyPanels();
    panels[0].emit('part-click', String(added?.no));
    await flushPromises();
    expect(w.emitted('select')?.at(-1)).toEqual([null, added?.no]);
    expect(seen.at(-1)?.partNumbers.has('p#2')).toBe(false);
  });

  it('決着済みは判定バーを出さず、行は読み取り専用', async () => {
    serve(
      data({
        review: {
          status: 'approved',
          reviewedBy: 'boss',
          reviewedAt: '2026-10-02T00:00:00.000Z',
        },
      }),
    );
    const w = await mountDetail();
    expect(w.find('[data-decision-bar]').exists()).toBe(false);
    expect(w.text()).toContain('この申請は');
    expect(w.text()).toContain('承認済み');
    expect(buttonIn(row(w, 1), '承認')).toBeUndefined();
    expect(w.find('[data-review-band]').exists()).toBe(false);
  });

  it('承認者でなければ判定バーを出さず、権限が要ると出す', async () => {
    auth.isApprover = false;
    serve(data());
    const w = await mountDetail();
    expect(w.find('[data-decision-bar]').exists()).toBe(false);
    expect(w.text()).toContain('承認操作には精査者(承認者)権限が必要です。');
  });
});

// ── 5. 最終確定 ──

describe('ReviewDetail の最終確定', () => {
  it('最終確定は確認のあと approveReview を comment 無しで呼ぶ', async () => {
    serve(allApproved());
    const w = await mountDetail();
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: '最終確定する',
        description: expect.stringContaining('承認済みパーツ: 2件'),
      }),
    );
    expect(vi.mocked(confirm).mock.calls[0][0].description).toContain('書式設定の変更: なし');
    expect(repo.approveReview).toHaveBeenCalledWith('r1', { comment: undefined });
  });

  it('確認で取りやめれば送らない', async () => {
    serve(allApproved());
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const w = await mountDetail();
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(repo.approveReview).not.toHaveBeenCalled();
  });

  /** ほかの人が先に決着させた申請(読み直しで届く形)。 */
  const decidedBy = (status: 'approved' | 'rejected') =>
    data({
      review: {
        status,
        reviewedBy: 'other',
        reviewedAt: '2026-10-03T00:00:00.000Z',
        comment: status === 'rejected' ? '先に却下' : null,
      },
    });
  const decidedErr = () =>
    err(appError('conflict', 'この申請は既に承認済みです', { code: REVIEW_ALREADY_DECIDED }));

  it('最終確定・申請ごと却下が REVIEW_ALREADY_DECIDED で失敗したら読み直して「この申請はすでに処理されています。」を出す', async () => {
    // 最終確定: 読み直した決着(ほかの人の承認)を親へ伝え、トーストは 1 つだけ。
    repo.approveReview.mockResolvedValue(decidedErr());
    serve(allApproved(), decidedBy('approved'));
    const w = await mountDetail();
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(buildDiff).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toast).mock.calls).toEqual([[ALREADY, 'error']]);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
    let decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided).toMatchObject({ id: 'r1', status: 'approved', reviewedBy: 'other' });
    expect(decided).not.toHaveProperty('html');
    expect(w.find('[data-decision-bar]').exists()).toBe(false);

    // 申請ごと却下: 同じく読み直した決着(ほかの人の却下)を伝える。
    vi.mocked(toast).mockClear();
    repo.rejectReview.mockResolvedValue(decidedErr());
    serve(data(), decidedBy('rejected'));
    const w2 = await mountDetail();
    (w2.vm as unknown as { openRequestReject(): void }).openRequestReject();
    await flushPromises();
    await w2.find('[data-request-reject] textarea').setValue('直してください');
    await buttonIn(w2.find('[data-request-reject]'), '申請を却下する')?.trigger('click');
    await flushPromises();
    expect(vi.mocked(toast).mock.calls).toEqual([[ALREADY, 'error']]);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
    decided = w2.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided).toMatchObject({ status: 'rejected', reviewedBy: 'other', comment: '先に却下' });
  });

  it('REVIEW_ALREADY_DECIDED のあとの読み直しに失敗したら「読み直しました」と言わず、決着も伝えない', async () => {
    repo.approveReview.mockResolvedValue(decidedErr());
    serve(allApproved());
    const w = await mountDetail();
    buildDiff.mockResolvedValue(err(appError('unexpected', '読めません')));
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(vi.mocked(toast)).toHaveBeenCalledWith('この申請はすでに処理されています。', 'error');
    expect(w.emitted('decided')).toBeUndefined();
  });

  it('読み直しの最中は最終確定を押せない', async () => {
    repo.approveReview.mockResolvedValue(decidedErr());
    serve(allApproved());
    const w = await mountDetail();
    let finish: (v: unknown) => void = () => {};
    buildDiff.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(w.find('[data-finalize]').attributes('disabled')).toBeDefined();
    finish(ok(structuredClone(allApproved())));
    await flushPromises();
    expect(w.find('[data-finalize]').attributes('disabled')).toBeUndefined();
  });

  it('押せない状態で判定バーから finalize が届いても approveReview を呼ばない', async () => {
    serve(data());
    const w = await mountDetail();
    w.findComponent({ name: 'ReviewDecisionBar' }).vm.$emit('finalize');
    await flushPromises();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(repo.approveReview).not.toHaveBeenCalled();
  });

  it('最終確定のほかの失敗は今の文言のまま', async () => {
    repo.approveReview.mockResolvedValue(
      err(appError('internal', '承認の反映に失敗しました。時間をおいて再度お試しください。')),
    );
    serve(allApproved());
    const w = await mountDetail();
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    // 今の表示(`useAsyncResult` がサーバの文言をそのまま出す)を変えない。
    expect(vi.mocked(toastError)).toHaveBeenCalledWith(
      '承認の反映に失敗しました。時間をおいて再度お試しください。',
    );
    expect(vi.mocked(toast)).not.toHaveBeenCalledWith(ALREADY, 'error');
    expect(buildDiff).toHaveBeenCalledTimes(1);
  });

  it('承認後の読み直しに失敗しても、承認済みとして親へ伝える', async () => {
    serve(allApproved());
    const w = await mountDetail();
    buildDiff.mockResolvedValue(err(appError('internal', '読めません')));
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    const decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided?.id).toBe('r1');
    expect(decided?.status).toBe('approved');
    expect(decided?.comment).toBeNull();
  });

  it('現在の差分と一致しない保存済み判定があれば押せず、理由を判定バーにだけ出す', async () => {
    const d = allApproved();
    d.review.partDecisions = [
      ...(d.review.partDecisions ?? []),
      decision('消えたパーツ', 'approved'),
    ];
    serve(d);
    const w = await mountDetail();
    expect(w.find('[data-finalize]').attributes('disabled')).toBeDefined();
    const issues = w.findAll('[data-finalization-issue]');
    expect(issues).toHaveLength(1);
    expect(issues[0].text()).toContain('現在の差分対象と一致しない保存済み判定が 1 件');
    expect(w.find('[data-decision-bar] [data-finalization-issue]').exists()).toBe(true);
  });

  const blockedWith = async (d: ReturnType<typeof data>, message: string) => {
    serve(d);
    const w = await mountDetail();
    expect(w.find('[data-finalize]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-decision-bar]').text()).toContain(message);
  };

  it('差分が打ち切られていれば最終確定できず、理由を出す', async () => {
    const d = allApproved();
    d.truncated = true;
    await blockedWith(d, '差分の上限を超えて');
  });

  it('同じパーツの判定が複数あれば最終確定できず、該当キーを出す', async () => {
    const d = allApproved();
    const first = d.review.partDecisions?.[0] as ReviewPartDecision;
    d.review.partDecisions = [...(d.review.partDecisions ?? []), first];
    await blockedWith(d, `同じパーツの判定が複数あるため最終確定できません: ${first.partKey}`);
  });

  it('比較元の無い古い edit 申請に判定があれば最終確定できず、申請し直しを求める', async () => {
    const d = allApproved();
    d.review.baseHtml = undefined;
    d.review.baseCss = undefined;
    await blockedWith(d, '申請し直してください');
  });
});

// ── 6. 申請ごと却下 ──

describe('ReviewDetail の申請ごと却下', () => {
  it('申請ごと却下は理由が要り、rejectReview を理由付きで呼ぶ', async () => {
    serve(data());
    const w = await mountDetail({ attach: true });
    expect(w.find('[data-request-reject]').exists()).toBe(false);
    (w.vm as unknown as { openRequestReject(): void }).openRequestReject();
    await flushPromises();
    const area = w.find('[data-request-reject]');
    expect(area.text()).toContain('申請ごと却下する理由（必須）');
    expect(area.text()).toContain('何も確定せずに申請全体を申請者へ戻します');
    expect(area.find('textarea').attributes('placeholder')).toBe('直してほしい点を書きます');
    // 開いたら理由欄へ移る。
    expect(document.activeElement).toBe(area.find('textarea').element);

    await buttonIn(area, '申請を却下する')?.trigger('click');
    expect(w.find('[data-request-reject]').text()).toContain('理由を入力してください。');
    expect(repo.rejectReview).not.toHaveBeenCalled();

    await w.find('[data-request-reject] textarea').setValue('  直してください  ');
    expect(w.find('[data-request-reject]').text()).not.toContain('理由を入力してください。');
    await buttonIn(w.find('[data-request-reject]'), '申請を却下する')?.trigger('click');
    await flushPromises();
    expect(repo.rejectReview).toHaveBeenCalledWith('r1', { comment: '直してください' });
    const decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided?.status).toBe('rejected');
    expect(decided?.comment).toBe('直してください');
    expect(decided).not.toHaveProperty('html');
    w.unmount();
  });

  it('申請ごと却下の送信中は「申請を却下する」「取消」を押せない', async () => {
    serve(data());
    repo.rejectReview.mockImplementation(() => new Promise(() => {}));
    const w = await mountDetail();
    (w.vm as unknown as { openRequestReject(): void }).openRequestReject();
    await flushPromises();
    await w.find('[data-request-reject] textarea').setValue('理由');
    await buttonIn(w.find('[data-request-reject]'), '申請を却下する')?.trigger('click');
    await flushPromises();
    const area = w.find('[data-request-reject]');
    expect(buttonIn(area, '申請を却下する')?.attributes('disabled')).toBeDefined();
    expect(buttonIn(area, '取消')?.attributes('disabled')).toBeDefined();
  });

  it('申請ごと却下の理由は 2,000 単位まで。残りの字数を出し、超えたら送れない', async () => {
    serve(data());
    const w = await mountDetail();
    (w.vm as unknown as { openRequestReject(): void }).openRequestReject();
    await flushPromises();
    const area = () => w.find('[data-request-reject]');
    const count = () => area().find('[data-request-reject-count]').text();
    expect(count()).toBe('あと 2000 文字');
    // 残りの字数は理由欄の説明として読み上げられる(超えたときは上限の注意が同じ役をする)。
    const describedBy = () => area().find('textarea').attributes('aria-describedby');
    expect(describedBy()).toBeTruthy();
    expect(describedBy()).toBe(area().find('[data-request-reject-count]').attributes('id'));
    await area().find('textarea').setValue('理由');
    expect(count()).toBe('あと 1998 文字');
    // 前後の空白は送らないので数えない(サーバが受ける長さと同じ)。
    await area().find('textarea').setValue('  理由 \n');
    expect(count()).toBe('あと 1998 文字');
    await area().find('textarea').setValue('あ'.repeat(2001));
    expect(area().find('[role="alert"]').text()).toBe(
      '理由は 2000 文字までです（いま 2001 文字）。',
    );
    expect(describedBy()).toBe(area().find('[role="alert"]').attributes('id'));
    expect(area().find('textarea').attributes('aria-invalid')).toBe('true');
    const send = buttonIn(area(), '申請を却下する');
    expect(send?.attributes('disabled')).toBeDefined();
    await send?.trigger('click');
    await flushPromises();
    expect(repo.rejectReview).not.toHaveBeenCalled();
    await area().find('textarea').setValue('あ'.repeat(2000));
    expect(count()).toBe('あと 0 文字');
    expect(area().find('[role="alert"]').exists()).toBe(false);
    expect(buttonIn(area(), '申請を却下する')?.attributes('disabled')).toBeUndefined();
  });

  it('取消で理由欄を閉じる', async () => {
    serve(data());
    const w = await mountDetail();
    (w.vm as unknown as { openRequestReject(): void }).openRequestReject();
    await flushPromises();
    await buttonIn(w.find('[data-request-reject]'), '取消')?.trigger('click');
    expect(w.find('[data-request-reject]').exists()).toBe(false);
  });
});

// ── 7. PDF とページ送り ──

describe('ReviewDetail の PDF とページ送り', () => {
  it('記入済みインスタンスが無ければ、描画済みの申請版本文を描画に通さず PDF にする', async () => {
    serve(data());
    renderPdf.mockResolvedValue(ok(new Blob(['%PDF'])));
    const w = await mountDetail();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    w.findComponent({ name: 'ReviewNoticeBar' }).vm.$emit('open-pdf');
    await flushPromises();
    expect(renderPdf).toHaveBeenCalledTimes(1);
    const [html, , , , skipJinja] = renderPdf.mock.calls[0] as unknown[];
    expect(html).toBe('<p>{{ 描画済みの本文 }}</p>');
    expect(skipJinja).toBe(true);
  });

  it('gotoPage は読み込み前なら待ち、紙面が出てから送る', async () => {
    serve(data());
    const w = mount(ReviewDetail, { props: { reqId: 'r1' } });
    (w.vm as unknown as { gotoPage(i: number): void }).gotoPage(1);
    await flushPromises();
    await readyPanels();
    expect(panels.some((p) => p.api.gotoAnchor.mock.calls.length > 0)).toBe(true);
  });
});

// ── 8. 承認後の通知・読み込み・組の差し替え ──

describe('ReviewDetail の承認後の通知と読み込み', () => {
  it('現行版が申請後に変わっていれば上書き注意を出し、同期と注記マスタの結果を知らせる', async () => {
    repo.approveReview.mockResolvedValue(
      ok({
        meta: {} as ApproveReviewResult['meta'],
        staleWarning: true,
        sync: {} as ApproveReviewResult['sync'],
        noteMaster: { updated: ['注記A'], error: null },
      } as unknown as ApproveReviewResult),
    );
    const d = allApproved();
    d.cssChanged = true;
    serve(d, { ...d, review: { ...d.review, status: 'approved', reviewedBy: 'boss' } });
    const w = await mountDetail();
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(vi.mocked(confirm).mock.calls[0][0].description).toContain('書式設定の変更: あり');
    const texts = vi.mocked(toast).mock.calls.map((c) => c[0]);
    expect(texts.some((t) => t.includes('上書きした可能性があります'))).toBe(true);
    expect(texts).toContain('同期の結果');
    expect(texts.some((t) => t.includes('注記マスタへ 1 パーツを反映しました'))).toBe(true);
    // 読み直した申請が決着済みなら、それをそのまま伝える。
    const decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided?.reviewedBy).toBe('boss');
    expect(decided?.status).toBe('approved');
  });

  it('注記マスタへの反映の失敗は長めに知らせ、反映 0 件なら鳴らさない', async () => {
    repo.approveReview.mockResolvedValueOnce(
      ok({
        meta: {} as ApproveReviewResult['meta'],
        staleWarning: false,
        noteMaster: { updated: [], error: '書けません' },
      } as unknown as ApproveReviewResult),
    );
    serve(allApproved());
    const w = await mountDetail();
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      '注記マスタへの反映に失敗しました: 書けません',
      'error',
      8000,
    );

    vi.mocked(toast).mockClear();
    repo.approveReview.mockResolvedValueOnce(
      ok({
        meta: {} as ApproveReviewResult['meta'],
        staleWarning: false,
        noteMaster: { updated: [], error: null },
      } as unknown as ApproveReviewResult),
    );
    serve(allApproved());
    const w2 = await mountDetail();
    await w2.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it('読み込みに失敗したら案内を出し、待っていたページ送りを捨てる', async () => {
    buildDiff.mockResolvedValue(err(appError('internal', '読めません')));
    const w = mount(ReviewDetail, { props: { reqId: 'r1' } });
    (w.vm as unknown as { gotoPage(i: number): void }).gotoPage(1);
    await flushPromises();
    expect(w.text()).toContain('申請の読み込みに失敗しました');
    expect(panels).toHaveLength(0);
  });

  it('読み込み中は生成中と出す', async () => {
    buildDiff.mockImplementation(() => new Promise(() => {}));
    const w = mount(ReviewDetail, { props: { reqId: 'r1' } });
    await flushPromises();
    expect(w.text()).toContain('前後プレビューを生成中');
  });

  it('紙面が出たあとの gotoPage はその場で両面へ送る', async () => {
    serve(data());
    const w = await mountDetail();
    await readyPanels();
    (w.vm as unknown as { gotoPage(i: number): void }).gotoPage(0);
    expect(panels.every((p) => p.api.gotoAnchor.mock.calls.length > 0)).toBe(true);
  });

  it('PDF の作成に失敗したらその旨を出す', async () => {
    serve(data());
    renderPdf.mockResolvedValue(err(appError('internal', 'x')));
    const w = await mountDetail();
    w.findComponent({ name: 'ReviewNoticeBar' }).vm.$emit('open-pdf');
    await flushPromises();
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      'PDFの作成に失敗しました。時間をおいて再度お試しください。',
      'error',
    );
  });

  it('読み直しで変更の組が変わったら右欄を作り直し(表示窓を先頭へ戻す)、同じ組なら作り直さない', async () => {
    const decidedErr = err(
      appError('conflict', 'この申請は既に承認済みです', { code: REVIEW_ALREADY_DECIDED }),
    );
    repo.approveReview.mockResolvedValue(decidedErr);
    const first = allApproved();
    const smaller = allApproved();
    smaller.changes = smaller.changes.slice(0, 1);
    serve(first, first, smaller);
    const w = await mountDetail();
    const list = () => w.findComponent({ name: 'ReviewDecisionList' }).vm.$.uid;
    const original = list();
    // 同じ組の読み直し: 作り直さない(選択・書きかけ・表示窓を保つ)。
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(list()).toBe(original);
    // 組が変わった読み直し: 作り直す(表示窓は `initialWindow` から始まる)。
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(list()).not.toBe(original);
    expect(w.findAll('[data-review-row-no]')).toHaveLength(1);
  });

  it('読み直しで変更の組が変わったら、無くなった番号の選択を外す', async () => {
    const decidedErr = err(
      appError('conflict', 'この申請は既に承認済みです', { code: REVIEW_ALREADY_DECIDED }),
    );
    repo.approveReview.mockResolvedValue(decidedErr);
    const first = allApproved();
    const smaller = data();
    smaller.changes = smaller.changes.slice(0, 1);
    serve(first, smaller);
    const w = await mountDetail();
    await row(w, 2).find('[data-review-name]').trigger('click');
    await flushPromises();
    expect(row(w, 2).attributes('data-selected')).toBe('true');
    await w.find('[data-finalize]').trigger('click');
    await flushPromises();
    expect(row(w, 2).exists()).toBe(false);
    expect(w.find('[data-review-row-no][data-selected="true"]').exists()).toBe(false);
    // 親(コメントの宛先)にも選択が外れたことを知らせる。
    expect(w.emitted('select')?.at(-1)).toEqual([null, null]);
  });
});
