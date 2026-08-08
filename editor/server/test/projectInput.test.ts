import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { isAppError } from '@editor/shared';
import JSZip from 'jszip';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  cleanupProject,
  extractByteBudget,
  extractProjectZip,
  safeEntryPath,
  safeProjectEntry,
} from '../src/vivliostyle/projectInput.js';

// 「残骸を残さない」検査は tmp を他のテストファイルと共有していると成立しない。
// `vivlio-` 前置の絞り込みは `mergeInput.test.ts` の `vivlio-merge-*` にも当たるため、
// 並行実行中の他ファイルが作ったディレクトリが増分として写り込む(実測でフレーク)。
// そこで専用 tmp を割り当てて隔離する。`config` は import 時に env を読むので、代入は
// import より先に走らせねばならない — `vi.hoisted` がその唯一の手段(この中では import した
// 束縛をまだ参照できないため、値は `config` 側の `path.resolve(repoRoot, ...)` に解決を
// 任せる相対パスで組む)。既存の `.tmp/` 配下に置くのは、後始末に失敗しても gitignore
// 済みで済ませるため。
const TEST_TMP_MARKER = 'test-project-input-';
vi.hoisted(() => {
  process.env.TMP_DIR = `.tmp/test-project-input-${process.pid}-${Date.now().toString(36)}`;
});

const created: string[] = [];
afterEach(async () => {
  while (created.length) await cleanupProject(created.pop() as string);
  vi.unstubAllEnvs();
  vi.resetModules();
});
afterAll(async () => {
  // 隔離が効いていない(= 共有 `.tmp` を指している)ときに消しに行かないよう目印で確かめる。
  if (!config.tmpDir.includes(TEST_TMP_MARKER)) return;
  await fs.rm(config.tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function zipOf(files: Record<string, string>, deflate = false): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({
    type: 'nodebuffer',
    ...(deflate ? { compression: 'DEFLATE' as const } : {}),
  });
}

/**
 * 汎用フラグ bit3(データ記述子)を立てた zip を手組みする。JSZip は既定でこの形を作らない
 * ため、実データ長と食い違う申告値を持つアーカイブはここで組むしかない。
 *
 * bit3 のエントリは node-stream-zip が CRC/サイズ検証ストリームを繋がない
 * (`canVerifyCrc`)ので、`declaredSize` をいくら小さく偽っても全量が展開される。
 * ローカルヘッダのサイズ欄を 0 にしておくと中央ディレクトリの値が上書きされない
 * (`readDataHeader`)ため、読み出し長は実圧縮長のまま残る。
 */
function dataDescriptorZip(name: string, content: Buffer, declaredSize: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(content);
  const FLAGS = 0x0008;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(FLAGS, 6);
  local.writeUInt16LE(8, 8); // method = deflate
  // crc / compressedSize / size はローカル側では 0(データ記述子で後追いする形)。
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(0, 4); // crc(検証されないので 0 のまま)
  descriptor.writeUInt32LE(deflated.length, 8);
  descriptor.writeUInt32LE(content.length, 12);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(FLAGS, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20); // 実際に読ませる圧縮長
  central.writeUInt32LE(declaredSize, 24); // 攻撃者が偽る展開後サイズ
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // ローカルヘッダの位置
  nameBuf.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + deflated.length + descriptor.length, 16);

  return Buffer.concat([local, deflated, descriptor, central, end]);
}

/**
 * EOCD だけを持つ最小 zip を手組みする。`assertDeclaredEntryCount` は `archive.entries()`
 * より前に走るので、中央ディレクトリの実体を持たなくても足切りの検査ができる。
 * `zip64` を立てると ZIP64 EOCD 経路(64bit 値)を通す。
 */
function eocdOnlyZip(opts: { entries: number; cdBytes: number; zip64?: boolean }): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : opts.entries, 8);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : opts.entries, 10);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : opts.cdBytes, 12);
  if (!opts.zip64) return eocd;

  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeBigUInt64LE(BigInt(opts.entries), 24);
  z64.writeBigUInt64LE(BigInt(opts.entries), 32);
  z64.writeBigUInt64LE(BigInt(opts.cdBytes), 40);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(0n, 8); // ZIP64 EOCD の位置 = バッファ先頭
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([z64, locator, eocd]);
}

/**
 * 展開の資源上限はモジュール読込時に env から確定する。巨大な zip を作らずに上限へ
 * 到達させるため、env を差し替えてモジュールを読み直す。
 */
