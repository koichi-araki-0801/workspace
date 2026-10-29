// =============================================================================
// templateCss.test.ts — CSS はテンプレ単位(`<会社>_<ファンド>_<版種>.css`)で読む
// =============================================================================
// 基準日違いの値入り HTML は同じ CSS を共有し、交付版と全体版は別の CSS になる。cssDir の中は
// 大文字小文字を区別せずに探し、綴りだけ違うファイルが 2 つあればどちらとも決めずにエラーにする。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAppError } from '@editor/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-template-css-'));
process.env.DATA_ROOT = root;
process.env.CSS_DIR = path.join(root, 'css');
const cssDir = path.join(root, 'css');

const files = await import('../src/files/templateFiles.js');

const put = (name: string, text: string) => fs.writeFileSync(path.join(cssDir, name), text, 'utf8');

describe('readTemplateCss / resolveTemplateCssPath', () => {
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cssDir, { recursive: true, force: true });
    fs.mkdirSync(cssDir, { recursive: true });
  });

  it('基準日違いの 2 文書は同じ CSS を読む', async () => {
    put('XX01_950037_交付版.css', '.kofu{}');
    expect(await files.readTemplateCss('XX01_950037_20240710_交付版')).toBe('.kofu{}');
    expect(await files.readTemplateCss('XX01_950037_20250110_交付版')).toBe('.kofu{}');
    // テンプレート(3 つ区切り)も同じ CSS を読む。
    expect(await files.readTemplateCss('XX01_950037_交付版')).toBe('.kofu{}');
  });

  it('交付版と全体版は別の CSS', async () => {
    put('XX01_950037_交付版.css', '.kofu{}');
    put('XX01_950037_全体版.css', '.zentai{}');
    expect(await files.readTemplateCss('XX01_950037_20240710_交付版')).toBe('.kofu{}');
    expect(await files.readTemplateCss('XX01_950037_20240710_全体版')).toBe('.zentai{}');
  });

  it('旧名(<fund>.css)は読まない', async () => {
    put('950037.css', '.old{}');
    expect(await files.readTemplateCss('XX01_950037_20240710_交付版')).toBe('');
  });

  it('ID が XXAM でも実ファイル xxam_… を見つけ、その綴りのパスを返す', async () => {
    put('xxam_910024_交付版.css', '.lower{}');
    expect(await files.readTemplateCss('XXAM_910024_20240517_交付版')).toBe('.lower{}');
    expect(path.basename((await files.resolveTemplateCssPath('XXAM_910024_交付版')) ?? '')).toBe(
      'xxam_910024_交付版.css',
    );
    expect(await files.resolveTemplateCssName('XXAM_910024_20240517_交付版')).toBe(
      'xxam_910024_交付版.css',
    );
  });

  it('無ければ ID の綴りのパスを返し、読むと空', async () => {
    expect(await files.resolveTemplateCssPath('XXAM_910024_交付版')).toBe(
      path.join(cssDir, 'XXAM_910024_交付版.css'),
    );
    expect(await files.readTemplateCss('XXAM_910024_交付版')).toBe('');
  });

  it('cssDir 自体が無くても空(まだ CSS が 1 つも無い環境)', async () => {
    fs.rmSync(cssDir, { recursive: true, force: true });
    expect(await files.readTemplateCss('XX01_950037_交付版')).toBe('');
  });

  it('綴りだけ違う同名ファイルが 2 つあればエラー(どちらに書くかを決められない)', async () => {
    // NTFS は既定で大文字小文字を区別せず 2 ファイルを作れないため、一覧だけを差し替える。
    vi.spyOn(fsp, 'readdir').mockResolvedValue([
      'XXAM_910024_交付版.css',
      'xxam_910024_交付版.css',
    ] as never);
    await expect(files.resolveTemplateCssPath('XXAM_910024_交付版')).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.kind === 'conflict',
    );
    await expect(files.readTemplateCss('XXAM_910024_20240517_交付版')).rejects.toSatisfy(
      isAppError,
    );
  });

  it('規約外の ID は null / 空(パスを作らない)', async () => {
    expect(await files.resolveTemplateCssPath('../outside/x')).toBeNull();
    expect(await files.resolveTemplateCssName('../outside/x')).toBeNull();
    expect(await files.readTemplateCss('../outside/x')).toBe('');
    expect(await files.templateCssExists('../outside/x')).toBe(false);
  });

  it('templateCssExists は大文字小文字を区別せずに探した結果で有無を返す', async () => {
    expect(await files.templateCssExists('XXAM_910024_20240517_交付版')).toBe(false);
    put('xxam_910024_交付版.css', '');
    // 中身が空でも「ある」(見つからない警告は出さない)。
    expect(await files.templateCssExists('XXAM_910024_20240517_交付版')).toBe(true);
  });
});
