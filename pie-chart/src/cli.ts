// =============================================================================
// cli.ts — コマンドライン入口
// -----------------------------------------------------------------------------
// 提供コマンド:
//   list                              組み込みサンプル名一覧を表示
//   one --output-file path [...]      1 件だけ SVG を生成
//                                     入力は --sample / --data-file / --data-json /
//                                     --xlsx + --sheet + --range /
//                                     --fund + --base-date + --chart-type(ストアド)のいずれか
//   batch --output-dir dir [...]      まとめて SVG を生成
//   db-check [--db-name db]           DB ドライバを読み込めるか(と接続できるか)を確かめる
//   license                           埋め込みフォントの OFL 本文を表示
//   __db-fetch                        内部用。exe が DB 取得のために自分自身を子プロセスで起動する
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DbStageError, InterruptedError } from './input/dbStage.js';
import {
  normalizeInputItems,
  resolveInputData,
  resolveInputDataAsync,
  samples,
  type ResolveAsyncOpts,
} from './input/load.js';
import {
  buildSavedJson,
  defaultSavedJsonPath,
  extractDataItems,
  writeSavedJson,
} from './input/savedJson.js';
import { fetchSprocItems, formatDbCheckLine, runDbCheck } from './input/sproc.js';
import { hasSprocArgs, normalizeSprocArgs, type RawSprocArgs } from './input/sprocArgs.js';
import { MAX_JSON_BYTES } from './limits.js';
import { runDbChild } from './runtime/dbChild.js';
import { runDirParent, sweepStaleRunDirs } from './runtime/nativeDriver.js';
import { installSeaGuards, isSea, readSeaAsset } from './runtime/seaRuntime.js';
import { renderPdfStylePieToSvg } from './svg_export/pipeline.js';
import type { Item, PieLayoutConfig } from './types.js';
import { assertFontWeight } from './svg_export/values.js';

interface ParsedArgs {
  command: string | undefined;
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

/** `one` / `batch` 共通の描画フラグ。 */
const RENDER_FLAGS = ['font-weight', 'stroke-ratio'] as const;

/**
 * コマンドごとに受け付けるフラグの一覧。綴り違い(`--out-file` / `--datajson` 等)は
 * `parseArgs` が黙って未使用の option として捨てるため、指定したつもりの設定が効かないまま
 * SVG が書かれる。既定へ落ちたことを利用者へ見せるための警告表であって、実行は止めない
 * (止めると将来のフラグ追加が古い呼び出しスクリプトを壊す)。
 */
const KNOWN_FLAGS: Record<string, readonly string[]> = {
  one: [
    'output-file',
    'sample',
    'data-file',
    'data-json',
    'xlsx',
    'sheet',
    'range',
    'fund',
    'base-date',
    'chart-type',
    'save-json',
    'db-server',
    'db-name',
    ...RENDER_FLAGS,
  ],
  batch: ['output-dir', 'input-dir', 'samples', ...RENDER_FLAGS],
  'db-check': ['db-server', 'db-name'],
  list: [],
  license: [],
};

/** 認識できないフラグを stderr へ警告する(コマンド未知の場合は表が無いので何もしない)。 */
function warnUnknownFlags(command: string, options: Record<string, string | boolean>): void {
  const known = KNOWN_FLAGS[command];
  if (known === undefined) return;
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  console.warn(
    `[pie-chart] ${command} が知らないフラグを無視しました: ${unknown.map((k) => `--${k}`).join(', ')}` +
      `${known.length > 0 ? ` (使えるのは ${known.map((k) => `--${k}`).join(' / ')})` : ''}`,
  );
}

/**
 * 描画オーバーライドを CLI フラグから組み立てる。
 *   --font-weight <400|700>  … ウェイト切替 (config が対応フォントを自動選択)
 *   --stroke-ratio <num>     … faux-bold の stroke 量 (font-size 比, 0=無効)
 */
function buildRenderOverrides(options: Record<string, string | boolean>): Partial<PieLayoutConfig> {
  const overrides: Partial<PieLayoutConfig> = {};
  const fw = options['font-weight'];
  // 隣の `--stroke-ratio` が形式を検査しているのに、ここだけ `typeof` で素通ししていた。
  // 入口と出口(`assertConfigValues`)の両方で検証する — 入口だけだと別の入口が生えたときに
  // 漏れ、出口だけだとエラーが「SVG を書く瞬間」に出て原因が遠い。
  if (typeof fw === 'string') overrides.fontWeight = assertFontWeight('--font-weight', fw);
  const sr = options['stroke-ratio'];
  if (typeof sr === 'string') {
    const ratio = Number(sr);
    if (!Number.isFinite(ratio) || ratio < 0) {
      throw new Error(`--stroke-ratio must be a non-negative number (got "${sr}").`);
    }
    overrides.textWeightStrokeRatio = ratio;
  }
  return overrides;
}

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // xlsx / dataJson と同じ funnel 思想: JSON.parse の前に byte 長を見る
  // (`--data-file` はファイルなので `.length`(文字数)でなく実際の byte 数を見る)。
  const byteLength = Buffer.byteLength(raw, 'utf-8');
  if (byteLength > MAX_JSON_BYTES) {
    throw new Error(
      `--data-file "${filePath}" is ${byteLength} bytes (limit ${MAX_JSON_BYTES}). ` +
        'Raise the limit with PIE_MAX_JSON_BYTES=<n> if this input is expected.',
    );
  }
  // PowerShell 5.1 の `Out-File -Encoding utf8` / `Set-Content -Encoding utf8` は先頭に BOM を
  // 書き、`JSON.parse` は BOM を不正な先頭文字として拒否する。
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`Failed to parse JSON file "${filePath}": ${err.message ?? err}`);
  }
}

