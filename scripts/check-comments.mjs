// =============================================================================
// check-comments.mjs — コメント規約の機械検査 (全プロジェクト横断)
// =============================================================================
// 規約 `docs/コメント規約.md` のうち「客観的に機械判定できる項目だけ」を検査する
// (「日本語か」の厳密判定はしない。誤検知を避けるため)。`pnpm run check:comments`
// で実行し、CI 集約 `ci` からも呼ぶ。
//
// 検査項目:
//   - ハード失敗 (exit 1): 非 ASCII を含む `.ps1` の UTF-8 BOM、`.ps1`↔`.bat` 併設、
//     コメント・テスト名・docs 原稿に残るレビュー所見番号 (英字 1 文字 + 番号の識別子)
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
  'vendor',
  'git-tools',
  '.claude-security-run',
  '.code-review-graph',
]);

// セキュリティ監査の作業ディレクトリ (`CLAUDE-SECURITY-<日付>`) は所見番号を主題とする
// 資料の置き場なので、名前の前方一致で除外する (走査対象は自作コードだけ)。
const isSkipDir = (name) => SKIP_DIRS.has(name) || name.startsWith('CLAUDE-SECURITY-');

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
    if (isSkipDir(name)) continue;
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

// ── 5. レビュー所見番号の残存 (ハード失敗) ──
// 規約「過去の経緯を書かない」のうち機械判定できる形 = 監査所見の識別子 (「所見」+
// 番号、英字 F/P/R + 番号、root + 英字番号、run + 番号) を、コメント行・テスト名・docs
// 原稿から締め出す。番号は監査資料 (`CLAUDE-SECURITY-*`) の中でしか意味を持たず、コードを
// 読む人には解決できない参照になるため。ガード段の命名 (英字 G + 番号。`origin_guard.py` /
// `app.py`) は現役の識別子なので対象に含めない。誤検知が出たら allowlist を足すのではなく
// 文面を直す。

// コメント行 (行コメント + ブロックコメント内) と `describe`/`it`/`test` の名前だけを見る。
// コード本体の識別子・テストデータ (ファンドコード等) には掛けない。
const FINDING_ID_CODE = [
  /所見\s*[A-Z]?\d/u,
  /(?<![A-Za-z0-9_])[FPR]\d{1,3}(?![A-Za-z0-9_.])/u,
  /root A\d/u,
  /旧 P\d{3}/u,
  /前回 R\d/u,
  /(?<![A-Za-z0-9_])run \d(?![A-Za-z0-9_])/u,
];
// docs 原稿は mermaid のノード ID (英字 + 番号) やファンクションキー名を含むため、番号単独
// では見ず所見参照の言い回しだけを拾う。
const FINDING_ID_DOCS = [
  /所見\s*[A-Z]?\d/u,
  /旧 P\d{3}/u,
  /前回 R\d/u,
  /(?<![A-Za-z0-9_])[FPR]\d{1,3}\s*(の|と同じ|と同一)\s*(判断|経路|脅威|仕様|主張|実害|再発)/u,
];
const TEST_NAME_RE = /(?<![A-Za-z0-9_.])(?:describe|it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gu;

// 拡張子ごとの行コメント接頭辞とブロックコメントの開閉。ブロック内の行は全部コメント行。
const COMMENT_SYNTAX = {
  ts: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] },
  py: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] },
  ps1: { line: ['#'], block: [['<#', '#>']] },
  sh: { line: ['#'], block: [] },
  sql: { line: ['--'], block: [['/*', '*/']] },
};
const EXT_SYNTAX = {
  '.ts': 'ts', '.tsx': 'ts', '.js': 'ts', '.cjs': 'ts', '.mjs': 'ts', '.vue': 'ts',
  '.py': 'py', '.ps1': 'ps1', '.psm1': 'ps1', '.sh': 'sh', '.sql': 'sql',
};
const isTestFile = (r) => /(\.test\.|\.e2e\.|\.spec\.|\/test_[^/]*\.py$)/.test(r);

// コメント行を列挙する。ブロックコメントは「開始トークンで始まる行から終了トークンを
// 含む行まで」を単位にする (行の途中で始まるブロックは開始行を含めて追う)。
function commentLines(text, syntax) {
  const out = [];
  let open = null; // 現在開いているブロックの終了トークン
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (open) {
      out.push([i + 1, raw]);
      if (t.includes(open)) open = null;
      continue;
    }
    if (syntax.line.some((p) => t.startsWith(p)) || t.startsWith('*')) {
      out.push([i + 1, raw]);
      continue;
    }
    // 行末コメント (`code  # 説明`)。文字列中の `#`/`//` を拾う誤検知は、所見番号の形が
    // 文字列に現れないこと (URL・色コードは英字+数字の並びが違う) で実用上避けられる。
    const trailing = syntax.line
      .map((p) => raw.indexOf(` ${p}`))
      .filter((at) => at >= 0)
      .sort((a, b) => a - b)[0];
    if (trailing !== undefined) {
      out.push([i + 1, raw.slice(trailing)]);
      continue;
    }
    for (const [start, end] of syntax.block) {
      const at = raw.indexOf(start);
      if (at < 0) continue;
      out.push([i + 1, raw]);
      // 同じ行で閉じていなければブロックを開いたまま次行へ
      if (!raw.slice(at + start.length).includes(end)) open = end;
      break;
    }
  }
  return out;
}

function checkFindingIds(r, text, syntaxKey, patterns) {
  const syntax = COMMENT_SYNTAX[syntaxKey];
  for (const [ln, line] of commentLines(text, syntax)) {
    const hit = patterns.find((re) => re.test(line));
    if (hit) errors.push(`${r}:${ln}: コメントにレビュー所見番号が残っている (${hit}) — 現在形の理由へ書き換える`);
  }
  if (isTestFile(r)) {
    let m;
    TEST_NAME_RE.lastIndex = 0;
    while ((m = TEST_NAME_RE.exec(text)) !== null) {
      const hit = patterns.find((re) => re.test(m[2]));
      if (!hit) continue;
      const ln = text.slice(0, m.index).split(/\r?\n/).length;
      errors.push(`${r}:${ln}: テスト名にレビュー所見番号が残っている (${hit}) — 番号を外し内容で名付ける`);
    }
  }
}

for (const f of allFiles) {
  const r = rel(f);
  if (r.startsWith('docs/_samples/')) continue; // PDF 抽出サンプルの生テキスト
  const ext = extname(f);
  const isHusky = r.startsWith('.husky/') && ext === '';
  const key = isHusky ? 'sh' : EXT_SYNTAX[ext];
  if (key) {
    if (r.endsWith('.d.ts')) continue;
    checkFindingIds(r, readFileSync(f, 'utf8'), key, FINDING_ID_CODE);
    continue;
  }
  if (ext === '.md' && /^docs\/[^/]+\/src\//.test(r)) {
    const text = readFileSync(f, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const hit = FINDING_ID_DOCS.find((re) => re.test(line));
      if (hit) errors.push(`${r}:${i + 1}: docs 原稿にレビュー所見番号が残っている (${hit}) — 番号を消し内容で書く`);
    });
  }
}

// ── 6. 結果出力 ──
for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

console.log(
  `\ncheck-comments: ${errors.length} error(s), ${warnings.length} warning(s) ` +
    `(走査 ${allFiles.length} files)`,
);

process.exit(errors.length > 0 ? 1 : 0);
