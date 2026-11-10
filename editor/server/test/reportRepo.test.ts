// =============================================================================
// reportRepo.test.ts — create_report 連携の集約(会社コード引き・排他の外の検査・git コミット)
// =============================================================================
// generate / files / git は境界で差し替え、検査と呼び出しの順序だけを確かめる。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  generateFilled: vi.fn(),
  generateReportPdf: vi.fn(),
  listTemplateFiles: vi.fn(),
  readFilledHtml: vi.fn(),
  filledExists: vi.fn(),
  commitAll: vi.fn(),
  ensureRepo: vi.fn(),
  report: {} as unknown,
}));
vi.mock('../src/generate/createReport.js', () => ({
  generateFilled: m.generateFilled,
  generateReportPdf: m.generateReportPdf,
}));
vi.mock('../src/files/templateFiles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/files/templateFiles.js')>()),
  listTemplateFiles: m.listTemplateFiles,
  readFilledHtml: m.readFilledHtml,
  filledExists: m.filledExists,
}));
vi.mock('../src/git/gitRepo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/gitRepo.js')>()),
  ensureRepo: m.ensureRepo,
  commitAll: m.commitAll,
  withGitLock: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, k) => (k === 'report' ? m.report : Reflect.get(t, k)),
    }),
  };
});

import { REPORT_COMPANY_UNKNOWN, REPORT_INPUT_REF_OUTSIDE } from '@editor/shared';
import { createReportRepo } from '../src/repositories/reportRepo.js';

const ID = 'XX01_950037_20240710_交付版';
const SKELETON = 'XX01_950037_交付版.html';

function repoWith(companies: { companyCode: string; rep1CompanyCode: string }[]) {
  return createReportRepo({
    listCompanies: async () => companies.map((c) => ({ ...c, companyName: c.companyCode })),
  });
}

describe('reportRepo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.report = {};
    m.listTemplateFiles.mockResolvedValue([SKELETON]);
    m.generateFilled.mockResolvedValue({ created: true });
    m.generateReportPdf.mockResolvedValue(Buffer.from('%PDF'));
    m.readFilledHtml.mockResolvedValue('<p>ok</p>');
    m.filledExists.mockResolvedValue(true);
    m.commitAll.mockResolvedValue('sha');
  });

  it('status reflects config.report', () => {
    const repo = repoWith([]);
    expect(repo.status()).toEqual({ enabled: true });
    m.report = undefined;
    expect(repo.status()).toEqual({ enabled: false });
  });

  it('listSkeletons returns only 3-part templates', async () => {
    m.listTemplateFiles.mockResolvedValue([SKELETON, 'A_B_20240101_交付版.html', 'x.html']);
    expect(await repoWith([]).listSkeletons()).toEqual([
      { companyCode: 'XX01', fundCode: '950037', editionType: '交付版' },
    ]);
  });

  it('fill resolves rep1 code ignoring trailing spaces and case', async () => {
    const repo = repoWith([{ companyCode: 'xx01   ', rep1CompanyCode: ' R-XX01 ' }]);
    await repo.fill(ID, 'alice');
    expect(m.generateFilled).toHaveBeenCalledWith(ID, 'R-XX01');
  });

  it('fill rejects REPORT_COMPANY_UNKNOWN', async () => {
    const repo = repoWith([{ companyCode: 'ZZ99', rep1CompanyCode: 'R-ZZ99' }]);
    await expect(repo.fill(ID, 'alice')).rejects.toMatchObject({
      code: REPORT_COMPANY_UNKNOWN,
      kind: 'validation',
    });
    expect(m.generateFilled).not.toHaveBeenCalled();
  });

  it('fill rejects not_found when skeleton is missing', async () => {
    m.listTemplateFiles.mockResolvedValue([]);
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.fill(ID, 'alice')).rejects.toMatchObject({ kind: 'not_found' });
    expect(m.generateFilled).not.toHaveBeenCalled();
  });

  it('fill rejects a bad id', async () => {
    await expect(repoWith([]).fill('../x', 'alice')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('fill commits only when created', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    expect(await repo.fill(ID, 'alice')).toEqual({ created: true });
    expect(m.commitAll).toHaveBeenCalledTimes(1);
    expect(m.commitAll.mock.calls[0]?.[1]).toEqual({ name: 'alice' });

    m.commitAll.mockClear();
    m.generateFilled.mockResolvedValue({ created: false });
    expect(await repo.fill(ID, 'alice')).toEqual({ created: false });
    expect(m.commitAll).not.toHaveBeenCalled();
  });

  it('fill survives a git commit failure', async () => {
    m.commitAll.mockRejectedValue(new Error('lock'));
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    expect(await repo.fill(ID, 'alice')).toEqual({ created: true });
  });

  it('buildPdf passes the html to the generator', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    const pdf = await repo.buildPdf(ID, '<p>ok</p>');
    expect(pdf.toString()).toBe('%PDF');
    expect(m.generateReportPdf).toHaveBeenCalledWith(ID, '<p>ok</p>', 'R-XX01');
  });

  it('buildPdf rejects html whose scripts differ from filled', async () => {
    m.readFilledHtml.mockResolvedValue('<p>ok</p><script>a()</script>');
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, '<p>ok</p><script>evil()</script>')).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf rejects external refs', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, '<img src="https://evil.example/x.png">')).rejects.toMatchObject(
      { kind: 'validation' },
    );
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it.each([
    '<iframe src="../../../../x/appconfig.json"></iframe>',
    '<img src="/C:/x/appconfig.json">',
    '<object data="../.."></object>',
    '<link rel="stylesheet" href="../../x.css">',
    '<div style="background:url(../../x.png)"></div>',
    '<img srcset="../images/a.svg 1x, ../../x.png 2x">',
  ])('buildPdf rejects refs outside the asset dirs: %s', async (html) => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, html)).rejects.toMatchObject({
      kind: 'validation',
      code: REPORT_INPUT_REF_OUTSIDE,
    });
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf accepts refs to css, images and js', async () => {
    const html =
      '<link rel="stylesheet" href="../css/XX01_950037_交付版.css">' +
      '<img src="../images/XX01/a.svg"><script src="../js/x.js"></script>';
    m.readFilledHtml.mockResolvedValue(html);
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await repo.buildPdf(ID, html);
    expect(m.generateReportPdf).toHaveBeenCalledTimes(1);
  });

  it('buildPdf rejects editing markers', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, '<!-- jinja-rt:abc --><p>x</p>')).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf rejects not_found when filled is missing', async () => {
    m.filledExists.mockResolvedValue(false);
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, '<p>ok</p>')).rejects.toMatchObject({ kind: 'not_found' });
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf rejects REPORT_COMPANY_UNKNOWN', async () => {
    const repo = repoWith([]);
    await expect(repo.buildPdf(ID, '<p>ok</p>')).rejects.toMatchObject({
      code: REPORT_COMPANY_UNKNOWN,
    });
  });
});
