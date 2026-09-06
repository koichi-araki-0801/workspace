/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// web ディレクトリで vitest を直に起動する経路(`pnpm --filter web test <name>` = `vitest run`)の
// ための root 設定。vitest が自動検出するのは `vitest.config.*` / `vite.config.*` だけで、
// `vitest.dom.config.ts` / `vitest.node.config.ts` は検出されないため、ここから 2 つの leaf を
// `projects` で束ねる。
//
// ワークスペース root の `vitest.config.ts` はこのファイルを列挙しない。参照された config の中の
// `test.projects` は無視され(全ファイルが node で 1 project として走る)、root 側は leaf 2 本を
// 直接列挙する。`projects` が効くのは「自身が root として起動されたとき」だけ。
export default defineConfig({
  test: {
    projects: ['./vitest.dom.config.ts', './vitest.node.config.ts'],
  },
});
