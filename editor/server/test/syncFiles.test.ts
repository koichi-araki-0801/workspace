// =============================================================================
// syncFiles.test.ts — ペア同期状態ファイルの往復
// =============================================================================
// `readSyncState` は未作成なら空状態を返す(raw===null 分岐)だけでなく、既に書かれた
// ファイルを Zod スキーマ越しに読み戻す分岐も持つ。`pathGuards.test.ts` は往復のうち
// 「書く→存在確認」までしか見ておらず、書いた後の再読み取り(parse 経路)が未到達
// だったため、ここで往復と壊れたファイルの拒否を専用に見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-syncfiles-'));
process.env.DATA_ROOT = root;
process.env.SYNC_DIR = path.join(root, 'sync');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readSyncState', () => {
  it('未作成なら空状態、書けば同じ内容が読み戻る(Zod の形で検証される)', async () => {
    const { readSyncState, writeSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240710';
    const empty = await readSyncState(key);
    expect(empty.parts).toEqual({});
    await writeSyncState({
      ...empty,
      parts: { 'p-1': { lastSynced: 'h1' } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await readSyncState(key)).toMatchObject({
      pairKey: key,
      parts: { 'p-1': { lastSynced: 'h1' } },
    });
  });

  it('形の壊れたファイルは例外(黙って空状態にしない = 書き込み経路の入力にしない)', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    fs.mkdirSync(path.join(root, 'sync'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sync', 'AM01_510037_20240711.json'), '{"pairKey":1}', 'utf8');
    await expect(readSyncState('AM01_510037_20240711')).rejects.toThrow();
  });
});
