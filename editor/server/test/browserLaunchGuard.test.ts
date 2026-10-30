// =============================================================================
// browserLaunchGuard.test.ts — PDF ビルドのブラウザに WebRTC の UDP を止めるフラグを必ず渡す
// =============================================================================
// CLI がブラウザへ渡すネットワークの制御は `--proxy-server` だけで、WebRTC の ICE(UDP)と STUN の
// 名前解決はプロキシを通らない。ワーカーは 2 段で止める。(1) CLI の実体から解決した
// `puppeteer-core` の `ChromeLauncher.prototype.computeLaunchArguments` を包んでフラグを足す。
// (2) 実体に依らない最後の関所として `child_process.spawn` を包み、ブラウザの起動にフラグが
// 無ければその場で投げる。実ブラウザは起動しない(sandbox が無いため効き目は運用で確かめる)。
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  findPackageDir,
  hardenBrowserLaunch,
  importTargetOf,
  installSpawnGate,
  isBrowserExecutable,
  normalizeExecutable,
  resolvePuppeteerCoreFromCli,
  WEBRTC_FLAG,
  wrapComputeLaunchArguments,
} from '../scripts/browserLaunchGuard.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-launch-guard-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}
function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

/** 本物の CLI の入口(サーバの scripts から見た解決。ワーカーと同じ起点)。 */
const cliEntry = (() => {
  const url = import.meta.resolve('@vivliostyle/cli');
  return fs.realpathSync(new URL(url));
})();