async function importWithEnv(
  env: Record<string, string>,
): Promise<typeof import('../src/vivliostyle/projectInput.js')> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return import('../src/vivliostyle/projectInput.js');
}

/** 展開ディレクトリの残骸が増えていないこと(失敗時も中途展開を残さない)。 */
async function tmpProjectDirs(): Promise<string[]> {
  const names = await fs.readdir(config.tmpDir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('vivlio-') && !n.endsWith('.zip'));
}

/** アップロード zip 実体の残骸。 */
async function tmpZipFiles(): Promise<string[]> {
  const names = await fs.readdir(config.tmpDir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('vivlio-') && n.endsWith('.zip'));
}

// 隔離が効かなくなったら(vitest が `vi.hoisted` を import より前に走らせなくなる等)、
// 残骸検査が他ファイルと干渉して「たまに落ちる」テストへ静かに退化する。無言の退化を
// 避けるため、隔離そのものを 1 本のテストで固定する。
it('runs against an isolated tmp dir so leftover checks cannot see other test files', () => {
  expect(config.tmpDir).toContain(TEST_TMP_MARKER);
});

describe('safeEntryPath', () => {
  const root = path.join(config.tmpDir, 'safe-root');

  it('resolves nested and Japanese names under root', () => {
    expect(safeEntryPath(root, 'manuscript/本文.md')).toBe(
      path.resolve(root, 'manuscript/本文.md'),
    );
  });

  it('rejects parent traversal, absolute and drive-letter paths', () => {
    for (const bad of ['../evil.txt', '../../x', '/etc/passwd', 'C:\\windows\\x', 'a/../../b']) {
      expect(() => safeEntryPath(root, bad), bad).toThrow();
    }
  });

  it('rejects backslash-escaped traversal', () => {
    expect(() => safeEntryPath(root, '..\\evil')).toThrow();
  });
});

