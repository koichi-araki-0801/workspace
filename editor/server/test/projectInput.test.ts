import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { isAppError } from '@editor/shared';
import JSZip from 'jszip';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  assertSafeConfigBase,
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
  it('extracts files (incl. Japanese names) and detects the config', async () => {
    const buf = await zipOf({
      'vivliostyle.config.json': '{"entry":"manuscript/本文.md"}',
      'manuscript/本文.md': '# こんにちは',
    });
    const project = await extractProjectZip(buf);
    created.push(project.dir);

    expect(project.fileCount).toBe(2);
    expect(project.configPath).toBe(path.join(project.dir, 'vivliostyle.config.json'));
    expect(existsSync(path.join(project.dir, 'manuscript', '本文.md'))).toBe(true);
    expect(await fs.readFile(path.join(project.dir, 'manuscript', '本文.md'), 'utf8')).toContain(
      'こんにちは',
    );
  });

  it('detects a config nested under a top-level folder, leaves configPath undefined otherwise', async () => {
    const nested = await zipOf({ 'proj/vivliostyle.config.json': '{}' });
    const a = await extractProjectZip(nested);
    created.push(a.dir);
    expect(a.configPath).toBe(path.join(a.dir, 'proj', 'vivliostyle.config.json'));

    const noConfig = await zipOf({ 'index.html': '<p>x</p>' });
    const b = await extractProjectZip(noConfig);
    created.push(b.dir);
    expect(b.configPath).toBeUndefined();
  });

  // 実行可能形式の config は vivliostyle CLI が「モジュールとして読み込む」= サーバ上で
  // 任意コードが走る。こちらが configPath を渡さなくても CLI は cwd から自動発見するため、
  // 「使わない」ではなく展開ごと拒否する、が守るべき挙動。
  it.each([
    'vivliostyle.config.js',
    'vivliostyle.config.cjs',
    'vivliostyle.config.mjs',
    'vivliostyle.config.ts',
  ])('rejects an executable config (%s) anywhere in the tree', async (name) => {
    const buf = await zipOf({ [name]: 'process.exit(1)', 'index.html': '<p>x</p>' });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
  });

  it('rejects an executable config hidden deep under subdirectories', async () => {
    const buf = await zipOf({
      'vivliostyle.config.json': '{}',
      'a/b/c/vivliostyle.config.js': 'module.exports = {};',
    });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
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

  it('rejects an over-compressed archive (zip bomb)', async () => {
    // 圧縮比の検査は展開後 8MB 超から効く。9MB の同一文字は deflate で数 KB に縮み、
    // 比は 100 倍を大きく超える。
    const buf = await zipOf({ 'bomb.html': 'a'.repeat(9 * 1024 * 1024) }, true);
    expect(buf.length).toBeLessThan(9 * 1024 * 1024 * 0.01);
    const before = await tmpProjectDirs();
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect(await tmpProjectDirs()).toEqual(before);
  });

  it('falls back to the default limit when the env override is not a positive number', async () => {
    // `'256MB'` のような打ち間違いが `NaN` になると `total > NaN` が常に false になり、
    // 上限を上書きしたつもりで無効化されてしまう。既定へ倒れて検査が生き続けること
    // (= 既定 256MB 内の zip は通り、上限そのものは消えていない)を固定する。
    const mod = await importWithEnv({
      VIVLIO_MAX_UNZIP_BYTES: '256MB',
      VIVLIO_MAX_UNZIP_ENTRIES: '0',
      VIVLIO_MAX_UNZIP_RATIO: '',
    });
    const project = await mod.extractProjectZip(await zipOf({ 'index.html': 'x'.repeat(200) }));
    created.push(project.dir);
    expect(project.fileCount).toBe(1);
    // 既定の圧縮比上限(100 倍)は生きているので、zip bomb は引き続き弾かれる。
    const bomb = await zipOf({ 'bomb.html': 'a'.repeat(9 * 1024 * 1024) }, true);
    await expect(mod.extractProjectZip(bomb)).rejects.toSatisfy(isAppError);
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

// `base` は文書の配信 path を決める CLI の正規フィールドで、config ファイル側の値が
// 唯一の権威(inline config では上書きできない)。ビューアの取り分を名乗られると、
// アップロード由来の HTML が `previewProxy` のビューアプロファイル
// (`script-src 'unsafe-eval'`)で配信されるため、入口で拒否する。
describe('assertSafeConfigBase', () => {
  it('rejects a base that claims the viewer or Vite internal namespace', () => {
    for (const base of [
      '/__vivliostyle-viewer',
      '/__vivliostyle-viewer/docs',
      '/@',
      '/@fs/x',
      '/node_modules/evil',
    ]) {
      expect(() => assertSafeConfigBase(JSON.stringify({ base })), base).toThrow();
    }
  });

  it('allows the default and other bases (they land on the content CSP profile)', () => {
    for (const text of [
      '{}',
      JSON.stringify({ base: '/vivliostyle' }),
      JSON.stringify({ base: '/docs' }),
      // `base` が文字列でない・JSON として読めない config は CLI 側の失敗に委ねる。
      JSON.stringify({ base: 1 }),
      'not json at all',
    ]) {
      expect(() => assertSafeConfigBase(text), text).not.toThrow();
    }
  });

  it('rejects the whole upload when the bundled config declares a reserved base', async () => {
    const before = await tmpProjectDirs();
    const buf = await zipOf({
      'vivliostyle.config.json': '{"base":"/__vivliostyle-viewer"}',
      'index.html': '<p>x</p>',
    });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect(await tmpProjectDirs()).toEqual(before);
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
