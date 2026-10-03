// =============================================================================
// pairSyncService.test.ts — 承認後のペア同期はテンプレート側にも掛かり、状態ファイルは形ごとに別
// =============================================================================
// テンプレート(templates/。3 つ区切り)のペアのキーは `会社_ファンド`、値入り HTML(filled/。
// 4 つ区切り)は `会社_ファンド_基準日` で、状態ファイル `sync/<pairKey>.json` は自然に別になる。
// 1 つにまとめると、基準日の違う値入り HTML の同期状態とテンプレートの同期状態が混ざる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-pair-sync-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.SYNC_DIR = path.join(tmp, 'sync');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.CSS_DIR = path.join(tmp, 'css');
// 監査ログの DB 複写へ出ないようにする(`reviews.test.ts` と同じ)。
process.env.AUDIT_DB = 'false';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

const part = (id: string, text: string): string =>
  `<section data-part-id="${id}"><p>${text}</p></section>`;
const doc = (...parts: string[]): string =>
  `<html><body><div class="page">\n${parts.join('\n')}\n</div></body></html>`;
const put = (dir: string, id: string, html: string) => {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), html, 'utf8');
};
const read = (dir: string, id: string) =>
  fs.readFileSync(path.join(tmp, dir, `${id}.html`), 'utf8');
const syncFile = (pairKey: string) => path.join(tmp, 'sync', `${pairKey}.json`);

d('pairSyncService', () => {
  let svc: import('../src/sync/pairSyncService.js').PairSyncService;
  const listParts = async () => [{ id: 'a', syncDefault: '同期' }];

  beforeAll(async () => {
    const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
    // カタログは 1 パーツだけ。同期既定=同期 のパーツが転写の対象になる。
    const parts = { listParts: () => listParts(), getPartClassificationOptions: async () => ({}) };
    svc = createPairSyncService(parts as never);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('テンプレートの承認後は templates/ のペアへ転写し、状態は sync/会社_ファンド.json', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_510037_交付版', doc(part('a', '旧')));
    put('templates', 'AM01_510037_全体版', doc(part('a', '旧')));
    // 1 回目: 両版が一致しているので転写せず、前回同期の基準だけを作る。
    const first = await svc.syncPairAfterConfirm('AM01_510037_交付版', 'approver1', 'template');
    expect(first).toMatchObject({ pairTemplateId: 'AM01_510037_全体版', error: null });
    expect(fs.existsSync(syncFile('AM01_510037'))).toBe(true);
    // 2 回目: 交付版だけが変わったので全体版へ転写する。
    put('templates', 'AM01_510037_交付版', doc(part('a', '新')));
    const second = await svc.syncPairAfterConfirm('AM01_510037_交付版', 'approver1', 'template');
    expect(second?.error).toBeNull();
    expect(second?.applied).toHaveLength(1);
    expect(read('templates', 'AM01_510037_全体版')).toContain('新');
  });

  it('値入り HTML の状態は sync/会社_ファンド_基準日.json で、テンプレート側の状態を上書きしない', {
    timeout: 60_000,
  }, async () => {
    const before = fs.readFileSync(syncFile('AM01_510037'), 'utf8');
    put('filled', 'AM01_510037_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_510037_20240710_全体版', doc(part('a', 'x')));
    await svc.syncPairAfterConfirm('AM01_510037_20240710_交付版', 'approver1', 'filled');
    expect(fs.existsSync(syncFile('AM01_510037_20240710'))).toBe(true);
    expect(fs.readFileSync(syncFile('AM01_510037'), 'utf8')).toBe(before);
  });

  it('ペアのテンプレートが無ければ null、版種がペアの対象外でも null', async () => {
    put('templates', 'AM01_510155_交付版', doc(part('a', 'x')));
    expect(
      await svc.syncPairAfterConfirm('AM01_510155_交付版', 'approver1', 'template'),
    ).toBeNull();
    expect(await svc.syncPairAfterConfirm('AM01_510155_kr', 'approver1', 'template')).toBeNull();
  });

  it('同期の途中で失敗しても throw せず、error 付きで返す(承認は成立させる)', async () => {
    put('templates', 'AM01_510003_交付版', doc(part('a', 'x')));
    put('templates', 'AM01_510003_全体版', doc(part('a', 'x')));
    const r = await (async () => {
      const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
      const broken = {
        listParts: async () => {
          throw new Error('カタログを読めない');
        },
        getPartClassificationOptions: async () => ({}),
      };
      return createPairSyncService(broken as never).syncPairAfterConfirm(
        'AM01_510003_交付版',
        'approver1',
        'template',
      );
    })();
    expect(r).toMatchObject({
      pairTemplateId: 'AM01_510003_全体版',
      applied: [],
      error: 'カタログを読めない',
    });
  });

  it('同期の現況はテンプレートでは値入り HTML のペアを見ない(バナーの対象外)', async () => {
    expect(await svc.getPairSyncStatus('AM01_510037_交付版')).toEqual({
      pairTemplateId: 'AM01_510037_全体版',
      pairExists: false,
      conflicts: [],
    });
    expect(await svc.getPairSyncStatus('規約外')).toEqual({
      pairTemplateId: null,
      pairExists: false,
      conflicts: [],
    });
  });
});