/** ストアド入力。取得結果を JSON へ残すため、`ResolveAsyncOpts` とは別の経路で扱う。 */
interface SprocInput {
  kind: 'sproc';
  raw: RawSprocArgs;
  server?: string;
  database?: string;
}

type OneInput = ResolveAsyncOpts | SprocInput;

function optionString(options: Record<string, string | boolean>, key: string): string | undefined {
  return typeof options[key] === 'string' ? (options[key] as string) : undefined;
}

/**
 * --sample / --data-file / --data-json / --xlsx / ストアド(--fund ほか)のうち **1 つだけ** が
 * 指定されていることを検査し、対応する入力 variant を組み立てる。0 個や複数指定は明示的に拒否する。
 */
function buildResolveOpts(options: Record<string, string | boolean>): OneInput {
  const sample = typeof options.sample === 'string' ? options.sample : undefined;
  const dataFile = typeof options['data-file'] === 'string' ? options['data-file'] : undefined;
  const dataJson = typeof options['data-json'] === 'string' ? options['data-json'] : undefined;
  const xlsx = typeof options.xlsx === 'string' ? options.xlsx : undefined;
  const sprocRaw: RawSprocArgs = {
    fund: optionString(options, 'fund'),
    baseDate: optionString(options, 'base-date'),
    chartType: optionString(options, 'chart-type'),
  };
  const provided = [
    sample !== undefined ? '--sample' : null,
    dataFile !== undefined ? '--data-file' : null,
    dataJson !== undefined ? '--data-json' : null,
    xlsx !== undefined ? '--xlsx' : null,
    hasSprocArgs(sprocRaw) ? '--fund / --base-date / --chart-type' : null,
  ].filter((flag): flag is string => flag !== null);
  if (provided.length === 0) {
    throw new Error(
      'Provide one input source: --sample / --data-file / --data-json / --xlsx / --fund + --base-date + --chart-type.',
    );
  }
  if (provided.length > 1) {
    throw new Error(`Conflicting input sources (specify only one): ${provided.join(', ')}.`);
  }
  if (sample !== undefined) return { kind: 'sample', sample };
  if (dataFile !== undefined) {
    return {
      kind: 'data',
      data: extractDataItems(readJsonFile(dataFile), `--data-file "${dataFile}"`),
    };
  }
  if (dataJson !== undefined) return { kind: 'dataJson', dataJson };
  if (hasSprocArgs(sprocRaw)) {
    return {
      kind: 'sproc',
      raw: sprocRaw,
      server: optionString(options, 'db-server'),
      database: optionString(options, 'db-name'),
    };
  }
  // ここに来る時点で xlsx !== undefined が provided.length===1 から確定するが、
  // TS の narrowing では追えないので明示的に再確認する。
  if (xlsx === undefined) {
    throw new Error('internal: input source not resolved');
  }
  const sheet = typeof options.sheet === 'string' ? options.sheet : undefined;
  const range = typeof options.range === 'string' ? options.range : undefined;
  if (!sheet || !range) {
    throw new Error('--xlsx requires --sheet and --range.');
  }
  return { kind: 'xlsx', xlsx, sheet, range };
}

