// =============================================================================
// clean.mjs — ルート直下に溜まる再生成物・キャッシュの掃除コマンド
// =============================================================================
// ビルド/テスト/オフライン構築のたびに増える「再生成可能な生成物」がルートを埋めて
// 見通しを悪くするため、それらを片付ける。`pnpm run clean` (light) /
// `pnpm run clean:deep` / `pnpm run clean:bundles` から起動する。
//
// 安全設計:
//   - 既定はドライラン (消す対象と容量を表示するだけ)。実削除は `--yes` を付けたときのみ。
//   - `git clean -Xd` のような「ignore 全消し」はしない。巻き込み事故 (`editor/data` の
//     テンプレ実体・`git-tools` の同梱バイナリ・大容量バンドル) を避けるため、対象は
//     下のキュレーション済みリストに限定する。
//   - 何を消し何を残したかを必ず出力する (silent に絞ったように見せない)。
//
// 関連: 置き場/コマンド一覧は `README.md`、再生成物の正典は `.gitignore`。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 絶対に触れない領域 ──
// 走査で降りず、削除候補にも絶対に入れない。`.git` は履歴、`editor/data` はテンプレ実体
// (ワークスペース外 dataRoot の git 管理対象)、`git-tools` と `native-prebuilds` は
// 同梱バイナリ (git 管理外の重量物。再配布・再取得が要る)。
// 照合は**小文字へ畳んでから** (`isNever*`): Windows のファイルシステムは大文字小文字を
// 保持するだけで区別せず、ネットワークドライブ経由では `Data` のような別ケーシングが
// 返ることがある。厳密一致だと除外が外れて `--yes` がテンプレ実体を消しうる。
const NEVER = new Set(['.git', '.claude', '.github', '.husky', '.vscode']);
const NEVER_REL = new Set([rel('editor/data'), rel('git-tools'), rel('native-prebuilds')]);
const isNeverName = (name) => NEVER.has(name.toLowerCase());
const isNeverRel = (r) => NEVER_REL.has(r.toLowerCase());

// ── 2. ティア別の固定削除リスト ──
// light: 再生成が軽い生成物。`pnpm run build` / `test` ですぐ戻る。
const LIGHT_DIRS = [
  'out',
  '.tmp',
  'coverage',
  'test-results',
  'playwright-report',
  'editor/web/dist',
  'editor/server/dist',
  'pie-chart/dist',
  'graph-editor/dist',
];
// light の glob 系 (ディレクトリ名 / 拡張子で走査ヒット)。`.pyc` 単体は拾わない
// (ソースの bytecode は `__pycache__` 単位で消え、それ以外は exe build 配下のため
// `build/` をまるごと扱う deep に委ねる)。
const LIGHT_DIR_NAMES = new Set(['.vite', '__pycache__']);
const LIGHT_FILE_EXTS = new Set(['.tsbuildinfo']);

// deep: 再生成が重い/オフライン依存。`pnpm install` (オフライン機は
// `offline/setup-offline-local`) や exe 再ビルド・venv 再構築が要る。
const DEEP_DIRS = [
  '.pnpm-store',
  'ms-playwright',
  'python-wheelhouse',
  'pie-chart/dist-exe',
  'pdf-to-svg/dist',
  'pdf-to-svg/build',
  'graph-editor/build',
];
// deep ではネストした `node_modules` / Python venv も「まるごと」対象 (走査で収集)。
// これらは中身を個別に消さない (例: venv 内の `__pycache__` は無意味なノイズ)。
const DEEP_WHOLE_DIR_NAMES = new Set(['node_modules', '.venv-build', '.venv']);

// bundles: 大容量の配布物・ステージング。`offline/publish-offline-bundle.ps1`
// (content key 差分時に再生成) や再取得で戻せる。既定では消さない。
const BUNDLE_FILES = [
  'offline-deps-bundle.tar.gz',
  'offline-deps-bundle.tar.gz.sha256',
  'pnpm.tgz',
  'bundle.key',
];

// 容量計算をスキップする大容量ディレクトリ (du が遅いだけで意味が薄いため `(大容量)` 表示)。
const HEAVY = new Set([
  'node_modules',
  '.pnpm-store',
  'ms-playwright',
  'python-wheelhouse',
  '.venv-build',
  '.venv',
]);

// ── 3. 引数解釈 ──
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const wantDeep = has('--deep') || has('--all');
const wantBundles = has('--bundles') || has('--all');
const apply = has('--yes') || has('-y');

