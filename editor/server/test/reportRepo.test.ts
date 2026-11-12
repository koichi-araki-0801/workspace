// =============================================================================
// reportRepo.test.ts — create_report 連携の集約(会社コード引き・排他の外の検査・git コミット)
// =============================================================================
// generate / files / git は境界で差し替え、検査と呼び出しの順序だけを確かめる。
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 偽の create_report.py を実プロセスで通すテスト用の置き場。`config.ts` は import 時に env を
// 読むので、importより前(hoisted)で設定する。
const fakeRoot = vi.hoisted(() => {
  const r = `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/editor-reportrepo-fake-${process.pid}`;
  process.env.DATA_ROOT = r;
  process.env.TEMPLATES_DIR = `${r}/templates`;
  process.env.FILLED_DIR = `${r}/filled`;
  process.env.LOG_DIR = `${r}/logs`;
  process.env.PYTHON_BIN = process.platform === 'win32' ? 'py' : 'python3';
  process.env.PYTHONUTF8 = '1';
  process.env.REPORT_SCRIPT = `${import.meta.dirname}/../scripts/fake_create_report.py`;
  delete process.env.REPORT_SCRIPT_SHA256;
  return r;
});

const m = vi.hoisted(() => ({
  generateFilled: vi.fn(),
  generateReportPdf: vi.fn(),
  buildOfficialPdf: vi.fn(),
  listTemplateFiles: vi.fn(),
  readFilledHtml: vi.fn(),
  filledExists: vi.fn(),
  lastCommitFor: vi.fn(),
  isAncestorOrSame: vi.fn(),
  removeOfficialPdf: vi.fn(),
  commitAll: vi.fn(),
  ensureRepo: vi.fn(),
  report: {} as unknown,
}));
vi.mock('../src/generate/createReport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate/createReport.js')>()),
  generateFilled: m.generateFilled,
  generateReportPdf: m.generateReportPdf,
  buildOfficialPdf: (...a: [string, string]) => m.buildOfficialPdf(...a),
}));
vi.mock('../src/files/templateFiles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/files/templateFiles.js')>()),
  listTemplateFiles: m.listTemplateFiles,
  readFilledHtml: m.readFilledHtml,
  filledExists: m.filledExists,
}));
vi.mock('../src/files/officialPdfFiles.js', () => ({
  removeOfficialPdf: m.removeOfficialPdf,
}));
vi.mock('../src/git/gitRepo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/gitRepo.js')>()),
  ensureRepo: m.ensureRepo,
  commitAll: m.commitAll,
  lastCommitFor: m.lastCommitFor,
  isAncestorOrSame: m.isAncestorOrSame,
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