describe('extractProjectZip', () => {
  it('extracts files (incl. Japanese names) and parses the config', async () => {
    const buf = await zipOf({
      'vivliostyle.config.json': '{"entry":"manuscript/本文.md"}',
      'manuscript/本文.md': '# こんにちは',
    });
    const project = await extractProjectZip(buf);
    created.push(project.dir);

    expect(project.fileCount).toBe(2);
    // CLI へはファイルパスではなく検証済みオブジェクトを渡す(`configData` 方式)。
    expect(project.config?.entry).toBe('manuscript/本文.md');
    expect(project.config?.base).toBe('/vivliostyle');
    expect(existsSync(path.join(project.dir, 'manuscript', '本文.md'))).toBe(true);
    expect(await fs.readFile(path.join(project.dir, 'manuscript', '本文.md'), 'utf8')).toContain(
      'こんにちは',
    );
  });

  it('finds a config nested under a top-level folder, leaves config undefined otherwise', async () => {
    const nested = await zipOf({
      'proj/vivliostyle.config.json': '{"entry":"index.html"}',
      'proj/index.html': '<p>x</p>',
    });
    const a = await extractProjectZip(nested);
    created.push(a.dir);
    expect(a.config?.entry).toBe('index.html');

    const noConfig = await zipOf({ 'index.html': '<p>x</p>' });
    const b = await extractProjectZip(noConfig);
    created.push(b.dir);
    expect(b.config).toBeUndefined();
  });

  // 探索側は case-fold して**広く拾う**のが正しい。見落とすと検証しないまま zip に残る。
  it('picks up a config whose name differs only in case', async () => {
    const buf = await zipOf({
      'VIVLIOSTYLE.CONFIG.JSON': '{"entry":"index.html"}',
      'index.html': '<p>x</p>',
    });
    const project = await extractProjectZip(buf);
    created.push(project.dir);
    expect(project.config?.entry).toBe('index.html');
  });

  it('rejects a zip that carries two configs (ambiguity falls to reject)', async () => {
    // 以前は BFS 順の最初の 1 件を黙って採っていたため、深い所に別の config を隠して
    // 「どちらが効くか」を人間に判らなくできた。
    const buf = await zipOf({
      'vivliostyle.config.json': '{"entry":"index.html"}',
      'deep/vivliostyle.config.json': '{"entry":"index.html"}',
      'index.html': '<p>x</p>',
    });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
  });

  // 以前は「実行可能な config のファイル名」を数え上げて拒否していた。今は**拡張子の
  // 許可リスト**に載らないので落ちる — 別ツールの config も未知の実行面も同じ理由で落ちる。
  it.each([
    'vivliostyle.config.js',
    'vivliostyle.config.cjs',
    'vivliostyle.config.mjs',
    'vivliostyle.config.ts',
    'vivliostyle.config.JS',
    'vite.config.js',
    'vite.config.mts',
    'postcss.config.js',
    '.npmrc',
    'package.json',
    'node_modules/a/index.js',
    'evil.JS',
    'evil.jS',
    'x.png.js',
    'x.js.',
    'x.js ',
    'assets/logo.bmp',
  ])('rejects a non-allowlisted file (%s) anywhere in the tree', async (name) => {
    const before = await tmpProjectDirs();
    const buf = await zipOf({ [name]: 'x', 'index.html': '<p>x</p>' });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    // 拒否した展開ディレクトリを残さない。
    expect((await tmpProjectDirs()).filter((n) => !before.includes(n))).toEqual([]);
  });

  it('rejects a non-allowlisted file hidden deep under subdirectories', async () => {
    const buf = await zipOf({
      'vivliostyle.config.json': '{"entry":"index.html"}',
      'index.html': '<p>x</p>',
      'a/b/c/vivliostyle.config.js': 'module.exports = {};',
    });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
  });

  it('accepts a name that merely looks dangerous but ends with an allowed extension', () => {
    // 末尾一致であることの主張。「許可拡張子を**含む**」判定だと `x.png.js` が通る。
    return zipOf({ 'x.js.png': 'x', 'index.html': '<p>x</p>' })
      .then((buf) => extractProjectZip(buf))
      .then((project) => {
        created.push(project.dir);
        expect(existsSync(path.join(project.dir, 'x.js.png'))).toBe(true);
      });
  });

  it('silently drops OS noise but keeps the upload valid', async () => {
    const buf = await zipOf({
      '__MACOSX/._index.html': 'junk',
      '.DS_Store': 'junk',
      'Thumbs.db': 'junk',
      'desktop.ini': 'junk',
      'index.html': '<p>x</p>',
    });
    const project = await extractProjectZip(buf);
    created.push(project.dir);
    expect(project.fileCount).toBe(1);
    for (const n of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX']) {
      expect(existsSync(path.join(project.dir, n)), n).toBe(false);
    }
  });

  it('names the offending file in the 400 message', async () => {
    const buf = await zipOf({ 'evil.js': 'x', 'index.html': '<p>x</p>' });
    await expect(extractProjectZip(buf)).rejects.toMatchObject({
      message: expect.stringContaining('evil.js'),
    });
  });

  it('leaves no extracted directory behind when a config is rejected', async () => {
    const before = await fs.readdir(config.tmpDir).catch(() => [] as string[]);
    const buf = await zipOf({ 'vivliostyle.config.js': 'module.exports = {};' });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    const after = await fs.readdir(config.tmpDir).catch(() => [] as string[]);
    expect(after.filter((n) => n.startsWith('vivlio-'))).toEqual(
      before.filter((n) => n.startsWith('vivlio-')),
    );
  });

  it('rejects a zip-slip entry and writes nothing outside root', async () => {
    const buf = await zipOf({ '../escape.txt': 'pwned', 'ok.txt': 'fine' });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect(existsSync(path.join(config.tmpDir, 'escape.txt'))).toBe(false);
  });

  // 拒否した zip 実体(最大 64MB)を temp に残すと、それ自体がディスクを埋める経路になる。
  it('removes the uploaded zip itself even when the archive is rejected', async () => {
    const before = await tmpZipFiles();
    const buf = await zipOf({ '../escape.txt': 'pwned', 'ok.txt': 'fine' });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect((await tmpZipFiles()).filter((n) => !before.includes(n))).toEqual([]);
  });

  it('rejects an empty archive', async () => {
    const buf = await zipOf({});
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
  });
});

