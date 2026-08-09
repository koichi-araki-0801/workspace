// =============================================================================
// pathGuards.test.ts — ファイル I/O 層のパス封じ込め
// =============================================================================
// `templateId` / `fundCode` は request 由来のままディレクトリへ連結される。検査を呼び出し側に
// 委ねると、`../templates/<確定版>` を渡すだけで承認ゲートを迂回して確定ファイルを
// 上書き・読み出し・削除できてしまう。ここで守るのは「I/O 層に入った不正な名前は、必ず例外か
// 空振りになり、管理ディレクトリの外へは 1 バイトも触れない」こと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAppError } from '@editor/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 確定書込はチョークポイント(`repositories/confirmedWrite.ts`)経由でしか呼べないので、
// そこが引き込む git を止める。ここで見たいのはパス封じ込めであって版管理ではない。
vi.mock('../src/git/gitRepo.js', () => ({
  ensureRepo: async () => {},
  withGitLock: async (fn: () => Promise<unknown>) => fn(),
  commitAll: async () => {},
}));

// config を import する前に全ディレクトリを一時領域へ向ける。`root/outside` を「管理外」の
// 標的に見立て、脱出が成立していれば必ずここに痕跡が残る配置にする。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-pathguards-'));
process.env.DATA_ROOT = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.DRAFTS_DIR = path.join(root, 'data', 'drafts');
process.env.PENDING_DIR = path.join(root, 'data', 'pending');

const OUTSIDE = path.join(root, 'outside');
const VALID_ID = 'AM01_510037_20240710_交付版';

/** 管理ディレクトリの外を狙う id。相対 1 段上がると `data/` 直下、2 段で `root/outside`。 */
const ESCAPES = [
  '../outside/pwned',
  '..\\outside\\pwned',
  '../../outside/pwned',
  `${VALID_ID}/../../../outside/pwned`,
  '/etc/passwd',
  'C:\\Windows\\Temp\\pwned',
];

