// =============================================================================
// reviewForms.dom.test.ts — 承認画面に出ず本番だけに出る形が、右欄の文字の差分に出ること(web の経路)
// =============================================================================
// server の `reviewableForms.test.ts` と同じ表(敵対レビューの全形)を、承認画面の実際の経路に流す。
// 受付(shared の `renderCreateReview`。不変ゲートは表の `gatePass` を使う。server のテストが今の照合と
// 一致することを確かめている)を通った形だけを、`createReviewDiffService` の `buildDiff` に渡す:
// DOMParser で body を取り → innerHTML → Worker の linkedom で差分 → パーツごとに DOMParser で文字を
// 読んだ右欄の行(`textOps`)。本番で印が見える形は、右欄の追加の文字に印が出ることを確かめる。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ok, type ReviewRequest, renderCreateReview } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CompareService } from '@/features/compare/services/compareService';
import { createReviewDiffService } from '@/features/reviews/services/reviewDiffService';
import { htmlWorkerImpl } from '@/workers/htmlWorkerImpl';

vi.mock('@/workers', () => ({
  htmlWorker: {
    buildHtmlDiff: (...a: Parameters<typeof htmlWorkerImpl.buildHtmlDiff>) =>
      htmlWorkerImpl.buildHtmlDiff(...a),
  },
}));

interface FormCase {
  id: string;
  src: string;
  base: string;
  mark: string;
  data?: Record<string, unknown>;
  gatePass: boolean;
  prodShows: boolean;
}

const CASES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../server/test/reviewableForms.cases.json'), 'utf8'),
) as FormCase[];

/** 受付を通れば描画結果、止まれば null。 */
function accepted(c: FormCase): string | null {
  if (!c.gatePass) return null;
  try {
    return renderCreateReview(c.src, c.data ?? { fund: { name: 'F' } }, c.base).renderedHtml;
  } catch {
    return null;
  }
}

/** 承認画面の右欄に並ぶ追加の文字(作成経路は比較元が空なので、全部が追加)。 */
async function rightColumnText(renderedHtml: string): Promise<string> {
  const review: ReviewRequest = {
    id: 'r1',
    templateId: 'XX01_111111_交付版',
    attributes: { companyCode: 'XX01', fundCode: '111111', editionType: '交付版' },
    origin: 'create',
    status: 'pending',
    submittedBy: 'editor1',
    submittedAt: '2026-10-30T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: null,
    html: '',
    css: '',
    renderedHtml,
    baseHtml: '',
    baseCss: '',
  };
  const service = createReviewDiffService(
    { getReview: vi.fn().mockResolvedValue(ok(review)) } as unknown as Parameters<
      typeof createReviewDiffService
    >[0],
    { renderTemplateBody: vi.fn(), renderVersionHtml: vi.fn() } as unknown as CompareService,
    { listParts: vi.fn().mockResolvedValue(ok([])) } as unknown as Parameters<
      typeof createReviewDiffService
    >[2],
  );
  const res = await service.buildDiff('r1');
  if (!res.ok) throw new Error(res.error.message);
  return res.value.changes
    .flatMap((c) => c.textOps)
    .filter((o) => o.type !== 'del')
    .map((o) => o.text)
    .join('');
}

describe('敵対レビューの全形 — 承認画面の右欄', () => {
  it('表の全形を読む', () => {
    expect(CASES.length).toBeGreaterThan(80);
  });

  it.each(CASES.map((c) => [c.id, c] as const))(
    '%s: 受付で止まるか、右欄の文字に出る',
    async (_id, c) => {
      const rendered = accepted(c);
      if (rendered === null || !c.prodShows) return;
      expect(await rightColumnText(rendered), c.src).toContain(c.mark);
    },
  );
});
