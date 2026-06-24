// =============================================================================
// pdf-build-worker.mjs — PDF ビルドを隔離プロセスで実行する worker
// =============================================================================
// `@vivliostyle/cli` の `build()` を Express サーバプロセス内で直接呼ぶと、子ブラウザの
// stdio backpressure 等が原因で `build()` が返らずハングする事象がある(同一入力を別プロセスで
// 実行すると毎回成功する)。そこで PDF 生成だけをこの plain ESM worker に隔離し、`build.ts` から
// `child_process` で spawn する。これで in-process ハングを構造的に回避し、親側の timeout で
// 応答が必ず返る(無限スピナー解消)。`server/scripts/generate_template.py` と同じ「裏方スクリプト」
// 配置で、tsc のコンパイル対象外(.mjs)とし dev(tsx)/prod(node) の双方から `node` で直接実行できる。
//
// 契約: `process.argv[2]` = `@vivliostyle/cli` の `build()` へ渡すオプションの JSON 文字列
// (`{ input, output:[{path,format}], size, singleDoc?, executableBrowser?, logLevel }`)。
// 成功で exit 0、失敗は理由を stderr へ出して非 0。出力 PDF が生成されたかも検証する。
import { existsSync } from 'node:fs';

const optsJson = process.argv[2];
if (!optsJson) {
  console.error('usage: node pdf-build-worker.mjs <buildOptionsJson>');
  process.exit(2);
}

let opts;
try {
  opts = JSON.parse(optsJson);
} catch (e) {
  console.error(
    `build オプションの JSON parse に失敗: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(2);
}

try {
  // worker は `server/scripts/` に在るため、bare specifier は `server/node_modules` へ解決される。
  const { build } = await import('@vivliostyle/cli');
  await build(opts);

  // build() が解決しても出力が無いケースを失敗として扱う(親が PDF を read する前に検出する)。
  const outPath = opts?.output?.[0]?.path;
  if (outPath && !existsSync(outPath)) {
    console.error('PDF が生成されませんでした');
    process.exit(1);
  }
  // vivliostyle がブラウザ等で event loop を保持していても、生成完了後は明示終了する。
  process.exit(0);
} catch (e) {
  console.error(String(e?.stack || e));
  process.exit(1);
}
