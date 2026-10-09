// =============================================================================
// workDir.test.ts — 作業ディレクトリ名の形と一意性
// =============================================================================
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { makeWorkDir } from '../src/vivliostyle/workDir.js';

describe('makeWorkDir', () => {
  it('config.tmpDir 直下の `<prefix>-<時刻>-<乱数>` を返す', () => {
    const dir = makeWorkDir('vivlio-x');
    expect(path.dirname(dir)).toBe(path.dirname(path.join(config.tmpDir, 'x')));
    expect(path.basename(dir)).toMatch(/^vivlio-x-\d+-[0-9a-f]{8}$/);
  });

  it('同じミリ秒に続けて呼んでも別の名前になる', () => {
    const names = new Set(Array.from({ length: 50 }, () => makeWorkDir('p')));
    expect(names.size).toBe(50);
  });
});
