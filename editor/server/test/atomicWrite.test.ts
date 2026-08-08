// =============================================================================
// atomicWrite.test.ts — 一時ファイル名の衝突と、ファイル単位の直列化(F40)
// =============================================================================
// 一時名が `pid + ミリ秒` だった版は、サーバが単一プロセス(pid が定数)なので同一
// ミリ秒に走った 2 つの書き込みが**同じ一時パス**を切り詰めモードで開いた。結果は
// 「混ざったバイト列」か「後続の rename が ENOENT で 500」のどちらか。
// ここでは名前が毎回変わること(= 衝突しないこと)と、`withFileLock` が同一キーの
// 実行を重ねないことを主張する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '../src/files/atomic.js';
import { withFileLock } from '../src/files/fileLock.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-atomic-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  it('同一ミリ秒に別々の書き手が動いても一時ファイルを共有しない', async () => {
    // 一時名が `pid + ミリ秒` だけだった版は、この 20 本が同じ一時パスを切り詰めモードで
    // 開き、内容が混ざったうえ後続の rename が ENOENT で落ちた。宛先が別なので、
    // 一時名さえ一意なら全部成功して各々の全文が残る。
    const bodies = Array.from({ length: 20 }, (_, i) => `${'v'.repeat(1000)}-${i}`);
    await Promise.all(bodies.map((b, i) => atomicWrite(path.join(dir, `x${i}.json`), b)));
    for (const [i, b] of bodies.entries()) {
      expect(await fs.readFile(path.join(dir, `x${i}.json`), 'utf8')).toBe(b);
    }
    expect((await fs.readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('同一パスへ並行に書いても内容は混ざらず、一時ファイルも残さない', async () => {
    const target = path.join(dir, 'x.json');
    const bodies = Array.from({ length: 20 }, (_, i) => `${'v'.repeat(1000)}-${i}`);
    // 同一宛先の rename は OS 側の理由(Windows の共有違反等)で失敗しうる。ここで
    // 主張するのは「失敗しても壊れない」ことで、成功させたい呼び出し側は
    // `withFileLock` で直列化する(`noteRepo.saveNote`)。
    await Promise.allSettled(bodies.map((b) => atomicWrite(target, b)));

    // 残った内容は「いずれかの書き込みの全文」でなければならない(混ざっていない)。
    expect(bodies).toContain(await fs.readFile(target, 'utf8'));
    expect((await fs.readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('直列化すれば全部成功し、最後の内容が残る', async () => {
    const target = path.join(dir, 'y.json');
    for (const b of ['1', '22', '333']) {
      await withFileLock(target, () => atomicWrite(target, b));
    }
    expect(await fs.readFile(target, 'utf8')).toBe('333');
  });
});

describe('withFileLock', () => {
  it('同一キーの実行は重ならない(読み-改変-書きを守れる)', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const body = async (): Promise<void> => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => withFileLock('k', body)));
    expect(maxConcurrent).toBe(1);
  });

  it('キーが違えば直列化しない(無関係なファイルを待たせない)', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const body = async (): Promise<void> => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
    };
    await Promise.all([withFileLock('a', body), withFileLock('b', body)]);
    expect(maxConcurrent).toBe(2);
  });

  it('失敗しても後続は詰まらない(例外はそのまま呼び出し側へ)', async () => {
    const p1 = withFileLock('e', async () => {
      throw new Error('boom');
    });
    const p2 = withFileLock('e', async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });
});
