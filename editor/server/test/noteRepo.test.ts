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
    // id は挿入順(配列順)と辞書順がわざと食い違うようにしてある(z1 → m2 → a3 の順に
    // 書き込むが、辞書順は a3 < m2 < z1 で逆順)。id を tiebreak に使う実装が復活すると
    // 結果が辞書順(3 件目, 2 件目, 1 件目)へ入れ替わり、このテストが落ちる。
    await files.writeNotes(KOUFU, {
      [KEY]: [
        {
          id: 'z1',
          content: '1 件目',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
        {
          id: 'm2',
          content: '2 件目',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
        {
          id: 'a3',
          content: '3 件目',
          createdAt: t,
          createdBy: 'editor1',
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });

    const thread = await repo.listNotes(KOUFU);
    // 書き込んだ配列順そのものを主張する(集合ではなく順序を見る)。
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

    // 自版として「全体版」側を問い合わせる。期待順は自版 → ペア版 = [全体版, 交付版]。
    // templateId を tiebreak に使う実装が復活すると、"交付版" < "全体版" の文字コード順で
    // 交付版が先に来てしまい(自版がどちらでも辞書順は固定なので、自版=交付版側で問い合わせる
    // と辞書順と期待順が一致してしまい判定にならない)、このテストが落ちる。
    const thread = await repo.listNotes(ZENTAI);
    expect(thread.map((e) => e.content)).toEqual(['全体版', '交付版']);
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

describe('旧形式ファイル(複数 pathKey)での id 衝突を防ぐ', () => {
  // 旧形式(`pathKey` → メモ 1 件)の変換 ID を固定値 `legacy` にすると、`locate` はファイル内の
  // 全 pathKey を横断して ID 一致を探すため、2 パーツ以上を持つ旧形式ファイルでは全パーツが
  // 同じ ID を名乗ってしまい、削除・編集が先頭に見つかった別パーツへ誤爆する(データ損失)。
  // ここでは 2 つの異なる pathKey を持つ旧形式ファイルを直接書き、片方の削除・編集がもう片方に
  // 波及しないことを主張する。
  const KEY2 = '.page#1/cover#2';

  async function writeLegacyFile(): Promise<void> {
    const notesPath = path.join(tmpRoot, 'notes', `${KOUFU}.json`);
    await fs.mkdir(path.dirname(notesPath), { recursive: true });
    await fs.writeFile(
      notesPath,
      JSON.stringify({
        [KEY]: {
          content: 'パーツ1の旧メモ',
          updatedAt: '2026-08-01T00:00:00.000Z',
          updatedBy: 'u1',
        },
        [KEY2]: {
          content: 'パーツ2の旧メモ',
          updatedAt: '2026-08-01T00:00:00.000Z',
          updatedBy: 'u2',
        },
      }),
      'utf8',
    );
  }

  it('一方のパーツの投稿を削除しても、もう一方のパーツの投稿は残る', async () => {
    const { repo, files } = await importRepo();
    await writeLegacyFile();

    const before = await repo.listNotes(KOUFU);
    const target = before.find((e) => e.pathKey === KEY);
    if (!target) throw new Error('セットアップ失敗: パーツ1の投稿が見つからない');

    await repo.deleteNote(KOUFU, target.id);

    const after = await files.readNotes(KOUFU);
    expect(after[KEY]).toBeUndefined();
    expect(after[KEY2]).toHaveLength(1);
    expect(after[KEY2][0].content).toBe('パーツ2の旧メモ');
  });

  it('一方のパーツの投稿を編集しても、もう一方のパーツの投稿は変わらない', async () => {
    const { repo, files } = await importRepo();
    await writeLegacyFile();

    const before = await repo.listNotes(KOUFU);
    const target = before.find((e) => e.pathKey === KEY);
    if (!target) throw new Error('セットアップ失敗: パーツ1の投稿が見つからない');

    await repo.updateNote(KOUFU, target.id, 'パーツ1の修正後', 'editor1');

    const after = await files.readNotes(KOUFU);
    expect(after[KEY][0].content).toBe('パーツ1の修正後');
    expect(after[KEY2][0].content).toBe('パーツ2の旧メモ');
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
