// =============================================================================
// legacyLayoutCheck.test.ts — 旧構成の残り(assets・CSS の ../fonts/)を起動時に警告するか
// =============================================================================
// 一時フォルダに実物の置き場を作って確かめる。起動を止めない(reject しない)ことも固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // config の既定(dataRoot・cssDir)を、存在しない一時の場所へ向けてから import させる。
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  process.env.LOG_DIR = `${tmpRoot}/editor-legacy-layout-logs`;
  process.env.DATA_ROOT = `${tmpRoot}/editor-legacy-layout-missing-root`;
  process.env.APP_CONFIG = `${tmpRoot}/editor-legacy-layout-no-appconfig.json`;
});

import {
  findLegacyLayout,
  LEGACY_FONT_URL_RE,
  warnLegacyLayoutAtStartup,
} from '../src/files/legacyLayoutCheck.js';
import { logger } from '../src/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];

function makeRoot(): { dataRoot: string; cssDir: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-legacy-layout-'));
  roots.push(dataRoot);
  const cssDir = path.join(dataRoot, 'css');
  fs.mkdirSync(cssDir, { recursive: true });
  return { dataRoot, cssDir };
}

const fakeLog = () => ({ warn: vi.fn() });

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('LEGACY_FONT_URL_RE', () => {
  it.each([
    ['url(../fonts/a.woff2)', true],
    ['url( "../fonts/a.woff2")', true],
    ["URL('../FONTS/a.woff2')", true],
    ['url(fonts/a.woff2)', false],
    ['url(../../fonts/a.woff2)', false],
    ['url(css/fonts/a.woff2)', false],
  ])('%s → %s', (css, expected) => {
    expect(LEGACY_FONT_URL_RE.test(css)).toBe(expected);
  });
});

describe('findLegacyLayout', () => {
  it('cssDir 直下の .css だけを見て、名前順に返す', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, 'b.css'), '@font-face{src:url(../fonts/b.woff2)}');
    fs.writeFileSync(path.join(r.cssDir, 'a.css'), '@font-face{src:url("../fonts/a.woff2")}');
    fs.writeFileSync(path.join(r.cssDir, 'new.css'), '@font-face{src:url(fonts/n.woff2)}');
    fs.writeFileSync(path.join(r.cssDir, 'note.txt'), 'url(../fonts/x.woff2)');
    fs.mkdirSync(path.join(r.cssDir, 'sub'));
    fs.writeFileSync(path.join(r.cssDir, 'sub', 'd.css'), 'url(../fonts/d.woff2)');
    expect(await findLegacyLayout(r)).toEqual({ assetsDir: null, cssFiles: ['a.css', 'b.css'] });
  });

  it('読めない CSS は残っていない扱いで読み飛ばす', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, 'a.css'), 'url(../fonts/a.woff2)');
    vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('EACCES'));
    expect((await findLegacyLayout(r)).cssFiles).toEqual([]);
  });

  it('assets がファイルなら残っていない扱い', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.dataRoot, 'assets'), 'not a folder');
    expect((await findLegacyLayout(r)).assetsDir).toBeNull();
  });
});

describe('warnLegacyLayoutAtStartup', () => {
  it('assets が残っていれば、場所とパッチの案内を添えて警告する', async () => {
    const r = makeRoot();
    fs.mkdirSync(path.join(r.dataRoot, 'assets', 'fonts'), { recursive: true });
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const msg = log.warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/^\[layout\] /);
    expect(msg).toContain(path.join(r.dataRoot, 'assets'));
    expect(msg).toContain(
      'フォント移設パッチ editor/patches/2026-10-fonts-to-css/ を流してください',
    );
  });

  it('CSS に url(../fonts/ が残っていれば、ファイル名を並べて警告する', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, '510037.css'), '@font-face{src:url(../fonts/a.woff2)}');
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const msg = log.warn.mock.calls[0][0] as string;
    expect(msg).toContain('url(../fonts/');
    expect(msg).toContain('510037.css');
    expect(msg).toContain('フォント移設パッチ');
  });

  it('6 件以上は 5 件まで並べ、残りの件数を添える', async () => {
    const r = makeRoot();
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(r.cssDir, `f${i}.css`), 'src:url(../fonts/a.woff2)');
    }
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    const msg = log.warn.mock.calls[0][0] as string;
    expect(msg).toContain('f1.css, f2.css, f3.css, f4.css, f5.css ほか 2 件');
    expect(msg).not.toContain('f6.css');
  });

  it('何も残っていなければ警告しない', async () => {
    const r = makeRoot();
    fs.writeFileSync(path.join(r.cssDir, '510037.css'), '@font-face{src:url(fonts/a.woff2)}');
    const log = fakeLog();
    await warnLegacyLayoutAtStartup(log, r);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('置き場が無くても reject せず、警告もしない', async () => {
    const log = fakeLog();
    const missing = path.join(os.tmpdir(), 'editor-legacy-layout-none', 'x');
    await expect(
      warnLegacyLayoutAtStartup(log, { dataRoot: missing, cssDir: path.join(missing, 'css') }),
    ).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('確認に失敗したら、その旨も渡された出力先へ警告する', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const log = fakeLog();
    // path.join が型の違う引数で投げる = 確認そのものの失敗。
    const bad = { dataRoot: 42 as unknown as string, cssDir: 'x' };
    await expect(warnLegacyLayoutAtStartup(log, bad)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('旧構成の確認に失敗しました'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('出力先が例外を投げても reject せず、サーバのロガーへ警告する', async () => {
    const r = makeRoot();
    fs.mkdirSync(path.join(r.dataRoot, 'assets'));
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const log = {
      warn: () => {
        throw new Error('boom');
      },
    };
    await expect(warnLegacyLayoutAtStartup(log, r)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('旧構成の確認に失敗しました: boom'));
  });

  it('既定ではサーバの設定(dataRoot・cssDir)を見る', async () => {
    const log = fakeLog();
    await expect(warnLegacyLayoutAtStartup(log)).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('serve.ts は起動時に待たずに呼ぶ(listen を遅らせず、例外で起動を止めない)', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../src/serve.ts'), 'utf8');
    expect(src).toMatch(/\n\s*warnLegacyLayoutAtStartup\(\)\.catch\(\(\) => \{\}\);/);
  });
});
