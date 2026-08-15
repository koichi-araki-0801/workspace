// =============================================================================
// check-comments.mjs — コメント規約の機械検査 (全プロジェクト横断)
// =============================================================================
// 規約 `docs/コメント規約.md` のうち「客観的に機械判定できる項目だけ」を検査する
// (「日本語か」の厳密判定はしない。誤検知を避けるため)。`pnpm run check:comments`
// で実行し、CI 集約 `ci` からも呼ぶ。
//
// 検査項目:
//   - ハード失敗 (exit 1): 非 ASCII を含む `.ps1` の UTF-8 BOM、`.ps1`↔`.bat` 併設
//   - 警告のみ (exit 0): `.ts/.js` 系のファイル先頭装飾ボックスヘッダの有無
//     (移行途中のブロックを避けるため段階導入。移行完了後にハード化する)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 走査対象 — 重量物/生成物/ベンダを除外 ──
// `node_modules` や `.venv-build` 等は自作コードでないため検査しない。
// 装飾ボックスヘッダ警告 (§4) の走査でのみ使う。ハード失敗になる `.ps1` 検査 (§3) は
// `dist`/`out`/`build`/`coverage` も除外せず別走査する (下記 `isPs1SkipDir` 参照)。
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv-build',
  '.venv',
  'ms-playwright',
  'python-wheelhouse',
  '.pnpm-store',
  'dist',
  'coverage',
  'out',
  'build',
]);

// `.ps1` ハード検査 (BOM・`.bat` 併設) 専用の除外。PyInstaller 等が `build/`・`dist/` に
// 生成物を作る構成があり、そこへ将来 `.ps1` が同梱された瞬間に無検査になるのを避けるため、
// `dist`/`out`/`build`/`coverage` は除外しない。除外するのは自作コードでない領域のみ
// (`.venv*` は前方一致で venv バリエーションをまとめて除く)。
const isPs1SkipDir = (name) =>
  name === 'node_modules' ||
  name === '.git' ||
  name.startsWith('.venv') ||
  name === 'ms-playwright' ||
  name === 'python-wheelhouse';

// `.ps1`↔`.bat` 併設の例外: dot-source 専用ライブラリは単体起動しないため `.bat` 不要。
// 正典は `offline/lib/content-key.ts` 相当の運用 (ルート `README.md` のスクリプト節を参照)。
const BAT_PAIRING_EXCEPTIONS = new Set([
  'offline/lib/content-key.ps1',
  'offline/lib/verify.ps1',
  'offline/lib/git-tools.ps1',
  'scripts/lib/build-python-venv.ps1',
]);

// 装飾ボックスヘッダを検査する `.ts/.js` のソート対象ルート (生成物は含めない)。
const BOX_HEADER_ROOTS = [
  'editor/shared/src',
  'editor/server/src',
  'editor/web/src',
  'editor/e2e',
  'pie-chart/src',
  'graph-editor/resources/web/js',
  'pdf-to-svg/resources/web',
  'scripts',
];

const TSJS_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);

// ── 2. ファイル収集 ──
// 装飾ボックスヘッダ警告 (§4) 用。SKIP_DIRS で dist/out/build/coverage も除外する。
function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
}

// `.ps1` ハード検査 (§3) 専用。dist/out/build/coverage を降りる別走査 (`.ps1` だけ収集)。
function walkPs1(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (isPs1SkipDir(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkPs1(full, acc);
    else if (extname(name) === '.ps1') acc.push(full);
  }
}

const allFiles = [];
walk(ROOT, allFiles);
const ps1Files = [];
walkPs1(ROOT, ps1Files);
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

const errors = [];
const warnings = [];

// ── 3. PowerShell 検査 (.ps1: BOM + .bat 併設) ──
for (const f of ps1Files) {
  const r = rel(f);
  const buf = readFileSync(f);

  // 非 ASCII (>0x7f) を含むなら UTF-8 BOM (EF BB BF) 必須。cp932 環境での文字化け回避。
  const hasNonAscii = buf.some((b) => b > 0x7f);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasNonAscii && !hasBom) {
    errors.push(`${r}: 非 ASCII を含む .ps1 に UTF-8 BOM が無い (cp932 文字化け回避のため必須)`);
  }

  // 同名 .bat ランチャの併設 (dot-source ライブラリと Pester テストは例外: どちらも
  // 単体の入口ではなく、前者は dot-source、後者は Invoke-Pester から呼ばれる)。
  // `.bat` 自体は walkPs1 が収集しないため、存在確認は `existsSync` で行う。
  if (!BAT_PAIRING_EXCEPTIONS.has(r) && !r.endsWith('.Tests.ps1')) {
    const bat = `${f.slice(0, -4)}.bat`;
    if (!existsSync(bat)) {
      errors.push(`${r}: 同名 .bat ランチャが無い (.ps1 には .bat を併設する)`);
    }
  }
}

// ── 4. TS/JS のファイル先頭装飾ボックスヘッダ (警告のみ) ──
// 先頭の shebang / triple-slash 指示子 / 'use strict' / coding 行は読み飛ばして判定。
function startsWithBoxHeader(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') {
      i++;
      continue;
    }
    if (t.startsWith('#!') || t.startsWith('///') || t.startsWith("'use ")) {
      i++;
      continue;
    }
    break;
  }
  return lines[i]?.trim().startsWith('// ===') ?? false;
}

const inBoxRoot = (r) => BOX_HEADER_ROOTS.some((root) => r === root || r.startsWith(`${root}/`));

for (const f of allFiles) {
  if (!TSJS_EXT.has(extname(f))) continue;
  const r = rel(f);
  if (!inBoxRoot(r)) continue;
  if (r.endsWith('.d.ts')) continue; // 型宣言のみのファイルは対象外
  const text = readFileSync(f, 'utf8');
  if (/AUTO-GENERATED/.test(text.slice(0, 200))) continue; // 自動生成物は手編集しない
  if (!startsWithBoxHeader(text)) {
    warnings.push(`${r}: ファイル先頭の装飾ボックスヘッダ (// ===) が無い`);
  }
}

// ── 5. 結果出力 ──
for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

console.log(
  `\ncheck-comments: ${errors.length} error(s), ${warnings.length} warning(s) ` +
    `(走査 ${allFiles.length} files)`,
);

process.exit(errors.length > 0 ? 1 : 0);
