// =============================================================================
// ioFailurePolicy.test.ts — 読み取り失敗を空文字へ丸めない(I/O 例外方針)
// =============================================================================
// 「無い」を空文字で表すのは正常状態の表現であって、**読めなかった**ことの表現ではない。
// 一過性の I/O 障害(EACCES / EBUSY / EISDIR)を空文字へ倒すと、その値を書き戻す経路が
// 本文を空で確定させたり、承認画面が「変更前は空だった」と読める差分を出したりする。
// 読み取り側の分岐が「不存在」と「読めない」を区別していることを固定する。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-io-policy-'));
process.env.DATA_ROOT = tmp;

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

d('gitRepo.showFile', () => {
  let git: typeof import('../src/git/gitRepo.js');
  let hash: string;

  beforeAll(async () => {
    git = await import('../src/git/gitRepo.js');
    await git.ensureRepo();
    fs.mkdirSync(path.join(tmp, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'templates', 'a.html'), '<p>A</p>', 'utf8');
    hash = await git.commitAll('初回', { name: 'tester' });
  });

  it('その版に無いパスは空文字を返す(正常な「無い」)', async () => {
    expect(await git.showFile(hash, 'templates/nope.html')).toBe('');
  });

  it('パスの不在以外の失敗は握りつぶさない', async () => {
    // git の実行そのものが失敗する状況(ここでは作業ディレクトリの消失)を作る。空文字を
    // 返すとその版の中身が消えたように見え、承認画面の差分が全文追加として描かれる。
    const { config } = await import('../src/config.js');
    const original = config.gitRepoDir;
    config.gitRepoDir = path.join(tmp, '存在しない作業ディレクトリ');
    try {
      await expect(git.showFile(hash, 'templates/a.html')).rejects.toThrow();
    } finally {
      config.gitRepoDir = original;
    }
  });
});

describe('templateFiles.readTemplateHtml', () => {
  let files: typeof import('../src/files/templateFiles.js');
  const templatesDir = path.join(tmp, 'templates');

  beforeAll(async () => {
    files = await import('../src/files/templateFiles.js');
    fs.mkdirSync(templatesDir, { recursive: true });
  });

  it('まだ無いテンプレは空文字(正常な「無い」)', async () => {
    expect(await files.readTemplateHtml('AM01_777777_20250101_交付版.html')).toBe('');
  });

  it('規約外の名前は空文字(パスを解決しないので読みに行かない)', async () => {
    expect(await files.readTemplateHtml('../escape.html')).toBe('');
  });

  it('解決できたパスの読み取り失敗は例外にする', async () => {
    // ディレクトリを同名で置くと readFile は EISDIR で落ちる。空文字へ倒すと、その値を
    // 基準にした実行コード照合や書き戻しが「本文が空」を前提に進む。
    const id = 'AM01_888888_20250101_交付版';
    fs.mkdirSync(path.join(templatesDir, `${id}.html`), { recursive: true });
    await expect(files.readTemplateHtml(`${id}.html`)).rejects.toThrow();
  });
});
