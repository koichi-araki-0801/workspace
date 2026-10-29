// =============================================================================
// buildLifecycle.test.ts — build / preview の作業フォルダの後始末・既定値・CSS の源の固定
// =============================================================================
// 組版そのもの(CLI)と egress の予約は差し替え、作業フォルダが残らないこと・CLI へ渡る
// オプション・文書の本文を見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface RunRecord {
  options: Record<string, unknown>;
  docs: Record<string, string>;
}
const { runs, reserve } = vi.hoisted(() => ({
  runs: [] as RunRecord[],
  reserve: { fail: false },
}));

vi.mock('../src/vivliostyle/buildWorkerServer.js', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    killProcessTree: () => {},
    buildWorkerPool: {
      withSlot: async <T>(fn: (run: (o: unknown) => Promise<void>) => Promise<T>): Promise<T> =>
        fn(async (o) => {
          const options = o as Record<string, unknown>;
          const cwd = String(options.cwd);
          const docs: Record<string, string> = {};
          const docDir = nodePath.join(cwd, 'doc');
          if (nodeFs.existsSync(docDir)) {
            for (const f of nodeFs.readdirSync(docDir)) {
              docs[`doc/${f}`] = nodeFs.readFileSync(nodePath.join(docDir, f), 'utf8');
            }
          }
          runs.push({ options, docs });
          const out = (options.output as Array<{ path: string }>)[0].path;
          nodeFs.writeFileSync(out, '%PDF-fake');
        }),
    },
  };
});
vi.mock('../src/vivliostyle/egressGuard.js', () => ({
  reserveBuildOrigin: async () => {
    if (reserve.fail) throw new Error('port pick failed');
    return { port: 0, ports: [0], proxyServer: 'http://127.0.0.1:9', release: () => {} };
  },
}));
vi.mock('../src/vivliostyle/options.js', () => ({ sharedInlineConfig: async () => ({}) }));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-build-lifecycle-'));
const dataRoot = path.join(root, 'data');
const tmpDir = path.join(root, 'tmp');
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = dataRoot;
process.env.CSS_DIR = path.join(dataRoot, 'css');
process.env.JS_DIR = path.join(dataRoot, 'js');
process.env.IMAGES_DIR = path.join(dataRoot, 'images');
process.env.TMP_DIR = tmpDir;
process.env.LOG_DIR = path.join(root, 'logs');

const HTML_WITH_LINK =
  '<html><head><link rel="stylesheet" href="../css/A.css"></head><body>x</body></html>';

let build: typeof import('../src/vivliostyle/build.js');
let merge: typeof import('../src/vivliostyle/mergeInput.js');
let cleanupProject: (dir: string) => Promise<void>;

/** tmp 直下に残っている、`prefix` で始まる作業フォルダ。 */
const leftovers = (prefix: string): string[] =>
  fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((n) => n.startsWith(prefix)) : [];

beforeAll(async () => {
  fs.mkdirSync(path.join(dataRoot, 'css'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'css', 'A.css'), 'p{color:red}');
  build = await import('../src/vivliostyle/build.js');
  merge = await import('../src/vivliostyle/mergeInput.js');
  ({ cleanupProject } = await import('../src/vivliostyle/projectInput.js'));
});

beforeEach(() => {
  runs.length = 0;
  reserve.fail = false;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('作業フォルダの後始末', () => {
  it('inline build で egress の予約に失敗しても作業フォルダを残さない', async () => {
    reserve.fail = true;
    await expect(build.buildInlinePdf({ html: '<p>x</p>' })).rejects.toThrow('port pick failed');
    expect(leftovers('vivlio-inline-')).toEqual([]);
  });

  it('preview-inline の入力が外部参照で 400 になっても作業フォルダを残さない', async () => {
    await expect(
      build.prepareInlineDoc({ html: '<img src="https://evil.example/x.png">' }),
    ).rejects.toThrow();
    expect(leftovers('vivlio-prev-')).toEqual([]);
  });
});

describe('ページサイズの既定は A4', () => {
  it('結合 build で size を省くと config の size は A4', async () => {
    await build.buildMergedPdf({ documents: [{ html: '<p>x</p>', css: '' }] });
    expect((runs[0].options.configData as { size?: string }).size).toBe('A4');
  });

  it('preview-inline で size を省くと config の size は A4', async () => {
    const { dir, config } = await build.prepareInlineDoc({ html: '<p>x</p>' });
    try {
      expect(config.size).toBe('A4');
    } finally {
      await cleanupProject(dir);
    }
  });
});

describe('結合の CSS の源', () => {
  it('リクエストの css が空なら、文書の stylesheet <link> を残す', async () => {
    const { dir } = await merge.materializeMergeProject([{ html: HTML_WITH_LINK, css: '' }]);
    try {
      const doc = fs.readFileSync(path.join(dir, 'doc', 'doc-000.html'), 'utf8');
      expect(doc).toContain('<link rel="stylesheet" href="../css/A.css">');
      // 通しページ番号の CSS は付く。
      expect(doc).toContain('counter(page)');
    } finally {
      await cleanupProject(dir);
    }
  });

  it('リクエストの css があれば、文書の stylesheet <link> を落とす', async () => {
    const { dir } = await merge.materializeMergeProject([
      { html: HTML_WITH_LINK, css: 'p{color:blue}' },
    ]);
    try {
      const doc = fs.readFileSync(path.join(dir, 'doc', 'doc-000.html'), 'utf8');
      expect(doc).not.toContain('href="../css/A.css"');
    } finally {
      await cleanupProject(dir);
    }
  });
});

describe('buildProjectInSlot — config の置き場', () => {
  it('cwd を渡すと CLI の cwd はそのフォルダになる(出力は展開ルートに置く)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-lifecycle-project-'));
    const cwd = path.join(dir, 'proj');
    try {
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'index.html'), '<p>x</p>');
      await build.withBuildSlot((run) =>
        build.buildProjectInSlot(
          { dir, cwd, config: { entry: 'index.html', base: '/vivliostyle' } },
          run,
        ),
      );
      const options = runs[runs.length - 1].options;
      expect(options.cwd).toBe(cwd);
      const out = (options.output as Array<{ path: string }>)[0].path;
      expect(path.dirname(out)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
