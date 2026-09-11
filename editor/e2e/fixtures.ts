// =============================================================================
// fixtures.ts — 一時 dataRoot を作り直す Playwright fixture
// =============================================================================
// 全 spec はここから `test` / `expect` を取る(`@playwright/test` を直に import しない)。
// 既定はテストごとに白紙の dataRoot で、spec の主張はその前提で書かれている
// (「下書きが無い」「コメントが 1 件」など)。直列に依存し合うテストを持つファイルだけが
// `test.use({ keepDataRootAcrossTests: true })` で自ファイル内の共有へ切り替える。
//
// リセットの射程は **dataRoot だけ**。sproc フェイクの in-memory テーブル(ユーザー・台帳・
// 監査)と `auth/loginRateLimit.ts` の計数はサーバプロセス側にあり、テストをまたいで残る。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { seedDataRoot } from '../server/scripts/e2e-rest-seed';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 直前に走った spec ファイル。`keepDataRootAcrossTests` のときだけ意味を持つ。 */
let lastFile: string | null = null;

export const test = base.extend<{
  /**
   * true にしたファイルは自ファイルの中で dataRoot を共有する。**`test.describe.configure`
   * で `mode: 'serial'` にしてあることが前提** — 直列でないと同じファイルのテストが連続して
   * 走る保証が無く、間に別ファイルの seed が挟まって共有したい状態が消える。
   */
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
