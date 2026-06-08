// =============================================================================
// cli.ts — コマンドライン入口 (graph/cli.js の TS 移植)
// -----------------------------------------------------------------------------
// 提供コマンド:
//   list                              組み込みサンプル名一覧を表示
//   one --output-file path [...]      1 件だけ SVG を生成
//                                     入力は --sample / --data-file / --data-json /
//                                     --xlsx + --sheet + --range のいずれか
//   batch --output-dir dir [...]      まとめて SVG を生成
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import {
  resolveInputData,
  resolveInputDataAsync,
  samples,
  type ResolveAsyncOpts,
} from "./src/data.js";
import { renderPdfStylePieToSvg } from "./src/svg_export/index.js";

interface ParsedArgs {
  command: string | undefined;
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse JSON file "${filePath}": ${err.message ?? err}`);
  }
}

/**
 * --sample / --data-file / --data-json / --xlsx のうち **1 つだけ** が指定されていることを
 * 検査し、対応する ResolveAsyncOpts variant を組み立てる。0 個や複数指定は明示的に拒否する。
 */
function buildResolveOpts(options: Record<string, string | boolean>): ResolveAsyncOpts {
  const sample = typeof options.sample === "string" ? options.sample : undefined;
  const dataFile = typeof options["data-file"] === "string" ? options["data-file"] : undefined;
  const dataJson = typeof options["data-json"] === "string" ? options["data-json"] : undefined;
  const xlsx = typeof options.xlsx === "string" ? options.xlsx : undefined;
  const provided = [
    sample !== undefined ? "--sample" : null,
    dataFile !== undefined ? "--data-file" : null,
    dataJson !== undefined ? "--data-json" : null,
    xlsx !== undefined ? "--xlsx" : null,
  ].filter((flag): flag is string => flag !== null);
  if (provided.length === 0) {
    throw new Error(
      "Provide one input source: --sample / --data-file / --data-json / --xlsx.",
    );
  }
  if (provided.length > 1) {
    throw new Error(`Conflicting input sources (specify only one): ${provided.join(", ")}.`);
  }
  if (sample !== undefined) return { kind: "sample", sample };
  if (dataFile !== undefined) return { kind: "data", data: readJsonFile(dataFile) as unknown[] };
  if (dataJson !== undefined) return { kind: "dataJson", dataJson };
  // ここに来る時点で xlsx !== undefined が provided.length===1 から確定するが、
  // TS の narrowing では追えないので明示的に再確認する。
  if (xlsx === undefined) {
    throw new Error("internal: input source not resolved");
  }
  const sheet = typeof options.sheet === "string" ? options.sheet : undefined;
  const range = typeof options.range === "string" ? options.range : undefined;
  if (!sheet || !range) {
    throw new Error("--xlsx requires --sheet and --range.");
  }
  return { kind: "xlsx", xlsx, sheet, range };
}

async function renderOne(options: Record<string, string | boolean>): Promise<void> {
  const outputFile = options["output-file"] as string | undefined;
  if (!outputFile) {
    throw new Error("--output-file is required.");
  }
  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });

  const items = await resolveInputDataAsync(buildResolveOpts(options));
  const result = await renderPdfStylePieToSvg(items, {});
  fs.writeFileSync(outputFile, result.svg, "utf-8");
  console.log(path.resolve(outputFile));
}

async function renderBatch(options: Record<string, string | boolean>): Promise<void> {
  const outputDir = options["output-dir"] as string | undefined;
  if (!outputDir) {
    throw new Error("--output-dir is required.");
  }
  fs.mkdirSync(path.resolve(outputDir), { recursive: true });

  if (options["input-dir"]) {
    const inputDir = path.resolve(options["input-dir"] as string);
    const files = fs
      .readdirSync(inputDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const fileName of files) {
      const fullPath = path.join(inputDir, fileName);
      const items = resolveInputData({ data: readJsonFile(fullPath) as unknown[] });
      const outputFile = path.join(
        path.resolve(outputDir),
        `${path.parse(fileName).name}.svg`,
      );
      const result = await renderPdfStylePieToSvg(items, {});
      fs.writeFileSync(outputFile, result.svg, "utf-8");
      console.log(outputFile);
    }
    return;
  }

  const sampleNames = options.samples
    ? (options.samples as string)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : Object.keys(samples);
  for (const sampleName of sampleNames) {
    const outputFile = path.join(path.resolve(outputDir), `${sampleName}.svg`);
    const items = resolveInputData({ sample: sampleName });
    const result = await renderPdfStylePieToSvg(items, {});
    fs.writeFileSync(outputFile, result.svg, "utf-8");
    console.log(outputFile);
  }
}

function listSamples(): void {
  Object.keys(samples).forEach((name) => console.log(name));
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(
      [
        "Usage:",
        "  npm run cli -- list",
        "  npm run cli -- one --sample asset_gbca_pdf_like --output-file out/test.svg",
        "  npm run cli -- one --data-file data/example.json --output-file out/test.svg",
        "  npm run cli -- one --xlsx data.xlsx --sheet Sheet1 --range A2:B11 --output-file out/test.svg",
        "  npm run cli -- batch --output-dir out/svg",
        "  npm run cli -- batch --input-dir data --output-dir out/svg",
      ].join("\n"),
    );
    return;
  }

  if (command === "list") {
    listSamples();
    return;
  }
  if (command === "one") {
    await renderOne(options);
    return;
  }
  if (command === "batch") {
    await renderBatch(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err: any) => {
  console.error(err.message ?? err);
  process.exit(1);
});
