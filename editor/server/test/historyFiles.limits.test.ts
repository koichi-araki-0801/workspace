// =============================================================================
// historyFiles.limits.test.ts — 1 レコード上限と旧世代フォールバック
// =============================================================================
// `readTail` は末尾 `MAX_HISTORY_TAIL_BYTES` しか読まず、行の途中から始まる先頭は捨てる。
// つまり**読み窓を丸ごと覆う 1 行**を書けば、それ以前の履歴は「0 件」として返る。
// さらに `rotateIfNeeded` が世代を繰り上げると、旧世代を読まない実装では過去の履歴が
// 恒久的に画面から消える。追記側の 1 レコード上限と、読み側の世代フォールバックの
// **両方**が効いていることを主張する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

async function importHistory(): Promise<typeof import('../src/files/historyFiles.js')> {
  vi.stubEnv('LOG_DIR', tmpRoot);
  vi.resetModules();
  return import('../src/files/historyFiles.js');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-history-limits-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const historyFile = (kind: string, gen?: number): string =>
  path.join(tmpRoot, 'history', gen === undefined ? `${kind}.jsonl` : `${kind}.${gen}.jsonl`);

describe('1 レコードの上限', () => {
  it('上限値を固定する', async () => {
    const h = await importHistory();
    expect(h.MAX_HISTORY_RECORD_BYTES).toBe(64 * 1024);
    // 読み窓より十分小さいこと自体が要件(1 行で窓を覆えない)。
    expect(h.MAX_HISTORY_RECORD_BYTES * 8).toBeLessThan(h.MAX_HISTORY_TAIL_BYTES);
  });

  it('上限超過のレコードは書かずに拒否する(既存の履歴を押し出せない)', async () => {
    const h = await importHistory();
    await h.appendHistory('pdf', { id: 'ok-1' });
    await expect(
      h.appendHistory('pdf', { id: 'x'.repeat(h.MAX_HISTORY_RECORD_BYTES) }),
    ).rejects.toMatchObject({ kind: 'validation' });

    // 拒否された行はファイルに残らず、既存の履歴も無傷。
    const rows = await h.readHistory<{ id: string }>('pdf');
    expect(rows.map((r) => r.id)).toEqual(['ok-1']);
  });

  it('上限ちょうどは通る(境界で誤って正当な記録を落とさない)', async () => {
    const h = await importHistory();
    // `{"id":"…"}\n` の外枠ぶんを引いた長さで、行全体をちょうど上限に合わせる。
    const overhead = Buffer.byteLength(`${JSON.stringify({ id: '' })}\n`, 'utf8');
    await h.appendHistory('pdf', { id: 'a'.repeat(h.MAX_HISTORY_RECORD_BYTES - overhead) });
    expect(await h.readHistory('pdf')).toHaveLength(1);
  });
});

describe('旧世代へのフォールバック', () => {
  it('ローテーション後も過去の履歴が読める', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    // 世代 1・2 に過去分、現行に最新分を置く(`rotateIfNeeded` が作る形と同じ)。
    await fs.writeFile(historyFile('pdf', 2), `${JSON.stringify({ id: 'old' })}\n`, 'utf8');
    await fs.writeFile(historyFile('pdf', 1), `${JSON.stringify({ id: 'mid' })}\n`, 'utf8');
    await fs.writeFile(historyFile('pdf'), `${JSON.stringify({ id: 'new' })}\n`, 'utf8');

    const rows = await h.readHistory<{ id: string }>('pdf');
    // 現行 → 旧世代の順(= 新しい順)で連結される。
    expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('件数上限に達したら旧世代は読まない(打ち切りは常にフィルタ後の件数で)', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    await fs.writeFile(historyFile('pdf', 1), `${JSON.stringify({ id: 'old' })}\n`, 'utf8');
    await fs.writeFile(historyFile('pdf'), `${JSON.stringify({ id: 'new' })}\n`, 'utf8');

    const rows = await h.readHistory<{ id: string }>('pdf', { limit: 1 });
    expect(rows.map((r) => r.id)).toEqual(['new']);
  });
});
