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

  it('CSS の競合(css 欄)を持つ状態ファイルを書いて読み戻せる', async () => {
    const { readSyncState, writeSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240712';
    await writeSyncState({
      pairKey: key,
      parts: {},
      css: { conflicts: [{ ruleKey: '.a', detectedAt: '2026-10-05T00:00:00.000Z' }] },
      updatedAt: '2026-10-05T00:00:00.000Z',
    });
    expect((await readSyncState(key)).css).toEqual({
      conflicts: [{ ruleKey: '.a', detectedAt: '2026-10-05T00:00:00.000Z' }],
    });
  });

  it('競合「ペア側先行」を持つ状態ファイルを読める(同期エンジンが書く種別)', async () => {
    const { readSyncState, writeSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240713';
    await writeSyncState({
      pairKey: key,
      parts: {
        'p-1': { conflict: { kind: 'ペア側先行', detectedAt: '2026-10-05T00:00:00.000Z' } },
      },
      updatedAt: '2026-10-05T00:00:00.000Z',
    });
    expect((await readSyncState(key)).parts['p-1'].conflict?.kind).toBe('ペア側先行');
  });

  it('新しい競合の種類(ペア側削除・照合不可)を含む状態ファイルを読める', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240715';
    fs.mkdirSync(path.join(root, 'sync'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'sync', `${key}.json`),
      JSON.stringify({
        pairKey: key,
        parts: {
          'a#1': {
            lastSynced: 'x',
            conflict: { kind: 'ペア側削除', detectedAt: 't', deletedIn: '全体版' },
          },
          'b#1': {
            lastSynced: 'y',
            conflict: { kind: 'ペア側削除・ソース変更', detectedAt: 't', deletedIn: '交付版' },
          },
        },
        css: {
          conflicts: [
            { ruleKey: '[".a"]', detectedAt: 't', kind: '照合不可', sourceEdition: '交付版' },
          ],
        },
        updatedAt: 't',
      }),
      'utf8',
    );
    const s = await readSyncState(key);
    expect(s.parts['a#1'].conflict?.deletedIn).toBe('全体版');
    expect(s.parts['b#1'].conflict?.kind).toBe('ペア側削除・ソース変更');
    expect(s.css?.conflicts[0].kind).toBe('照合不可');
    expect(s.css?.conflicts[0].sourceEdition).toBe('交付版');
  });

  it('新しい項目を持たない古い状態ファイルもそのまま読める', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240716';
    fs.mkdirSync(path.join(root, 'sync'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'sync', `${key}.json`),
      JSON.stringify({
        pairKey: key,
        parts: { 'p-1': { conflict: { kind: '両側変更', detectedAt: 't' } } },
        css: { conflicts: [{ ruleKey: '.a', detectedAt: 't' }] },
        updatedAt: 't',
      }),
      'utf8',
    );
    const s = await readSyncState(key);
    expect(s.parts['p-1'].conflict?.deletedIn).toBeUndefined();
    expect(s.css?.conflicts[0].kind).toBeUndefined();
  });

  it('知らない競合の種類は形の崩れとして throw する', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    const key = 'AM01_510037_20240717';
    fs.mkdirSync(path.join(root, 'sync'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'sync', `${key}.json`),
      JSON.stringify({
        pairKey: key,
        parts: { 'p-1': { conflict: { kind: '謎', detectedAt: 't' } } },
        updatedAt: 't',
      }),
      'utf8',
    );
    await expect(readSyncState(key)).rejects.toThrow();
  });

  it('形の壊れたファイルは例外(黙って空状態にしない = 書き込み経路の入力にしない)', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    fs.mkdirSync(path.join(root, 'sync'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sync', 'AM01_510037_20240711.json'), '{"pairKey":1}', 'utf8');
    await expect(readSyncState('AM01_510037_20240711')).rejects.toThrow();
  });

  it('未作成以外の読み取り失敗は例外(空状態にして承認が記録を上書きしない)', async () => {
    const { readSyncState } = await import('../src/files/syncFiles.js');
    // 同名のディレクトリを置くと readFile は EISDIR で落ちる。空状態へ倒すと、承認が
    // lastSynced と競合の記録を失った状態で書き戻す。
    fs.mkdirSync(path.join(root, 'sync', 'AM01_510037_20240714.json'), { recursive: true });
    await expect(readSyncState('AM01_510037_20240714')).rejects.toThrow();
  });
});
