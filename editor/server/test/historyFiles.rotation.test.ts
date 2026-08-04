// =============================================================================
// historyFiles.rotation.test.ts — 履歴 JSONL の上限・ローテーション(R40 / R41)
// =============================================================================
// 旧実装はサイズ上限も世代管理も保持期限も持たず、読み取りは「ファイル全体を 1 文字列に
// して split → JSON.parse」だった。行が 1 つでも壊れると当該フィードが恒久 500 になり、
// Node の文字列上限を超えると履歴が消えたように見えた。**迂回入力(壊れた行・巨大
// ファイル)で破綻しないこと**を主張する形で書く。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

/** `config.logging.dir` を一時ディレクトリへ差し替えて `historyFiles` を読み直す。 */
async function importHistory(): Promise<typeof import('../src/files/historyFiles.js')> {
  vi.stubEnv('LOG_DIR', tmpRoot);
  vi.resetModules();
  return import('../src/files/historyFiles.js');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-history-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const historyFile = (kind: string, gen?: number): string =>
  path.join(tmpRoot, 'history', gen === undefined ? `${kind}.jsonl` : `${kind}.${gen}.jsonl`);

describe('履歴 JSONL の上限', () => {
  it('上限値を固定する(変更に「テストを直す」意思決定を伴わせる)', async () => {
    const h = await importHistory();
    expect(h.MAX_HISTORY_BYTES).toBe(32 * 1024 * 1024);
    expect(h.MAX_HISTORY_GENERATIONS).toBe(3);
    expect(h.MAX_HISTORY_TAIL_BYTES).toBe(4 * 1024 * 1024);
  });

  it('上限超過で世代がローテーションし、現行ファイルが作り直される', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    // 上限ちょうどのダミーを置いてから 1 件追記する。
    await fs.writeFile(historyFile('pdf'), 'x'.repeat(h.MAX_HISTORY_BYTES), 'utf8');
    await h.appendHistory('pdf', { at: 'after-rotate' });

    await expect(fs.stat(historyFile('pdf', 1))).resolves.toBeTruthy();
    const cur = await fs.readFile(historyFile('pdf'), 'utf8');
    expect(cur.trim()).toBe(JSON.stringify({ at: 'after-rotate' }));
  });

  it('壊れた行が 1 行あってもフィード全体が落ちない', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    // 追記の競合で途中まで書かれた行を模す。旧実装はここで JSON.parse が throw し、
    // ルートが恒久 500 になっていた。
    await fs.writeFile(
      historyFile('part'),
      `${JSON.stringify({ n: 1 })}\n{"n": 2\n${JSON.stringify({ n: 3 })}\n`,
      'utf8',
    );
    const rows = await h.readHistory<{ n: number }>('part');
    expect(rows.map((r) => r.n)).toEqual([3, 1]);
  });

  it('末尾しか読まないので巨大ファイルでも件数に比例した応答になる', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    // 先頭に大きなゴミを置き、その後ろへ正当な行を積む。全体読みなら先頭も parse 対象。
    const junk = `${'z'.repeat(h.MAX_HISTORY_TAIL_BYTES)}\n`;
    const tail = Array.from({ length: 5 }, (_, i) => JSON.stringify({ n: i })).join('\n');
    await fs.writeFile(historyFile('create'), `${junk}${tail}\n`, 'utf8');

    const rows = await h.readHistory<{ n: number }>('create');
    // 先頭のゴミは読み範囲外(= 末尾しか読んでいないことの証明)。
    expect(rows.map((r) => r.n)).toEqual([4, 3, 2, 1, 0]);
  });

  it('limit で返却件数を絞れる(既定値も上限として効く)', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ n: i })).join('\n');
    await fs.writeFile(historyFile('pdf'), `${lines}\n`, 'utf8');

    expect(await h.readHistory('pdf', { limit: 3 })).toHaveLength(3);
    // 既定より大きい limit を要求しても既定で頭打ちにする(呼び出し側で外せない上限)。
    expect(await h.readHistory('pdf', { limit: 1_000_000 })).toHaveLength(20);
  });

  it('ファイルが無ければ空配列(従来挙動の回帰)', async () => {
    const h = await importHistory();
    expect(await h.readHistory('pdf')).toEqual([]);
  });
});

// `part.jsonl` は全テンプレ共用の 1 本。先に件数で打ち切ってから呼び出し側で絞ると、
// 他テンプレの編集が上限件数進むだけで当該テンプレの履歴が 0 件になる(画面から消える)。
describe('共用 jsonl の絞り込みと打ち切りの順序', () => {
  it('他テンプレの更新が上限件数を超えても対象テンプレの履歴は消えない', async () => {
    const h = await importHistory();
    await fs.mkdir(path.join(tmpRoot, 'history'), { recursive: true });
    const mine = JSON.stringify({ id: 'mine', templateId: 'T1' });
    const others = Array.from({ length: h.DEFAULT_HISTORY_LIMIT + 50 }, (_, i) =>
      JSON.stringify({ id: `o${i}`, templateId: 'T2' }),
    ).join('\n');
    await fs.writeFile(historyFile('part'), `${mine}\n${others}\n`, 'utf8');

    const rows = await h.readHistory<{ id: string; templateId: string }>('part', {
      where: (e) => e.templateId === 'T1',
    });
    expect(rows.map((r) => r.id)).toEqual(['mine']);

    // 参考: 迂回の形(先に打ち切ってから絞る)だと 0 件になることを同じ入力で示す。
    const truncatedThenFiltered = (
      await h.readHistory<{ id: string; templateId: string }>('part')
    ).filter((e) => e.templateId === 'T1');
    expect(truncatedThenFiltered).toEqual([]);
  });
});
