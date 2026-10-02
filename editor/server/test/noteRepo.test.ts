// =============================================================================
// noteRepo.test.ts — コメントの版インスタンス独立・返信・解決・連鎖削除
// =============================================================================
// コメントは版インスタンス単位のファイルに保存し、他の版(交付版⇄全体版のペアを含む)とは
// 共有しない。ここで主張するのは、読み取りが自版に閉じること・返信が同じパーツの親投稿にだけ
// 付くこと・状態の切替が親にだけ許され返信へ伝播すること・親の削除が返信を道連れにすること。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_NOTE_ENTRIES_PER_PART } from '@editor/shared';
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
const KEY = '.page#1/cover#1';
const OTHER_KEY = '.page#1/.summary#1';
const PARENT = { replyTo: null };

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-note-repo-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('版インスタンスの独立', () => {
  it('交付版から読んでも全体版の投稿は混ざらない', async () => {
    const { repo } = await importRepo();
    await repo.addNote(KOUFU, KEY, '交付版', 'editor1', PARENT);
    await repo.addNote(ZENTAI, KEY, '全体版', 'editor2', PARENT);
    expect((await repo.listNotes(KOUFU)).map((e) => e.content)).toEqual(['交付版']);
    expect((await repo.listNotes(ZENTAI)).map((e) => e.content)).toEqual(['全体版']);
  });

  it('作成日時の昇順で返し、同一 createdAt は書き込み順を保つ', async () => {
    const { repo, files } = await importRepo();
    const t = '2026-09-01T00:00:00.000Z';
    const stored = (id: string, content: string) => ({
      id,
      content,
      createdAt: t,
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
      status: 'open' as const,
      replyTo: null,
    });
    await files.writeNotes(KOUFU, {
      [KEY]: [stored('z1', '1 件目'), stored('m2', '2 件目'), stored('a3', '3 件目')],
    });
    expect((await repo.listNotes(KOUFU)).map((e) => e.content)).toEqual([
      '1 件目',
      '2 件目',
      '3 件目',
    ]);
  });
});

describe('追加', () => {
  it('親投稿は open / replyTo null で保存され、種別は持たない', async () => {
    const { repo } = await importRepo();
    const e = await repo.addNote(KOUFU, KEY, '修正して', 'editor1', { replyTo: null });
    expect(e).toMatchObject({
      status: 'open',
      replyTo: null,
      templateId: KOUFU,
      pathKey: KEY,
    });
    expect(e).not.toHaveProperty('kind');
  });

  it('返信は親の状態を引き継ぐ', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    await repo.updateNote(KOUFU, p.id, { status: 'resolved' }, 'editor1');
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id });
    expect(r).toMatchObject({ replyTo: p.id, status: 'resolved' });
  });

  it('存在しない親への返信は拒否する', async () => {
    const { repo } = await importRepo();
    await expect(
      repo.addNote(KOUFU, KEY, '返信', 'editor1', { replyTo: 'nope' }),
    ).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('別パーツの投稿を親にした返信は拒否する', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, OTHER_KEY, '別パーツ', 'editor1', PARENT);
    await expect(
      repo.addNote(KOUFU, KEY, '返信', 'editor1', { replyTo: p.id }),
    ).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('返信への返信は拒否する(入れ子は 1 段)', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id });
    await expect(
      repo.addNote(KOUFU, KEY, '孫', 'editor1', { replyTo: r.id }),
    ).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  // 上限件数ぶんの投稿を 1 件ずつ足す(毎回ファイルを読んで書き直す)ので、CI の並列負荷下では
  // 既定の 5 秒に収まらない。上限に達するまでの件数は仕様の一部なので減らさず、時間の方を許す。
  it('1 パーツの投稿数上限は返信を含めて数える', { timeout: 30_000 }, async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    // 親 1 件 + 返信 (上限 - 1) 件で上限に達する。次の親投稿は拒否される。
    for (let i = 1; i < MAX_NOTE_ENTRIES_PER_PART; i += 1) {
      await repo.addNote(KOUFU, KEY, `返信 ${i}`, 'editor1', { replyTo: p.id });
    }
    await expect(repo.addNote(KOUFU, KEY, '上限超え', 'editor1', PARENT)).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});

