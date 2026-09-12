// =============================================================================
// templateRepo.filled.test.ts — 編集タブの一覧・取得が filled/ を主、templates/ を従とすること
// =============================================================================
// 値入り HTML(filled/)を置いたテンプレだけが一覧に出て、取得は filled/ の本文を `html` と
// `filled` の両方に返す。templates/(作成タブの Jinja)にしか無い id は一覧に出ないが、
// 取得では読める(作成経路の承認直後に精査画面が確定版を読むため)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const JINJA_ONLY_ID = 'AM01_510037_20240710_全体版';
const BOTH_ID = 'AM01_110024_20251117_交付版';

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
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('一覧は filled/ にあるテンプレだけを published として返す', async () => {
    const ids = (await repo.listTemplates({})).map((m) => `${m.id}:${m.status}`);
    expect(ids).toEqual([`${BOTH_ID}:published`, `${FILLED_ID}:published`]);
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
    expect(sample.fund.name).not.toBe('x');
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
