// =============================================================================
// postcssSearch.test.ts — 祖先の PostCSS 設定が展開プロジェクトの組版に効かないことの実測
// =============================================================================
// Vite は PostCSS の設定を `serverRootDir` から親方向へ `pnpm-workspace.yaml` まで、cli 11.4.0 は
// 同じく親方向へホームフォルダまで(lilconfig の既定の `stopDir`。ホームの外ならドライブ直下まで)
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
// ⚠ cli 11.4.0 は PostCSS 設定を探索ディレクトリごとにプロセス内でキャッシュする。各テストは
// 新しい名前の marker と新しい展開ディレクトリを使う(本番は展開ディレクトリが毎回ランダム)。
//
// ⚠ Vite の探索は待たないと観測できない。Vite 8.3.5 の `cssPlugin` は生成時に
// `resolvePostcssConfig(config)` を投げっぱなしで始め(`.catch(() => {})` だけで誰も await
// しない)、プラグインの import もその中で走る。cli の preview は CSS を自前の middleware で返し、
// config モードでは cli の PostCSS 設定が `css.postcss: {}`(`parseProjectConfig` が注入)なので、
// 応答は Vite の探索の完了を待たない。記録を読む前に Vite 自身の CSS 変換(`/style.css` を base の
// 外から取る。`compilePostCSS` が同じ promise を await する)を 1 回通して完了を待つ。待たないと、
// 対照は負荷の高い CI で読み込みを見落とし(2026-10-29 の CI で 3 回続けて落ちた)、陰性側は
// 探索が止まっていなくても通ってしまう。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * 読み込みと実行の時点で `MARKER_LOG` に 1 行ずつ書く PostCSS プラグイン。読み込みをわざと
 * `MARKER_LOAD_DELAY_MS` 遅らせ、テストが探索の完了を待たずに記録を読むと手元でも必ず落ちる
 * ようにする(CI の負荷でだけ出ていた揺れを決定的にする)。postcss-load-config は `import()` で
 * 読むので ESM で書ける。
 */
const MARKER_LOAD_DELAY_MS = 300;
const MARKER_SOURCE = [
  "import fs from 'node:fs';",
  "const log = (s) => fs.appendFileSync(process.env.MARKER_LOG, s + '\\n');",
  `await new Promise((r) => setTimeout(r, ${MARKER_LOAD_DELAY_MS}));`,
  "log('load');",
  "const plugin = () => ({ postcssPlugin: 'marker', Once() { log('once'); } });",
  'plugin.postcss = true;',
  'export default plugin;',
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
  const marker = path.join(config.tmpDir, `marker-${++seq}.mjs`);
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

type Fetched = { status: number; body: string };

/**
 * 展開したプロジェクトを本番と同じ起動形(`previewServer.ts`)で preview し、CSS を取る。`doc` は
 * 本番の経路(base 配下。cli の middleware が返す)、`vite` は Vite 自身の CSS 変換を通した応答で、
 * Vite の PostCSS 探索の完了を待つために取る(ファイル冒頭の ⚠)。
 */
async function previewOnce(
  mode: Mode,
  removeStopper: boolean,
): Promise<{ doc: Fetched; vite: Fetched }> {
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
    const get = async (urlPath: string): Promise<Fetched> => {
      const res = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`, {
        headers: { accept: 'text/css,*/*;q=0.1' },
      });
      return { status: res.status, body: await res.text() };
    };
    const doc = await get(`${DEFAULT_DOC_BASE}/style.css`);
    // base の外は cli の middleware が拾わず、Vite の `transformMiddleware` → `compilePostCSS` に
    // 届く。そこで `resolvePostcssConfig` の promise(生成時に投げっぱなしで始まったものと共有)を
    // await するので、この応答が返った時点で Vite の探索とプラグインの読み込みは終わっている。
    const vite = await get('/style.css');
    return { doc, vite };
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
      const { doc, vite } = await previewOnce(mode, false);
      expect(doc.status).toBe(200);
      expect(doc.body).toContain('css-marker');
      // Vite の変換が通ったこと(= 探索の完了を待てたこと)を確かめてから、読み込みが無いと言う。
      expect(vite.status).toBe(200);
      expect(vite.body).toContain('css-marker');
      expect(markerLines()).toEqual([]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it.each<Mode>(['single', 'config'])(
    '対照(%s): 空の設定を消すと祖先のプラグインが読み込まれる(テストが空振りしていない証明)',
    // config モードでは cli 自身は探索しない(`css.postcss: {}`)ので、ここで読み込むのは Vite の
    // 探索だけ。その完了を待つのが `previewOnce` の `vite` の応答(ファイル冒頭の ⚠)。失敗時の
    // 状態はメッセージへ出す。cli 側の探索が止まることは `vivliostyleCliContract.test.ts` の
    // PostCSS 設定の契約で固定する。
    CLI_TEST_TIMEOUT_MS,
    async (mode) => {
      await plantAncestorMarker();
      const { doc, vite } = await previewOnce(mode, true);
      const state = JSON.stringify({
        doc: { status: doc.status, body: doc.body.slice(0, 200) },
        vite: { status: vite.status, body: vite.body.slice(0, 200) },
        marker: markerLines(),
        log: existsSync(logFile()),
      });
      expect(doc.status, state).toBe(200);
      expect(doc.body, state).toContain('css-marker');
      expect(vite.status, state).toBe(200);
      expect(vite.body, state).toContain('css-marker');
      expect(markerLines(), state).toContain('load');
    },
  );
});

/** 遮断端末の展開先で見ないフォルダ(依存・生成物・同梱ツール・退避)。 */
const UNTRACKED_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'ms-playwright',
  'python-wheelhouse',
  'git-tools',
  'bk',
  'dist',
  'out',
  'coverage',
]);

/**
 * リポジトリのファイル一覧(ルートからの `/` 区切り)。git があれば追跡中のファイル、無ければ
 * source.zip を展開した遮断端末とみなし、`SOURCE-COMMIT` のあるフォルダの下を歩く。端末では
 * 本番の改修で足したファイルも対象に入れたいので、MANIFEST ではなく実ファイルを見る。
 */
function listRepoFiles(): { root: string; tracked: string[] } {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const tracked = execFileSync('git', ['ls-files', '--full-name'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f !== '' && !f.split('/').includes('node_modules'));
    return { root, tracked };
  } catch {
    let root = path.resolve(import.meta.dirname);
    while (!existsSync(path.join(root, 'SOURCE-COMMIT'))) {
      const parent = path.dirname(root);
      if (parent === root) throw new Error('git も SOURCE-COMMIT も見つからない');
      root = parent;
    }
    const tracked: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const child = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (!UNTRACKED_DIRS.has(e.name) && !/^patch-/.test(e.name)) walk(child);
        } else if (e.isFile()) tracked.push(child);
      }
    };
    walk('');
    return { root, tracked };
  }
}

describe('リポジトリに PostCSS 設定が無い', () => {
  // inline / merge の作業フォルダはサーバが中身を書くので空の設定を置いていない。リポジトリの
  // どこかに PostCSS 設定(ファイル、または package.json の `postcss` キー)が入ると、その祖先に
  // ある作業フォルダの組版へ効いてしまう。追加された時点でここが落ちる。
  const { root, tracked } = listRepoFiles();

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
