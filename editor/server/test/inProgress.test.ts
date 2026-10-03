// =============================================================================
// inProgress.test.ts — 作業中(下書きか pending)の照合は会社コードの大文字小文字を区別しない
// =============================================================================
// 作成済み(templates/)と申請中の照合は大文字小文字を区別しない。作業中だけ綴りどおりに見ると、
// 大文字小文字を区別するファイルシステムでは綴り違いの pending が並び、作り直しの確認もすり抜ける。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-in-progress-'));
process.env.DATA_ROOT = tmp;
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.DRAFTS_DIR = path.join(tmp, 'drafts');

const put = (dir: string, name: string) => {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, dir, name), '<p>x</p>', 'utf8');
};

describe('findInProgressIds', () => {
  beforeEach(() => {
    for (const d of ['pending', 'drafts'])
      fs.rmSync(path.join(tmp, d), { recursive: true, force: true });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('下書きと pending を、大文字小文字を区別せずにファイルの綴りのまま返す', async () => {
    put('pending', 'am01_510037_交付版.html');
    put('drafts', 'Am01_510037_交付版.html');
    put('drafts', 'Am01_510037_交付版.css');
    put('pending', 'AM01_510037_全体版.html'); // 版種違いは数えない
    const { findInProgressIds } = await import('../src/files/inProgress.js');
    expect(await findInProgressIds('AM01_510037_交付版')).toEqual({
      pending: ['am01_510037_交付版'],
      drafts: ['Am01_510037_交付版'],
    });
  });

  it('どちらにも無ければ空、置き場が無くても落ちない', async () => {
    const { findInProgressIds } = await import('../src/files/inProgress.js');
    expect(await findInProgressIds('AM01_510037_交付版')).toEqual({ pending: [], drafts: [] });
  });
});
