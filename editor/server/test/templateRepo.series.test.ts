// =============================================================================
// templateRepo.series.test.ts — 系列は templates/(作成タブの Jinja)のファイル名から作る
// =============================================================================
// 「系列から作る」で生成器が読むのは templates/<ID>.html なので、そこに在るものだけを返す。
// filled/ にしか無いテンプレは出さない。照合は大文字小文字を区別しない。DB に触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-series-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const put = (dir: string, name: string) =>
  fs.writeFileSync(path.join(tmp, dir, name), '<p>{{ x }}</p>', 'utf8');

describe('templateRepo.listSeriesFunds', () => {
  let repo: import('../src/repositories/templateRepo.js').TemplateRepo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    put('templates', 'AM01_510155_20240710_交付版.html');
    put('templates', 'AM01_510037_20250101_交付版.html');
    put('templates', 'AM01_510037_20240710_交付版.html');
    put('templates', 'am01_510124_20251020_交付版.html');
    put('templates', 'AM01_510037_20240710_全体版.html'); // 版種違い
    put('templates', 'AM02_110024_20240710_交付版.html'); // 会社違い
    put('templates', 'readme.html'); // 規約外
    put('filled', 'AM01_999999_20240710_交付版.html'); // filled/ にしか無い
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('会社・版種が一致する templates/ のテンプレをファンド → 基準日の順で返す', async () => {
    const rows = await repo.listSeriesFunds('AM01', '交付版');
    expect(rows.map((m) => m.id)).toEqual([
      'AM01_510037_20240710_交付版',
      'AM01_510037_20250101_交付版',
      'am01_510124_20251020_交付版',
      'AM01_510155_20240710_交付版',
    ]);
    expect(rows[0]).toMatchObject({
      status: 'published',
      fileName: 'AM01_510037_20240710_交付版.html',
    });
    expect(rows[0].updatedAt).toEqual(expect.any(String));
  });

  it('templates/ が無ければ空', async () => {
    fs.rmSync(path.join(tmp, 'templates'), { recursive: true, force: true });
    expect(await repo.listSeriesFunds('AM01', '交付版')).toEqual([]);
  });
});
