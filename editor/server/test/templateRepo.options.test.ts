// =============================================================================
// templateRepo.options.test.ts — 候補の出所を scope で切り替えること
// =============================================================================
// edit は filled/ + pending/、published は filled/ だけ。どちらもファイル起点の
// scope は DB に触れない(DB 不在の sproc を渡しても候補が返る)。照合は大文字小文字を区別しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-repo-options-'));
process.env.DATA_ROOT = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const put = (dir: string, id: string, body = '<p>x</p>') =>
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), body, 'utf8');

type Repo = import('../src/repositories/templateRepo.js').TemplateRepo;

describe('templateRepo.getDropdownOptions の scope', () => {
  let repo: Repo;

  beforeAll(async () => {
    for (const d of ['templates', 'filled', 'pending']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    put('filled', 'smtam_110024_2024-05-17_交付版');
    put('filled', 'SMTAM_510037_2024-05-17_全体版');
    put('filled', 'AM01_510155_20240710_交付版');
    put('filled', 'not-a-template'); // 規約外は黙って除く
    // pending/ のメタは pending/<id>.html と同名の JSON 等の形式に合わせる(下の注記)。
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM02_999999_20261001_交付版', '<p>未確定</p>', '');
    // filled/ と同じ id の pending は filled/ 側で数える(二重にしない)。
    await writePending('AM01_510155_20240710_交付版', '<p>消し残り</p>', '');
    // 大文字小文字だけが違う id の消し残りも filled/ 側で数える(NTFS では承認が既存の綴りへ上書きする)。
    await writePending('am01_510155_20240710_交付版', '<p>綴り違いの消し残り</p>', '');
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
    repo = createTemplateRepo(createOfflineSproc());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('edit は filled/ と pending/ から作り、DB に触れない', async () => {
    const o = await repo.getDropdownOptions({}, 'edit');
    // smtam / SMTAM のどちらが残るかは readdir の順に依る。1 つにまとまることだけを見る。
    expect(o.companyCodes.map((c) => c.toLowerCase())).toEqual(['am01', 'am02', 'smtam']);
  });

  it('published は pending/ を含めない', async () => {
    const o = await repo.getDropdownOptions({}, 'published');
    expect(o.companyCodes.map((c) => c.toLowerCase())).toEqual(['am01', 'smtam']);
  });

  it('大文字小文字だけが違う値は 1 つにまとめ、絞り込みも区別しない', async () => {
    const o = await repo.getDropdownOptions({ companyCode: 'SMTAM' }, 'edit');
    expect(o.fundCodes).toEqual(['110024', '510037']);
  });

  it('各候補は自分より上位の選択だけで絞る', async () => {
    const o = await repo.getDropdownOptions(
      { companyCode: 'smtam', fundCode: '110024', baseDate: '2024-05-17', editionType: '交付版' },
      'edit',
    );
    expect(o.companyCodes.map((c) => c.toLowerCase())).toEqual(['am01', 'am02', 'smtam']);
    expect(o.fundCodes).toEqual(['110024', '510037']);
    expect(o.baseDates).toEqual(['2024-05-17']);
    expect(o.editionTypes).toEqual(['交付版']);
  });

  it('pending/ と filled/ に同じ id があっても二重にならない', async () => {
    const o = await repo.getDropdownOptions({ companyCode: 'AM01' }, 'edit');
    expect(o.fundCodes).toEqual(['510155']);
  });

  it('一覧は大文字小文字だけが違う pending の消し残りを二重に出さない', async () => {
    const ids = (await repo.listTemplates({ fundCode: '510155' })).map((m) => m.id);
    expect(ids).toEqual(['AM01_510155_20240710_交付版']);
  });

  it('一覧の絞り込みも大文字小文字を区別しない', async () => {
    const ids = (await repo.listTemplates({ companyCode: 'Smtam' })).map((m) => m.id);
    expect(ids).toEqual(['smtam_110024_2024-05-17_交付版', 'SMTAM_510037_2024-05-17_全体版']);
  });
});
