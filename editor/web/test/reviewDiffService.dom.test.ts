// =============================================================================
// reviewDiffService.test.ts — 承認画面のパーツ単位 diff 組み立ての単体テスト (vitest)
// =============================================================================
// `createReviewDiffService` は repo/compare を注入する DI ファクトリなので、`getReview` と
// `compare.renderTemplateBody`/`renderVersionHtml`、および Worker (`htmlWorker.buildHtmlDiff`)
// をモックして、2 系統(edit=現行版と diff / create=全 added)・エラー伝播・集計を固定する。
import { err, notFound, ok, type ReviewRequest } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompareService } from '@/features/compare/services/compareService';
import { createReviewDiffService } from '@/features/reviews/services/reviewDiffService';

// Worker は jsdom で生成できないため、`buildHtmlDiff` だけをモックする。
const buildHtmlDiff = vi.fn();
vi.mock('@/workers', () => ({
  htmlWorker: { buildHtmlDiff: (...a: unknown[]) => buildHtmlDiff(...a) },
}));

// 本文語句差分の LCS 予算共有をテストしやすくするため、予算を小さく固定する
// (`diffTokens` / `tokenize` は実物のまま)。値は下の各小テキストのテスト(数十セル)には
// 影響せず、予算共有テストの 2 ブロック(各 ~19000 セル)でだけ効く大きさにしてある。
vi.mock('@/features/compare/htmlBlockDiff', async (orig) => {
  const actual = await orig<typeof import('@/features/compare/htmlBlockDiff')>();
  return { ...actual, createLcsBudget: () => ({ remaining: 20_000 }) };
});

/** テスト用の申請(本体込み)。origin を差し替えて 2 系統を作る。 */
function review(origin: 'edit' | 'create'): ReviewRequest {
  return {
    id: 'req-1',
    templateId: 'XX01_111111_20250101_交付版',
    attributes: {
      companyCode: 'XX01',
      fundCode: '111111',
      baseDate: '20250101',
      editionType: '交付版',
    },
    origin,
    status: 'pending',
    submittedBy: 'editor1',
    submittedAt: '2025-01-02T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: 'h0',
    html: '<p>{{ fund.name }}</p>',
    css: '.x{}',
  };
}

/** 1 パーツ = 1 block の最小 diff ページを組む。 */
function diffPage(blocks: Array<{ status: string }>) {
  const rows = blocks.map((block, index) => {
    const key = `page-local-${index}`;
    const partKey = `part-${index}#1`;
    const beforeHtml = block.status === 'added' ? '' : `<before-${index}>`;
    const afterHtml = block.status === 'removed' ? '' : `<after-${index}>`;

    return {
      key,
      partKey,
      label: `ページ1・パーツ${index + 1}`,
      status: block.status,
      beforeHtml,
      afterHtml,
      rawBeforeHtml: beforeHtml,
      rawAfterHtml: afterHtml,
      coarse: false,
    };
  });

  return {
    pages: [
      {
        index: 0,
        changed: rows.some((row) => row.status !== 'same'),
        changedBlockCount: rows.filter((row) => row.status !== 'same').length,
        beforeHtml: '',
        afterHtml: '',
        beforeKeys: rows.filter((row) => row.status !== 'added').map((row) => row.key),
        afterKeys: rows.filter((row) => row.status !== 'removed').map((row) => row.key),
        blocks: rows,
        coarse: false,
      },
    ],
    changedPageCount: rows.some((row) => row.status !== 'same') ? 1 : 0,
    beforePageCount: 1,
    afterPageCount: 1,
    coarse: false,
    truncated: false,
  };
}
/** 改ページ区切りを持つ2ページのsame差分を組む。 */
function twoPageSameDiff() {
  const firstHtml = '<section data-part-id="first">1ページ目</section>';
  const secondHtml = '<section data-part-id="second">2ページ目</section>';

  return {
    pages: [
      {
        index: 0,
        changed: false,
        changedBlockCount: 0,
        beforeHtml: firstHtml,
        afterHtml: firstHtml,
        beforeKeys: ['first'],
        afterKeys: ['first'],
        blocks: [
          {
            key: 'first',
            partKey: 'first#1',
            label: 'ページ1・パーツ1',
            status: 'same',
            beforeHtml: firstHtml,
            afterHtml: firstHtml,
            rawBeforeHtml: firstHtml,
            rawAfterHtml: firstHtml,
            coarse: false,
          },
        ],
        coarse: false,
      },
      {
        index: 1,
        changed: false,
        changedBlockCount: 0,
        beforeHtml: secondHtml,
        afterHtml: secondHtml,
        beforeKeys: ['second'],
        afterKeys: ['second'],
        blocks: [
          {
            key: 'second',
            partKey: 'second#1',
            label: 'ページ2・パーツ1',
            status: 'same',
            beforeHtml: secondHtml,
            afterHtml: secondHtml,
            rawBeforeHtml: secondHtml,
            rawAfterHtml: secondHtml,
            coarse: false,
          },
        ],
        coarse: false,
      },
    ],
    changedPageCount: 0,
    beforePageCount: 2,
    afterPageCount: 2,
    coarse: false,
    truncated: false,
  };
}

