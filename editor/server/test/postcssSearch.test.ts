// =============================================================================
// postcssSearch.test.ts — 祖先の PostCSS 設定が展開プロジェクトの組版に効かないことの実測
// =============================================================================
// Vite(と cli 11.4.0)は PostCSS の設定を `serverRootDir` から親方向へ `pnpm-workspace.yaml` まで
// 探し、見つけた設定の `plugins` をサーバの node_modules から require して実行する。展開先は
// このリポジトリ配下の temp なので、祖先に設定があれば利用者の zip の組版で任意のパッケージが
// 動く。主防御は展開ルートに置く空の設定(`POSTCSS_STOPPER`)で、ここでは**実物の CLI を
// 起動して** marker プラグインが読み込まれないことを確かめる。対照として空の設定を消すと
// 読み込まれることも確かめ、テストが空振りしていないことを示す。
//
// 置き場所を `vivliostyleCliContract.test.ts` にしないのは、TMP_DIR をリポジトリ配下の専用
// ディレクトリへ隔離する `vi.hoisted` が、`os.tmpdir()` を前提にした契約テストと両立しないため。
// `os.tmpdir()` 配下ではワークスペースのルートが見つからず、探索の上限が本番と変わる。
//
// ⚠ Vite / postcss-load-config はプラグインを同じパスなら 2 回目以降キャッシュから読み、
// cli 11.4.0 は PostCSS 設定を探索ディレクトリごとにプロセス内でキャッシュする。各テストは
// 新しい名前の marker と新しい展開ディレクトリを使う(本番は展開ディレクトリが毎回ランダム)。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { DEFAULT_DOC_BASE } from '../src/vivliostyle/previewProxy.js';
import {
  cleanupProject,
  extractProjectZip,
  isPostcssConfigName,
  POSTCSS_STOPPER,
} from '../src/vivliostyle/projectInput.js';

const TEST_TMP_MARKER = 'test-postcss-search-';
vi.hoisted(() => {
  process.env.TMP_DIR = `.tmp/test-postcss-search-${process.pid}-${Date.now().toString(36)}`;
});

/** require と実行の時点で `MARKER_LOG` に 1 行ずつ書く PostCSS プラグイン。 */
const MARKER_SOURCE = [
  "const fs = require('node:fs');",
  "const log = (s) => fs.appendFileSync(process.env.MARKER_LOG, s + '\\n');",
  "log('load');",
  "module.exports = () => ({ postcssPlugin: 'marker', Once() { log('once'); } });",
  'module.exports.postcss = true;',
  '',
].join('\n');

/**
 * 実物の CLI を起こすテストの上限。CLI の import だけで約 11 秒かかり、並列実行(pre-push の
 * `ci:affected` は 4 ワーカー)では既定の 5 秒を大きく超える。`vivliostyleCliContract.test.ts` と
 * 同じ値にそろえる。
 */
const CLI_TEST_TIMEOUT_MS = 120_000;

const logFile = (): string => path.join(config.tmpDir, 'marker.log');
let seq = 0;

/** 新しい名前の marker を書き、展開ディレクトリの祖先(`config.tmpDir`)に設定を置く。 */
async function plantAncestorMarker(): Promise<void> {
  const marker = path.join(config.tmpDir, `marker-${++seq}.cjs`);
  await fs.writeFile(marker, MARKER_SOURCE, 'utf8');
  const plugins = { [marker.split(path.sep).join('/')]: {} };
  await fs.writeFile(path.join(config.tmpDir, '.postcssrc.json'), JSON.stringify({ plugins }));
  await fs.rm(logFile(), { force: true });
}

const markerLines = (): string[] =>
  existsSync(logFile()) ? readFileSync(logFile(), 'utf8').split('\n').filter(Boolean) : [];

type Mode = 'single' | 'config';

/**
 * 本番の 2 通りの起動形に合わせた zip。config 無しは単一入力(起点 = エントリの親 = 展開ルート)、
 * config ありはサブフォルダに置いて起点(= config の置き場)を展開ルートより深くする。どちらも
 * 祖先へ登る途中で展開ルートの空の設定に当たることを確かめる。
 */
