// =============================================================================
// legacyLayoutCheck.ts — 旧い data 構成の残りを起動時に 1 回だけ確かめて警告する
// =============================================================================
// フォントは `<cssDir>/fonts`、js は `jsDir` に置く構成で、旧構成の `<dataRoot>/assets` や CSS の
// `url(../fonts/…)` が残っていると、PDF のフォントと JS が黙って欠けたまま成功扱いになる。
// 起動は止めない — 片付けはフォント移設パッチ(`editor/patches/2026-10-fonts-to-css/`)の役目で、
// 止めるとパッチを流す前の確認や生成を使わない運用まで止まる。警告で運用者に気づかせる。
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** 警告の出力先(既定はサーバのロガー。テストで差し替える)。 */
interface LegacyLayoutLog {
  warn(msg: string): void;
}

/** 旧構成の残り。 */
interface LegacyLayoutFindings {
  /** 残っている `<dataRoot>/assets`(ディレクトリでなければ null)。 */
  assetsDir: string | null;
  /** `url(../fonts/` を含む cssDir 直下の CSS のファイル名(名前順)。 */
  cssFiles: string[];
}

/**
 * `url(` の直後の旧いフォント参照。フォント移設パッチ(`migrate.ps1` の `$rewriteRe`)が書き換える
 * 形と同じにする(`../../fonts/` のような別の相対参照は対象外)。
 */
export const LEGACY_FONT_URL_RE = /url\(\s*["']?\.\.\/fonts\//i;

const PATCH_HINT = 'フォント移設パッチ editor/patches/2026-10-fonts-to-css/ を流してください';
/** 警告に並べる CSS の件数の上限(多数あっても 1 行に収める)。 */
const MAX_LISTED = 5;

/** 旧構成の残りを調べる。置き場が無い・読めないものは「残っていない」として扱う。 */
export async function findLegacyLayout(opts: {
  dataRoot: string;
  cssDir: string;
}): Promise<LegacyLayoutFindings> {
  const assets = path.join(opts.dataRoot, 'assets');
  const assetsDir = await fs.stat(assets).then(
    (s) => (s.isDirectory() ? assets : null),
    () => null,
  );
  // 見るのは cssDir 直下だけ(パッチが書き換えるのも直下の確定 CSS)。
  const entries = await fs.readdir(opts.cssDir, { withFileTypes: true }).catch(() => null);
  const cssFiles: string[] = [];
  for (const e of entries ?? []) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.css')) continue;
    const text = await fs.readFile(path.join(opts.cssDir, e.name), 'utf8').catch(() => '');
    if (LEGACY_FONT_URL_RE.test(text)) cssFiles.push(e.name);
  }
  cssFiles.sort();
  return { assetsDir, cssFiles };
}

/**
 * 旧構成の残りを確かめて警告する。reject しない — 呼び出し側は待たずに投げるため、ここで例外を
 * 漏らすと unhandled rejection でプロセスが落ちる。
 */
export async function warnLegacyLayoutAtStartup(
  log: LegacyLayoutLog = logger,
  opts: { dataRoot: string; cssDir: string } = {
    dataRoot: config.dataRoot,
    cssDir: config.cssDir,
  },
): Promise<void> {
  try {
    const found = await findLegacyLayout(opts);
    if (found.assetsDir !== null) {
      log.warn(
        `[layout] 旧構成の ${found.assetsDir} が残っています。フォントは <cssDir>/fonts、js は ` +
          `jsDir へ移す構成のため、このままでは PDF のフォントと JS が欠けます — ${PATCH_HINT}`,
      );
    }
    if (found.cssFiles.length > 0) {
      const listed = found.cssFiles.slice(0, MAX_LISTED).join(', ');
      const rest = found.cssFiles.length - MAX_LISTED;
      log.warn(
        `[layout] ${opts.cssDir} の CSS に url(../fonts/ が残っています(${listed}` +
          `${rest > 0 ? ` ほか ${rest} 件` : ''})。新構成では url(fonts/…) と書きます — ${PATCH_HINT}`,
      );
    }
  } catch (err) {
    const msg = `[layout] 旧構成の確認に失敗しました: ${
      err instanceof Error ? err.message : String(err)
    }`;
    // 失敗も渡された出力先へ出す。出力先そのものが投げた場合だけサーバのロガーへ逃がす。
    try {
      log.warn(msg);
    } catch {
      logger.warn(msg);
    }
  }
}
