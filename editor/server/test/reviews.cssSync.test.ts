// =============================================================================
// reviews.cssSync.test.ts — 承認の直前の CSS を base にしてペアへ CSS を写す
// =============================================================================
// base は承認が CSS を書く前に読まないと取れない(書いた後は next と同じになり、何も写らない)。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `readTemplateCss` の呼び出しごとの結果の予定(先頭から消費し、空なら本物を読む)。'fail' は
 * 権限エラー(EACCES)を投げる — ENOENT 以外の読取失敗で承認が止まらないことを確かめる。
 */
const cssReadPlan: Array<'ok' | 'fail'> = [];
vi.mock('../src/files/templateFiles.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/files/templateFiles.js')>();
  return {
    ...mod,
    readTemplateCss: async (templateId: string) => {
      if (cssReadPlan.shift() === 'fail') {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return mod.readTemplateCss(templateId);
    },
  };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-css-sync-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.SYNC_DIR = path.join(tmp, 'sync');
process.env.AUDIT_DB = 'false';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('承認とペアの CSS 転写', () => {
  let reviews: import('../src/repositories/reviewRepo.js').ReviewRepo;
  const put = (dir: string, name: string, text: string) => {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, dir, name), text, 'utf8');
  };

  beforeAll(async () => {
    const { createReviewRepo } = await import('../src/repositories/reviewRepo.js');
    const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
    const parts = { listParts: async () => [], getPartClassificationOptions: async () => ({}) };
    reviews = createReviewRepo({
      pairSync: createPairSyncService(parts as never),
      noteMaster: { reflectNoteMasterAfterConfirm: async () => null } as never,
    });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('値入り HTML の承認で変わった CSS 規則が全体版の CSS へ写る', {
    timeout: 60_000,
  }, async () => {
    put('filled', 'AM01_580000_20240710_交付版.html', '<p>交付</p>');
    put('filled', 'AM01_580000_20240710_全体版.html', '<p>全体</p>');
    put('css', 'AM01_580000_交付版.css', '.a{color:red}\n.b{color:blue}');
    put('css', 'AM01_580000_全体版.css', '.a{color:red}\n.b{color:navy}');
    const meta = await reviews.submitReview(
      {
        templateId: 'AM01_580000_20240710_交付版',
        html: '<p>交付</p>',
        css: '.a{color:green}\n.b{color:blue}',
        origin: 'edit',
      },
      { username: 'editor1', role: 'editor' },
    );
    const r = await reviews.approveReview(meta.id, {}, { username: 'approver1', role: 'approver' });
    expect(r.sync?.css?.applied).toHaveLength(1);
    const pairCss = fs.readFileSync(path.join(tmp, 'css', 'AM01_580000_全体版.css'), 'utf8');
    expect(pairCss).toContain('.a{color:green}');
    expect(pairCss).toContain('.b{color:navy}');
  });

  it('承認の直前の CSS を読めなくても承認は成立し、CSS の転写だけを飛ばす', {
    timeout: 60_000,
  }, async () => {
    put('filled', 'AM01_581000_20240710_交付版.html', '<p>交付</p>');
    put('filled', 'AM01_581000_20240710_全体版.html', '<p>全体</p>');
    put('css', 'AM01_581000_交付版.css', '.a{color:red}');
    put('css', 'AM01_581000_全体版.css', '.a{color:red}');
    const meta = await reviews.submitReview(
      {
        templateId: 'AM01_581000_20240710_交付版',
        html: '<p>交付</p>',
        css: '.a{color:green}',
        origin: 'edit',
      },
      { username: 'editor1', role: 'editor' },
    );
    // 承認での読み取り順: 1 回目 = 並行性警告の現行版の計測、2 回目 = 転写の base(承認の直前の CSS)。
    cssReadPlan.push('ok', 'fail');
    const r = await reviews.approveReview(meta.id, {}, { username: 'approver1', role: 'approver' });
    expect(cssReadPlan).toEqual([]);
    expect(r.meta.id).toBe('AM01_581000_20240710_交付版');
    expect(r.sync?.error).toBeNull();
    expect(r.sync?.css).toBeNull();
    // 承認した CSS は反映され、ペアの CSS は変わらない('' を base にした誤転写をしない)。
    expect(fs.readFileSync(path.join(tmp, 'css', 'AM01_581000_交付版.css'), 'utf8')).toBe(
      '.a{color:green}',
    );
    expect(fs.readFileSync(path.join(tmp, 'css', 'AM01_581000_全体版.css'), 'utf8')).toBe(
      '.a{color:red}',
    );
  });
});