async function projectZip(mode: Mode): Promise<Buffer> {
  const zip = new JSZip();
  const at = mode === 'config' ? 'proj/' : '';
  if (mode === 'config') zip.file(`${at}vivliostyle.config.json`, '{"entry":"index.html"}');
  zip.file(
    `${at}index.html`,
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<link rel="stylesheet" href="style.css"></head><body><p>x</p></body></html>',
  );
  zip.file(`${at}style.css`, '/* css-marker */\np{color:red}\n');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 展開したプロジェクトを本番と同じ起動形(`previewServer.ts`)で preview し、CSS を 1 回取る。 */
async function previewOnce(
  mode: Mode,
  removeStopper: boolean,
): Promise<{ status: number; body: string }> {
  const project = await extractProjectZip(await projectZip(mode));
  type PreviewServer = Awaited<ReturnType<typeof import('@vivliostyle/cli')['preview']>>;
  let server: PreviewServer | undefined;
  try {
    if (removeStopper) await fs.rm(path.join(project.dir, POSTCSS_STOPPER));
    const { preview } = await import('@vivliostyle/cli');
    const entry =
      mode === 'config'
        ? { configData: project.config, cwd: project.cwd }
        : { input: 'index.html', cwd: project.cwd };
    if (mode === 'config') expect(project.cwd).not.toBe(project.dir);
    server = await preview({
      ...entry,
      openViewer: false,
      host: '127.0.0.1',
      viteConfigFile: false,
      logLevel: 'silent',
      vite: { server: { hmr: false, fs: { strict: true, allow: [project.dir] } } },
    } as Parameters<typeof preview>[0]);
    const addr = server.httpServer?.address();
    if (addr === null || addr === undefined || typeof addr !== 'object') {
      throw new Error('プレビューサーバのポートが取れません');
    }
    const res = await fetch(`http://127.0.0.1:${addr.port}${DEFAULT_DOC_BASE}/style.css`, {
      headers: { accept: 'text/css,*/*;q=0.1' },
    });
    return { status: res.status, body: await res.text() };
  } finally {
    await server?.close();
    await cleanupProject(project.dir);
  }
}

beforeAll(async () => {
  process.env.MARKER_LOG = logFile();
  await fs.mkdir(config.tmpDir, { recursive: true });
});

afterAll(async () => {
  // 隔離が効いていない(= 共有 `.tmp` を指している)ときに消しに行かないよう目印で確かめる。
  if (!config.tmpDir.includes(TEST_TMP_MARKER)) return;
  await fs.rm(config.tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('PostCSS 設定の親方向探索(実物の CLI)', () => {
  it.each<Mode>(['single', 'config'])(
    '展開したプロジェクトの preview(%s)で、祖先の PostCSS 設定のプラグインは読み込まれない',
    async (mode) => {
      await plantAncestorMarker();
      const css = await previewOnce(mode, false);
      expect(css.status).toBe(200);
      expect(css.body).toContain('css-marker');
      expect(markerLines()).toEqual([]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it.each<Mode>(['single', 'config'])(
    '対照(%s): 空の設定を消すと祖先のプラグインが読み込まれる(テストが空振りしていない証明)',
    // `ci`(全プロジェクト + カバレッジ + 4 ワーカー)の下でだけ、config の対照が読み込みを
    // 観測できないことがあった(2 回中 1 回。単独・server だけの並列では再現しない)。対照の役目は
    // 「空の設定が無ければ読み込まれる」ことを 1 回示すことなので、やり直しを許す。
    { timeout: CLI_TEST_TIMEOUT_MS, retry: 2 },
    async (mode) => {
      await plantAncestorMarker();
      const css = await previewOnce(mode, true);
      expect(css.status).toBe(200);
      expect(css.body).toContain('css-marker');
      expect(markerLines()).toContain('load');
    },
  );
});

describe('リポジトリに PostCSS 設定が無い', () => {
  // inline / merge の作業フォルダはサーバが中身を書くので空の設定を置いていない。リポジトリの
  // どこかに PostCSS 設定(ファイル、または package.json の `postcss` キー)が入ると、その祖先に
  // ある作業フォルダの組版へ効いてしまう。追加された時点でここが落ちる。
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const tracked = execFileSync('git', ['ls-files', '--full-name'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '' && !f.split('/').includes('node_modules'));

  it('PostCSS 設定のファイル名を追跡していない', () => {
    expect(tracked.filter((f) => isPostcssConfigName(f))).toEqual([]);
  });

  it('追跡中の package.json に postcss キーが無い', () => {
    const withKey = tracked
      .filter((f) => f.split('/').pop() === 'package.json')
      .filter((f) => {
        const pkg = JSON.parse(readFileSync(path.join(root, f), 'utf8')) as Record<string, unknown>;
        return 'postcss' in pkg;
      });
    expect(withKey).toEqual([]);
  });
});