if (has('--help') || has('-h')) {
  console.log(`clean.mjs — ルート直下の再生成物を掃除する (既定はドライラン)

  pnpm run clean            light: out/.tmp/coverage/test-results/各 dist 等
  pnpm run clean:deep       light + node_modules/.pnpm-store/ms-playwright 等
  pnpm run clean:bundles    light + 大容量バンドル (tar.gz/pnpm.tgz/bundle.key)
  ... -- --all              deep + bundles をまとめて
  ... -- --yes              実削除 (付けない限り消さない)
`);
  process.exit(0);
}

// ── 4. 削除候補の収集 ──
// 固定リスト + 走査 glob を集め、NEVER 系を除外し、存在するものだけ残す。
const targets = new Map(); // rel path -> reason ラベル

function add(absPath, reason) {
  const r = rel(absPath);
  if (isNeverRel(r)) return;
  if (!existsSync(absPath)) return;
  if (!targets.has(r)) targets.set(r, reason);
}

for (const d of LIGHT_DIRS) add(join(ROOT, d), 'light');
if (wantDeep) for (const d of DEEP_DIRS) add(join(ROOT, d), 'deep');
if (wantBundles) for (const f of BUNDLE_FILES) add(join(ROOT, f), 'bundle');

// 走査 1 回で light の glob と (deep 時) `node_modules` を集める。マッチしたディレクトリ
// には降りない (中の `.vite` 等を二重計上しないため)。
walk(ROOT);

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (isNeverName(e.name) || isNeverRel(rel(full))) continue;
    if (e.isDirectory()) {
      if (DEEP_WHOLE_DIR_NAMES.has(e.name)) {
        if (wantDeep) add(full, 'deep');
        continue; // まるごと対象。配下は走査しない (venv 内 __pycache__ 等を拾わない)
      }
      if (LIGHT_DIR_NAMES.has(e.name)) {
        add(full, 'light');
        continue;
      }
      if (targets.has(rel(full))) continue; // 既に丸ごと対象 (dist/coverage/build 等)。降りない
      if (HEAVY.has(e.name)) continue; // 固定リストで拾い済み。降りない
      walk(full);
    } else if (LIGHT_FILE_EXTS.has(extOf(e.name))) {
      add(full, 'light');
    }
  }
}

// ── 5. 出力と削除 ──
if (targets.size === 0) {
  console.log('掃除対象は見つかりませんでした (既にクリーンです)。');
  process.exit(0);
}

const rows = [...targets.entries()]
  .map(([r, reason]) => ({ r, reason, bytes: sizeOf(join(ROOT, r)) }))
  // 容量降順。大容量 (bytes < 0 = du 省略) は実際は最大なので先頭へ。
  .sort((a, b) => (b.bytes < 0 ? Infinity : b.bytes) - (a.bytes < 0 ? Infinity : a.bytes));

const total = rows.reduce((s, x) => s + Math.max(0, x.bytes), 0);
const mode = apply ? '削除します' : 'ドライラン (消しません)';
console.log(`掃除対象 ${rows.length} 件 / 計 ${fmt(total)} — ${mode}\n`);
for (const { r, reason, bytes } of rows) {
  console.log(`  [${reason.padEnd(6)}] ${fmt(bytes).padStart(9)}  ${r}`);
}

if (!apply) {
  console.log('\n実際に削除するには `--yes` を付けて再実行してください。');
  if (!wantDeep) console.log('node_modules 等も消すなら `pnpm run clean:deep`。');
  if (!wantBundles) console.log('大容量バンドルも消すなら `pnpm run clean:bundles`。');
  process.exit(0);
}

if (wantDeep) {
  console.log('\n⚠ deep: 次回 `pnpm install` (オフライン機は offline/setup-offline-local) が必要です。');
}
for (const { r } of rows) {
  rmSync(join(ROOT, r), { recursive: true, force: true });
  console.log(`  削除: ${r}`);
}
console.log(`\n完了。${fmt(total)} を解放しました。`);

// ── 6. ユーティリティ ──
function rel(absPath) {
  return relative(ROOT, absPath).split('\\').join('/');
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i);
}

// 容量。大容量ディレクトリは du を回さず -1 (表示は `(大容量)`)。空ディレクトリの 0 と区別する。
function sizeOf(absPath) {
  const base = absPath.split(/[\\/]/).pop();
  if (HEAVY.has(base)) return -1;
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  let kids;
  try {
    kids = readdirSync(absPath, { withFileTypes: true });
  } catch {
    return sum;
  }
  for (const k of kids) sum += sizeOf(join(absPath, k.name));
  return sum;
}

function fmt(bytes) {
  if (bytes < 0) return '(大容量)';
  if (bytes === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
