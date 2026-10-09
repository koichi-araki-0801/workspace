// =============================================================================
// docLayout.test.ts — PDF・プレビューの作業フォルダに doc/ と兄弟の資産を置くことの固定
// =============================================================================
// 文書は `doc/index.html`(結合は `doc/doc-NNN.html`)に書き、`css/` `js/` `images/` は作業
// フォルダ直下(= `doc/` の兄弟)へ置く。文書の `../css/…` がそのまま実体へ届く形である。
// 組版そのもの(CLI)は差し替え、組版へ渡る直前の作業フォルダの中身と CLI オプションを見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 組版 1 回ぶんの記録(渡ったオプション・その瞬間の作業フォルダの中身・文書の本文)。 */
interface RunRecord {
  options: Record<string, unknown>;
  files: string[];
  docs: Record<string, string>;
}
const { runs } = vi.hoisted(() => ({ runs: [] as RunRecord[] }));

vi.mock('../src/vivliostyle/buildWorkerServer.js', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const walk = (d: string, pre = ''): string[] =>
    nodeFs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? walk(nodePath.join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`],
      );
  return {
    buildWorkerPool: {
      withSlot: async <T>(fn: (run: (o: unknown) => Promise<void>) => Promise<T>): Promise<T> =>
        fn(async (o) => {
          const options = o as Record<string, unknown>;
          const cwd = String(options.cwd);
          const files = walk(cwd);
          const docs: Record<string, string> = {};
          for (const f of files.filter((n) => n.endsWith('.html'))) {
            docs[f] = nodeFs.readFileSync(nodePath.join(cwd, ...f.split('/')), 'utf8');
          }
          runs.push({ options, files, docs });
          const out = (options.output as Array<{ path: string }>)[0].path;
          nodeFs.writeFileSync(out, '%PDF-fake');
        }),
    },
  };
});
vi.mock('../src/vivliostyle/egressGuard.js', () => ({
  reserveBuildOrigin: async () => ({
    port: 0,
    ports: [0],
    proxyServer: 'http://127.0.0.1:9',
    release: () => {},
  }),
}));
vi.mock('../src/vivliostyle/options.js', () => ({ sharedInlineConfig: async () => ({}) }));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-doc-layout-'));
const dataRoot = path.join(root, 'data');
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = dataRoot;
process.env.CSS_DIR = path.join(dataRoot, 'css');
process.env.JS_DIR = path.join(dataRoot, 'js');
process.env.IMAGES_DIR = path.join(dataRoot, 'images');
process.env.TMP_DIR = path.join(root, 'tmp');
process.env.LOG_DIR = path.join(root, 'logs');

const NS = 'http://www.w3.org/2000/svg';
const GOOD_SVG = `<svg xmlns="${NS}" width="10" height="10"><rect width="10" height="10"/></svg>`;

/** 実データの形の文書(テンプレ CSS・会社フォルダの画像・style 属性の画像・文書直下基準の旧形)。 */
const HTML =
  '<html><head><link rel="stylesheet" href="../css/A_1_交付版.css">' +
  '<link rel="stylesheet" href="css/x.css">' +
  '<script src="../js/app.js"></script></head><body>' +
  '<img src="../images/smtam/qr.svg">' +
  '<div style="background:url(../images/b.png)"></div>' +
  '</body></html>';

let build: typeof import('../src/vivliostyle/build.js');
let merge: typeof import('../src/vivliostyle/mergeInput.js');
let cleanupProject: (dir: string) => Promise<void>;

const write = (rel: string, body: string | Buffer): void => {
  const full = path.join(dataRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

beforeAll(async () => {
  write('css/A_1_交付版.css', '@font-face{font-family:F;src:url(fonts/F.woff2)}');
  write('css/fonts/F.woff2', 'font');
  write('css/fonts/G.woff2', 'font');
  write('css/x.css', 'p{}');
  write('js/app.js', 'window.APP=1;');
  write('images/b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write('images/SMTAM/qr.svg', GOOD_SVG);
  build = await import('../src/vivliostyle/build.js');
  merge = await import('../src/vivliostyle/mergeInput.js');
  ({ cleanupProject } = await import('../src/vivliostyle/projectInput.js'));
});

beforeEach(() => {
  runs.length = 0;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildInlinePdf — 作業フォルダの形', () => {
  it('文書は doc/index.html、参照された資産は doc/ の兄弟に置き、CLI へは configData で渡す', async () => {
    await build.buildInlinePdf({ html: HTML });
    expect(runs).toHaveLength(1);
    const [run] = runs;
    // 単一入力(`input`)はエントリの親(doc/)を配信ルートにするので使わない。
    expect(run.options).not.toHaveProperty('input');
    expect(run.options.configData).toEqual({
      entry: ['doc/index.html'],
      size: 'A4',
      base: '/vivliostyle',
    });
    expect(run.files).toEqual(
      expect.arrayContaining([
        'doc/index.html',
        'css/A_1_交付版.css',
        'css/fonts/F.woff2',
        'js/app.js',
        'images/b.png',
      ]),
    );
    // 文書直下基準(`css/x.css`)は doc/ から見ると `doc/css/x.css` で、論理ルートの css/ ではない。
    expect(run.files).not.toContain('css/x.css');
    expect(run.files).not.toContain('doc/css/x.css');
    // 参照していないフォントは置かない。
    expect(run.files).not.toContain('css/fonts/G.woff2');
  });

  it('会社フォルダの画像も参照の綴りで images/ の 1 段下に置く(実フォルダは SMTAM)', async () => {
    await build.buildInlinePdf({ html: HTML });
    expect(runs[0].files).toContain('images/smtam/qr.svg');
  });

  it('実体のある <link> は残し、実体の無い文書直下基準の <link> は落とし、JS は展開する', async () => {
    await build.buildInlinePdf({ html: HTML });
    const doc = runs[0].docs['doc/index.html'];
    expect(doc).toContain('<link rel="stylesheet" href="../css/A_1_交付版.css">');
    expect(doc).not.toContain('href="css/x.css"');
    expect(doc).toContain('window.APP=1;');
    expect(doc).not.toContain('src="../js/app.js"');
  });

  it('リクエスト CSS は doc/ から見た形へ付け替えて埋め、その参照先も置く', async () => {
    await build.buildInlinePdf({
      html: '<html><head></head><body>x</body></html>',
      css: '@font-face{font-family:G;src:url(fonts/G.woff2)}',
    });
    const [run] = runs;
    expect(run.docs['doc/index.html']).toContain('url("../css/fonts/G.woff2")');
    expect(run.files).toContain('css/fonts/G.woff2');
  });

  it('size は config に載せ、singleDoc は CLI へ渡さない(entry 1 本の config は既に単一文書)', async () => {
    await build.buildInlinePdf({ html: HTML, size: 'B5', singleDoc: true });
    const [run] = runs;
    expect((run.options.configData as { size?: string }).size).toBe('B5');
    expect(run.options).not.toHaveProperty('singleDoc');
  });
});

describe('buildProjectInSlot — zip の PDF の singleDoc', () => {
  /** `withBuildSlot` から 1 回組版し、CLI へ渡った build オプションを返す。 */
  const runProject = async (input: {
    config?: { entry: string; base: string };
    entry?: string;
    singleDoc?: boolean;
  }): Promise<Record<string, unknown>> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclayout-project-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), HTML);
      await build.withBuildSlot((run) => build.buildProjectInSlot({ dir, ...input }, run));
      return runs[runs.length - 1].options;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('config があれば singleDoc を CLI へ渡さない(configData と併用すると組版が壊れる)', async () => {
    const options = await runProject({
      config: { entry: 'index.html', base: '/vivliostyle' },
      singleDoc: true,
    });
    expect(options).toHaveProperty('configData');
    expect(options).not.toHaveProperty('singleDoc');
  });

  it('config が無くエントリで組むときは singleDoc を CLI へ渡す', async () => {
    const options = await runProject({ entry: 'index.html', singleDoc: true });
    expect(options).toMatchObject({ input: 'index.html', singleDoc: true });
  });
});

describe('prepareInlineDoc — プレビューの作業フォルダ', () => {
  it('config のエントリは doc/index.html で、資産は兄弟に置く', async () => {
    const { dir, config } = await build.prepareInlineDoc({ html: HTML, size: 'A5' });
    try {
      expect(config).toEqual({ entry: ['doc/index.html'], size: 'A5', base: '/vivliostyle' });
      expect(fs.existsSync(path.join(dir, 'doc', 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'css', 'A_1_交付版.css'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'images', 'b.png'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'css', 'x.css'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(false);
    } finally {
      await cleanupProject(dir);
    }
  });
});

describe('結合 — doc/doc-NNN.html', () => {
  it('materializeMergeProject は doc/ 配下へ連番で書き、資産は兄弟に置く', async () => {
    const { dir, config } = await merge.materializeMergeProject([
      { html: HTML, css: '' },
      { html: '<html><head></head><body>2</body></html>', css: '' },
    ]);
    try {
      expect(config.entry).toEqual(['doc/doc-000.html', 'doc/doc-001.html']);
      expect(fs.existsSync(path.join(dir, 'doc', 'doc-000.html'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'doc', 'doc-001.html'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'css', 'A_1_交付版.css'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'css', 'x.css'))).toBe(false);
    } finally {
      await cleanupProject(dir);
    }
  });

  it('buildMergedPdf は configData の entry を doc/ 配下で渡す', async () => {
    await build.buildMergedPdf({ documents: [{ html: HTML, css: '' }] });
    const [run] = runs;
    expect((run.options.configData as { entry: string[] }).entry).toEqual(['doc/doc-000.html']);
    expect(run.files).toEqual(expect.arrayContaining(['doc/doc-000.html', 'css/A_1_交付版.css']));
  });
});