describe('puppeteer-core の解決(CLI の実体を起点に、import の条件で)', () => {
  it('本物の CLI からは、CLI の実体の側の puppeteer-core の exports の import の行き先を返す', () => {
    const file = resolvePuppeteerCoreFromCli(cliEntry);
    const pkgDir = findPackageDir(cliEntry, 'puppeteer-core');
    expect(pkgDir).not.toBeNull();
    expect(file).toBe(
      fs.realpathSync(path.resolve(pkgDir as string, importTargetOf(pkgDir as string))),
    );
    // CLI の実体の置き場(pnpm なら `.pnpm/<cli>/node_modules`)の中で見つけている(そこから
    // さらに実体へのリンクを辿った先が `file`)。
    const cliStore = cliEntry.split(`${path.sep}@vivliostyle${path.sep}cli${path.sep}`)[0];
    expect((pkgDir as string).startsWith(cliStore)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('リンク経由の入口でも実体を起点にし、hoisted の別の版と require の行き先を拾わない', () => {
    const store = path.join(tmp, 'store', 'cli@1', 'node_modules');
    const entry = path.join(store, '@vivliostyle', 'cli', 'dist', 'index.js');
    writeFile(entry, 'export {};');
    writeJson(path.join(store, '@vivliostyle', 'cli', 'package.json'), {
      name: '@vivliostyle/cli',
    });
    writeJson(path.join(store, 'puppeteer-core', 'package.json'), {
      name: 'puppeteer-core',
      version: '2.0.0',
      exports: { '.': { types: './t.d.ts', import: './esm/main.js', require: './cjs/main.js' } },
    });
    writeFile(path.join(store, 'puppeteer-core', 'esm', 'main.js'), 'export {};');
    writeFile(path.join(store, 'puppeteer-core', 'cjs', 'main.js'), '');
    // hoisted の別の版(アプリの直下)。リンク側から素直に辿るとこちらを拾う。
    const app = path.join(tmp, 'app');
    writeJson(path.join(app, 'node_modules', 'puppeteer-core', 'package.json'), {
      name: 'puppeteer-core',
      version: '1.0.0',
      exports: './decoy.js',
    });
    writeFile(path.join(app, 'node_modules', 'puppeteer-core', 'decoy.js'), '');
    const link = path.join(app, 'node_modules', '@vivliostyle', 'cli');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(store, '@vivliostyle', 'cli'), link, 'junction');

    const resolved = resolvePuppeteerCoreFromCli(path.join(link, 'dist', 'index.js'));
    expect(resolved).toBe(fs.realpathSync(path.join(store, 'puppeteer-core', 'esm', 'main.js')));
  });

  it.each([
    ['文字列', './a.js', './a.js'],
    ['入れ子の条件', { '.': { node: { import: './n.mjs', require: './n.cjs' } } }, './n.mjs'],
    ['default だけ', { '.': { default: './d.js' } }, './d.js'],
  ])('exports の %s を import の条件で読む', (_label, exportsField, expected) => {
    const dir = path.join(tmp, `pkg-${Math.random().toString(16).slice(2)}`);
    writeJson(path.join(dir, 'package.json'), { name: 'x', exports: exportsField });
    expect(importTargetOf(dir)).toBe(expected);
  });

  it('exports が無ければ main、それも無ければ投げる', () => {
    const withMain = path.join(tmp, 'pkg-main');
    writeJson(path.join(withMain, 'package.json'), { name: 'x', main: './m.js' });
    expect(importTargetOf(withMain)).toBe('./m.js');
    const none = path.join(tmp, 'pkg-none');
    writeJson(path.join(none, 'package.json'), {
      name: 'x',
      exports: { '.': { require: './r.cjs' } },
    });
    expect(() => importTargetOf(none)).toThrow(/import/);
  });

  it('CLI の側に puppeteer-core が無ければ投げる(ワーカーを起動させない)', () => {
    const lonely = path.join(tmp, 'lonely', 'cli', 'dist', 'index.js');
    writeFile(lonely, '');
    expect(() => resolvePuppeteerCoreFromCli(lonely)).toThrow(/puppeteer-core/);
  });
});

describe('フラグの名前', () => {
  it('Chromium が読む `--webrtc-ip-handling-policy` で、`--force-` の付いた名前ではない', () => {
    // `--force-webrtc-ip-handling-policy` は Chromium のスイッチに無く、黙って無視される
    // (Edge でサーバの公開 IP の srflx 候補が PDF に出た)。名前を字面で固定する。
    expect(WEBRTC_FLAG).toBe('--webrtc-ip-handling-policy=disable_non_proxied_udp');
  });

  it('関所は `--force-` の付いた名前をフラグとして数えない', () => {
    const off = installSpawnGate(new Set());
    try {
      expect(() =>
        childProcess.spawn('C:/nowhere/msedge.exe', [
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ]),
      ).toThrow(WEBRTC_FLAG);
    } finally {
      off();
    }
  });
});

describe('computeLaunchArguments を包む', () => {
  class FakeLauncher {
    async computeLaunchArguments(options: { args?: string[] } = {}) {
      return { executablePath: 'C:/fake/chrome.exe', args: [...(options.args ?? [])] };
    }
  }

  it('戻りの args にフラグを 1 回だけ足し、実行ファイルを覚える', async () => {
    const known = new Set<string>();
    wrapComputeLaunchArguments(FakeLauncher, known);
    // 2 回包んでも二重にならない。
    wrapComputeLaunchArguments(FakeLauncher, known);
    const res = await new FakeLauncher().computeLaunchArguments({ args: ['--a', WEBRTC_FLAG] });
    expect(res.args.filter((a: string) => a === WEBRTC_FLAG)).toHaveLength(1);
    const res2 = await new FakeLauncher().computeLaunchArguments({ args: ['--a'] });
    expect(res2.args).toEqual(['--a', WEBRTC_FLAG]);
    expect(isBrowserExecutable('C:/fake/chrome.exe', known)).toBe(true);
  });

  it('包む先が関数でなければ投げる(版が変わって形が違えば起動させない)', () => {
    expect(() => wrapComputeLaunchArguments(class {}, new Set())).toThrow(/computeLaunchArguments/);
    expect(() => wrapComputeLaunchArguments(undefined, new Set())).toThrow(
      /computeLaunchArguments/,
    );
  });
});

describe('spawn の関所', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it.each([
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/opt/google/chrome/chrome',
    '/home/u/.cache/puppeteer/chrome-headless-shell/linux/chrome-headless-shell',
    'C:/x/Chromium.EXE',
    '/usr/bin/firefox',
  ])('%s はブラウザとして見分ける', (file) => {
    expect(isBrowserExecutable(file, new Set())).toBe(true);
  });

  it('node やほかの実行ファイルはブラウザとして扱わない', () => {
    expect(isBrowserExecutable(process.execPath, new Set())).toBe(false);
    expect(isBrowserExecutable('C:/x/git.exe', new Set())).toBe(false);
  });

  it('フラグの無いブラウザの起動は、子を起こす前にその場で投げる(名前付きの import も)', async () => {
    uninstall = installSpawnGate(new Set());
    expect(() => childProcess.spawn('C:/nowhere/msedge.exe', ['--headless'])).toThrow(WEBRTC_FLAG);
    expect(() => childProcess.spawn('C:/nowhere/msedge.exe')).toThrow(WEBRTC_FLAG);
    const { spawn } = await import('node:child_process');
    expect(() => spawn('/opt/google/chrome/chrome', ['--a'])).toThrow(WEBRTC_FLAG);
  });

  it('覚えた実行ファイルは名前が違ってもブラウザとして関所に掛ける', () => {
    const known = new Set<string>();
    uninstall = installSpawnGate(known);
    known.add(normalizeExecutable('C:/custom/renamed-browser.exe'));
    expect(() => childProcess.spawn('C:/custom/renamed-browser.exe', [])).toThrow(WEBRTC_FLAG);
  });

  it('フラグがあるブラウザの起動と、ブラウザ以外の起動は素通しする', async () => {
    uninstall = installSpawnGate(new Set());
    const browser = childProcess.spawn(path.join(tmp, 'missing', 'chrome.exe'), [WEBRTC_FLAG]);
    // 実体が無いので起動は失敗する(関所は通った = 例外は同期に出ていない)。
    await new Promise<void>((resolve) => browser.once('error', () => resolve()));
    const node = childProcess.spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => node.once('exit', () => resolve()));
    expect(node.exitCode).toBe(0);
  });

  it('二重に張っても 1 段だけで、外せば元の spawn に戻る', () => {
    const original = childProcess.spawn;
    const off = installSpawnGate(new Set());
    const off2 = installSpawnGate(new Set());
    expect(childProcess.spawn).not.toBe(original);
    off2();
    off();
    expect(childProcess.spawn).toBe(original);
  });
});

