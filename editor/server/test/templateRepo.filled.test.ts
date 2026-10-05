// =============================================================================
// templateRepo.filled.test.ts — 編集タブの一覧・取得が filled/ を主、templates/ を従とすること
// =============================================================================
// 値入り HTML(filled/)を置いたテンプレだけが一覧に出て、取得は filled/ の本文を `html` と
// `filled` の両方に返す。templates/(作成タブの Jinja)にしか無い id は一覧に出ないが、
// 取得では読める(作成経路の承認直後に精査画面が確定版を読むため)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleCommon } from '@editor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SprocClient } from '../src/db/sproc.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-filled-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const FILLED_ID = 'AM01_510037_20240710_交付版';
const JINJA_ONLY_ID = 'AM01_510037_全体版';
const BOTH_ID = 'AM01_110024_20251117_交付版';
const SKELETON_ID = 'AM01_510124_交付版';
const SKELETON_PENDING_ID = 'AM01_510155_交付版';
const NO_COMPANY_ID = '510037_20240710_交付版';

describe('templateRepo と filled/', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'css', 'pending']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, 'filled', `${FILLED_ID}.html`), '<p>値入り 510037</p>', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'templates', `${JINJA_ONLY_ID}.html`),
      '<p>{{ x }}</p>',
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'templates', `${BOTH_ID}.html`), '<p>{{ y }}</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'filled', `${BOTH_ID}.html`), '<p>値入り 110024</p>', 'utf8');
    fs.writeFileSync(path.join(tmp, 'css', '510037.css'), '.a{}', 'utf8');
    // 会社コードの無い 3 つ区切り(ファンド_基準日_版種)。3 つ区切りはテンプレートの形なので
    // 会社=510037・ファンド=20240710 と読めてしまうが、値入り HTML ではない。
    fs.writeFileSync(path.join(tmp, 'filled', `${NO_COMPANY_ID}.html`), '<p>会社なし</p>', 'utf8');
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    fs.writeFileSync(path.join(tmp, 'templates', `${SKELETON_ID}.html`), '<p>{{ s }}</p>', 'utf8');
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending(SKELETON_PENDING_ID, '<p>{{ 生成直後 }}</p>', '');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('一覧は filled/ にあるテンプレだけを published として返す', async () => {
    const ids = (await repo.listTemplates({}))
      .filter((m) => m.status === 'published')
      .map((m) => `${m.id}:${m.status}`);
    expect(ids).toEqual([`${BOTH_ID}:published`, `${FILLED_ID}:published`]);
  });

  it('テンプレート(3 つ区切り)は templates/ を読み、基準日を持たない', async () => {
    const t = await repo.getTemplate(SKELETON_ID);
    expect(t.html).toBe('<p>{{ s }}</p>');
    expect(t.filled).toBe('');
    expect(t.meta.status).toBe('published');
    expect(t.meta.attributes).toEqual({
      companyCode: 'AM01',
      fundCode: '510124',
      editionType: '交付版',
    });
  });

  it('pending/ にしか無いテンプレート(基準日なし)は取得できるが、編集タブの一覧と候補には出ない', async () => {
    const t = await repo.getTemplate(SKELETON_PENDING_ID);
    expect(t.meta.status).toBe('draft');
    const ids = (await repo.listTemplates({})).map((m) => m.id);
    expect(ids).not.toContain(SKELETON_PENDING_ID);
    const opts = await repo.getDropdownOptions({ companyCode: 'AM01' }, 'edit');
    expect(opts.fundCodes).not.toContain('510155');
  });

  it('filled/ の 3 つ区切り(ファンド_基準日_版種 など)は一覧にも候補にも出ない', async () => {
    const ids = (await repo.listTemplates({})).map((m) => m.id);
    expect(ids).not.toContain(NO_COMPANY_ID);
    for (const scope of ['edit', 'published'] as const) {
      const opts = await repo.getDropdownOptions({}, scope);
      expect(opts.companyCodes).not.toContain('510037');
    }
  });

  it('pending/ の基準日つき(4 つ区切り)は編集タブの一覧に draft で出る', async () => {
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM01_510999_20240711_交付版', '<p>生成直後</p>', '');
    const row = (await repo.listTemplates({})).find((m) => m.id === 'AM01_510999_20240711_交付版');
    expect(row?.status).toBe('draft');
  });

  it('基準日で絞った一覧と候補に、基準日を持たない行は混ざらない', async () => {
    const ids = (await repo.listTemplates({ baseDate: '20240710' })).map((m) => m.id);
    expect(ids).not.toContain(SKELETON_PENDING_ID);
    const opts = await repo.getDropdownOptions({}, 'edit');
    expect(opts.baseDates.every((d) => d !== '')).toBe(true);
  });

  it('4 つ区切りの id は templates/ を読まない(旧形式のファイルがあっても filled/ → pending/ だけ)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'templates', 'AM01_510003_20240710_交付版.html'),
      '<p>旧形式</p>',
      'utf8',
    );
    await expect(repo.getTemplate('AM01_510003_20240710_交付版')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('取得は filled/ の本文を html と filled の両方に返す', async () => {
    const t = await repo.getTemplate(FILLED_ID);
    expect(t.html).toBe('<p>値入り 510037</p>');
    expect(t.filled).toBe('<p>値入り 510037</p>');
    expect(t.css).toBe('.a{}');
    expect(t.meta.status).toBe('published');
  });

  it('filled/ と templates/ の両方にあれば filled/ が勝つ', async () => {
    const t = await repo.getTemplate(BOTH_ID);
    expect(t.html).toBe('<p>値入り 110024</p>');
  });

  it('templates/ にしか無い id は一覧に出ないが取得はできる(filled は空)', async () => {
    const t = await repo.getTemplate(JINJA_ONLY_ID);
    expect(t.html).toBe('<p>{{ x }}</p>');
    expect(t.filled).toBe('');
  });

  it('どこにも無い id は notFound', async () => {
    await expect(repo.getTemplate('AM01_999999_20240710_交付版')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('一覧は companyCode/baseDate/editionType でも絞れる', async () => {
    const ids = (
      await repo.listTemplates({ companyCode: 'AM01', baseDate: '20240710', editionType: '交付版' })
    ).map((m) => m.id);
    expect(ids).toEqual([FILLED_ID]);
    const none = await repo.listTemplates({
      companyCode: 'AM01',
      baseDate: '20240710',
      editionType: '全体版',
    });
    expect(none).toEqual([]);
  });
});

describe('getSampleData と parseFundMaster の分岐', () => {
  let createTemplateRepo: typeof import('../src/repositories/templateRepo.js').createTemplateRepo;
  let createSprocClient: typeof import('../src/db/sproc.js').createSprocClient;

  beforeAll(async () => {
    ({ createTemplateRepo } = await import('../src/repositories/templateRepo.js'));
    ({ createSprocClient } = await import('../src/db/sproc.js'));
  });

  /** サンプルデータ sproc の `データJSON` 列だけを差し替える最小 sproc。 */
  const sprocWithSampleJson = (json: string | null): SprocClient =>
    createSprocClient(async () => [{ データJSON: json }]);

  it('company が欠けたマスタは未収録ファンド扱い(placeholder のまま)', async () => {
    const repo = createTemplateRepo(sprocWithSampleJson(JSON.stringify({ fund: { name: 'x' } })));
    const sample = await repo.getSampleData('999999');
    // if 条件が false になり `buildSampleData(undefined, ...)` へ落ちるので、
    // 共通ダミー(`sampleCommon`)の placeholder がそのまま出る。
    expect(sample.fund.name).toBe(sampleCommon.fund.name);
  });

  it('nickname が無ければ空文字で補う', async () => {
    const repo = createTemplateRepo(
      sprocWithSampleJson(
        JSON.stringify({
          fund: { name: 'ニックネーム無し' },
          company: { code: 'AM01', name: '会社' },
        }),
      ),
    );
    const sample = await repo.getSampleData('510037');
    expect(sample.fund.name).toBe('ニックネーム無し');
    expect(sample.fund.nickname).toBe('');
  });

  it('壊れた JSON は例外を投げずマスタ無し扱いにする', async () => {
    const repo = createTemplateRepo(sprocWithSampleJson('{not valid json'));
    const sample = await repo.getSampleData('999999');
    expect(sample.fund.code).toBe('999999');
  });
});
