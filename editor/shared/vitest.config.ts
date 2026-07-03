/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// coverage はルート vitest.config.ts に一本化(集約・閾値 85%)。ここは environment/globals と
// typecheck モード(型テスト `test/schemas.test-d.ts` の実行基盤)のみ。
export default defineConfig({
  test: {
    // ルート vitest.config.ts の `projects` 集約で `--project shared` 選別を効かせるための名前。
    name: 'shared',
    environment: 'node',
    globals: true,
    // 通常テストは esbuild transform のみで型は検証されないため、`*.test-d.ts` を tsc で
    // 検査する。tsconfig は build 用と分ける(test を include し composite を外した専用)。
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.typecheck.json',
    },
  },
});