describe('更新', () => {
  it('本文の更新は updatedAt/updatedBy を刻み、状態だけの更新は刻まない', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const edited = await repo.updateNote(KOUFU, p.id, { content: '直した' }, 'editor2');
    expect(edited.content).toBe('直した');
    expect(edited.updatedBy).toBe('editor2');
    const resolved = await repo.updateNote(KOUFU, p.id, { status: 'resolved' }, 'editor3');
    expect(resolved.status).toBe('resolved');
    expect(resolved.updatedBy).toBe('editor2');
  });

  it('親の状態切替は返信へ伝播する', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id });
    await repo.updateNote(KOUFU, p.id, { status: 'resolved' }, 'editor1');
    const all = await repo.listNotes(KOUFU);
    expect(all.find((e) => e.id === r.id)?.status).toBe('resolved');
    await repo.updateNote(KOUFU, p.id, { status: 'open' }, 'editor1');
    expect((await repo.listNotes(KOUFU)).every((e) => e.status === 'open')).toBe(true);
  });

  it('返信への状態指定は拒否する', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id });
    await expect(
      repo.updateNote(KOUFU, r.id, { status: 'resolved' }, 'editor1'),
    ).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('返信の本文は編集できる', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id });
    expect((await repo.updateNote(KOUFU, r.id, { content: '直した返信' }, 'editor2')).content).toBe(
      '直した返信',
    );
  });
});

describe('削除', () => {
  it('親を削除すると返信も消え、パーツが空になればキーごと畳む', async () => {
    const { repo, files } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    await repo.addNote(KOUFU, KEY, '返信 1', 'editor2', { replyTo: p.id });
    await repo.addNote(KOUFU, KEY, '返信 2', 'editor2', { replyTo: p.id });
    await repo.deleteNote(KOUFU, p.id);
    expect(await repo.listNotes(KOUFU)).toEqual([]);
    expect(await files.readNotes(KOUFU)).toEqual({});
  });

  it('返信だけを削除しても親は残る', async () => {
    const { repo } = await importRepo();
    const p = await repo.addNote(KOUFU, KEY, '親', 'editor1', PARENT);
    const r = await repo.addNote(KOUFU, KEY, '返信', 'editor2', { replyTo: p.id });
    await repo.deleteNote(KOUFU, r.id);
    expect((await repo.listNotes(KOUFU)).map((e) => e.id)).toEqual([p.id]);
  });
});

describe('存在しない投稿への操作', () => {
  it('updateNote は validation で拒否する', async () => {
    const { repo } = await importRepo();
    await expect(
      repo.updateNote(KOUFU, 'nope', { content: '更新' }, 'editor1'),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('deleteNote は validation で拒否する', async () => {
    const { repo } = await importRepo();
    await expect(repo.deleteNote(KOUFU, 'nope')).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('件数上限に達したパーツの更新・削除(上限は詰みを作らない)', () => {
  async function seedAtCapacity(files: typeof import('../src/files/notesFile.js')): Promise<void> {
    const entries = Array.from({ length: MAX_NOTE_ENTRIES_PER_PART }, (_, i) => ({
      id: `e${i}`,
      content: `メモ${i}`,
      createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
      status: 'open' as const,
      replyTo: null,
    }));
    await files.writeNotes(KOUFU, { [KEY]: entries });
  }

  it('追加は拒否するが、既存投稿の編集は通す', async () => {
    const { repo, files } = await importRepo();
    await seedAtCapacity(files);
    await expect(repo.addNote(KOUFU, KEY, 'あふれる', 'editor1', PARENT)).rejects.toMatchObject({
      kind: 'validation',
    });
    const updated = await repo.updateNote(KOUFU, 'e0', { content: '更新' }, 'editor1');
    expect(updated.content).toBe('更新');
  });

  it('追加は拒否するが、既存投稿の削除は通す', async () => {
    const { repo, files } = await importRepo();
    await seedAtCapacity(files);
    await repo.deleteNote(KOUFU, 'e1');
    expect((await repo.listNotes(KOUFU)).find((e) => e.id === 'e1')).toBeUndefined();
  });
});

describe('配列でない値の扱い', () => {
  // 読み取りで捨てた値は、次の書き込みの元にもならない(書き込みも同じ読み取りから組む)。
  async function writeMixedFile(): Promise<void> {
    const notesDir = path.join(tmpRoot, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      path.join(notesDir, `${KOUFU}.json`),
      JSON.stringify({
        [KEY]: { content: '旧', updatedAt: 'x', updatedBy: 'u' },
        [OTHER_KEY]: [
          {
            id: 'e1',
            content: '残る',
            createdAt: '2026-09-01T00:00:00.000Z',
            createdBy: 'u',
            updatedAt: null,
            updatedBy: null,
          },
        ],
      }),
      'utf8',
    );
  }

  it('一覧には配列の投稿だけが出る', async () => {
    const { repo } = await importRepo();
    await writeMixedFile();
    expect((await repo.listNotes(KOUFU)).map((e) => e.id)).toEqual(['e1']);
  });

  it('同じファイルへ書き込むと、配列でない値は残らない', async () => {
    const { repo } = await importRepo();
    await writeMixedFile();
    await repo.addNote(KOUFU, KEY, '新しい投稿', 'editor1', PARENT);
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpRoot, 'notes', `${KOUFU}.json`), 'utf8'),
    ) as Record<string, Array<{ id: string; content: string }>>;
    expect(raw[KEY].map((e) => e.content)).toEqual(['新しい投稿']);
    expect(raw[OTHER_KEY][0].id).toBe('e1');
  });
});
