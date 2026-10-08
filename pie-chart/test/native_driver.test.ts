import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRIVER_FILE_NAME,
  createRunDir,
  embeddedDriverSha256,
  isPidAlive,
  registerDriverPath,
  removeRunDir,
  runDirParent,
  sha256Hex,
  sweepStaleRunDirs,
  verifyDriverFile,
  writeVerifiedDriver,
} from '../src/runtime/nativeDriver.js';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'piechart-native-'));
});
afterEach(() => {
  try {
    rmSync(parent, { recursive: true, force: true });
  } catch {
    // dlopen したドライバはプロセス終了まで消せない(Windows)。OS の一時フォルダ掃除に任せる。
  }
});

describe('実行ごとのフォルダ', () => {
  it('runDirParent は <tmp>/pie-chart-db', () => {
    expect(runDirParent('C:\\T')).toBe(join('C:\\T', 'pie-chart-db'));
  });
  it('<pid>-<6 文字> の名前で作り、親が無ければ作る', () => {
    const dir = createRunDir(join(parent, 'pie-chart-db'), 4242);
    expect(dir).toMatch(/[\\/]4242-[A-Za-z0-9]{6}$/);
    expect(existsSync(dir)).toBe(true);
  });
  it('作れなければ extract 段階のエラー', () => {
    const file = join(parent, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(() => createRunDir(join(file, 'sub'))).toThrow(
      expect.objectContaining({ stage: 'extract' }),
    );
  });
  it('removeRunDir は消せたら null、無くても null', () => {
    const dir = createRunDir(parent);
    expect(removeRunDir(dir)).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(removeRunDir(dir)).toBeNull();
  });
});

describe('sweepStaleRunDirs', () => {
  it('作ったプロセスが生きていないフォルダだけを消す', () => {
    const dead = join(parent, '111-aaaaaa');
    const alive = join(parent, '222-bbbbbb');
    const mine = join(parent, `${process.pid}-cccccc`);
    const other = join(parent, 'unrelated');
    for (const d of [dead, alive, mine, other]) mkdirSync(d);
    const removed = sweepStaleRunDirs(parent, (pid) => pid === 222);
    expect(removed).toEqual([dead]);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
  it('親フォルダが無ければ何もしない', () => {
    expect(sweepStaleRunDirs(join(parent, 'missing'))).toEqual([]);
  });
  it('isPidAlive は自分を生きている、使われていない大きな PID を死んでいると判定する', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});

describe('ドライバの書き出しと照合', () => {
  const bytes = Buffer.from('fake driver bytes');
  const sha = sha256Hex(bytes);

  it('書き出して照合し、パスを返す', () => {
    const dir = createRunDir(parent);
    const file = writeVerifiedDriver(dir, bytes, sha);
    expect(file).toBe(join(dir, DRIVER_FILE_NAME));
    expect(readFileSync(file)).toEqual(bytes);
  });
  it('既にファイルがあれば上書きせず extract 段階のエラー', () => {
    const dir = createRunDir(parent);
    writeFileSync(join(dir, DRIVER_FILE_NAME), 'planted');
    expect(() => writeVerifiedDriver(dir, bytes, sha)).toThrow(
      expect.objectContaining({ stage: 'extract' }),
    );
  });
  it('ハッシュが違えば verify 段階のエラー', () => {
    const dir = createRunDir(parent);
    expect(() => writeVerifiedDriver(dir, bytes, '0'.repeat(64))).toThrow(
      expect.objectContaining({ stage: 'verify' }),
    );
  });
  it('読めなければ verify 段階のエラー', () => {
    expect(() => verifyDriverFile(join(parent, 'missing.node'), sha)).toThrow(
      expect.objectContaining({ stage: 'verify' }),
    );
  });
  it('開発版では埋め込みハッシュは空', () => {
    expect(embeddedDriverSha256()).toBe('');
  });
});

describe('sqlserverv8Shim', () => {
  const shimPath = join(root, 'src', 'runtime', 'sqlserverv8Shim.cjs');
  const realDriver = join(
    root,
    'node_modules',
    'msnodesqlv8',
    'build',
    'Release',
    'sqlserverv8.node',
  );

  it('パスが登録されていなければ識別できるメッセージで投げる', () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('pie-chart.sqlserverv8.path')];
    delete require.cache[shimPath];
    expect(() => require(shimPath)).toThrow(/pie-chart:sqlserverv8-shim/);
  });

  // 日本語を含むフォルダ(ユーザー名が日本語の %TEMP% を想定)からでも dlopen できること。
  it.skipIf(!existsSync(realDriver))('日本語を含むパスへ書き出したドライバを読める', () => {
    const bytes = readFileSync(realDriver);
    const dir = createRunDir(join(parent, '山田', 'pie-chart-db'));
    const file = writeVerifiedDriver(dir, bytes, sha256Hex(bytes));
    registerDriverPath(file);
    delete require.cache[shimPath];
    const driver = require(shimPath) as Record<string, unknown>;
    expect(typeof driver).toBe('object');
  });
});
