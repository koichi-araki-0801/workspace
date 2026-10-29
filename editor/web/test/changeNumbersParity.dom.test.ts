// =============================================================================
// changeNumbersParity.dom.test.ts — 編集画面と承認タブの変更の番号のパリティ
// =============================================================================
// 編集画面の丸数字(`useChangeNumbers`)と承認タブの番号(`reviewDiffService`)は、同じ差分
// (`buildHtmlDiff`)に同じ `numberChangedParts` を当てて一致させる(計画で決めたこと 22)。ここでは
// fixture を GrapesJS の canvas で直し、編集画面側はその canvas の本文から、承認タブ側は同じ本文を
// 下書きにして申請を組み(`templatePreviewService`)、その申請を `reviewDiffService` の実経路へ
// 通して、両側の (no, partKey, kind) を比べる。
// 番号の一致は保存済みの下書きの時点で比べる(編集画面はライブの canvas、申請は保存済みの下書きから
// 組むため、保存の前の一瞬はずれうる)。差分は両側とも worker と同じ linkedom のパーサで取る。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ChangedPart,
  type HistoryRepository,
  isErr,
  numberChangedParts,
  ok,
  type PartRepository,
  type ReviewRepository,
  type ReviewRequest,
  type Template,
  type TemplateRepository,
} from '@editor/shared';
import type { Component, Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompareService } from '@/features/compare/services/compareService';
import { canvasRoot } from '@/features/editor/canvasGeometry';
import { canvasRawKey, partEntries } from '@/features/editor/partKey';
import { changeBaselineOf, useChangeNumbers } from '@/features/editor/useChangeNumbers';
import { useGrapes } from '@/features/editor/useGrapes';
import { submitBodyOf } from '@/features/preview/services/submitBody';
import { createTemplatePreviewService } from '@/features/preview/services/templatePreviewService';
import { createReviewDiffService } from '@/features/reviews/services/reviewDiffService';
import { getBodyInner } from '@/lib/templateDoc';
import { htmlWorker } from '@/workers';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));
// worker と同じ linkedom のパーサで差分を取る(jsdom では Worker を起こせない)。
vi.mock('@/workers', async () => {
  const { htmlWorkerImpl } = await import('@/workers/htmlWorkerImpl');
  const { toAsyncApi } = await import('@/workers/htmlApi');
  return { htmlWorker: toAsyncApi(htmlWorkerImpl) };
});

const NAME = 'XX01_950037_20240710_交付版';
const FILLED = readFileSync(path.resolve(__dirname, `../../fixtures/filled/${NAME}.html`), 'utf8');
const CSS = '.cover-title{font-size:20px}';
const tpl: Template = {
  meta: {
    id: NAME,
    attributes: {
      companyCode: 'XX01',
      fundCode: '950037',
      baseDate: '20240710',
      editionType: '交付版',
    },
    fileName: `${NAME}.html`,
    status: 'published',
    updatedAt: null,
    updatedBy: null,
  },
  html: FILLED,
  css: CSS,
  filled: FILLED,
};
/** `loadForEdit` の `confirmedBody`(確定版の本文の原文)。 */
const confirmedBody = getBodyInner(FILLED);

let g: ReturnType<typeof useGrapes>;
let viewEl: HTMLElement | undefined;

/** wrapper の view を作って文書へ置く(`canvasPages.dom.test.ts` と同じ。本番の描画の代わり)。 */
function render(): HTMLElement {
  viewEl?.remove();
  const ed = g.editor.value as Editor;
  const wrapper = ed.getWrapper() as Component;
  // biome-ignore lint/suspicious/noExplicitAny: GrapesJS の view の型は公開されていない
  const View = (ed.Components.getType('wrapper') as any).view;
  const view = new View({
    model: wrapper,
    config: ed.Components.config,
    componentTypes: ed.Components.componentTypes,
  });
  viewEl = view.render().el as HTMLElement;
  document.body.appendChild(viewEl);
  g.refreshPageMarks();
  return viewEl;
}

