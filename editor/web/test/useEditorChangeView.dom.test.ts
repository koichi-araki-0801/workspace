// =============================================================================
// useEditorChangeView.dom.test.ts — 編集画面の変更の見え方の配線(番号・名前・見出し・却下の理由)
// =============================================================================
// `useTemplateEditor.ts` は GrapesJS 一式を起こすので単体で組めない。canvas に依らない配線
// (`useEditorChangeView.ts`)をここで組み、canvas の全パーツは jsdom の文書から `partEntries` で
// 作る。
// 差分は worker と同じ linkedom のパーサで取る(`changeNumbersParity.dom.test.ts` と同じ差し替え)。
import {
  ok,
  type PartCatalogItem,
  type PartHistoryEntry,
  type ReviewPartDecision,
  type ReviewRepository,
  type ReviewRequest,
  type ReviewRequestMeta,
} from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, shallowRef } from 'vue';
import { createCleanCheck } from '@/features/editor/cleanCheck';
import { type PartEntry, partEntries } from '@/features/editor/partKey';
import { useEditorChangeView, wireEditorChangeView } from '@/features/editor/useEditorChangeView';

vi.mock('@/workers', async () => {
  const { htmlWorkerImpl } = await import('@/workers/htmlWorkerImpl');
  const { toAsyncApi } = await import('@/workers/htmlApi');
  return { htmlWorker: toAsyncApi(htmlWorkerImpl) };
});

const TID = 'XX01_950037_20240710_交付版';
/** 確定版の本文(2 ページ。2 ページ目のパーツは業務名のある `data-part-id` つき)。 */
const BASE =
  '<section class="a"><p>表紙</p></section><div class="pagebreak"></div>' +
  '<section data-part-id="P001"><p>運用の経過</p></section>';
const FILLED = `<!doctype html><html><head></head><body>${BASE}</body></html>`;
/** 1 ページ目のパーツの文字だけを変えた本文。 */
const EDITED = BASE.replace('表紙', '表紙(改)');

function entriesOf(body: string): PartEntry[] {
  const root = document.createElement('div');
  root.innerHTML = body;
  return partEntries(root);
}

function catalog(id: string, name: string): PartCatalogItem {
  return {
    id,
    classification: { category: '注記', majorClass: 'a', middleClass: 'b', minorClass: 'c' },
    name,
    description: '',
    usageNotes: '',
    updatedAt: null,
    updatedBy: null,
    content: '',
  };
}

function meta(partDecisions: ReviewPartDecision[]): ReviewRequestMeta {
  return {
    id: 'req-1',
    templateId: TID,
    attributes: {
      companyCode: 'XX01',
      fundCode: '950037',
      baseDate: '20240710',
      editionType: '交付版',
    },
    origin: 'edit',
    status: 'approved',
    submittedBy: 'me',
    submittedAt: '2026-10-28T00:00:00.000Z',
    reviewedBy: '承認 太郎',
    reviewedAt: '2026-10-28T01:00:00.000Z',
    comment: null,
    baseHash: null,
    partDecisions,
  };
}

function reviewsWith(list: ReviewRequestMeta[]) {
  const listReviews = vi.fn(async () => ok(list));
  const getReview = vi.fn(async () =>
    ok({ ...meta([]), html: '', css: '', baseHtml: null, baseCss: null } as ReviewRequest),
  );
  return {
    repo: { listReviews, getReview } as unknown as ReviewRepository,
    listReviews,
    getReview,
  };
}

