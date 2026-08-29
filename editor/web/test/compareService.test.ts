import {
  err,
  type HistoryRepository,
  isErr,
  isOk,
  notFound,
  ok,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateSnapshot,
  type TemplateVersionMeta,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPARE_RENDER_ERROR,
  createCompareService,
} from '@/features/compare/services/compareService';

// 実際の描画は opaque オリジンの iframe(`lib/renderHostClient.ts`)が行うため jsdom では
// 起動しない。ここで固定したいのはサービス側の組み立て・エラー伝播なので、隔離の
// **向こう側**にあたる nunjucks 実装を直に噛ませる。隔離クライアント自体の契約
// (発信元検証・保留・id 対応付け・期限)は `renderHostClient.test.ts` が固定する。
vi.mock('@/lib/renderHostClient', async () => {
  const { renderJinja } = await import('@/lib/nunjucksRender');
  return { renderJinjaIsolated: async (t: string, d: unknown) => renderJinja(t, d as never) };
});

const snapshot: TemplateSnapshot = {
  historyId: 'eh-1',
  templateId: 'AM01_510037_20240710_kr',
  html: '<p>{{ fund.name }}</p>',
  css: '.x{}',
  fundCode: '510037',
  timestamp: '2026-06-01T00:00:00.000Z',
};

describe('CompareService.renderVersionHtml', () => {
  it('propagates not_found when the snapshot is missing', async () => {
    const history = {
      getSnapshot: vi.fn(async () => err(notFound('no snapshot'))),
    } as unknown as HistoryRepository;
    const templates = {} as TemplateRepository;
    const svc = createCompareService(templates, history);

    const res = await svc.renderVersionHtml('eh-missing');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('not_found');
  });

  it('renders the current template (baseline=現行版) to value-filled HTML', async () => {
    // baseline historyId は snapshot を経ず、現在のテンプレート HTML をサンプル値で描画する。
    const templates = {
      getTemplate: vi.fn(async () =>
        ok({
          meta: { attributes: { fundCode: '510037' } },
          html: '<p>{{ fund.name }}</p>',
          css: '.base{}',
          filled: '',
        }),
      ),
      getSampleData: vi.fn(async () => ok({ fund: { name: '原本ファンド' } })),
    } as unknown as TemplateRepository;
    const history = {} as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersionHtml('baseline:AM01_510037_20240710_kr');

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.html).toContain('原本ファンド');
      expect(res.value.css).toBe('.base{}');
    }
  });

  it('propagates a getTemplate error on the 現行版 baseline path', async () => {
    const templates = {
      getTemplate: vi.fn(async () => err(notFound('no template'))),
    } as unknown as TemplateRepository;
    const svc = createCompareService(templates, {} as HistoryRepository);
    const res = await svc.renderVersionHtml('baseline:t');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe('not_found');
  });

  it('propagates a getSampleData error on the 現行版 baseline path', async () => {
    const templates = {
      getTemplate: vi.fn(async () =>
        ok({ meta: { attributes: { fundCode: '510037' } }, html: '<p/>', css: '', filled: '' }),
      ),
      getSampleData: vi.fn(async () => err(notFound('no sample'))),
    } as unknown as TemplateRepository;
    const svc = createCompareService(templates, {} as HistoryRepository);
    const res = await svc.renderVersionHtml('baseline:t');
    expect(isErr(res)).toBe(true);
  });

  it('returns the safe render error when the 現行版 baseline fails to render', async () => {
    const templates = {
      getTemplate: vi.fn(async () =>
        ok({ meta: { attributes: { fundCode: '510037' } }, html: '{% if %}', css: '', filled: '' }),
      ),
      getSampleData: vi.fn(async () => ok({})),
    } as unknown as TemplateRepository;
    const svc = createCompareService(templates, {} as HistoryRepository);
    const res = await svc.renderVersionHtml('baseline:t');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(COMPARE_RENDER_ERROR);
  });

  it('renders the snapshot to HTML and returns the html and snapshot css', async () => {
    const history = {
      getSnapshot: vi.fn(async () => ok(snapshot)),
    } as unknown as HistoryRepository;
    const templates = {
      getSampleData: vi.fn(async () => ok({ fund: { name: 'テストファンド' } })),
    } as unknown as TemplateRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersionHtml('eh-1');

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // the nunjucks-applied HTML and the snapshot CSS come back unchanged
      expect(res.value.html).toContain('テストファンド');
      expect(res.value.css).toBe('.x{}');
    }
  });

  it('returns the safe render error when the template fails to render', async () => {
    const history = {
      getSnapshot: vi.fn(async () => ok({ ...snapshot, html: '{% if %}' })),
    } as unknown as HistoryRepository;
    const templates = {
      getSampleData: vi.fn(async () => ok({})),
    } as unknown as TemplateRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.renderVersionHtml('eh-1');

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(COMPARE_RENDER_ERROR);
  });
});