/** モデル木からクラスで component を探す。 */
function byClass(cls: string): Component {
  const walk = (c: Component): Component | undefined => {
    if (c.getClasses().includes(cls)) return c;
    for (const child of c.components()) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  const hit = walk(g.editor.value?.getWrapper() as Component);
  if (!hit) throw new Error(`no .${cls}`);
  return hit;
}

/** canvas の操作で 1 つの文字の変更・1 つの削除・1 つの追加を入れる。 */
function editCanvas(): void {
  byClass('cover-title').components('ダミーバランスファンド(改)');
  byClass('cover_report').remove();
  const wrapper = g.editor.value?.getWrapper() as Component;
  const body = byClass('cover_body');
  wrapper.append('<p class="added-note">追加した注記</p>', { at: body.index() + 1 });
  render();
}

/** 承認タブ側: canvas の本文を下書きにして申請を組み、`reviewDiffService` の実経路で番号を振る。 */
async function reviewSide(canvasBody: string): Promise<ChangedPart[]> {
  const templates = {
    getTemplate: vi.fn(async () => ok(tpl)),
    getSampleData: vi.fn(async () => ok({ sample: {}, warnings: [] })),
    getDraft: vi.fn(async () =>
      ok({ templateId: NAME, html: canvasBody, css: CSS, savedAt: '', savedBy: '' }),
    ),
  } as unknown as TemplateRepository;
  const history = {} as unknown as HistoryRepository;
  const owner = { claim: vi.fn(), release: vi.fn(), belongsToSession: vi.fn(() => true) };
  const preview = await createTemplatePreviewService(templates, history, owner).loadForPreview(
    NAME,
  );
  if (isErr(preview)) throw new Error(preview.error.message);
  const review: ReviewRequest = {
    id: 'req-1',
    templateId: NAME,
    attributes: tpl.meta.attributes,
    origin: 'edit',
    status: 'pending',
    submittedBy: 'editor1',
    submittedAt: '2025-01-02T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: 'h0',
    // 申請の本文(`PreviewView` は `restoredHtml` を送る)と、サーバが申請時に読む確定版の原文。
    html: preview.value.restoredHtml,
    css: preview.value.css,
    baseHtml: FILLED,
    baseCss: CSS,
  };
  const reviews = { getReview: vi.fn(async () => ok(review)) } as unknown as ReviewRepository;
  const parts = { listParts: vi.fn(async () => ok([])) } as unknown as PartRepository;
  const res = await createReviewDiffService(
    reviews,
    createCompareService(templates, history),
    parts,
  ).buildDiff('req-1');
  if (isErr(res)) throw new Error(res.error.message);
  return res.value.changes;
}

/** 編集画面側: `useChangeNumbers` の入力(確定版の原文と申請と同じ組み立ての本文)で番号を振る。 */
async function editorSide(): Promise<ChangedPart[]> {
  const diff = await htmlWorker.buildHtmlDiff(confirmedBody, submitBodyOf(FILLED, g.getBodyHtml()));
  return numberChangedParts(diff);
}

const sig = (parts: ChangedPart[]) => parts.map((p) => [p.no, p.partKey, p.kind]);

/** canvas の全パーツのキー(目印を測る `partEntries` と同じ数え方)。 */
function canvasKeys(): Set<string> {
  const ed = g.editor.value as Editor;
  const root = canvasRoot(g.editor) ?? (viewEl as HTMLElement);
  return new Set(partEntries(root, canvasRawKey(ed)).map((e) => e.key));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  g = useGrapes();
  g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
  const ed = g.editor.value as Editor;
  vi.spyOn(ed.Canvas, 'getDocument').mockReturnValue(document);
  ed.trigger('load');
  g.load(confirmedBody, CSS);
  render();
});

afterEach(() => {
  viewEl?.remove();
  viewEl = undefined;
  g.destroy();
  for (const s of Array.from(document.head.querySelectorAll('style'))) s.remove();
});

describe('編集画面と承認タブの変更の番号', () => {
  it('fixture を canvas 経路で 1 か所直して申請したとき、編集画面と承認タブの (no, partKey, kind) が一致する', async () => {
    editCanvas();
    const body = g.getBodyHtml();
    const edit = await editorSide();
    const review = await reviewSide(body);
    expect(sig(edit)).toEqual(sig(review));
    // 直したパーツだけに番号が付く(変更のないパーツに番号が付かない)。
    expect(sig(edit)).toEqual([
      [1, '.cover_header#1', 'changed'],
      [2, '.cover_report#1', 'removed'],
      [3, '.added-note#1', 'added'],
    ]);

    // `useChangeNumbers` の出力は同じ番号を canvas のキーと削除パーツへ分ける。
    const n = useChangeNumbers({
      baseline: () => confirmedBody,
      current: () => submitBodyOf(FILLED, g.getBodyHtml()),
    });
    await n.flush();
    expect([...n.numbers.value.byKey]).toEqual([
      ['.cover_header#1', 1],
      ['.added-note#1', 3],
    ]);
    expect(n.numbers.value.removed.map((r) => [r.no, r.key])).toEqual([[2, '.cover_report#1']]);
    // 編集側の番号のキーは、canvas の目印が測るパーツのキーに全件ある。
    const keys = canvasKeys();
    for (const key of n.numbers.value.byKey.keys()) expect(keys.has(key), key).toBe(true);
  });

  it('無変更なら両側とも番号は空', async () => {
    const body = g.getBodyHtml();
    expect(await editorSide()).toEqual([]);
    expect(await reviewSide(body)).toEqual([]);
  });

  it('赤入れを出しても番号は変わらない', async () => {
    editCanvas();
    const before = sig(await editorSide());
    const keysBefore = canvasKeys();
    // 赤入れは canvas の生 DOM だけに旧文言を置く(`redlineApply.ts`)。根の直下の削除の帯と、
    // パーツの中の取り消し線を置く。
    const root = canvasRoot(g.editor) ?? (viewEl as HTMLElement);
    const block = document.createElement('del');
    block.setAttribute('data-redline', '');
    block.className = 'redline-block';
    block.textContent = '交付運用報告書(交付版)';
    root.insertBefore(block, root.children[1] ?? null);
    const inline = document.createElement('del');
    inline.setAttribute('data-redline', '');
    inline.textContent = '旧ファンド名';
    root.querySelector('.cover-title')?.appendChild(inline);

    expect(g.getBodyHtml()).not.toContain('data-redline');
    expect(sig(await editorSide())).toEqual(before);
    expect(canvasKeys()).toEqual(keysBefore);
  });

  it('tpl.filled が無い経路(作成経路)では番号を出さない', async () => {
    // 作成経路は確定版が無い。値入り HTML の無いテンプレも、申請の本文が Jinja 復元を通るので出さない。
    expect(changeBaselineOf({ isCreateRoute: true, filled: FILLED, confirmedBody })).toBeNull();
    expect(changeBaselineOf({ isCreateRoute: false, filled: '', confirmedBody })).toBeNull();
    expect(changeBaselineOf({ isCreateRoute: false, filled: FILLED, confirmedBody })).toBe(
      confirmedBody,
    );
    const n = useChangeNumbers({
      baseline: () => changeBaselineOf({ isCreateRoute: true, filled: FILLED, confirmedBody }),
      current: () => submitBodyOf(FILLED, g.getBodyHtml()),
    });
    editCanvas();
    await n.flush();
    expect(n.numbers.value.byKey.size).toBe(0);
    expect(n.numbers.value.removed).toEqual([]);
  });
});
