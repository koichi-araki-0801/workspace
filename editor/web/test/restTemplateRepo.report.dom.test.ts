import { isErr, isOk, REPORT_TIMEOUT } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restTemplateRepo } from '@/api/rest/templateRepo';

function stubFetch(res: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => res);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('restTemplateRepo の create_report 連携', () => {
  it('getReportStatus と listReportSkeletons は GET で値を返す', async () => {
    const f = stubFetch(jsonRes({ enabled: true }));
    const st = await restTemplateRepo.getReportStatus();
    expect(isOk(st) && st.value.enabled).toBe(true);
    expect(String(f.mock.calls[0]?.[0])).toContain('/api/report/status');

    const sk = { companyCode: 'XX01', fundCode: '950037', editionType: '交付版' };
    const f2 = stubFetch(jsonRes({ skeletons: [sk] }));
    const list = await restTemplateRepo.listReportSkeletons();
    expect(isOk(list) && list.value).toEqual([sk]);
    expect(String(f2.mock.calls[0]?.[0])).toContain('/api/report/skeletons');
  });

  it('fillTemplate は POST /api/templates/:id/fill を呼ぶ', async () => {
    const f = stubFetch(jsonRes({ created: true }));
    const res = await restTemplateRepo.fillTemplate('XX01_950037_交付版');
    expect(isOk(res) && res.value.created).toBe(true);
    expect(String(f.mock.calls[0]?.[0])).toContain(
      '/api/templates/XX01_950037_%E4%BA%A4%E4%BB%98%E7%89%88/fill',
    );
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
  });

  it('fillTemplate maps 504 REPORT_TIMEOUT to error result with code', async () => {
    stubFetch(jsonRes({ kind: 'unexpected', message: '時間切れ', code: REPORT_TIMEOUT }, 504));
    const res = await restTemplateRepo.fillTemplate('XX01_950037_交付版');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.code).toBe(REPORT_TIMEOUT);
      expect(res.error.message).toBe('時間切れ');
    }
  });

  it('buildReportPdf posts {html} to /api/templates/:id/report-pdf and returns blob', async () => {
    const f = stubFetch(
      new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    );
    const res = await restTemplateRepo.buildReportPdf('XX01_950037_交付版', '<p>x</p>');
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.size).toBe(8);
    }
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/templates\/.+\/report-pdf$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ html: '<p>x</p>' });
  });

  it('buildReportPdf は失敗応答の code と message を保つ', async () => {
    stubFetch(
      jsonRes(
        { kind: 'unexpected', message: '混み合っています', code: 'GENERATE_QUEUE_FULL' },
        503,
      ),
    );
    const res = await restTemplateRepo.buildReportPdf('XX01_950037_交付版', '<p>x</p>');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.code).toBe('GENERATE_QUEUE_FULL');
      expect(res.error.message).toBe('混み合っています');
    }
  });

  it('buildReportPdf は通信失敗を network エラーにする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('x');
      }),
    );
    const res = await restTemplateRepo.buildReportPdf('XX01_950037_交付版', '<p>x</p>');
    expect(isErr(res) && res.error.kind).toBe('network');
  });
});

describe('restTemplateRepo の不明な応答', () => {
  it('buildReportPdf は構造化されていない 401 を unauthorized にする', async () => {
    stubFetch(new Response('x', { status: 401 }));
    const res = await restTemplateRepo.buildReportPdf('XX01_950037_交付版', '<p>x</p>');
    expect(isErr(res) && res.error.kind).toBe('unauthorized');
  });
});
