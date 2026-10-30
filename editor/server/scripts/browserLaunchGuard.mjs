// =============================================================================
// browserLaunchGuard.mjs — PDF ビルドのブラウザへ WebRTC の UDP を止めるフラグを必ず渡す
// =============================================================================
// `@vivliostyle/cli` がブラウザへ渡すネットワークの制御は `--proxy-server`(ビルドごとの中継。
// `egressGuard.ts`)だけで、WebRTC の ICE(UDP)と STUN の名前解決はプロキシを通らない。文書の
// JS は組版中に動くので、閲覧者が送った文書からサーバの位置で UDP を出せてしまう。ビルド用の
// ワーカー(`pdf-build-worker.mjs` / `pdf-build-worker-daemon.mjs`)は CLI を読む前に
// `hardenBrowserLaunch` を呼び、2 段で止める。
//
//   1. フラグを足す: CLI の実体のパスを起点に `puppeteer-core` を import の条件で解決し、その
//      `ChromeLauncher.prototype.computeLaunchArguments` を包んで `WEBRTC_FLAG` を足す。素の
//      指定子はワーカーの置き場から解決されるので、pnpm では届かず、hoisted の配備では CLI が
//      使うのと別の版を拾いうる。CLI が `import('puppeteer-core')` で読むのと同じ実体(同じ
//      ファイル = 同じモジュール)を包むために、起点を CLI の実体にする。
//   2. 起動前の関所: `node:child_process` の `spawn` を包み、ブラウザを起こす呼び出し(実行
//      ファイルのパスで見分ける)の引数にフラグが無ければ、子を起こす前に投げる。1 が包み
//      損ねても(版が変わって別の口から起動するなど)、ブラウザが文書を読む前に失敗させる。
//      `@puppeteer/browsers` は起動のたびに `childProcess.spawn` を引くので、差し替えが効く。
//      関所は `spawn` だけで、`exec`・`execFile`・`fork` は対象外(puppeteer がブラウザを
//      起こすのに `spawn` しか使わないため)。
//
// どちらも失敗したら投げる。ワーカーは起動に失敗し、ビルドは 5xx になる(フラグの無い
// ブラウザで組版するより、出力できない方を選ぶ)。

import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * WebRTC にプロキシを通らない UDP を使わせない Chromium のフラグ。`--force-` の付いた名前は
 * Chromium のスイッチに無く、黙って無視される(ICE 候補がそのまま出る)。
 */
export const WEBRTC_FLAG = '--webrtc-ip-handling-policy=disable_non_proxied_udp';

/** 包んだ関数に付ける印(二重に包まないため)。 */
const WRAPPED = Symbol.for('editor.browserLaunchGuard.wrapped');

/**
 * ブラウザとして見分ける実行ファイルの名前(拡張子と大文字小文字は無視)。Firefox はフラグが
 * 効かないブラウザだが、名前に入れておけば起動そのものが関所で止まる(使う設定は無い)。
 */
const BROWSER_NAMES = new Set([
  'chrome',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome-headless-shell',
  'headless_shell',
  'msedge',
  'microsoft-edge',
  'microsoft-edge-stable',
  'firefox',
]);

/** import の解決で有効な条件(Node の既定)。 */
const IMPORT_CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

/** 実行ファイルのパスを比べられる形にする(Windows は大文字小文字を区別しない)。 */
export function normalizeExecutable(file) {
  const resolved = path.resolve(String(file));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `file` がブラウザの起動か。覚えた実行ファイル(`known`)か、名前で見分ける。 */
export function isBrowserExecutable(file, known) {
  if (known.has(normalizeExecutable(file))) return true;
  const base = path
    .basename(String(file).replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  return BROWSER_NAMES.has(base);
}

// ── 1. puppeteer-core の解決 ──

/** exports の 1 項目を import の条件で読む(Node と同じく、キーの順で最初に合う条件)。 */
function pickImportTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const hit = pickImportTarget(e);
      if (hit) return hit;
    }
    return undefined;
  }
  if (entry && typeof entry === 'object') {
    for (const [key, value] of Object.entries(entry)) {
      if (!IMPORT_CONDITIONS.has(key)) continue;
      const hit = pickImportTarget(value);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** パッケージの `exports` の `.` の、import の条件での行き先(パッケージ相対)。 */
export function importTargetOf(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.exports !== undefined) {
    const root =
      typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) && '.' in pkg.exports
        ? pkg.exports['.']
        : pkg.exports;
    const target = pickImportTarget(root);
    if (target) return target;
    throw new Error(`[browserLaunchGuard] ${pkgDir} の exports に import の行き先がありません`);
  }
  if (typeof pkg.main === 'string') return pkg.main;
  throw new Error(`[browserLaunchGuard] ${pkgDir} の入口(exports / main)がありません`);
}

/**
 * `fromFile` の置き場から Node と同じ順(親へ向かって各階層の `node_modules`)でパッケージを
 * 探す。見つかったパッケージのフォルダ、無ければ null。
 */
