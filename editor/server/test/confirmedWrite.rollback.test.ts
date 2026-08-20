// =============================================================================
// confirmedWrite.rollback.test.ts — 書込失敗時の補償(存在しなかったファイルの後始末)
// =============================================================================
// 確定書込は「HTML → CSS」の 2 ファイルを続けて書く。CSS で落ちたときに HTML だけが
// 残ると、承認していない実体が templatesDir に居座り一覧へ載る。snapshot は
// 「元から無かった」を「読めなかった」と区別して保持し、restore は不存在だった
// ファイルを削除しなければならない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/git/gitRepo.js', () => ({
  ensureRepo: async () => {},
  withGitLock: async (fn: () => Promise<unknown>) => fn(),
  commitAll: async () => {},
}));

/** 書込を失敗させたいパスの末尾。テストごとに入れ替える。 */
const failingSuffixes = new Set<string>();

vi.mock('../src/files/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/atomic.js')>();
  return {
    ...orig,
    atomicWrite: async (filePath: string, content: string) => {
      for (const suffix of failingSuffixes) {
        if (filePath.endsWith(suffix)) throw new Error(`書込に失敗しました: ${filePath}`);
      }
      return orig.atomicWrite(filePath, content);
    },
  };
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-cw-rollback-'));
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');

const TEMPLATE_ID = 'AM01_510037_20240710_交付版';
const FUND = '510037';
const templatesDir = path.join(root, 'data', 'templates');
const cssDir = path.join(root, 'data', 'css');

const confirmedWrite = await import('../src/repositories/confirmedWrite.js');

const approve = () =>
  confirmedWrite.applyConfirmedWrite({
    kind: 'review-approve',
    templateId: TEMPLATE_ID,
    fundCode: FUND,
    html: '<p>新しい本文</p>',
    css: 'body{color:#000}',
    author: 'approver1',
    commitMessage: 'm',
  });

describe('applyConfirmedWrite の補償', () => {
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    failingSuffixes.clear();
    fs.rmSync(templatesDir, { recursive: true, force: true });
    fs.rmSync(cssDir, { recursive: true, force: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(cssDir, { recursive: true });
  });

  it('新規テンプレの CSS 書込が失敗したら HTML を残さない', async () => {
    failingSuffixes.add(`${FUND}.css`);

    await expect(approve()).rejects.toThrow('書込に失敗しました');

    expect(fs.existsSync(path.join(templatesDir, `${TEMPLATE_ID}.html`))).toBe(false);
    expect(fs.existsSync(path.join(cssDir, `${FUND}.css`))).toBe(false);
  });

  it('既存テンプレの CSS 書込が失敗したら HTML を元のバイト列へ戻す', async () => {
    fs.writeFileSync(path.join(templatesDir, `${TEMPLATE_ID}.html`), '<p>元の本文</p>', 'utf8');
    failingSuffixes.add(`${FUND}.css`);

    await expect(approve()).rejects.toThrow('書込に失敗しました');

    expect(fs.readFileSync(path.join(templatesDir, `${TEMPLATE_ID}.html`), 'utf8')).toBe(
      '<p>元の本文</p>',
    );
  });

  it('afterWrite が失敗したら新規に作った転写先を残さない', async () => {
    const PAIR = 'AM01_510037_20240710_全体版';
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        targetTemplateId: PAIR,
        sourceTemplateId: TEMPLATE_ID,
        html: '<p>転写後</p>',
        actor: 'approver1',
        appliedParts: ['p1'],
        afterWrite: async () => {
          throw new Error('同期状態の書込に失敗');
        },
      }),
    ).rejects.toThrow('同期状態の書込に失敗');

    expect(fs.existsSync(path.join(templatesDir, `${PAIR}.html`))).toBe(false);
  });
});
