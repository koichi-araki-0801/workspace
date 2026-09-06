/// <reference types="vitest/config" />
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// web の vitest は dom / node の 2 project に分ける。jsdom の起動はファイルごとに約 1.5 秒かかり、
// DOM に触れないテストまで jsdom で走らせると、この起動費だけで `test:editor` の過半を占める。
// jsdom が要るのは `*.dom.test.ts` と名付けたファイルだけで、それ以外は `vitest.node.config.ts`
// が node 環境で走らせる。
//
// `vite.config.ts` を `mergeConfig` で取り込むのは、`vue()` プラグインと `resolve.alias`(`@` /
// `@editor/shared`)が `test` ブロックの外にあり、`vitest.*.config.ts` が存在すると vitest は
// `vite.config.ts` を読まなくなるため。coverage はルート `vitest.config.ts` に一本化されており、
// ここでは environment / globals / 対象ファイルだけを持つ。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // ルート `vitest.config.ts` の `projects` 集約で `--project web-dom` の選別を効かせるための名前。
      // `web-` 接頭辞は node 側と対で、`--project "web-*"` のワイルドカード選別の単位。
      name: 'web-dom',
      environment: 'jsdom',
      globals: true,
      include: ['test/**/*.dom.test.ts'],
    },
  }),
);
