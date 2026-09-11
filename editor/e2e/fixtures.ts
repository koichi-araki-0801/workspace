// =============================================================================
// fixtures.ts — spec ファイルごとに一時 dataRoot を作り直す Playwright fixture
// =============================================================================
// 全 spec はここから `test` / `expect` を取る(`@playwright/test` を直に import しない)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { seedDataRoot } from '../server/scripts/e2e-rest-seed';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 直前に走った spec ファイル。同じファイルの中ではリセットしない(approval.spec のように
// 直列の 2 テストが 1 つの申請を共有する)。workers: 1 が前提で、ファイルごとに 1 回だけ
// dataRoot を作り直す。local 時代は localStorage がコンテキストごとに白紙だったので、
// drafts/ notes/ reviews/ が spec をまたいで残ることは無かった。
let lastFile: string | null = null;

// biome-ignore lint/suspicious/noConfusingVoidType: 値を配らない auto fixture の Playwright 既定形
export const test = base.extend<{ freshDataRoot: void }>({
  freshDataRoot: [
    // Playwright は依存 fixture を第 1 引数の分割代入から読むので、何も要らなくても `{}` と
    // 書く必要がある(素の識別子は実行時に "must use the object destructuring pattern" で拒否)。
    // biome-ignore lint/correctness/noEmptyPattern: 上記のとおり Playwright の要求
    async ({}, use, testInfo) => {
      if (testInfo.file !== lastFile) {
        await seedDataRoot(repoRoot);
        lastFile = testInfo.file;
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect } from '@playwright/test';
