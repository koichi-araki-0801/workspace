// =============================================================================
// createReviewKeys.dom.test.ts — 作成経路の申請で、右欄の行のキーとサーバの照合のキーが一致すること
// =============================================================================
// 作成経路の申請では、承認タブの右欄の行(判定を送るキー)は `reviewDiffService.ts` の差分から作り、
// サーバは判定の保存と最終確定で Jinja 原文のパーツ(`extractReviewParts`)と照合する
// (`server/src/repositories/reviewRepo.ts` の `decidablePartKeys`、shared の
// `buildCreateReviewedHtml`)。両者が食い違うと、画面で押した判定が 400 で拒まれる。
// 画面と同じ呼び方(`createReviewDiffService` の `buildDiff`、比較元はサーバが保存する空の本文と
// 申請の CSS、差分は worker と同じ linkedom の実装)で、テスト用の全 fixture(Jinja 原文
// `fixtures/templates/` と値入り `fixtures/filled/`、CSS `fixtures/css/`)の行のキーを、並びと重複まで
// 比べる。値入りの本文が無い申請(`renderReviewPair` の経路)は、描画の代わりに値入りの fixture の
// 本文を返す。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyTemplateAttributes,
  extractReviewParts,
  ok,
  type ReviewRequest,
  sampleCommon,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CompareService } from '@/features/compare/services/compareService';
import { createReviewDiffService } from '@/features/reviews/services/reviewDiffService';
import { assemblePreviewDocument } from '@/lib/nunjucksRender';
import { getBodyInner } from '@/lib/templateDoc';
import { htmlWorkerImpl } from '@/workers/htmlWorkerImpl';
import { renderJinja } from './helpers/renderJinja';

// jsdom では Worker を起こせないので、worker の中身(linkedom の実装)を直接呼ぶ。
vi.mock('@/workers', () => ({
  htmlWorker: {
    buildHtmlDiff: (...a: Parameters<typeof htmlWorkerImpl.buildHtmlDiff>) =>
      htmlWorkerImpl.buildHtmlDiff(...a),
  },
}));

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const names = readdirSync(path.join(FIXTURES, 'templates')).filter((n) => n.endsWith('.html'));
const read = (dir: string, n: string) => readFileSync(path.join(FIXTURES, dir, n), 'utf8');
/** `XX01_950037_20240710_交付版.html` → `XX01_950037_交付版.css`。 */
const cssOf = (n: string) => {
  const [company, fund, , edition] = n.replace(/\.html$/, '').split('_');
  return read('css', `${company}_${fund}_${edition}.css`);
};

/** サーバが保存する作成経路の申請(比較元は空の本文と申請の CSS)。 */
function createReview(n: string, withFilled: boolean): ReviewRequest {
  const css = cssOf(n);
  return {
    id: `req-${n}`,
    templateId: n.replace(/\.html$/, ''),
    attributes: { companyCode: 'XX01', fundCode: '0', editionType: '交付版' },
    origin: 'create',
    status: 'pending',
    submittedBy: 'editor1',
    submittedAt: '2026-10-29T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: null,
    html: read('templates', n),
    css,
    ...(withFilled ? { filledHtml: read('filled', n) } : {}),
    baseHtml: '',
    baseCss: css,
  };
}

async function screenKeys(n: string, withFilled: boolean): Promise<string[]> {
  const reviews = { getReview: vi.fn().mockResolvedValue(ok(createReview(n, withFilled))) };
  const compare = {
    renderTemplateBody: vi
      .fn()
      .mockResolvedValue(ok({ html: getBodyInner(read('filled', n)), css: cssOf(n) })),
    renderVersionHtml: vi.fn(),
  } as unknown as CompareService;
  const parts = { listParts: vi.fn().mockResolvedValue(ok([])) };
  const service = createReviewDiffService(
    reviews as unknown as Parameters<typeof createReviewDiffService>[0],
    compare,
    parts as unknown as Parameters<typeof createReviewDiffService>[2],
  );
  const res = await service.buildDiff(`req-${n}`);
  if (!res.ok) throw new Error(res.error.message);
  expect(res.value.truncated).toBe(false);
  if (!withFilled) expect(compare.renderTemplateBody).toHaveBeenCalledTimes(1);
  return [...res.value.changes].sort((a, b) => a.no - b.no).map((c) => c.partKey);
}

describe('作成経路の申請の判定のキー', () => {
  it('Jinja 原文と値入りの組が 1 件以上ある', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(readdirSync(path.join(FIXTURES, 'filled'))).toContain(n);
  });

  it.each(names)(
    '%s: 右欄の行のキー(番号順) = Jinja 原文のパーツのキー(並び・重複まで)',
    async (n) => {
      const source = extractReviewParts(read('templates', n)).map((p) => p.partKey);
      expect(source.length).toBeGreaterThan(0);
      expect(extractReviewParts(read('filled', n)).map((p) => p.partKey)).toEqual(source);
      expect(await screenKeys(n, true)).toEqual(source);
      expect(await screenKeys(n, false)).toEqual(source);
    },
    30_000,
  );

  // 申請の受付(サーバの `assertCreateReviewable`)は、原文と値入り HTML のパーツの構造を
  // `extractReviewParts` で比べる。画面が送る値入り HTML は、プレビューの画面
  // (`templatePreviewService.ts` の `loadForPreview`)が原文を共通サンプルで描画して文書に組んだもの。
  it.each(names)(
    '%s: 画面が送る形の値入り HTML でも、受付が原文とパーツの構造を同じと見る',
    (n) => {
      const source = read('templates', n);
      const [company, fund, , edition] = n.replace(/\.html$/, '').split('_');
      const sample = applyTemplateAttributes(sampleCommon, {
        companyCode: company ?? '',
        fundCode: fund ?? '',
        editionType: edition ?? '',
      });
      const rendered = renderJinja(source, sample);
      expect(rendered.error).toBeNull();
      const filledHtml = assemblePreviewDocument(rendered.html, cssOf(n));
      expect(extractReviewParts(filledHtml).map((p) => p.partKey)).toEqual(
        extractReviewParts(source).map((p) => p.partKey),
      );
    },
  );
});
