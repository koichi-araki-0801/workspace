// =============================================================================
// fixtures.ts — 一時 dataRoot を作り直す Playwright fixture
// =============================================================================
// 全 spec はここから `test` / `expect` を取る(`@playwright/test` を直に import しない)。
// 既定はテストごとに白紙の dataRoot。local 時代は localStorage がコンテキストごとに白紙
// だったので `drafts/` `notes/` `reviews/` がテストをまたいで残ることは無く、spec の主張は
// その前提で書かれている。直列に依存し合うテストを持つファイルだけが
// `test.use({ keepDataRootAcrossTests: true })` で自ファイル内の共有へ切り替える。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { seedDataRoot } from '../server/scripts/e2e-rest-seed';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 直前に走った spec ファイル。`keepDataRootAcrossTests` のときだけ意味を持つ。 */
let lastFile: string | null = null;

export const test = base.extend<{
  keepDataRootAcrossTests: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: 値を配らない auto fixture の Playwright 既定形
  freshDataRoot: void;
}>({
  keepDataRootAcrossTests: [false, { option: true }],
  freshDataRoot: [
    async ({ keepDataRootAcrossTests }, use, testInfo) => {
      if (!keepDataRootAcrossTests || testInfo.file !== lastFile) {
        await seedDataRoot(repoRoot);
        lastFile = testInfo.file;
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect } from '@playwright/test';
