// =============================================================================
// workDir.ts — 組版の作業ディレクトリ名
// =============================================================================
// 入力ごとに専用ディレクトリを `config.tmpDir` 直下に切る。名前は時刻とランダム 4 バイトで、
// 同じミリ秒に始まる並行リクエストでも衝突させない。作成と掃除は呼び出し側が行う。

import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

/** `config.tmpDir/<prefix>-<時刻>-<乱数>` のパスを返す(ディレクトリは作らない)。 */
export function makeWorkDir(prefix: string): string {
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(config.tmpDir, `${prefix}-${stamp}`);
}
