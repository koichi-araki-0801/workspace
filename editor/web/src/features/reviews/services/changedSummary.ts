// =============================================================================
// changedSummary.ts — 申請時に計算する変更概要(一覧の先出し表示用・自己申告)
// =============================================================================
// 承認タブの一覧で「変更 N か所(業務名…)」を開く前に見せるための概要。差分計算は
// web 側にしか無く一覧表示のたびに全件計算はできないため、**申請者のブラウザが申請時に
// 1 回計算して meta に保存**する。参考情報であり承認判断には使わない(精査画面はその場で
// 実差分を計算する)。計算のどこで失敗しても null を返し、申請そのものは決して止めない。
import { isErr, type PartRepository, type Result, type ReviewChangedSummary } from '@editor/shared';
import { usePartRepo } from '@/api/repositories';
import { type CompareService, useCompareService } from '@/features/compare/services/compareService';
import { htmlWorker } from '@/workers';
import { loadPartNameMap, partIdFromBlockKey } from './partNames';

interface SummaryInput {
  templateId: string;
  html: string;
  css: string;
  fundCode: string;
  origin: 'edit' | 'create';
}

/** 依存の束(テストで差し替える点)。実運用は `createChangedSummaryService` が既定を組む。 */
export interface SummaryDeps {
  renderAfter: (
    html: string,
    css: string,
    fundCode: string,
  ) => Promise<Result<{ html: string; css: string }>>;
  renderBefore: (templateId: string) => Promise<Result<{ html: string; css: string }>>;
  buildHtmlDiff: (
    beforeHtml: string,
    afterHtml: string,
    cssBefore: string,
    cssAfter: string,
  ) => Promise<{ pages: { blocks: { key: string; label: string; status: string }[] }[] }>;
  loadNames: () => Promise<ReadonlyMap<string, string>>;
}

/** 概要に載せる名前の上限。超過分は count だけが伝える(names は先頭から切る)。 */
const MAX_NAMES = 10;

/**
 * 概要用のラベル。`partNames.businessLabel` は精査画面の行(ページごとに 1 行)向けに
 * 一致時「業務名（N ページ目）」を返すが、この概要は複数ページに跨る同一パーツを
 * 1 件へ**重複除去**したい(件数と一致しない名前一覧は誤解を招く)。ページ番号を混ぜると
 * 別ページの同名パーツが別文字列になり重複が潰れないため、一致時は名前のみを返す。
 */
function summaryLabel(
  key: string,
  fallbackLabel: string,
  nameById: ReadonlyMap<string, string>,
): string {
  const id = partIdFromBlockKey(key);
  const name = id ? nameById.get(id) : undefined;
  return name ?? fallbackLabel;
}

export async function computeChangedSummaryWith(
  input: SummaryInput,
  deps: SummaryDeps,
): Promise<ReviewChangedSummary | null> {
  try {
    const afterRes = await deps.renderAfter(input.html, input.css, input.fundCode);
    if (isErr(afterRes)) return null;
    let beforeHtml = '';
    let cssBefore = afterRes.value.css;
    if (input.origin === 'edit') {
      const beforeRes = await deps.renderBefore(input.templateId);
      if (!isErr(beforeRes)) {
        beforeHtml = beforeRes.value.html;
        cssBefore = beforeRes.value.css;
      }
    }
    const diff = await deps.buildHtmlDiff(
      beforeHtml,
      afterRes.value.html,
      cssBefore,
      afterRes.value.css,
    );
    const nameById = await deps.loadNames();
    const changed = diff.pages.flatMap((p) => p.blocks).filter((b) => b.status !== 'same');
    const names = [...new Set(changed.map((b) => summaryLabel(b.key, b.label, nameById)))];
    return { count: changed.length, names: names.slice(0, MAX_NAMES) };
  } catch {
    return null;
  }
}

/** 申請ボタンの event handler から使う入口。 */
export interface ChangedSummaryService {
  computeChangedSummary(input: SummaryInput): Promise<ReviewChangedSummary | null>;
}

/** 実運用の DI ファクトリ。compare / worker / パーツカタログを既定依存として束ねる。 */
export function createChangedSummaryService(
  compare: CompareService,
  parts: PartRepository,
): ChangedSummaryService {
  return {
    computeChangedSummary: (input) =>
      computeChangedSummaryWith(input, {
        renderAfter: (html, css, fundCode) => compare.renderTemplateBody(html, css, fundCode),
        renderBefore: (templateId) => compare.renderVersionHtml(`baseline:${templateId}`),
        buildHtmlDiff: (b, a, cb, ca) => htmlWorker.buildHtmlDiff(b, a, cb, ca),
        loadNames: () => loadPartNameMap(parts),
      }),
  };
}

// `useCompareService`/`usePartRepo` は Vue の `inject` を使うため setup 時にしか呼べない。
// 申請ボタンの押下(async event handler)は setup 実行後に走るので、依存の取得は
// `useChangedSummaryService()` を setup で 1 度だけ呼んで済ませ、返した
// `computeChangedSummary` を event handler 側から使う(他の `use*Service` と同型)。
export const useChangedSummaryService = (): ChangedSummaryService =>
  createChangedSummaryService(useCompareService(), usePartRepo());
