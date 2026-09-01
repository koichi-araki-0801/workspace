// =============================================================================
// notes.limits.test.ts — メモの資源上限と読み-改変-書きの直列化
// =============================================================================
// メモは `dataRoot/notes/<templateId>.json` に**マップ丸ごと**で持つ。上限が無い形では
//   ① 1 件の本文にも、マップの件数にも、ファイル全体にも天井が無く、
//   ② 読み側はサイズを見ずに `JSON.parse` し(全 GET が同じ時間だけ止まる)、
//   ③ 保存は読み-改変-書きを直列化しないので同時保存が互いの更新を消す。
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
  it('上限に達したら新規キーは拒否し、既存キーの追加と削除は通す', async () => {
    const { files, repo } = await importNotes();
    const full: Record<string, unknown> = {};
    for (let i = 0; i < files.MAX_NOTES_PER_TEMPLATE; i++) {
      full[`p${i}`] = [
        {
          id: `e${i}`,
          content: 'x',
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'tester',
          updatedAt: null,
          updatedBy: null,
        },
      ];
    }
    await fs.mkdir(path.join(tmpRoot, 'notes'), { recursive: true });
    await fs.writeFile(notesPath(), JSON.stringify(full), 'utf8');

    await expect(repo.addNote(TPL, 'brand-new', 'メモ', 'tester')).rejects.toMatchObject({
      kind: 'validation',
    });
    // 既存キーへの追加・削除は上限に関係なく通る(上限が「消せない」状態を作らない)。
    await expect(repo.addNote(TPL, 'p0', '追記', 'tester')).resolves.toMatchObject({
      content: '追記',
    });
    await expect(repo.deleteNote(TPL, 'e1')).resolves.toBeUndefined();
    const after = await files.readNotes(TPL);
    expect(after.p0).toHaveLength(2);
    expect(after.p1).toBeUndefined();
  });
});

describe('同時保存で更新が消えない', () => {
  it('同一テンプレへの並行 addNote が全て残る', async () => {
    const { files, repo } = await importNotes();
    // 直列化が無いと、両者が同じ「空のマップ」を読んで書き戻すので後勝ちで片方が消える。
    await Promise.all([
      repo.addNote(TPL, 'a', 'A', 'u1'),
      repo.addNote(TPL, 'b', 'B', 'u2'),
      repo.addNote(TPL, 'c', 'C', 'u3'),
    ]);
    const map = await files.readNotes(TPL);
    expect(Object.keys(map).sort()).toEqual(['a', 'b', 'c']);
  });

  // ── degrade を書き込みの入力にしない ──
  // 「読めないときは空を返す」は読み取りを守るための degrade だが、読み-改変-書きの
  // 入力にすると**破壊**になる。メモは git 管理外なので消えたら復元できず、監査も残らない。
  it('読めないメモファイルがあるとき保存は拒否され、既存の内容が保たれる', async () => {
    const { files, repo } = await importNotes();
    const tplId = 'AM01_510037_20240710_交付版';
    const file = path.join(tmpRoot, 'notes', `${tplId}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 上限を超える実体を直に置く(修正前の版が書いたファイル、という想定)。
    const big = 'x'.repeat(files.MAX_NOTES_FILE_BYTES + 1);
    await fs.writeFile(file, big, 'utf8');

    await expect(repo.addNote(tplId, 'p1', '新しいメモ', 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
    // 中身は 1 バイトも変わっていない(全件が 1 件へ潰れていない)。
    expect((await fs.readFile(file, 'utf8')).length).toBe(big.length);
  });

  it('壊れた JSON でも保存は拒否される(表示は空でも書き戻さない)', async () => {
    const { files, repo } = await importNotes();
    const tplId = 'AM01_510037_20240710_交付版';
    const file = path.join(tmpRoot, 'notes', `${tplId}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ this is not json', 'utf8');

    // 表示経路は落とさない(degrade はそのまま)。
    expect(await files.readNotes(tplId)).toEqual({});
    // 書き込み経路は拒否する。
    await expect(repo.addNote(tplId, 'p1', 'x', 'editor1')).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(await fs.readFile(file, 'utf8')).toBe('{ this is not json');
  });

  // ── 件数上限はサイズ上限を守れない ──
  it('件数上限内でもサイズ上限を超える書き込みは拒否される', async () => {
    const { files } = await importNotes();
    const tplId = 'AM01_510037_20240710_交付版';
    // 1 件 64KiB × 70 件 ≒ 4.4MiB。件数上限 1000 の 7% でファイル上限を超える
    // (1000 × 64KiB = 64MiB は 4MiB の 16 倍で、件数だけではサイズを縛れない)。
    const map: Record<string, unknown> = {};
    for (let i = 0; i < 70; i++)
      map[`p${i}`] = [
        {
          id: `e${i}`,
          content: 'あ'.repeat(20_000),
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ];
    expect(Object.keys(map).length).toBeLessThan(files.MAX_NOTES_PER_TEMPLATE);
    await expect(
      files.writeNotes(tplId, map as Parameters<typeof files.writeNotes>[1]),
    ).rejects.toMatchObject({ kind: 'validation' });
    // 実体を作らせない(次の保存で全件が消える状態を最初から作らない)。
    await expect(fs.stat(path.join(tmpRoot, 'notes', `${tplId}.json`))).rejects.toBeTruthy();
  });
});