describe('CompareService.listCandidates', () => {
  const meta = (id: string): TemplateMeta => ({
    id,
    attributes: {
      companyCode: 'AM01',
      fundCode: '510037',
      baseDate: '20240710',
      editionType: '確報',
    },
    fileName: `${id}.html`,
    status: 'published',
    updatedAt: null,
    updatedBy: null,
  });
  const version = (historyId: string, templateId: string): TemplateVersionMeta => ({
    historyId,
    templateId,
    timestamp: '2024-07-10T00:00:00.000Z',
    user: '山田太郎',
    summary: '確定保存',
  });

  it('counts confirmed versions plus the always-present 現行版 baseline (+1)', async () => {
    const versionsById: Record<string, TemplateVersionMeta[]> = {
      a: [version('a2', 'a'), version('a1', 'a')],
      b: [version('b1', 'b')],
      c: [],
    };
    const templates = {
      listTemplates: vi.fn(async () => ok([meta('a'), meta('b'), meta('c')])),
    } as unknown as TemplateRepository;
    const history = {
      listVersions: vi.fn(async (id: string) => ok(versionsById[id] ?? [])),
    } as unknown as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // 確定版数 + 現行版 1。確定版ゼロの c も 1 版になり比較対象に出る。
      expect(res.value.map((c) => [c.meta.id, c.versionCount])).toEqual([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ]);
      // 各候補は版リスト(現行版込み)を持ち、先頭が現行版 baseline、長さは versionCount に一致。
      for (const c of res.value) {
        expect(c.versions).toHaveLength(c.versionCount);
        expect(c.versions[0].historyId).toBe(`baseline:${c.meta.id}`);
      }
      // a は現行版(最新)の後に確定版(新しい順) a2,a1 が続く。
      expect(res.value[0].versions.map((v) => v.historyId)).toEqual(['baseline:a', 'a2', 'a1']);
    }
  });

  it('includes un-edited (zero-snapshot) published templates via the baseline', async () => {
    const templates = {
      listTemplates: vi.fn(async () => ok([meta('d')])),
    } as unknown as TemplateRepository;
    const history = {
      listVersions: vi.fn(async () => ok([])),
    } as unknown as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});

    expect(isOk(res)).toBe(true);
    // 確定版スナップショットがゼロでも除外されず、現行版 1 版を持つ候補として出る。
    if (isOk(res)) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0].meta.id).toBe('d');
      expect(res.value[0].versionCount).toBe(1);
    }
  });

  it('excludes unapproved (draft = pending) templates', async () => {
    // `listTemplates` は編集タブが生成直後のテンプレへ到達できるよう pending も返す。
    // 比較は確定済み同士で行うので、呼び出し側で落とせていなければ未承認の内容が
    // 比較画面(= 承認者が見る面)へ載る。
    const templates = {
      listTemplates: vi.fn(async () =>
        ok([meta('a'), { ...meta('pending1'), status: 'draft' as const }]),
      ),
    } as unknown as TemplateRepository;
    const history = {
      listVersions: vi.fn(async () => ok([])),
    } as unknown as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.map((c) => c.meta.id)).toEqual(['a']);
  });

  it('propagates a listTemplates error', async () => {
    const templates = {
      listTemplates: vi.fn(async () => err(notFound('boom'))),
    } as unknown as TemplateRepository;
    const history = {} as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});
    expect(isErr(res)).toBe(true);
  });

  it('propagates a listVersions error while counting candidates', async () => {
    const templates = {
      listTemplates: vi.fn(async () => ok([meta('a')])),
    } as unknown as TemplateRepository;
    const history = {
      listVersions: vi.fn(async () => err(notFound('boom'))),
    } as unknown as HistoryRepository;

    const svc = createCompareService(templates, history);
    const res = await svc.listCandidates({});
    expect(isErr(res)).toBe(true);
  });
});

describe('CompareService delegation', () => {
  it('listTemplates delegates; listVersions delegates then prepends the 現行版 baseline', async () => {
    const listTemplates = vi.fn(async () => ok([]));
    const listVersions = vi.fn(async () => ok([]));
    const svc = createCompareService(
      { listTemplates } as unknown as TemplateRepository,
      { listVersions } as unknown as HistoryRepository,
    );
    await svc.listTemplates({ companyCode: 'AM01' });
    const vers = await svc.listVersions('tpl-1');
    expect(listTemplates).toHaveBeenCalledWith({ companyCode: 'AM01' });
    expect(listVersions).toHaveBeenCalledWith('tpl-1');
    // snapshot ゼロでも先頭に現行版(baseline)が 1 件足される。
    expect(isOk(vers)).toBe(true);
    if (isOk(vers)) {
      expect(vers.value).toHaveLength(1);
      expect(vers.value[0].historyId).toBe('baseline:tpl-1');
    }
  });

  it('propagates a listVersions error without appending the baseline', async () => {
    const listVersions = vi.fn(async () => err(notFound('boom')));
    const svc = createCompareService(
      {} as TemplateRepository,
      { listVersions } as unknown as HistoryRepository,
    );
    const res = await svc.listVersions('tpl-1');
    expect(isErr(res)).toBe(true);
  });
});
