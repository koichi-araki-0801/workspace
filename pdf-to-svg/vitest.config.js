/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// PdfToSvg は本体が Python (pytest) で、JS はフロントの純粋ヘルパのみ。ルート集約
// (`workspace/vitest.config.ts` の projects) には含めず、この最小設定で単独実行する。
// 設定が無いと vitest が上位のルート設定へ登り projects 解決に失敗するため必須。
export default defineConfig({
  test: {
    name: "pdf-to-svg",
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
