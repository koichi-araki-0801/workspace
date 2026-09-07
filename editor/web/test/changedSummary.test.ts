// =============================================================================
// changedSummary.test.ts — 申請時の変更概要(自己申告・参考情報)の計算
// =============================================================================
import { err, notFound, ok, type PartRepository } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CompareService } from '@/features/compare/services/compareService';
import {
  computeChangedSummaryWith,
  createChangedSummaryService,
} from '@/features/reviews/services/changedSummary';

// `createChangedSummaryService` は `@/workers` の `htmlWorker` を import する。この test は
// node 環境(DOM 無し)で走るため、実体(DOMParser 依存の buildHtmlDiffCore フォールバック)を
// 通すと落ちる — 配線の確認だけが目的なので固定応答へ差し替える。
vi.mock('@/workers', () => ({
  htmlWorker: { buildHtmlDiff: vi.fn(async () => ({ pages: [] })) },
}));

const diff = {
  truncated: false,
  pages: [
    {
      blocks: [
        { key: 'note-a#1', label: 'ページ1・パーツ1', status: 'changed' },
        { key: '.x#1', label: 'ページ1・パーツ2', status: 'same' },
        { key: 'note-b#1', label: 'ページ2・パーツ1', status: 'added' },
      ],
    },
  ],
};

const deps = {
  renderAfter: vi.fn(async () => ok({ html: '<p>a</p>', css: '' })),
  renderBefore: vi.fn(async () => ok({ html: '<p>b</p>', css: '' })),
  buildHtmlDiff: vi.fn(async () => diff),
  loadNames: vi.fn(async () => new Map([['note-a', '運用実績の表']])),
};

describe('computeChangedSummaryWith', () => {
  it('変更ブロックの件数と業務名(重複除去)を返す', async () => {
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' },
      deps,
    );
    expect(s).toEqual({ count: 2, names: ['運用実績の表', 'ページ2・パーツ1'] });
  });

  it('内部で例外が出ても null(申請を止めない)', async () => {
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '', css: '', fundCode: 'f', origin: 'edit' },
      {
        ...deps,
        buildHtmlDiff: vi.fn(async () => {
          throw new Error('x');
        }),
      },
    );
    expect(s).toBeNull();
  });

  it('renderAfter の失敗は null、origin=create は renderBefore を呼ばない、renderBefore の失敗は空の before で続行', async () => {
    const afterErr = await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' },
      { ...deps, renderAfter: vi.fn(async () => err(notFound('x'))) },
    );
    expect(afterErr).toBeNull();

    const before = vi.fn(async () => ok({ html: '', css: '' }));
    await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'create' },
      { ...deps, renderBefore: before },
    );
    expect(before).not.toHaveBeenCalled();

    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' },
      { ...deps, renderBefore: vi.fn(async () => err(notFound('x'))) },
    );
    expect(s?.count).toBe(2); // before 空のまま続行し、after 側の全ブロックが変更扱い
  });

  it('パーツ id を持たないキーは業務名突合をスキップしてラベルを使う', async () => {
    const diffNoId = {
      truncated: false,
      pages: [{ blocks: [{ key: 'table#1', label: 'ページ1・パーツ3', status: 'changed' }] }],
    };
    const s = await computeChangedSummaryWith(
      { templateId: 't', html: '<p>a</p>', css: '', fundCode: 'f', origin: 'edit' },
      { ...deps, buildHtmlDiff: vi.fn(async () => diffNoId) },
    );
    expect(s).toEqual({ count: 1, names: ['ページ1・パーツ3'] });
  });
});

describe('createChangedSummaryService', () => {
  it('compare の描画 2 本と parts の名前表を配線する', async () => {
    const compare = {
      renderTemplateBody: vi.fn(async () => ok({ html: '<p>a</p>', css: '' })),
      renderVersionHtml: vi.fn(async () => ok({ html: '<p>b</p>', css: '' })),
    } as unknown as CompareService;
    const parts = {
      listParts: vi.fn(async () => ok([{ id: 'note-a', name: '運用実績の表' }])),
    } as unknown as PartRepository;
    const svc = createChangedSummaryService(compare, parts);
    await svc.computeChangedSummary({
      templateId: 't',
      html: '<p>a</p>',
      css: '',
      fundCode: 'f',
      origin: 'edit',
    });
    expect(compare.renderVersionHtml).toHaveBeenCalledWith('baseline:t');
    expect(parts.listParts).toHaveBeenCalled();
  });
});