// zip bomb ガード。展開「前」に申告値で弾くのが要件なので、拒否と同時に「1 つも
// 展開ディレクトリを残さない」ことまで見る。
describe('extractProjectZip resource limits', () => {
  it('rejects a zip whose declared uncompressed total exceeds the limit', async () => {
    const mod = await importWithEnv({ VIVLIO_MAX_UNZIP_BYTES: '64' });
    const before = await tmpProjectDirs();
    const buf = await zipOf({ 'index.html': 'x'.repeat(200) });
    await expect(mod.extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect(await tmpProjectDirs()).toEqual(before);
  });

  it('rejects a zip with too many entries', async () => {
    const mod = await importWithEnv({ VIVLIO_MAX_UNZIP_ENTRIES: '2' });
    const buf = await zipOf({ 'a.html': 'a', 'b.html': 'b', 'c.html': 'c' });
    await expect(mod.extractProjectZip(buf)).rejects.toSatisfy(isAppError);
  });

  // 9MB を実際に inflate するので、ルート CI(5 プロジェクト並列 + coverage)では既定 5s を
  // 超えて落ちる(単独なら 1s 未満)。遅いこと自体は退行ではないので上限を実測へ合わせる。
  it('rejects an over-compressed archive (zip bomb)', { timeout: 60_000 }, async () => {
    // 圧縮比の検査は展開後 8MB 超から効く。9MB の同一文字は deflate で数 KB に縮み、
    // 比は 100 倍を大きく超える。
    const buf = await zipOf({ 'bomb.html': 'a'.repeat(9 * 1024 * 1024) }, true);
    expect(buf.length).toBeLessThan(9 * 1024 * 1024 * 0.01);
    const before = await tmpProjectDirs();
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect(await tmpProjectDirs()).toEqual(before);
  });

  // `'256MB'` のような打ち間違いが `NaN` になると `total > NaN` が常に false になり、
  // 上限を上書きしたつもりで無効化されてしまう。旧仕様は既定へ倒していたが、それだと
  // 運用者は上限が変わっていないことに一生気付けない。現仕様は**起動を中止**する。
  it('refuses to load when an env override is not a positive decimal number', async () => {
    // `vi.stubEnv` は積み上がるので、1 変数ずつ隔離して評価する。
    for (const [name, value] of [
      ['VIVLIO_MAX_UNZIP_BYTES', '256MB'],
      ['VIVLIO_MAX_UNZIP_ENTRIES', '0'],
      ['VIVLIO_MAX_UNZIP_RATIO', ''],
    ] as const) {
      vi.unstubAllEnvs();
      await expect(importWithEnv({ [name]: value }), name).rejects.toThrow(name);
    }
    vi.unstubAllEnvs();
  });

  // 申告値だけを見る検査は汎用フラグ bit3 で完全に外れる(CRC 検証が繋がれない)。
  // 実際に書いたバイト数を数える後段が最後の関所であることを、拒否と正常系の対で固定する。
  it('stops a zip that lies about its uncompressed size with the data-descriptor flag', async () => {
    const mod = await importWithEnv({ VIVLIO_MAX_UNZIP_BYTES: '1048576' });
    const before = await tmpProjectDirs();
    // 申告 100 バイト・実体 4MB。前段(申告値)は素通りし、後段の実測予算(1MB)で止まる。
    const buf = dataDescriptorZip('bomb.html', Buffer.alloc(4 * 1024 * 1024, 0x61), 100);
    await expect(mod.extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    // 中途展開のディレクトリも、書きかけのファイルも残さない。
    expect(await tmpProjectDirs()).toEqual(before);
  });

  it('still extracts an honest data-descriptor zip (the flag itself is not rejected)', async () => {
    const body = Buffer.from('<p>ok</p>', 'utf8');
    const project = await extractProjectZip(dataDescriptorZip('index.html', body, body.length));
    created.push(project.dir);
    expect(project.fileCount).toBe(1);
    expect(await fs.readFile(path.join(project.dir, 'index.html'), 'utf8')).toBe('<p>ok</p>');
  });

  it('caps the measured budget by the absolute limit and the compression ratio', () => {
    // 小さな zip では圧縮比側(下駄 8MB)が効き、大きな zip では絶対上限(既定 256MB)で頭打ち。
    expect(extractByteBudget(1024)).toBe(8 * 1024 * 1024);
    expect(extractByteBudget(64 * 1024 * 1024)).toBe(256 * 1024 * 1024);
  });

  it('still extracts an ordinary project that is well within the limits', async () => {
    const mod = await importWithEnv({
      VIVLIO_MAX_UNZIP_BYTES: '1048576',
      VIVLIO_MAX_UNZIP_ENTRIES: '10',
      VIVLIO_MAX_UNZIP_RATIO: '2',
    });
    // 展開後 8MB 未満なので、比が上限を超えていても圧縮比の検査は効かない(誤検知防止の下駄)。
    const buf = await zipOf({ 'index.html': 'x'.repeat(100_000) }, true);
    const project = await mod.extractProjectZip(buf);
    created.push(project.dir);
    expect(project.fileCount).toBe(1);
  });
});

// `base`(文書の配信 path)は利用者に指定させず、サーバ側で固定する。指定を黙って捨てず
// 400 にするのは、「設定が効かない」を利用者が無言で踏まないため。値の検証そのものは
// `projectConfig.test.ts` が持つ。
describe('config の base', () => {
  it('rejects the whole upload when the bundled config declares a base', async () => {
    const before = await tmpProjectDirs();
    const buf = await zipOf({
      'vivliostyle.config.json': '{"entry":"index.html","base":"/__vivliostyle-viewer"}',
      'index.html': '<p>x</p>',
    });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect((await tmpProjectDirs()).filter((n) => !before.includes(n))).toEqual([]);
  });

  it('always reports the fixed docBase for the preview allowlist', async () => {
    const buf = await zipOf({
      'vivliostyle.config.json': '{"entry":"index.html"}',
      'index.html': '<p>x</p>',
    });
    const project = await extractProjectZip(buf);
    created.push(project.dir);
    expect(project.docBase).toBe('/vivliostyle');
  });
});

// zip のエントリ数は `archive.entries()` が**全件読み終えた後**にしか観測できない
// (node-stream-zip の `entriesCount` は 'ready' 待ち = materialize 済み)。したがって
// 事前の足切りは EOCD を自前で読むしかない。申告値は偽れるので、真の関所は実測バイト予算。
describe('assertDeclaredEntryCount(EOCD の事前足切り)', () => {
  it('rejects a zip that declares more entries than the limit before materialising', async () => {
    const before = await tmpProjectDirs();
    await expect(
      extractProjectZip(eocdOnlyZip({ entries: 60000, cdBytes: 1024 })),
    ).rejects.toSatisfy(isAppError);
    expect((await tmpProjectDirs()).filter((n) => !before.includes(n))).toEqual([]);
  });

  it('reads 64-bit values from a ZIP64 EOCD (1,000,000 declared entries)', async () => {
    await expect(
      extractProjectZip(eocdOnlyZip({ entries: 1_000_000, cdBytes: 1024, zip64: true })),
    ).rejects.toSatisfy(isAppError);
  });

  it('rejects an oversized central directory', async () => {
    await expect(
      extractProjectZip(eocdOnlyZip({ entries: 10, cdBytes: 64 * 1024 * 1024 })),
    ).rejects.toSatisfy(isAppError);
  });

  it('rejects a buffer with no EOCD at all', async () => {
    await expect(extractProjectZip(Buffer.alloc(64, 0x41))).rejects.toSatisfy(isAppError);
  });

  it('takes the last EOCD, not a decoy planted in the comment area', async () => {
    // zip 仕様どおり後方から最初に見つかったものが本物。前方走査だと偽 EOCD を掴む。
    const decoy = Buffer.alloc(22);
    decoy.writeUInt32LE(0x06054b50, 0);
    decoy.writeUInt16LE(1, 10);
    const real = eocdOnlyZip({ entries: 60000, cdBytes: 1024 });
    await expect(extractProjectZip(Buffer.concat([decoy, real]))).rejects.toSatisfy(isAppError);
  });
});

// クエリ `entry` は CLI の `input` になり、CLI 側に封じ込めが無い。URL 形式と展開
// ディレクトリ外への脱出をここで断ち切る(任意ファイル読み出し / SSRF)。
describe('safeProjectEntry', () => {
  const root = path.join(config.tmpDir, 'entry-root');

  it('resolves a relative entry under the extracted directory', () => {
    expect(safeProjectEntry(root, 'manuscript/本文.md')).toBe(
      path.resolve(root, 'manuscript/本文.md'),
    );
  });

  it('rejects URI schemes', () => {
    for (const bad of [
      'http://127.0.0.1:9200/_cat/indices',
      'https://example.test/x.html',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
    ]) {
      expect(() => safeProjectEntry(root, bad), bad).toThrow();
    }
  });

  it('rejects traversal, absolute paths, drive letters, UNC and NUL', () => {
    for (const bad of [
      '../../../secret.html',
      '/etc/passwd',
      'C:/Users/Public/report.html',
      '//attacker/share/x.html',
      '\\\\attacker\\share\\x.html',
      'ok.html\0.png',
    ]) {
      expect(() => safeProjectEntry(root, bad), bad).toThrow();
    }
  });
});
