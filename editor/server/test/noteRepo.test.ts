// =============================================================================
// noteRepo.test.ts — メモのペア共有(交付版⇄全体版)と投稿の追加・編集・削除
// =============================================================================
// メモは版インスタンス単位のファイルに保存しつつ、読み取りでペアの版をマージして 1 本の
// スレッドとして返す。ここで主張するのは、マージの範囲と順序・書き込みが投稿の属する版
// だけを変えること・上限が追加のみを止めること。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

async function importRepo(): Promise<{
  repo: typeof import('../src/repositories/noteRepo.js');
  files: typeof import('../src/files/notesFile.js');
}> {
  vi.stubEnv('DATA_ROOT', tmpRoot);
  vi.resetModules();
  return {
    repo: await import('../src/repositories/noteRepo.js'),
    files: await import('../src/files/notesFile.js'),
  };
}

const KOUFU = 'AM01_510037_20240710_交付版';
const ZENTAI = 'AM01_510037_20240710_全体版';
const LONE = 'AM01_510037_20240710_kr';
const KEY = '.page#1/cover#1';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-note-repo-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('ペア版種のマージ', () => {
  it('交付版から読むと全体版の投稿も同じスレッドに並ぶ(作成日時の昇順)', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版の 1 件目', 'editor1');
    await repo.addNote(ZENTAI, KEY, '全体版の 1 件目', 'editor2');
    await repo.addNote(KOUFU, KEY, '交付版の 2 件目', 'editor1');

    const thread = await repo.listNotes(KOUFU);
    expect(thread.map((e) => e.content)).toEqual([
      '交付版の 1 件目',
      '全体版の 1 件目',
      '交付版の 2 件目',
    ]);
    // 版種が分かるよう、投稿は自分が属する版の id を持つ。
    expect(thread.map((e) => e.templateId)).toEqual([KOUFU, ZENTAI, KOUFU]);
  });

  it('全体版から読んでも同じ並びになる', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, 'A', 'editor1');
    await repo.addNote(ZENTAI, KEY, 'B', 'editor2');
    expect((await repo.listNotes(ZENTAI)).map((e) => e.content)).toEqual(['A', 'B']);
  });

  it('ペア対象外の版種は自版のみを返す', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版', 'editor1');
    await repo.addNote(LONE, KEY, '旧版種', 'editor1');
    expect((await repo.listNotes(LONE)).map((e) => e.content)).toEqual(['旧版種']);
  });
});

describe('createdAt が同値のときの安定性', () => {
  it('同一 createdAt の投稿は書き込み順(配列順)で返る', async () => {
    const { repo, files } = await importRepo();
    const t = '2026-09-01T00:00:00.000Z';
    await files.writeNotes(KOUFU, {
      [KEY]: [
        {
          id: 'e1',
          content: '1 件目',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
        {
          id: 'e2',
          content: '2 件目',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
        {
          id: 'e3',
          content: '3 件目',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });

    const thread = await repo.listNotes(KOUFU);
    // id は乱数 UUID 相当で挿入順と無関係なため、id 順(e1<e2<e3 に見える並び)へ逃げずに
    // 配列順そのものが保たれることを主張する(タイブレークを持たないことの検証)。
    expect(thread.map((e) => e.content)).toEqual(['1 件目', '2 件目', '3 件目']);
  });

  it('ペアをまたぐ同一 createdAt でも自版 → ペア版の順になる', async () => {
    const { repo, files } = await importRepo();
    const t = '2026-09-01T00:00:00.000Z';
    await files.writeNotes(KOUFU, {
      [KEY]: [
        {
          id: 'k1',
          content: '交付版',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });
    await files.writeNotes(ZENTAI, {
      [KEY]: [
        {
          id: 'z1',
          content: '全体版',
          createdAt: t,
          createdBy: 'editor2',
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });

    const thread = await repo.listNotes(KOUFU);
    expect(thread.map((e) => e.content)).toEqual(['交付版', '全体版']);
  });
});

describe('編集と削除の宛先', () => {
  it('ペア側の投稿を編集してもこちらの版のファイルは変わらない', async () => {
    const { repo, files } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版', 'editor1');
    const zentai = await repo.addNote(ZENTAI, KEY, '全体版', 'editor2');

    await repo.updateNote(ZENTAI, zentai.id, '全体版(修正)', 'editor3');

    expect((await files.readNotes(KOUFU))[KEY][0].content).toBe('交付版');
    const updated = (await files.readNotes(ZENTAI))[KEY][0];
    expect(updated.content).toBe('全体版(修正)');
    expect(updated.updatedBy).toBe('editor3');
  });

  it('削除は指定した版の投稿だけを消す', async () => {
    const { repo, files } = await importRepo();
    const koufu = await repo.addNote(KOUFU, KEY, '交付版', 'editor1');
    await repo.addNote(ZENTAI, KEY, '全体版', 'editor2');

    await repo.deleteNote(KOUFU, koufu.id);

    expect((await files.readNotes(KOUFU))[KEY]).toBeUndefined();
    expect((await files.readNotes(ZENTAI))[KEY]).toHaveLength(1);
  });

  it('存在しない投稿 ID は validation エラーにする', async () => {
    const { repo } = await importRepo();
    await expect(repo.updateNote(KOUFU, 'no-such-id', 'x', 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(repo.deleteNote(KOUFU, 'no-such-id')).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});

describe('投稿数の上限', () => {
  it('上限に達したら追加は拒否し、編集と削除は通す', async () => {
    const { repo, files } = await importRepo();
    const entries = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      content: `メモ${i}`,
      createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
    }));
    await files.writeNotes(KOUFU, { [KEY]: entries });

    await expect(repo.addNote(KOUFU, KEY, 'あふれる', 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(repo.updateNote(KOUFU, 'e0', '更新', 'editor1')).resolves.toMatchObject({
      content: '更新',
    });
    await expect(repo.deleteNote(KOUFU, 'e1')).resolves.toBeUndefined();
  });
});

describe('同時追加で投稿が消えない', () => {
  it('同一テンプレへの並行 addNote が全て残る', async () => {
    const { repo } = await importRepo();
    await Promise.all([
      repo.addNote(KOUFU, KEY, 'A', 'u1'),
      repo.addNote(KOUFU, KEY, 'B', 'u2'),
      repo.addNote(KOUFU, KEY, 'C', 'u3'),
    ]);
    expect((await repo.listNotes(KOUFU)).map((e) => e.content).sort()).toEqual(['A', 'B', 'C']);
  });
});
