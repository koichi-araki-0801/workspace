// =============================================================================
// officialPdfFiles.test.ts — 正式 PDF と値入り HTML の更新時刻・PDF の削除
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = vi.hoisted(() => `${process.env.TEMP ?? '/tmp'}/editor-opf-${process.pid}`);
vi.mock('../src/config.js', () => ({
  config: { pdfDir: `${root}/pdf`, filledDir: `${root}/filled`, templatesDir: `${root}/templates` },
}));

import {
  filledFileMtime,
  officialPdfMtime,
  removeOfficialPdf,
} from '../src/files/officialPdfFiles.js';

const ID = 'XX01_950037_20240710_交付版';
fs.mkdirSync(`${root}/pdf`, { recursive: true });
fs.mkdirSync(`${root}/filled`, { recursive: true });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('officialPdfFiles', () => {
  it('returns null for missing files and a Date for existing ones', async () => {
    expect(await officialPdfMtime(ID)).toBeNull();
    expect(await filledFileMtime(ID)).toBeNull();
    fs.writeFileSync(path.join(root, 'pdf', `${ID}.pdf`), '%PDF');
    fs.writeFileSync(path.join(root, 'filled', `${ID}.html`), '<p>x</p>');
    expect(await officialPdfMtime(ID)).toBeInstanceOf(Date);
    expect(await filledFileMtime(ID)).toBeInstanceOf(Date);
  });

  it('removeOfficialPdf deletes the pdf and tolerates a missing one', async () => {
    await removeOfficialPdf(ID);
    expect(await officialPdfMtime(ID)).toBeNull();
    await expect(removeOfficialPdf(ID)).resolves.toBeUndefined();
  });
});
