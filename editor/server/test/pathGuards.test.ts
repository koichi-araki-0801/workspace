// =============================================================================
// pathGuards.test.ts — ファイル I/O 層のパス封じ込め
// =============================================================================
// `templateId` / `fundCode` は request 由来のままディレクトリへ連結される。検査を呼び出し側に
// 委ねていた頃は、`../templates/<確定版>` を渡すだけで承認ゲートを迂回して確定ファイルを
// 上書き・読み出し・削除できた。ここで守るのは「I/O 層に入った不正な名前は、必ず例外か
// 空振りになり、管理ディレクトリの外へは 1 バイトも触れない」こと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAppError } from '@editor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config を import する前に全ディレクトリを一時領域へ向ける。`root/outside` を「管理外」の
// 標的に見立て、脱出が成立していれば必ずここに痕跡が残る配置にする。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-pathguards-'));
process.env.DATA_ROOT = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.DRAFTS_DIR = path.join(root, 'data', 'drafts');

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

  beforeAll(async () => {
    fs.mkdirSync(OUTSIDE, { recursive: true });
    draftFiles = await import('../src/files/draftFiles.js');
    templateFiles = await import('../src/files/templateFiles.js');
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

  it.each(ESCAPES)('writeTemplateAndCss rejects a traversal file name (%s)', async (id) => {
    await expect(
      templateFiles.writeTemplateAndCss(`${id}.html`, '<p>pwned</p>', '510037', ''),
    ).rejects.toSatisfy(isAppError);
    expect(strayFiles()).toEqual([]);
  });

  it.each(ESCAPES)('writeTemplateAndCss rejects a traversal fund code (%s)', async (fund) => {
    await expect(
      templateFiles.writeTemplateAndCss(`${VALID_ID}.html`, '<p>x</p>', fund, 'body{}'),
    ).rejects.toSatisfy(isAppError);
    expect(strayFiles()).toEqual([]);
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

  it('writeTemplateAndCss accepts a valid pair and writes only inside the managed dirs', async () => {
    await templateFiles.writeTemplateAndCss(`${VALID_ID}.html`, '<p>ok</p>', '510037', 'body{}');
    expect(fs.existsSync(path.join(root, 'data', 'templates', `${VALID_ID}.html`))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'css', '510037.css'))).toBe(true);
    expect(strayFiles()).toEqual([]);
  });
});