function setup(
  opts: { body?: string; reviews?: ReviewRepository; onBodyRead?: (body: string) => void } = {},
) {
  let body = opts.body ?? BASE;
  const readBody = vi.fn(() => body);
  const canvasEntries = shallowRef(entriesOf(body));
  const partsById = shallowRef<ReadonlyMap<string, PartCatalogItem>>(new Map());
  const selectedKey = ref<string | null>(null);
  const history = shallowRef<readonly PartHistoryEntry[]>([]);
  const setChangeNumbers = vi.fn();
  const view = useEditorChangeView({
    canvasEntries,
    partsById,
    selectedKey,
    history,
    readBody,
    onBodyRead: opts.onBodyRead,
    setChangeNumbers,
    templateId: TID,
    me: () => 'me',
    reviews: opts.reviews ?? reviewsWith([]).repo,
  });
  return {
    view,
    canvasEntries,
    partsById,
    selectedKey,
    history,
    setChangeNumbers,
    readBody,
    /** canvas の本文を変える(GrapesJS の編集の代わり)。 */
    edit(next: string) {
      body = next;
      canvasEntries.value = entriesOf(next);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useEditorChangeView', () => {
  it('ラベルと表示名は canvas の同じ数え上げから作り、業務名 → 先頭の文字の順で名前を決める', () => {
    const { view, partsById } = setup();
    const keys = entriesOf(BASE).map((e) => e.key);
    expect([...view.partLabels.value.keys()]).toEqual(keys);
    expect([...view.partNames.value.keys()]).toEqual(keys);
    expect([...view.partLabels.value.values()]).toEqual(['ページ1・パーツ1', 'ページ2・パーツ1']);
    // カタログがまだ無いときは先頭の文字。
    expect([...view.partNames.value.values()]).toEqual(['表紙', '運用の経過']);
    // カタログがあとから読み込まれても、名前は業務名へ直る(`partsById` の差し替えで作り直す)。
    partsById.value = new Map([['P001', catalog('P001', '運用経過の注記')]]);
    expect([...view.partNames.value.values()]).toEqual(['表紙', '運用経過の注記']);
  });

  it('編集経路で開くと番号を計算し、紙面の目印・選択中の番号と名前・修正履歴の見出しへ流す', async () => {
    const { view, selectedKey, setChangeNumbers } = setup({ body: EDITED });
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    expect(view.changeMarksAvailable.value).toBe(true);
    const key = entriesOf(EDITED)[0].key;
    await vi.waitFor(() => expect(view.changeNumbers.value.byKey.size).toBe(1));
    expect([...view.changeNumbers.value.byKey]).toEqual([[key, 1]]);
    await nextTick();
    expect(setChangeNumbers).toHaveBeenLastCalledWith(new Map([[key, 1]]));

    selectedKey.value = key;
    expect(view.selectedNo.value).toBe(1);
    expect(view.selectedName.value).toBe('表紙(改)');
    expect(view.historyGroups.value.map((g) => [g.key, g.no, g.name])).toEqual([
      [key, 1, '表紙(改)'],
    ]);
  });

  it('作成経路では番号を出さず、前回の申請の一覧も取らない', async () => {
    const reviews = reviewsWith([meta([])]);
    const { view } = setup({ body: EDITED, reviews: reviews.repo });
    view.open({ isCreateRoute: true, filled: FILLED, confirmedBody: BASE });
    await vi.waitFor(() => expect(view.changeMarksAvailable.value).toBe(false));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.changeNumbers.value.byKey.size).toBe(0);
    expect(reviews.listReviews).not.toHaveBeenCalled();
  });

  it('編集経路では前回の申請の却下の理由を 1 回読み、紙面のキーで選択中のパーツへ当てる', async () => {
    const key = entriesOf(BASE)[0].key;
    const reviews = reviewsWith([
      meta([
        {
          partKey: key,
          status: 'rejected',
          decidedBy: '承認 太郎',
          decidedAt: '2026-10-28T01:02:00.000Z',
          comment: '日付を直してください',
          history: [],
        },
      ]),
    ]);
    const { view, selectedKey } = setup({ reviews: reviews.repo });
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    selectedKey.value = key;
    await vi.waitFor(() =>
      expect(view.selectedRejected.value?.reason).toBe('日付を直してください'),
    );
    expect(reviews.listReviews).toHaveBeenCalledTimes(1);
    // 紙面にあるパーツなので、名前のために申請の本文は取らない(canvas の名前を使う)。
    expect(reviews.getReview).not.toHaveBeenCalled();
    expect(view.historyGroups.value.find((g) => g.key === key)?.rejected?.reason).toBe(
      '日付を直してください',
    );
  });

  it('選択が無い・番号も理由も無いパーツの選択では、番号・名前・理由を空にする', async () => {
    const { view, selectedKey } = setup({ body: EDITED });
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    await vi.waitFor(() => expect(view.changeNumbers.value.byKey.size).toBe(1));
    expect([view.selectedNo.value, view.selectedName.value, view.selectedRejected.value]).toEqual([
      null,
      '',
      null,
    ]);
    // 変更の無い 2 ページ目のパーツ: 名前はあるが番号と理由は無い。
    selectedKey.value = entriesOf(EDITED)[1].key;
    expect([view.selectedNo.value, view.selectedName.value, view.selectedRejected.value]).toEqual([
      null,
      '運用の経過',
      null,
    ]);
  });

  it('紙面に無いキーの却下は、申請の本文から作った名前で末尾へ並べ、作れなければ既定の名前にする', async () => {
    const reject = (partKey: string): ReviewPartDecision => ({
      partKey,
      status: 'rejected',
      decidedBy: '承認 太郎',
      decidedAt: '2026-10-28T01:02:00.000Z',
      comment: `${partKey} は不要`,
      history: [],
    });
    const listReviews = vi.fn(async () => ok([meta([reject('.gone#1'), reject('.lost#1')])]));
    // 申請の本文には `.gone` だけがある(`.lost` は本文からも名前を作れない)。
    const getReview = vi.fn(async () =>
      ok({
        ...meta([]),
        html: '<!doctype html><html><body><section class="gone"><p>消した注記</p></section></body></html>',
        css: '',
      } as ReviewRequest),
    );
    const { view } = setup({ reviews: { listReviews, getReview } as unknown as ReviewRepository });
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    await vi.waitFor(() => expect(view.historyGroups.value.length).toBe(2));
    expect(view.historyGroups.value.map((g) => [g.key, g.name, g.offCanvas])).toEqual([
      ['.gone#1', '消した注記', true],
      ['.lost#1', '削除済みパーツ', true],
    ]);
    expect(getReview).toHaveBeenCalledTimes(1);
  });

  it('本文の変わった通知だけを、300ms の待ちと 1,000ms の予約のあとで計算し直す', async () => {
    vi.useFakeTimers();
    const { view, edit } = setup();
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.changeNumbers.value.byKey.size).toBe(0);

    // 本文が変わらない通知(CSS だけ・選択だけ)では予約しない。
    view.notify();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(view.changeNumbers.value.byKey.size).toBe(0);

    edit(EDITED);
    view.notify();
    await vi.advanceTimersByTimeAsync(300 + 999);
    expect(view.changeNumbers.value.byKey.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(view.changeNumbers.value.byKey.size).toBe(1));
  });

  it('1 回の通知で本文を読むのは 1 回で、確定版との同一判定にも同じ本文を渡す', async () => {
    vi.useFakeTimers();
    const onBodyRead = vi.fn();
    const { view, edit, readBody } = setup({ onBodyRead });
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    await vi.advanceTimersByTimeAsync(0);
    readBody.mockClear();
    edit(EDITED);
    view.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(onBodyRead).toHaveBeenCalledExactlyOnceWith(EDITED);
    // 番号の計算(予約のあと)も同じ本文を使い、読み直さない。
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(view.changeNumbers.value.byKey.size).toBe(1));
    expect(readBody).toHaveBeenCalledTimes(1);
  });

  it('dispose のあとは、待ちと予約が残っていても計算しない', async () => {
    vi.useFakeTimers();
    const { view, edit } = setup();
    view.open({ isCreateRoute: false, filled: FILLED, confirmedBody: BASE });
    await vi.advanceTimersByTimeAsync(0);
    edit(EDITED);
    view.notify();
    view.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.changeNumbers.value.byKey.size).toBe(0);
  });
});

