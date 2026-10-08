// =============================================================================
// runtime/nativeDriver.ts — exe に埋め込んだ DB ドライバの書き出し・照合・後片付け
// -----------------------------------------------------------------------------
// msnodesqlv8 のネイティブ部分(`sqlserverv8.node`)は実ファイルからしか読み込めない
// (`process.dlopen` の制約)。exe はこれを SEA アセットとして持ち、DB を使うときだけ
// 実行ごとのフォルダ(`%TEMP%\pie-chart-db\<pid>-<6 文字>`)へ書き出して照合する。
// exe の外にあるファイルを読む唯一の例外なので、次の 3 点で幅を狭める:
//   1. 書き出しは新規作成のみ(`wx`)。既にあるファイルは使わない。
//   2. 照合は書き出した直後と、子プロセスが読み込む直前の 2 回。
//   3. フォルダは子プロセスの終了後に親が消す。読み込み中の DLL は Windows では消せないため、
//      読み込むのは子だけにしてある(`runtime/dbChild.ts`)。強制終了で残ったものは、次の
//      起動時に、作ったプロセスが既にいないものだけを消す(同時に動く別の exe のフォルダは残す)。
// =============================================================================

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DbStageError, errorMessage } from '../input/dbStage.js';

/** SEA アセットのキー(`seaRuntime.ts` の `SEA_ASSET_KEYS` の 1 要素)。 */
export const DRIVER_ASSET_KEY = 'sqlserverv8.node';
/** 書き出すファイル名。 */
export const DRIVER_FILE_NAME = 'sqlserverv8.node';
/** 実行ごとのフォルダを置く親フォルダの名前(`%TEMP%` の直下)。 */
const RUN_DIR_PARENT_NAME = 'pie-chart-db';

/** `sqlserverv8Shim.cjs` と共有する登録先。モジュールの同一性に頼らないようグローバルに置く。 */
const DRIVER_PATH_KEY = Symbol.for('pie-chart.sqlserverv8.path');

/** `mkdtemp` が付ける 6 文字と、先頭の PID。 */
const RUN_DIR_RE = /^(\d+)-[A-Za-z0-9]{6}$/;

/**
 * フォルダを消すときの指定。書き出した直後の DLL はウイルス対策ソフトや EDR が検査のために
 * 短い間つかんでいることがあり、1 回で諦めると消し残すので、間を置いて数回やり直す。
 */
const RM_OPTIONS: fs.RmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/** 実行ごとのフォルダの名前の形(`<pid>-<6 文字>`)か。 */
export function isRunDirName(name: string): boolean {
  return RUN_DIR_RE.test(name);
}

/** esbuild の `define` がビルド時に SHA256 の文字列リテラルへ置き換える。 */
declare const __PIE_SQLSERVERV8_SHA256__: string | undefined;

export function runDirParent(tmp: string = os.tmpdir()): string {
  return path.join(tmp, RUN_DIR_PARENT_NAME);
}

/** 実行ごとのフォルダを作る。名前の先頭の PID は、起動時の掃除が生死を判定するため。 */
export function createRunDir(parent: string, pid: number = process.pid): string {
  try {
    fs.mkdirSync(parent, { recursive: true });
    return fs.mkdtempSync(path.join(parent, `${pid}-`));
  } catch (err) {
    throw new DbStageError(
      'extract',
      `could not create a working folder under ${parent}: ${errorMessage(err)}`,
    );
  }
}

/** PID のプロセスが生きているか。`EPERM` は「居るが権限が無い」なので生きている扱い。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 作ったプロセスが既にいないフォルダを消し、消したパスを返す。名前の形が違うもの・
 * 消せないものは黙って飛ばす(掃除の失敗で本来の処理を止めない。次の起動で再び試す)。
 */
export function sweepStaleRunDirs(
  parent: string,
  isAlive: (pid: number) => boolean = isPidAlive,
): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = RUN_DIR_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(parent, name);
    try {
      fs.rmSync(dir, RM_OPTIONS);
      removed.push(dir);
    } catch {
      // 使用中などで消せない。次の起動に回す。
    }
  }
  return removed;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function verifyDriverFile(file: string, expectedSha256: string): void {
  let actual: string;
  try {
    actual = sha256Hex(fs.readFileSync(file));
  } catch (err) {
    throw new DbStageError('verify', `could not read the driver at ${file}: ${errorMessage(err)}`);
  }
  if (actual !== expectedSha256) {
    throw new DbStageError(
      'verify',
      `driver hash mismatch at ${file} (expected ${expectedSha256}, got ${actual}).`,
    );
  }
}

/** ドライバを新規作成で書き出し、照合してからパスを返す。 */
export function writeVerifiedDriver(dir: string, bytes: Buffer, expectedSha256: string): string {
  const file = path.join(dir, DRIVER_FILE_NAME);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  } catch (err) {
    throw new DbStageError(
      'extract',
      `could not write the driver to ${file}: ${errorMessage(err)}`,
    );
  }
  verifyDriverFile(file, expectedSha256);
  return file;
}

/** フォルダを消す。消せなければメッセージを返す(呼び出し側が警告として出す)。 */
export function removeRunDir(dir: string): string | null {
  try {
    fs.rmSync(dir, RM_OPTIONS);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/** 照合済みのドライバのパスを shim へ渡す。msnodesqlv8 を読み込む前に呼ぶ。 */
export function registerDriverPath(file: string): void {
  (globalThis as Record<symbol, unknown>)[DRIVER_PATH_KEY] = file;
}

/** ビルド時に埋め込んだドライバの SHA256。開発版と `--no-db` でビルドした exe では空。 */
export function embeddedDriverSha256(): string {
  return typeof __PIE_SQLSERVERV8_SHA256__ === 'string' ? __PIE_SQLSERVERV8_SHA256__ : '';
}