export function findPackageDir(fromFile, name) {
  let dir = path.dirname(fromFile);
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** CLI の入口ファイルから、CLI が読む `puppeteer-core` の実体のファイル(realpath)を返す。 */
export function resolvePuppeteerCoreFromCli(cliEntryFile) {
  const cliReal = fs.realpathSync(cliEntryFile);
  const pkgDir = findPackageDir(cliReal, 'puppeteer-core');
  if (!pkgDir) {
    throw new Error(`[browserLaunchGuard] CLI(${cliReal})の側に puppeteer-core が見つかりません`);
  }
  return fs.realpathSync(path.resolve(pkgDir, importTargetOf(pkgDir)));
}

/** `file` を含むパッケージのフォルダ(名前が `name` の package.json の置き場)。 */
function owningPackageDir(file, name) {
  let dir = path.dirname(file);
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 自前の解決が Node の解決と同じパッケージを指し、包むファイルがその exports の import の
 * 行き先と一致することを確かめる。自前の探索が Node と違う実体を選ぶと、包んだのと別の
 * モジュールで CLI がブラウザを起こす(フラグが付かない)ため、食い違えば投げる。
 */
function assertSameAsNodeResolution(cliReal, wrappedFile) {
  let nodeMain;
  try {
    nodeMain = fs.realpathSync(createRequire(cliReal).resolve('puppeteer-core'));
  } catch (e) {
    throw new Error(
      `[browserLaunchGuard] CLI の側から puppeteer-core を Node の解決で引けません: ${e}`,
    );
  }
  const pkgDir = owningPackageDir(nodeMain, 'puppeteer-core');
  const expected = pkgDir && fs.realpathSync(path.resolve(pkgDir, importTargetOf(pkgDir)));
  if (expected !== wrappedFile) {
    throw new Error(
      `[browserLaunchGuard] puppeteer-core の実体が食い違います(包む: ${wrappedFile}` +
        ` / exports の import: ${expected})`,
    );
  }
}

// ── 2. フラグを足す ──

/** `ChromeLauncher.prototype.computeLaunchArguments` を包み、戻りの args にフラグを足す。 */
export function wrapComputeLaunchArguments(ChromeLauncher, known) {
  const proto = ChromeLauncher?.prototype;
  const original = proto?.computeLaunchArguments;
  if (typeof original !== 'function') {
    throw new Error(
      '[browserLaunchGuard] ChromeLauncher.prototype.computeLaunchArguments がありません',
    );
  }
  if (original[WRAPPED]) return;
  const wrapped = async function computeLaunchArguments(...args) {
    const result = await original.apply(this, args);
    if (!result.args.includes(WEBRTC_FLAG)) result.args.push(WEBRTC_FLAG);
    // 関所が名前で見分けられない実行ファイル(名前を変えた配備)でも掛かるよう覚える。
    if (result.executablePath) known.add(normalizeExecutable(result.executablePath));
    return result;
  };
  wrapped[WRAPPED] = true;
  proto.computeLaunchArguments = wrapped;
}

// ── 3. spawn の関所 ──

/**
 * `child_process.spawn` を包む。外す関数を返す(テスト用。ワーカーは外さない)。既に包んで
 * あれば何もしない(最初に張ったときの `known` が効く)。
 */
export function installSpawnGate(known) {
  const original = childProcess.spawn;
  if (original[WRAPPED]) return () => {};
  const gated = function spawn(file, args, ...rest) {
    if (isBrowserExecutable(file, known)) {
      const list = Array.isArray(args) ? args : [];
      if (!list.includes(WEBRTC_FLAG)) {
        throw new Error(
          `[browserLaunchGuard] ブラウザの起動に ${WEBRTC_FLAG} がありません(${file})`,
        );
      }
    }
    return original.call(this, file, args, ...rest);
  };
  gated[WRAPPED] = true;
  childProcess.spawn = gated;
  // `import { spawn } from 'node:child_process'` の名前付きの束縛も差し替える。
  syncBuiltinESMExports();
  return () => {
    if (childProcess.spawn !== gated) return;
    childProcess.spawn = original;
    syncBuiltinESMExports();
  };
}

// ── 4. ワーカーの入口 ──

/**
 * ワーカーが CLI を読む前に呼ぶ。関所を先に張り(以降の失敗でもブラウザは起こさせない)、
 * CLI の実体から解決した `puppeteer-core` を読んで包む。
 *
 * `cliEntryUrl` は `import.meta.resolve('@vivliostyle/cli')` の結果(ワーカーの置き場からの解決)。
 * 戻りの `rememberBrowser` には、ジョブの `executableBrowser` を渡す(名前で見分けられない
 * 実行ファイルも関所に掛けるため)。
 */
export async function hardenBrowserLaunch(cliEntryUrl) {
  const known = new Set();
  const uninstall = installSpawnGate(known);
  const cliReal = fs.realpathSync(fileURLToPath(cliEntryUrl));
  const puppeteerCoreFile = resolvePuppeteerCoreFromCli(cliReal);
  assertSameAsNodeResolution(cliReal, puppeteerCoreFile);
  const mod = await import(pathToFileURL(puppeteerCoreFile).href);
  wrapComputeLaunchArguments(mod.ChromeLauncher, known);
  return {
    puppeteerCoreFile,
    rememberBrowser(file) {
      if (typeof file === 'string' && file !== '') known.add(normalizeExecutable(file));
    },
    uninstall,
  };
}
