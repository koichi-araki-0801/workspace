// =============================================================================
// build.ts — `@vivliostyle/cli` で PDF をビルドする(inline / project)
// =============================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { sharedInlineConfig } from './options.js';

/** inline(レンダリング済み HTML + 任意の CSS)ビルド入力。 */
export interface BuildInlineInput {
  html: string;
  css?: string;
  /** vivliostyle へ渡すページサイズ(既定 'A4')。 */
  size?: string;
  /** 入力を単一ドキュメントとして扱う(ファイル単位のページ分割をしない)。 */
  singleDoc?: boolean;
}

/**
 * レンダリング済み HTML(+ 任意の CSS)から `@vivliostyle/cli` で PDF を生成する。
 * CSS は vivliostyle へ渡す前に HTML へインライン展開する。
 *
 * `{html, css}` のみ(size は 'A4' 既定)の場合、旧 `htmlToPdf` 呼び出しをバイト単位で
 * 再現する。inline 経路はそのドロップイン置換である。
 */
export async function buildInlinePdf(input: BuildInlineInput): Promise<Buffer> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const htmlPath = path.join(config.tmpDir, `doc-${stamp}.html`);
  const pdfPath = path.join(config.tmpDir, `doc-${stamp}.pdf`);

  const doc = inlineCss(input.html, input.css ?? '');
  await fs.writeFile(htmlPath, doc, 'utf8');

  try {
    const { build } = await import('@vivliostyle/cli');
    await build({
      input: htmlPath,
      output: [{ path: pdfPath, format: 'pdf' }],
      size: input.size ?? 'A4',
      ...(input.singleDoc ? { singleDoc: true } : {}),
      ...sharedInlineConfig(),
    } as Parameters<typeof build>[0]);

    return await fs.readFile(pdfPath);
  } finally {
    await Promise.allSettled([fs.rm(htmlPath, { force: true }), fs.rm(pdfPath, { force: true })]);
  }
}

/** project(展開済みディレクトリ)ビルド入力。`projectInput.ts` を見よ。 */
export interface BuildProjectInput {
  /** 展開済み vivliostyle プロジェクトを格納するディレクトリ。 */
  dir: string;
  /** `vivliostyle.config.*` のパス(存在すれば優先エントリ)。 */
  configPath?: string;
  /** config が無い場合に使う相対エントリファイル。 */
  entry?: string;
  size?: string;
  singleDoc?: boolean;
}

/**
 * 展開済み vivliostyle プロジェクトディレクトリから PDF をビルドする。プロジェクトの
 * `vivliostyle.config.*` があればそれを、無ければ単一エントリファイルを使う。
 */
export async function buildProjectPdf(input: BuildProjectInput): Promise<Buffer> {
  const pdfPath = path.join(input.dir, `__out-${Date.now()}.pdf`);

  try {
    const { build } = await import('@vivliostyle/cli');
    // どちらの場合も `cwd` を設定し、vivliostyle がエントリをサーバの作業ディレクトリ
    // ではなく展開済みプロジェクトディレクトリ基準で解決するようにする。
    const entry = input.configPath
      ? { config: input.configPath, cwd: input.dir }
      : { cwd: input.dir, input: input.entry };
    await build({
      ...entry,
      output: [{ path: pdfPath, format: 'pdf' }],
      ...(input.size ? { size: input.size } : {}),
      ...(input.singleDoc ? { singleDoc: true } : {}),
      ...sharedInlineConfig(),
    } as Parameters<typeof build>[0]);

    return await fs.readFile(pdfPath);
  } finally {
    await fs.rm(pdfPath, { force: true });
  }
}

/**
 * inline(HTML + CSS)ドキュメントをライブプレビュー用に新規 temp ディレクトリへ書き出す。
 * `buildInlinePdf` と異なりファイルは残し続ける必要がある(プレビューサーバがライブ配信する)
 * ため、返したディレクトリのクリーンアップは呼び出し側の責務とする。
 */
export async function prepareInlineDoc(
  input: BuildInlineInput,
): Promise<{ dir: string; entry: string }> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dir = path.join(config.tmpDir, `vivlio-prev-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  const entry = path.join(dir, 'index.html');
  await fs.writeFile(entry, inlineCss(input.html, input.css ?? ''), 'utf8');
  return { dir, entry };
}

/** CSS 文字列を HTML ドキュメントへインライン展開する(head / body / 完全ラッパ)。 */
function inlineCss(html: string, css: string): string {
  if (!css) return html;
  const styleTag = `<style>\n${css}\n</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styleTag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${html}</body></html>`;
}
