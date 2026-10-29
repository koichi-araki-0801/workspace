// =============================================================================
// reviews.diffReuse.test.ts — 判定の保存と最終確定で、申請の差分を 1 回だけ計算すること
// =============================================================================
// 申請の差分(`buildHtmlDiff`)は大きい帳票で秒単位かかり、その間サーバ全体の要求が止まる(同期
// 計算)。判定の保存の照合で計算した差分を、最終確定(`buildEditReviewedHtml`)でも使い回すことを、
// shared の 2 関数を数える部分モックで確かめる。vi.mock は hoist されるので別ファイルにする。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionStub } from './helpers/sessionStub.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-diffreuse-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.AUDIT_DB = 'false';

const calls = vi.hoisted(() => ({ diff: 0, finalizeDiffs: [] as unknown[] }));
vi.mock('@editor/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editor/shared')>();
  return {
    ...actual,
    buildHtmlDiff: (...args: Parameters<typeof actual.buildHtmlDiff>) => {
      calls.diff++;
      return actual.buildHtmlDiff(...args);
    },
    buildEditReviewedHtml: (...args: Parameters<typeof actual.buildEditReviewedHtml>) => {
      calls.finalizeDiffs.push(args[3]);
      return actual.buildEditReviewedHtml(...args);
    },
  };
});

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('申請の差分の使い回し', () => {
  let reviews: import('../src/repositories/reviewRepo.js').ReviewRepo;
  const submitter = { username: 'editor1', role: 'editor' };
  const approver = { username: 'approver1', role: 'approver' };

  beforeAll(async () => {
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createDeps } = await import('../src/deps.js');
    reviews = createDeps(createOfflineSproc(), createSessionStub()).reviews;
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('判定の保存で計算した差分を最終確定でも使い、差分の計算は 1 回だけ', async () => {
    const tplId = 'XX01_730001_20250101_交付版';
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'filled', `${tplId}.html`), '<p>既存の値入り</p>', 'utf8');
    const meta = await reviews.submitReview(
      { templateId: tplId, html: '<p>新しい本文</p>', css: '.x{}', origin: 'edit' },
      submitter,
    );
    calls.diff = 0;
    calls.finalizeDiffs = [];
    await reviews.updatePartDecisions(
      meta.id,
      { decisions: [{ partKey: 'p#1', status: 'approved' }] },
      approver,
    );
    expect(calls.diff).toBe(1);
    await reviews.approveReview(meta.id, {}, approver);
    expect(calls.diff).toBe(1);
    expect(calls.finalizeDiffs).toHaveLength(1);
    expect(calls.finalizeDiffs[0]).toMatchObject({ truncated: false });
    expect(fs.readFileSync(path.join(tmp, 'filled', `${tplId}.html`), 'utf8')).toBe(
      '<p>新しい本文</p>',
    );
  });
});