function makeService(over: {
  getReview?: unknown;
  renderTemplateBody?: unknown;
  renderVersionHtml?: unknown;
}) {
  const reviews = {
    getReview: vi.fn().mockResolvedValue(over.getReview ?? ok(review('edit'))),
  } as unknown as Parameters<typeof createReviewDiffService>[0];
  const compare = {
    renderTemplateBody: vi
      .fn()
      .mockResolvedValue(over.renderTemplateBody ?? ok({ html: '<after>', css: '.after{}' })),
    renderVersionHtml: vi
      .fn()
      .mockResolvedValue(over.renderVersionHtml ?? ok({ html: '<before>', css: '.before{}' })),
  } as unknown as CompareService;
  // パーツカタログ突合はこのテストの主眼ではないため、常に空(= 全行フォールバック表記)にする。
  const parts = {
    listParts: vi.fn().mockResolvedValue(ok([])),
  } as unknown as Parameters<typeof createReviewDiffService>[2];
  return { service: createReviewDiffService(reviews, compare, parts), reviews, compare, parts };
}

beforeEach(() => {
  buildHtmlDiff.mockReset();
});

describe('reviewDiffService.buildDiff', () => {
  it('申請時点の比較元(baseHtml と baseCss)があれば、それを before にする(サーバの確定と同じ入力)', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'changed' }]));
    const { service } = makeService({
      getReview: ok({ ...review('edit'), baseHtml: '<base>', baseCss: '.base{}' }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok && res.value.cssBefore).toBe('.base{}');
    expect(buildHtmlDiff).toHaveBeenCalledWith('<base>', '<after>', '.base{}', '.after{}');
  });

  it('比較元の片方しか無い申請は、現行版を before にする', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'changed' }]));
    const { service } = makeService({
      getReview: ok({ ...review('edit'), baseHtml: '<base>' }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok && res.value.cssBefore).toBe('.before{}');
    expect(buildHtmlDiff).toHaveBeenCalledWith('<before>', '<after>', '.before{}', '.after{}');
  });

  it('edit 経路: 現行版(baseline)と diff し、パーツ行と集計を組み立てる', async () => {
    buildHtmlDiff.mockResolvedValue(
      diffPage([{ status: 'changed' }, { status: 'added' }, { status: 'same' }]),
    );
    const { service, compare } = makeService({});
    const res = await service.buildDiff('req-1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // edit なので現行版レンダリングが呼ばれ、before に反映される。
    expect(compare.renderVersionHtml as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'baseline:XX01_111111_20250101_交付版',
    );
    expect(res.value.rows).toHaveLength(3);
    expect(res.value.rows.map((row) => row.key)).toEqual(['part-0#1', 'part-1#1', 'part-2#1']);
    expect(res.value.pendingPartKeys).toEqual(['part-0#1', 'part-1#1']);

    expect(res.value.summary).toEqual({ total: 3, changed: 1, added: 1, removed: 0 });
    expect(res.value.cssBefore).toBe('.before{}');
    expect(res.value.cssAfter).toBe('.after{}');
    // buildHtmlDiff は (beforeHtml, afterHtml, cssBefore, cssAfter) の順で呼ぶ。
    expect(buildHtmlDiff).toHaveBeenCalledWith('<before>', '<after>', '.before{}', '.after{}');
  });
  it('edit申請の最終候補HTMLに申請版の改ページ区切りを保持する', async () => {
    const beforeHtml =
      '<section data-part-id="first">1ページ目</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="second">2ページ目</section>';

    const afterHtml =
      '<section data-part-id="first">1ページ目</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="second">2ページ目</section>';

    buildHtmlDiff.mockResolvedValue(twoPageSameDiff());

    const { service } = makeService({
      renderVersionHtml: ok({
        html: beforeHtml,
        css: '.pagebreak{break-after:page}',
      }),
      renderTemplateBody: ok({
        html: afterHtml,
        css: '.pagebreak{break-after:page}',
      }),
    });

    const res = await service.buildDiff('req-1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const doc = new DOMParser().parseFromString(res.value.reviewedBodyHtml, 'text/html');
    const children = Array.from(doc.body.children);

    expect(
      children.map((element) => {
        if (element.matches('div.pagebreak')) return 'pagebreak';
        return element.getAttribute('data-part-id');
      }),
    ).toEqual(['first', 'pagebreak', 'second']);

    expect(children.filter((element) => element.matches('div.pagebreak'))).toHaveLength(1);
  });

  it('create 経路: 保存済みの値入り本文を使い、before は空で全パーツを added にする', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'added' }, { status: 'added' }]));

    const createReview: ReviewRequest = {
      ...review('create'),
      filledHtml:
        '<!doctype html><html><head>' +
        '<style data-preview-css="">.x{}</style>' +
        '</head><body>' +
        '<section data-part-id="cover">値入り表紙</section>' +
        '<section data-part-id="cost">値入り費用</section>' +
        '</body></html>',
    };

    const { service, compare } = makeService({
      getReview: ok(createReview),
    });
    const res = await service.buildDiff('req-1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(compare.renderTemplateBody as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(compare.renderVersionHtml as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    expect(buildHtmlDiff).toHaveBeenCalledWith(
      '',
      '<section data-part-id="cover">値入り表紙</section>' +
        '<section data-part-id="cost">値入り費用</section>',
      '.x{}',
      '.x{}',
    );

    expect(res.value.summary).toEqual({
      total: 2,
      changed: 0,
      added: 2,
      removed: 0,
    });
  });

  it('現行版が取得できなくても before 空で画面は出す(edit・baseline err)', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'removed' }]));
    const { service } = makeService({ renderVersionHtml: err(notFound('no baseline')) });
    const res = await service.buildDiff('req-1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(buildHtmlDiff).toHaveBeenCalledWith('', '<after>', '.after{}', '.after{}');
    expect(res.value.summary.removed).toBe(1);
  });

  it('CSS だけ変わった申請(HTML 差分なし)でも cssChanged を立てる', async () => {
    // HTML 差分は全 same(changed/added/removed は 0)。それでも共有 CSS は変わっている。
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'same' }]));
    const { service } = makeService({
      renderTemplateBody: ok({ html: '<after>', css: '.shared{color:red}' }),
      renderVersionHtml: ok({ html: '<before>', css: '.shared{color:blue}' }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.summary.changed).toBe(0);
    expect(res.value.cssChanged).toBe(true);
  });

  it('CSS が空白差だけなら cssChanged は false', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'same' }]));
    const { service } = makeService({
      renderTemplateBody: ok({ html: '<after>', css: '.shared{color:red}' }),
      renderVersionHtml: ok({ html: '<before>', css: '  .shared{color:red}\n' }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cssChanged).toBe(false);
  });

  it('申請 HTML 内のインライン <style> の印刷専用規則も printOnlyCss に数える', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'changed' }]));
    // ファンド CSS(after.css)には印刷専用規則が無いが、本文の <style> にはある。
    const { service } = makeService({
      renderTemplateBody: ok({
        html: '<div><style>.x{display:none}@media print{.x{display:block}}</style><p class="x">秘</p></div>',
        css: '.after{}',
      }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.printOnlyCss).toBe(true);
  });

  it('印刷専用規則がどこにも無ければ printOnlyCss は false', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'changed' }]));
    const { service } = makeService({
      renderTemplateBody: ok({ html: '<div><style>.x{color:red}</style></div>', css: '.after{}' }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.printOnlyCss).toBe(false);
  });

  it('本文語句差分(textOps)は申請者 CSS で隠した変更も拾う(textContent 由来)', async () => {
    // 変更後の "90" を display:none で隠しても、textContent には残るので textOps に現れる。
    buildHtmlDiff.mockResolvedValue({
      pages: [
        {
          index: 0,
          changed: true,
          changedBlockCount: 1,
          beforeHtml: '',
          afterHtml: '',
          beforeKeys: ['k0'],
          afterKeys: ['k0'],
          blocks: [
            {
              key: 'k0',
              partKey: 'k0',
              label: 'ページ1・パーツ1',
              status: 'changed',
              beforeHtml: '<p>手数料は<span>10</span>%</p>',
              afterHtml: '<p>手数料は<span style="display:none">90</span>%</p>',
              rawBeforeHtml: '<p>手数料は<span>10</span>%</p>',
              rawAfterHtml: '<p>手数料は<span style="display:none">90</span>%</p>',
              coarse: false,
            },
          ],
          coarse: false,
        },
      ],
      changedPageCount: 1,
      beforePageCount: 1,
      afterPageCount: 1,
      coarse: false,
      truncated: false,
    });
    const { service } = makeService({});
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ops = res.value.rows[0].textOps;
    const insText = ops
      .filter((o) => o.type === 'ins')
      .map((o) => o.text)
      .join('');
    const delText = ops
      .filter((o) => o.type === 'del')
      .map((o) => o.text)
      .join('');
    expect(insText).toContain('90'); // 隠された変更後の値も拾える
    expect(delText).toContain('10');
  });

  it('本文語句差分の LCS 予算は文書単位で共有される(ブロック分割による DoS 回避)', async () => {
    // 各ブロック単独では語句差分できる大きさだが、合算で文書予算(モック 20000)を超えるよう
    // 2 ブロックを組む。予算を共有していれば 2 ブロック目は粗い差分(coarse=del+ins の 2 op)へ
    // 落ちる。ブロックごとに予算を切っていれば両方語句単位になり、この主張は破れる。
    const words = (seed: string) => Array.from({ length: 70 }, (_, i) => `${seed}${i}`).join(' ');
    const mkBlock = (i: number) => {
      const beforeHtml = `<p>${words(`a${i}`)}</p>`;
      const afterHtml = `<p>${words(`b${i}`)}</p>`;

      return {
        key: `k${i}`,
        partKey: `k${i}`,
        label: `ページ1・パーツ${i + 1}`,
        status: 'changed',
        beforeHtml,
        afterHtml,
        rawBeforeHtml: beforeHtml,
        rawAfterHtml: afterHtml,
        coarse: false,
      };
    };
    buildHtmlDiff.mockResolvedValue({
      pages: [
        {
          index: 0,
          changed: true,
          changedBlockCount: 2,
          beforeHtml: '',
          afterHtml: '',
          beforeKeys: ['k0', 'k1'],
          afterKeys: ['k0', 'k1'],
          blocks: [mkBlock(0), mkBlock(1)],
          coarse: false,
        },
      ],
      changedPageCount: 1,
      beforePageCount: 1,
      afterPageCount: 1,
      coarse: false,
      truncated: false,
    });
    const { service } = makeService({});
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const isCoarse = (ops: { type: string }[]) =>
      ops.length === 2 && ops.every((o) => o.type !== 'same');
    expect(isCoarse(res.value.rows[0].textOps)).toBe(false); // 1 つ目は語句単位
    expect(isCoarse(res.value.rows[1].textOps)).toBe(true); // 予算を使い切り 2 つ目は粗い差分
  });

  it('same パーツは textOps を作らない(空)', async () => {
    buildHtmlDiff.mockResolvedValue(diffPage([{ status: 'same' }]));
    const { service } = makeService({});
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows[0].textOps).toEqual([]);
  });

  it('getReview のエラーはそのまま伝播する', async () => {
    const { service } = makeService({ getReview: err(notFound('no request')) });
    const res = await service.buildDiff('req-x');
    expect(res.ok).toBe(false);
    expect(buildHtmlDiff).not.toHaveBeenCalled();
  });

  it('申請版レンダリング(renderTemplateBody)のエラーは伝播する', async () => {
    const { service } = makeService({ renderTemplateBody: err(notFound('render failed')) });
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(false);
    expect(buildHtmlDiff).not.toHaveBeenCalled();
  });

  it('申請者の style に隠し文言があっても本文テキストに現れ、空の style / fund CSS は無視される', async () => {
    buildHtmlDiff.mockResolvedValue({
      pages: [
        {
          index: 0,
          changed: true,
          changedBlockCount: 1,
          beforeHtml: '',
          afterHtml: '',
          beforeKeys: [],
          afterKeys: ['k0'],
          blocks: [
            {
              key: 'k0',
              partKey: 'k0',
              label: 'ページ1・パーツ1',
              status: 'added',
              beforeHtml: '', // htmlToText('') は空文字を返し、例外にならない
              afterHtml: '<p style="display:none">隠し文言</p>',
              rawBeforeHtml: '',
              rawAfterHtml: '<p style="display:none">隠し文言</p>',
              coarse: false,
            },
          ],
          coarse: false,
        },
      ],
      changedPageCount: 1,
      beforePageCount: 0,
      afterPageCount: 1,
      coarse: false,
      truncated: false,
    });
    // fund CSS が空、本文の <style> も空なら collectPaneStyleText は何も足さない。
    const { service } = makeService({
      renderTemplateBody: ok({ html: '<div><style></style></div>', css: '' }),
    });
    const res = await service.buildDiff('req-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ins = res.value.rows[0].textOps
      .filter((o) => o.type === 'ins')
      .map((o) => o.text)
      .join('');
    expect(ins).toContain('隠し文言'); // 申請者スタイルの display:none に関係なく textContent 由来で拾う
    expect(res.value.printOnlyCss).toBe(false);
  });
});
