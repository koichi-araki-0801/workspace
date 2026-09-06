/// <reference types="vitest/config" />
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// DOM に触れない web テストの project。jsdom を立てずに node 環境で走らせる(分割の理由と
// `vite.config.ts` を取り込む理由は `vitest.dom.config.ts` を参照)。`window` / `document` /
// `localStorage` が要るテストは `*.dom.test.ts` へ改名して dom 側へ移す。node 側で
// `document is not defined` 等の ReferenceError で落ちるのが移す合図。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // ルート `vitest.config.ts` の `projects` 集約で `--project web-node` の選別を効かせるための名前。
      name: 'web-node',
      environment: 'node',
      globals: true,
      include: ['test/**/*.test.ts'],
      // `include` は `*.dom.test.ts` にも一致するため、dom 側の担当を除いて二重実行を防ぐ。
      // `configDefaults.exclude` を展開して残すのは、素の配列にすると vitest 既定の
      // `node_modules` / `dist` 除外が消えるため。
      exclude: [...configDefaults.exclude, '**/*.dom.test.ts'],
    },
  }),
);