async function renderOne(options: Record<string, string | boolean>): Promise<void> {
  const outputFile = options['output-file'] as string | undefined;
  if (!outputFile) {
    throw new Error('--output-file is required.');
  }
  const input = buildResolveOpts(options);
  const saveJson = optionString(options, 'save-json');
  if (input.kind !== 'sproc' && options['save-json'] !== undefined) {
    throw new Error('--save-json is only for the stored procedure input (--fund ...).');
  }
  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });

  let items: Item[];
  if (input.kind === 'sproc') {
    const args = normalizeSprocArgs(input.raw);
    const jsonFile = saveJson ?? defaultSavedJsonPath(outputFile);
    const fetched = await fetchSprocItems(args, { server: input.server, database: input.database });
    items = normalizeInputItems(fetched.items);
    // 描画より前に書く。描画で失敗しても(項目数の上限など)、取得したデータは残る。
    writeSavedJson(jsonFile, buildSavedJson(args, items, fetched, new Date()));
    console.log(path.resolve(jsonFile));
  } else {
    items = await resolveInputDataAsync(input);
  }
  const result = await renderPdfStylePieToSvg(items, buildRenderOverrides(options));
  fs.writeFileSync(outputFile, result.svg, 'utf-8');
  console.log(path.resolve(outputFile));
}

async function renderBatch(options: Record<string, string | boolean>): Promise<void> {
  const outputDir = options['output-dir'] as string | undefined;
  if (!outputDir) {
    throw new Error('--output-dir is required.');
  }
  fs.mkdirSync(path.resolve(outputDir), { recursive: true });

  const overrides = buildRenderOverrides(options);

  if (options['input-dir']) {
    const inputDir = path.resolve(options['input-dir'] as string);
    const files = fs
      .readdirSync(inputDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const fileName of files) {
      const fullPath = path.join(inputDir, fileName);
      const items = resolveInputData({ data: extractDataItems(readJsonFile(fullPath), fullPath) });
      const outputFile = path.join(path.resolve(outputDir), `${path.parse(fileName).name}.svg`);
      const result = await renderPdfStylePieToSvg(items, overrides);
      fs.writeFileSync(outputFile, result.svg, 'utf-8');
      console.log(outputFile);
    }
    return;
  }

  const sampleNames = options.samples
    ? (options.samples as string)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : Object.keys(samples);
  for (const sampleName of sampleNames) {
    const outputFile = path.join(path.resolve(outputDir), `${sampleName}.svg`);
    const items = resolveInputData({ sample: sampleName });
    const result = await renderPdfStylePieToSvg(items, overrides);
    fs.writeFileSync(outputFile, result.svg, 'utf-8');
    console.log(outputFile);
  }
}

function listSamples(): void {
  Object.keys(samples).forEach((name) => console.log(name));
}

/**
 * 埋め込みフォント(BIZ UDPGothic)の OFL 本文を出す。exe には woff2 を埋め込むので、
 * 配布物が exe 単体だけになっても再配布条件を満たせる経路をコードに持たせておく。
 * SEA では埋込アセットから、dev ではリポジトリの `fonts/` から読む。
 */