describe('wireEditorChangeView(useTemplateEditor からの受け渡し)', () => {
  function fakeView() {
    return { open: vi.fn(), notify: vi.fn(), dispose: vi.fn() };
  }

  it('読み込みの結果から open に経路・値入り HTML・確定版の原文を渡す', () => {
    const view = fakeView();
    const wire = wireEditorChangeView({ view, onChange: vi.fn() });
    wire.loaded({ isCreateRoute: false, template: { filled: FILLED }, confirmedBody: BASE });
    expect(view.open).toHaveBeenCalledExactlyOnceWith({
      isCreateRoute: false,
      filled: FILLED,
      confirmedBody: BASE,
    });
  });

  it('canvas の変更は即時の処理(dirty・autosave)のあとで notify へ流し、離れるときに dispose する', () => {
    const order: string[] = [];
    const view = {
      open: vi.fn(),
      notify: vi.fn(() => order.push('notify')),
      dispose: vi.fn(() => order.push('dispose')),
    };
    const wire = wireEditorChangeView({ view, onChange: () => order.push('change') });
    wire.changed();
    wire.unmounted();
    expect(order).toEqual(['change', 'notify', 'dispose']);
  });
});

describe('確定版との同一判定(createCleanCheck)と変更の通知の配線', () => {
  const CANON = { html: BASE, css: '.a{color:red}' };

  function flow(opts: { canonical: typeof CANON | null }) {
    let body = EDITED;
    let css = CANON.css;
    const dirty = ref(false);
    const readBody = vi.fn(() => body);
    const onClean = vi.fn(async () => {});
    const clean = createCleanCheck({
      canonical: () => opts.canonical,
      dirty,
      readBody,
      readCss: () => css,
      onClean,
    });
    const view = useEditorChangeView({
      canvasEntries: shallowRef(entriesOf(BASE)),
      partsById: shallowRef(new Map()),
      selectedKey: ref(null),
      history: shallowRef([]),
      readBody,
      ...clean.bodyReader(),
      setChangeNumbers: vi.fn(),
      templateId: TID,
      me: () => 'me',
      reviews: reviewsWith([]).repo,
    });
    const order: string[] = [];
    const wire = wireEditorChangeView({
      view,
      onChange: () => {
        order.push(`dirty=${dirty.value}`);
        dirty.value = true;
      },
    });
    return {
      dirty,
      readBody,
      onClean,
      wire,
      order,
      clean,
      setBody: (b: string) => {
        body = b;
      },
      setCss: (c: string) => {
        css = c;
      },
    };
  }

  it('変更を受けると dirty を立ててから通知し、待ちのあとの 1 回の読み出しで確定版と比べる', async () => {
    vi.useFakeTimers();
    const f = flow({ canonical: CANON });
    f.wire.loaded({ isCreateRoute: false, template: { filled: FILLED }, confirmedBody: BASE });
    await vi.advanceTimersByTimeAsync(0);
    f.readBody.mockClear();
    f.wire.changed();
    // 通知の前に dirty が立っている(同一判定は dirty のときだけ本文を要る)。
    expect(f.order).toEqual(['dirty=false']);
    expect(f.dirty.value).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.readBody).toHaveBeenCalledTimes(1);
    // 本文は確定版と違うので、未確定のまま。
    expect(f.dirty.value).toBe(true);
    expect(f.onClean).not.toHaveBeenCalled();
  });

  it('本文も CSS も確定版へ戻すと、未確定を下ろして後始末を呼ぶ(CSS だけを戻した変更でも)', async () => {
    vi.useFakeTimers();
    const f = flow({ canonical: CANON });
    f.wire.loaded({ isCreateRoute: false, template: { filled: FILLED }, confirmedBody: BASE });
    await vi.advanceTimersByTimeAsync(0);
    // 本文は確定版のまま、CSS だけを変えて戻す(本文の変わらない通知)。
    f.setBody(BASE);
    f.setCss('.a{color:blue}');
    f.wire.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.dirty.value).toBe(true);
    f.setCss(CANON.css);
    f.wire.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.dirty.value).toBe(false);
    expect(f.onClean).toHaveBeenCalledTimes(1);
  });

  it('確定版の正規形が無ければ(作成経路)、本文を読まず、未確定も下ろさない', async () => {
    vi.useFakeTimers();
    const f = flow({ canonical: null });
    f.wire.loaded({ isCreateRoute: true, template: { filled: FILLED }, confirmedBody: BASE });
    await vi.advanceTimersByTimeAsync(0);
    f.readBody.mockClear();
    f.setBody(BASE);
    f.wire.changed();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.readBody).not.toHaveBeenCalled();
    expect(f.dirty.value).toBe(true);
    expect(await f.clean.settle(BASE)).toBe(false);
  });

  it('未確定でなければ settle は何もしない(本文を渡さなければ自分で読む)', async () => {
    const f = flow({ canonical: CANON });
    expect(await f.clean.settle()).toBe(false);
    expect(f.readBody).not.toHaveBeenCalled();
    f.dirty.value = true;
    f.setBody(BASE);
    expect(await f.clean.settle()).toBe(true);
    expect(f.readBody).toHaveBeenCalledTimes(1);
  });
});