import {
  REPORT_BUSY_USER,
  REPORT_BUSY_USER_MESSAGE,
  REPORT_COMPANY_UNKNOWN,
  REPORT_DISABLED,
  REPORT_INPUT_REF_OUTSIDE,
} from '@editor/shared';
import { config as realConfig } from '../src/config.js';
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
    m.buildOfficialPdf.mockResolvedValue(undefined);
    m.readFilledHtml.mockResolvedValue('<p>ok</p>');
    m.filledExists.mockResolvedValue(true);
    m.lastCommitFor.mockResolvedValue({ hash: 'c0', date: '2026-11-11T01:00:00.000Z' });
    m.isAncestorOrSame.mockResolvedValue(true);
    m.removeOfficialPdf.mockResolvedValue(undefined);
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
    m.filledExists.mockResolvedValue(false);
    const repo = repoWith([{ companyCode: 'xx01   ', rep1CompanyCode: ' R-XX01 ' }]);
    await repo.fill(ID, 'alice');
    expect(m.generateFilled).toHaveBeenCalledWith(ID, 'R-XX01');
  });

  it('fill opens an existing filled without asking the DB', async () => {
    const repo = createReportRepo({
      listCompanies: async () => {
        throw new Error('db down');
      },
    });
    expect(await repo.fill(ID, 'alice')).toEqual({ created: false });
    expect(m.generateFilled).not.toHaveBeenCalled();
    expect(m.commitAll).not.toHaveBeenCalled();
  });

  it('fill and buildPdf reject REPORT_DISABLED before asking the DB', async () => {
    m.report = undefined;
    m.filledExists.mockResolvedValue(false);
    const listCompanies = vi.fn(async () => []);
    const repo = createReportRepo({ listCompanies });
    await expect(repo.fill(ID, 'alice')).rejects.toMatchObject({ code: REPORT_DISABLED });
    m.filledExists.mockResolvedValue(true);
    await expect(repo.buildPdf(ID, '<p>ok</p>', 'alice')).rejects.toMatchObject({
      code: REPORT_DISABLED,
    });
    expect(listCompanies).not.toHaveBeenCalled();
  });

  it('fill rejects REPORT_COMPANY_UNKNOWN', async () => {
    m.filledExists.mockResolvedValue(false);
    const repo = repoWith([{ companyCode: 'ZZ99', rep1CompanyCode: 'R-ZZ99' }]);
    await expect(repo.fill(ID, 'alice')).rejects.toMatchObject({
      code: REPORT_COMPANY_UNKNOWN,
      kind: 'validation',
    });
    expect(m.generateFilled).not.toHaveBeenCalled();
  });

  it('fill rejects not_found when skeleton is missing', async () => {
    m.filledExists.mockResolvedValue(false);
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
    m.filledExists.mockResolvedValue(false);
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
    m.filledExists.mockResolvedValue(false);
    m.commitAll.mockRejectedValue(new Error('lock'));
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    expect(await repo.fill(ID, 'alice')).toEqual({ created: true });
  });

  it('buildPdf passes the html to the generator', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    const pdf = await repo.buildPdf(ID, '<p>ok</p>', 'alice');
    expect(pdf.toString()).toBe('%PDF');
    expect(m.generateReportPdf).toHaveBeenCalledWith(ID, '<p>ok</p>', 'R-XX01');
  });

  it('buildPdf rejects html whose scripts differ from filled', async () => {
    m.readFilledHtml.mockResolvedValue('<p>ok</p><script>a()</script>');
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(
      repo.buildPdf(ID, '<p>ok</p><script>evil()</script>', 'alice'),
    ).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf rejects external refs', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(
      repo.buildPdf(ID, '<img src="https://evil.example/x.png">', 'alice'),
    ).rejects.toMatchObject({ kind: 'validation' });
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
    await expect(repo.buildPdf(ID, html, 'alice')).rejects.toMatchObject({
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
    await repo.buildPdf(ID, html, 'alice');
    expect(m.generateReportPdf).toHaveBeenCalledTimes(1);
  });

  it('buildPdf rejects editing markers', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, '<!-- jinja-rt:abc --><p>x</p>', 'alice')).rejects.toMatchObject(
      {
        kind: 'validation',
      },
    );
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf rejects not_found when filled is missing', async () => {
    m.filledExists.mockResolvedValue(false);
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await expect(repo.buildPdf(ID, '<p>ok</p>', 'alice')).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(m.generateReportPdf).not.toHaveBeenCalled();
  });

  it('buildPdf rejects REPORT_COMPANY_UNKNOWN', async () => {
    const repo = repoWith([]);
    await expect(repo.buildPdf(ID, '<p>ok</p>', 'alice')).rejects.toMatchObject({
      code: REPORT_COMPANY_UNKNOWN,
    });
  });

  it('buildPdf limits one user to one running and one waiting', async () => {
    const releases: Array<() => void> = [];
    m.generateReportPdf.mockImplementation(
      () => new Promise<Buffer>((resolve) => releases.push(() => resolve(Buffer.from('%PDF')))),
    );
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    const first = repo.buildPdf(ID, '<p>ok</p>', 'alice');
    const second = repo.buildPdf(ID, '<p>ok</p>', 'alice');
    await expect(repo.buildPdf(ID, '<p>ok</p>', 'alice')).rejects.toMatchObject({
      code: REPORT_BUSY_USER,
      message: REPORT_BUSY_USER_MESSAGE,
      statusCode: 503,
    });
    // ほかの人の枠は別なので、alice の実行中でも bob は始まる。
    const other = repo.buildPdf(ID, '<p>ok</p>', 'bob');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const r of releases.splice(0)) {
      r();
    }
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]();
    await Promise.all([second, other]);
    expect(m.generateReportPdf).toHaveBeenCalledTimes(3);
  });

  it('requestOfficialPdf builds with the rep1 code and ends done', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await repo.requestOfficialPdf(ID);
    await repo.settleOfficialPdfs();
    expect(m.buildOfficialPdf).toHaveBeenCalledWith(ID, 'R-XX01');
    expect(await repo.officialPdfStatus(ID)).toMatchObject({ id: ID, state: 'done' });
  });

  it('a company lookup failure becomes a failed job, not a rejected request', async () => {
    m.lastCommitFor.mockResolvedValue(null);
    const repo = repoWith([]);
    await repo.requestOfficialPdf(ID);
    await repo.settleOfficialPdfs();
    expect(await repo.officialPdfStatus(ID)).toMatchObject({ state: 'failed' });
    expect(m.buildOfficialPdf).not.toHaveBeenCalled();
  });

  it('official pdf rejects REPORT_DISABLED and a missing filled', async () => {
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    m.filledExists.mockResolvedValue(false);
    await expect(repo.requestOfficialPdf(ID)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(repo.officialPdfStatus(ID)).rejects.toMatchObject({ kind: 'not_found' });
    m.report = undefined;
    await expect(repo.officialPdfStatus(ID)).rejects.toMatchObject({ code: REPORT_DISABLED });
  });

  it('a filled with an external ref fails the job without starting create_report', async () => {
    m.readFilledHtml.mockResolvedValue('<img src="https://evil.example/x.png">');
    m.lastCommitFor.mockResolvedValue(null);
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await repo.requestOfficialPdf(ID);
    await repo.settleOfficialPdfs();
    expect(await repo.officialPdfStatus(ID)).toMatchObject({ state: 'failed' });
    expect(m.buildOfficialPdf).not.toHaveBeenCalled();
  });

  it('removes the old pdf before the input check so a failed job leaves none', async () => {
    m.readFilledHtml.mockResolvedValue('<img src="https://evil.example/x.png">');
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await repo.requestOfficialPdf(ID);
    await repo.settleOfficialPdfs();
    expect(m.removeOfficialPdf).toHaveBeenCalledWith(ID);
    expect(m.buildOfficialPdf).not.toHaveBeenCalled();
  });

  it('requestOfficialPdf writes pdf/<id>.pdf through the fake create_report.py', async () => {
    const real = await vi.importActual<typeof import('../src/generate/createReport.js')>(
      '../src/generate/createReport.js',
    );
    m.buildOfficialPdf.mockImplementation(real.buildOfficialPdf);
    const files = await vi.importActual<typeof import('../src/files/officialPdfFiles.js')>(
      '../src/files/officialPdfFiles.js',
    );
    // 偽の create_report は git に記録しないので、PDF の有無をコミットの有無の代わりにする
    m.lastCommitFor.mockImplementation(async (rel: string) =>
      rel.startsWith('pdf/') && fs.existsSync(path.join(realConfig.pdfDir, rel.slice(4)))
        ? { hash: 'c0', date: '2026-11-11T01:00:00.000Z' }
        : null,
    );
    m.removeOfficialPdf.mockImplementation(files.removeOfficialPdf);
    // `config` はモック経由だと `report` が差し替わるので、本物の設定から取る。
    const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
    m.report = actual.config.report;
    // 偽のスクリプトは会社略称を templates/ のスケルトンから引く。
    fs.mkdirSync(`${fakeRoot}/templates`, { recursive: true });
    fs.writeFileSync(`${fakeRoot}/templates/${SKELETON}`, '<p>t</p>');
    fs.mkdirSync(realConfig.filledDir, { recursive: true });
    fs.writeFileSync(path.join(realConfig.filledDir, `${ID}.html`), '<p>filled</p>');
    const repo = repoWith([{ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' }]);
    await repo.requestOfficialPdf(ID);
    await repo.settleOfficialPdfs();
    const st = await repo.officialPdfStatus(ID);
    expect(st.error).toBeNull();
    expect(st.state).toBe('done');
    const pdf = fs.readFileSync(path.join(realConfig.pdfDir, `${ID}.pdf`), 'latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
  }, 60_000);
});

afterAll(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