describe('ビルド用ワーカーの配線', () => {
  it.each(['pdf-build-worker.mjs', 'pdf-build-worker-daemon.mjs'])(
    '%s は CLI を読む前に hardenBrowserLaunch を呼び、ジョブのブラウザを覚えさせる',
    (name) => {
      const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', name), 'utf8');
      const harden = src.indexOf(
        "await hardenBrowserLaunch(import.meta.resolve('@vivliostyle/cli'))",
      );
      const cli = src.indexOf("await import('@vivliostyle/cli')");
      expect(harden).toBeGreaterThan(-1);
      expect(cli).toBeGreaterThan(harden);
      expect(src).toContain('rememberBrowser(opts?.executableBrowser)');
    },
  );
});

describe('hardenBrowserLaunch(ワーカーが起動時に呼ぶ)', () => {
  it('本物の CLI の puppeteer-core を包み、spawn の関所を張る', async () => {
    const original = childProcess.spawn;
    const guard = await hardenBrowserLaunch(pathToFileURL(cliEntry).href);
    try {
      expect(guard.puppeteerCoreFile).toBe(resolvePuppeteerCoreFromCli(cliEntry));
      const mod = await import(pathToFileURL(guard.puppeteerCoreFile).href);
      // 本物の `computeLaunchArguments` を、ブラウザを解決させない形(実行ファイルと
      // user-data-dir を渡す)で呼んで、フラグが足されることを見る。
      const res = await mod.ChromeLauncher.prototype.computeLaunchArguments.call(
        {},
        {
          executablePath: 'C:/fake/msedge.exe',
          ignoreDefaultArgs: true,
          args: ['--user-data-dir=C:/fake/profile', '--proxy-server=http://127.0.0.1:1'],
        },
      );
      expect(res.args).toContain(WEBRTC_FLAG);
      expect(res.args).toContain('--proxy-server=http://127.0.0.1:1');
      // ジョブの `executableBrowser` を覚えさせれば、名前が違っても関所に掛かる。
      guard.rememberBrowser('C:/custom/odd-name.exe');
      guard.rememberBrowser(undefined);
      expect(() => childProcess.spawn('C:/custom/odd-name.exe', [])).toThrow(WEBRTC_FLAG);
      expect(() => childProcess.spawn('C:/fake/msedge.exe', [])).toThrow(WEBRTC_FLAG);
    } finally {
      guard.uninstall();
    }
    expect(childProcess.spawn).toBe(original);
  });

  it('Node の解決で突き合わせられなければ投げる', async () => {
    // exports に import の条件しか無く、Node の解決(require の条件)で同じ実体を引けない形。
    const store = path.join(tmp, 'mismatch', 'node_modules');
    const entry = path.join(store, '@vivliostyle', 'cli', 'dist', 'index.js');
    writeFile(entry, 'export {};');
    writeJson(path.join(store, 'puppeteer-core', 'package.json'), {
      name: 'puppeteer-core',
      exports: { '.': { import: './esm.js' } },
    });
    writeFile(path.join(store, 'puppeteer-core', 'esm.js'), 'export class ChromeLauncher {}');
    const original = childProcess.spawn;
    await expect(hardenBrowserLaunch(pathToFileURL(entry).href)).rejects.toThrow(/puppeteer-core/);
    // 失敗したときも関所は外さない(ワーカーはこの後で終了する)。テストでは戻しておく。
    expect(childProcess.spawn).not.toBe(original);
    childProcess.spawn = original;
    syncBuiltinESMExports();
  });

  it('Node の解決が別の実体を指せば投げる', async () => {
    // 自前の探索が拾う版(CLI の直下)と、Node の解決が拾う版が違う形を、require の行き先を
    // 別のパッケージへ逃がして作る。
    const store = path.join(tmp, 'split', 'node_modules');
    const entry = path.join(store, '@vivliostyle', 'cli', 'dist', 'index.js');
    writeFile(entry, 'export {};');
    writeJson(path.join(store, 'puppeteer-core', 'package.json'), {
      name: 'puppeteer-core',
      exports: { '.': { import: './esm.js', require: './other/cjs.js' } },
    });
    writeFile(path.join(store, 'puppeteer-core', 'esm.js'), 'export class ChromeLauncher {}');
    writeJson(path.join(store, 'puppeteer-core', 'other', 'package.json'), {
      name: 'puppeteer-core',
      exports: { '.': { import: './esm2.js', require: './cjs.js' } },
    });
    writeFile(path.join(store, 'puppeteer-core', 'other', 'cjs.js'), '');
    writeFile(path.join(store, 'puppeteer-core', 'other', 'esm2.js'), '');
    const original = childProcess.spawn;
    await expect(hardenBrowserLaunch(pathToFileURL(entry).href)).rejects.toThrow(/食い違います/);
    childProcess.spawn = original;
    syncBuiltinESMExports();
  });
});