function printFontLicense(): void {
  if (isSea()) {
    console.log(readSeaAsset('OFL-BIZUDPGothic.txt').toString('utf8'));
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  console.log(fs.readFileSync(path.resolve(here, '..', 'fonts', 'OFL-BIZUDPGothic.txt'), 'utf8'));
}

async function dbCheck(options: Record<string, string | boolean>): Promise<void> {
  const database = optionString(options, 'db-name');
  const { ok, lines } = await runDbCheck({
    connect: database !== undefined,
    conn: { server: optionString(options, 'db-server'), database },
  });
  for (const line of lines) console.log(formatDbCheckLine(line));
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  // SEA(単一 exe)実行時の外部モジュール解決を封鎖する。引数パースより前に張ることで、
  // どの経路を通っても exe 隣・上位ディレクトリの `node_modules` を見に行かせない
  // (`runtime/seaRuntime.ts`)。dev では no-op。
  installSeaGuards();
  const { command, options } = parseArgs(process.argv.slice(2));
  // 強制終了などで残った実行ごとのフォルダを消す(作ったプロセスが既にいないものだけ)。
  // 子プロセス自身は親のフォルダを使っている最中なので掃除しない。
  if (isSea() && command !== '__db-fetch') {
    sweepStaleRunDirs(runDirParent());
  }
  if (command === '__db-fetch') {
    process.exitCode = await runDbChild();
    return;
  }
  if (!command || command === 'help' || command === '--help') {
    console.log(
      [
        'Usage:',
        '  npm run cli -- list',
        '  npm run cli -- one --sample asset_gbca_pdf_like --output-file out/test.svg',
        '  npm run cli -- one --data-file data/example.json --output-file out/test.svg',
        '  npm run cli -- one --xlsx data.xlsx --sheet Sheet1 --range A2:B11 --output-file out/test.svg',
        '  npm run cli -- batch --output-dir out/svg',
        '  npm run cli -- batch --input-dir data --output-dir out/svg',
        '  npm run cli -- license',
        '  npm run cli -- one --fund 0331A --base-date 2026-09-30 --chart-type 資産配分 --db-name usrap --output-file out/test.svg',
        '  npm run cli -- db-check --db-name usrap',
        '',
        'DB (SQL Server) input (one):',
        '  --fund <code>            ファンドコード',
        '  --base-date <date>       基準日 (YYYY-MM-DD か YYYYMMDD)',
        '  --chart-type <type>      グラフ種別',
        '                           ストアド (既定 dbo.pie_chart_items、env PIE_DB_PROC) を',
        '                           Windows 統合認証で呼ぶ。3 つそろえて指定する',
        '  --save-json <path>       取得結果の保存先 (既定は --output-file の拡張子を .json にしたもの)',
        '  --db-server <host>       接続先サーバ (既定 env DB_SERVER / localhost)',
        '  --db-name <database>     データベース名 (既定 env DB_NAME)',
        '',
        'Font options (one / batch):',
        '  --font-weight <400|700>  ウェイト切替 (既定 400。対応フォントを自動選択)',
        '  --stroke-ratio <num>     faux-bold の stroke 量 (font-size 比, 既定 0=無効。0.015≈擬似500)',
      ].join('\n'),
    );
    return;
  }

  // `--sql` は廃止した。未知のフラグとして警告するだけだと「入力が無い」という別のエラーに
  // なり、何を使えばよいかが伝わらないので、代わりの指定を案内して止める。
  if (command === 'one' && options.sql !== undefined) {
    throw new Error(
      '--sql was removed. Use the stored procedure input: --fund <code> --base-date <date> ' +
        '--chart-type <type>.',
    );
  }
  warnUnknownFlags(command, options);

  if (command === 'list') {
    listSamples();
    return;
  }
  if (command === 'license') {
    printFontLicense();
    return;
  }
  if (command === 'db-check') {
    await dbCheck(options);
    return;
  }
  if (command === 'one') {
    await renderOne(options);
    return;
  }
  if (command === 'batch') {
    await renderBatch(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err: unknown) => {
  if (err instanceof InterruptedError) {
    console.error('[pie-chart] interrupted.');
    process.exit(130);
  }
  if (err instanceof DbStageError) {
    console.error(`[db:${err.stage}] ${err.message}`);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