describe('files/*.ts のパス封じ込め', () => {
  let draftFiles: typeof import('../src/files/draftFiles.js');
  let templateFiles: typeof import('../src/files/templateFiles.js');
  let pendingFiles: typeof import('../src/files/pendingFiles.js');
  let confirmedWrite: typeof import('../src/repositories/confirmedWrite.js');

  beforeAll(async () => {
    fs.mkdirSync(OUTSIDE, { recursive: true });
    draftFiles = await import('../src/files/draftFiles.js');
    templateFiles = await import('../src/files/templateFiles.js');
    pendingFiles = await import('../src/files/pendingFiles.js');
    confirmedWrite = await import('../src/repositories/confirmedWrite.js');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 管理ディレクトリ外に作られたファイルを列挙する(空であるべき)。 */
  function strayFiles(): string[] {
    return fs.readdirSync(OUTSIDE);
  }

  it.each(ESCAPES)('writeDraft rejects a traversal id (%s)', async (id) => {
    await expect(draftFiles.writeDraft(id, '<p>pwned</p>', '')).rejects.toSatisfy(isAppError);
    expect(strayFiles()).toEqual([]);
  });

  it.each(ESCAPES)('deleteDraft rejects a traversal id (%s)', async (id) => {
    // 削除は「消えても分からない」ぶん危険。到達前に落ちることを確かめる。
    const decoy = path.join(OUTSIDE, 'pwned.html');
    fs.writeFileSync(decoy, 'keep me');
    await expect(draftFiles.deleteDraft(id)).rejects.toSatisfy(isAppError);
    expect(fs.existsSync(decoy)).toBe(true);
    fs.rmSync(decoy);
  });

  it('readDraft ignores ledger entries that are not a valid draft file name', async () => {
    const secret = path.join(OUTSIDE, 'secret.html');
    fs.writeFileSync(secret, 'TOP SECRET');
    const got = await draftFiles.readDraft('../outside/secret.html', null);
    expect(got.html).toBe('');
    fs.rmSync(secret);
  });

  it('writeDraft accepts a valid id and keeps the file inside draftsDir', async () => {
    const refs = await draftFiles.writeDraft(VALID_ID, '<p>ok</p>', '.a{}');
    expect(refs.htmlFile).toBe(`${VALID_ID}.html`);
    expect(fs.existsSync(path.join(root, 'data', 'drafts', `${VALID_ID}.html`))).toBe(true);
    const got = await draftFiles.readDraft(refs.htmlFile, refs.cssFile);
    expect(got.html).toBe('<p>ok</p>');
    expect(strayFiles()).toEqual([]);
  });

  // 確定書込は `templateFiles` からは export されず、`applyConfirmedWrite` だけが
  // 持つ。トラバーサル拒否がこのチョークポイントでも生きていることをここで固定する。
  it.each(ESCAPES)('applyConfirmedWrite rejects a traversal template id (%s)', async (id) => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        templateId: id,
        fundCode: '510037',
        html: '<p>pwned</p>',
        css: '',
        author: 'tester',
        commitMessage: 'x',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(strayFiles()).toEqual([]);
  });

  it.each(ESCAPES)('applyConfirmedWrite rejects a traversal fund code (%s)', async (fund) => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        templateId: VALID_ID,
        fundCode: fund,
        html: '<p>x</p>',
        css: 'body{}',
        author: 'tester',
        commitMessage: 'x',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(strayFiles()).toEqual([]);
  });

  it.each(ESCAPES)('writePending rejects a traversal id (%s)', async (id) => {
    // pending は「確定へは書かせない」ための受け皿なので、ここが緩いと
    // `../templates/<確定版>` を渡すだけで承認ゲートごと迂回できる。
    await expect(pendingFiles.writePending(id, '<p>pwned</p>', '')).rejects.toSatisfy(isAppError);
    expect(strayFiles()).toEqual([]);
  });

  it.each(ESCAPES)('deletePending rejects a traversal id (%s)', async (id) => {
    const decoy = path.join(OUTSIDE, 'pwned.html');
    fs.writeFileSync(decoy, 'keep me');
    await expect(pendingFiles.deletePending(id)).rejects.toSatisfy(isAppError);
    expect(fs.existsSync(decoy)).toBe(true);
    fs.rmSync(decoy);
  });

  it('readPending treats an invalid id as missing rather than throwing', async () => {
    const secret = path.join(OUTSIDE, 'secret.html');
    fs.writeFileSync(secret, 'TOP SECRET');
    await expect(pendingFiles.readPending('../outside/secret')).resolves.toBeNull();
    await expect(pendingFiles.pendingExists('../outside/secret')).resolves.toBe(false);
    await expect(pendingFiles.pendingMtime('../outside/secret')).resolves.toBeNull();
    fs.rmSync(secret);
  });

  it('read/probe helpers treat an invalid name as missing rather than throwing', async () => {
    // ベストエフォートの経路(ペア同期・メタ組み立て)を不正入力 1 件で落とさないため、
    // 読み取り側は例外ではなく「無い」を返す約束にしている。
    await expect(templateFiles.templateExists('../outside/secret.html')).resolves.toBe(false);
    await expect(templateFiles.readTemplateHtml('../outside/secret.html')).resolves.toBe('');
    await expect(templateFiles.templateMtime('../outside/secret.html')).resolves.toBeNull();
    await expect(templateFiles.readFundCss('../outside/x')).resolves.toBe('');
    await expect(draftFiles.draftExists('../outside/x')).resolves.toBe(false);
    await expect(draftFiles.draftMtime('../outside/x')).resolves.toBeNull();
  });

  it('applyConfirmedWrite accepts a valid pair and writes only inside the managed dirs', async () => {
    await confirmedWrite.applyConfirmedWrite({
      kind: 'review-approve',
      templateId: VALID_ID,
      fundCode: '510037',
      html: '<p>ok</p>',
      css: 'body{}',
      author: 'tester',
      commitMessage: 'x',
    });
    expect(fs.existsSync(path.join(root, 'data', 'templates', `${VALID_ID}.html`))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'css', '510037.css'))).toBe(true);
    expect(strayFiles()).toEqual([]);
  });
});
