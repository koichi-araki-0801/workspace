// =============================================================================
// notes.limits.test.ts — メモの資源上限と読み-改変-書きの直列化(F10 / F40)
// =============================================================================
// メモは `dataRoot/notes/<templateId>.json` に**マップ丸ごと**で持つ。上限が無かった版は
//   ① 1 件の本文にも、マップの件数にも、ファイル全体にも天井が無く、
//   ② 読み側はサイズを見ずに `JSON.parse` し(全 GET が同じ時間だけ止まる)、
//   ③ 保存は読み-改変-書きを直列化していないので同時保存が互いの更新を消していた。
// ここで主張するのは**上限が効くこと**と**同時保存で更新が消えないこと**。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;

async function importNotes(): Promise<{
  files: typeof import('../src/files/notesFile.js');
  repo: typeof import('../src/repositories/noteRepo.js');
}> {
  vi.stubEnv('DATA_ROOT', tmpRoot);
  vi.resetModules();
  return {
    files: await import('../src/files/notesFile.js'),
    repo: await import('../src/repositories/noteRepo.js'),
  };
}

const TPL = 'AM01_510037_20240710_交付版';
const notesPath = (): string => path.join(tmpRoot, 'notes', `${TPL}.json`);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-notes-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('templateId の検証は正典 1 本に寄せる', () => {
  it('長さ上限(正典が持つ 200 文字)がここでも効く', async () => {
    const { files } = await importNotes();
    // 4 トークン構造には合うが、正典の単一セグメント上限を超える id。
    const longId = `AM01_510037_20240710_${'あ'.repeat(300)}`;
    await expect(files.readNotes(longId)).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('ファイルサイズの上限', () => {
  it('上限を超えたメモファイルは parse せず空として扱う', async () => {
    const { files } = await importNotes();
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), 'x'.repeat(files.MAX_NOTES_FILE_BYTES + 1), 'utf8');
    await expect(files.readNotes(TPL)).resolves.toEqual({});
  });

  it('壊れた JSON でも編集画面を落とさない(空として返す)', async () => {
    const { files } = await importNotes();
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), '{"a": ', 'utf8');
    await expect(files.readNotes(TPL)).resolves.toEqual({});
  });
});

describe('マップの件数上限', () => {
  it('上限に達したら新規キーは拒否し、既存キーの更新と削除は通す', async () => {
    const { files, repo } = await importNotes();
    const full: Record<string, unknown> = {};
    for (let i = 0; i < files.MAX_NOTES_PER_TEMPLATE; i++) {
      full[`p${i}`] = {
        templateId: TPL,
        pathKey: `p${i}`,
        content: 'x',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'tester',
      };
    }
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), JSON.stringify(full), 'utf8');

    await expect(repo.saveNote(TPL, 'brand-new', 'メモ', 'tester')).rejects.toMatchObject({
      kind: 'validation',
    });
    // 既存キーの更新は上限に関係なく通る(上限が「消せない」状態を作らない)。
    await expect(repo.saveNote(TPL, 'p0', '更新', 'tester')).resolves.toBeUndefined();
    await expect(repo.saveNote(TPL, 'p1', '', 'tester')).resolves.toBeUndefined();
    const after = await files.readNotes(TPL);
    expect(after.p0.content).toBe('更新');
    expect(after.p1).toBeUndefined();
  });
});

describe('同時保存で更新が消えない', () => {
  it('同一テンプレへの並行 saveNote が両方とも残る', async () => {
    const { files, repo } = await importNotes();
    // 直列化が無いと、両者が同じ「空のマップ」を読んで書き戻すので後勝ちで片方が消える。
    await Promise.all([
      repo.saveNote(TPL, 'a', 'A', 'u1'),
      repo.saveNote(TPL, 'b', 'B', 'u2'),
      repo.saveNote(TPL, 'c', 'C', 'u3'),
    ]);
    const map = await files.readNotes(TPL);
    expect(Object.keys(map).sort()).toEqual(['a', 'b', 'c']);
  });
});
