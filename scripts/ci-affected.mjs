// =============================================================================
// ci-affected.mjs — 変更領域だけ CI を走らせる affected ランナー
// =============================================================================
// `git diff` で変更ファイルを領域(editor / pie-chart / graph-editor)へマッピングし、
// 触れた領域の CI ステージだけ実行する。`pnpm run ci:affected` で起動し、`.husky/pre-push`
// から呼ばれる。フル `ci`(coverage 閾値ゲート込み)は手動 `pnpm run ci` と GitHub Actions が
// 担うため、ここでは速度優先で coverage 無しのテストのみ走らせる。
//
// なぜ affected か: 常設ブランチは重量物含め広大で、pie-chart の 1 ファイル変更でも従来は
// editor の build/e2e まで毎回フル実行され push が遅かった。push 前段で「触った領域」へ絞る。
//
// 安全側の判断:
//   - 領域に紐付かないルート直下の共有変更(package.json / lockfile / 各種 config)を検出したら
//     フル `ci` にフォールバックする(影響範囲が読めないため取りこぼさない)。
//   - 何が走り何をスキップしたかを冒頭に出力する(silent に絞ったように見せない)。

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 領域定義 — トップレベルディレクトリ単位 ──
// editor(shared+server+web)は密結合のため 1 領域。各領域の CI ステージを順に並べる。
// `pnpm run <script>` をそのまま呼ぶので、定義の正典はルート `package.json` の scripts 側。
const AREAS = {
  editor: {
    label: 'editor (shared+server+web)',
    match: (p) => p.startsWith('editor/'),
    stages: ['typecheck:editor', 'test:editor', 'build:editor', 'e2e:editor'],
  },
  'pie-chart': {
    label: 'pie-chart',
    match: (p) => p.startsWith('pie-chart/'),
    stages: ['typecheck:pie-chart', 'test:pie-chart'],
  },
  'graph-editor': {
    label: 'graph-editor',
    match: (p) => p.startsWith('graph-editor/'),
    // pytest を含めるのは、ローカルサーバの Origin/Host 検査(CSRF・DNS リバインディング対策)を
    // 守るテストが Python 側にしか無いため。vitest だけでは検査の退行を検出できない。
    stages: ['typecheck:graph-editor', 'test:graph-editor', 'test:graph-editor:py'],
  },
  'pdf-to-svg': {
    label: 'pdf-to-svg',
    match: (p) => p.startsWith('pdf-to-svg/'),
    stages: ['test:pdf-to-svg'],
  },
};

// 領域 CI を持たない無害ディレクトリ。これらだけの変更なら共有ゲート(comments/biome)のみで足りる。
// (`docs`/`offline` は配布物、`scripts`/`.github`/`.claude` は comments 検査が常時担保。)
// `pdf-to-svg/` は 2026-08-04 にここから外した。ローカル HTTP サーバへ Origin/Host 検査を
// 入れた際、その退行を守るテストが pytest 側にしか無いのに、この一覧に入っているせいで
// **変更しても CI が 1 段も起動しない**状態だったため(セキュリティテスト 34 本が pre-push で
// 一度も走っていなかった)。無害扱いにしてよいのは CI 領域を持たないディレクトリだけ。
const BENIGN_PREFIXES = ['docs/', 'offline/', 'scripts/', '.github/', '.claude/', '.husky/'];

// ── 2. 引数・ベース ref の決定 ──
// 既定は現ブランチの upstream(= origin/<branch>)。常設ブランチ運用では push 対象の新規コミット
// だけが差分になり最速。upstream 未設定(初回 push 等)は `origin/main` へフォールバック。
// `--base <ref>` / 環境変数 `CI_AFFECTED_BASE` で上書き、`--all` でフル `ci` を強制。
// `--dry-run` は実行計画(検出領域と走らせる script)だけ出力して何も実行しない。
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function resolveBase() {
  const flagIdx = argv.indexOf('--base');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  if (process.env.CI_AFFECTED_BASE) return process.env.CI_AFFECTED_BASE;
  // upstream の short ref(例: `origin/chore/...`)。未設定なら git が失敗するので null。
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    allowFail: true,
  });
  if (upstream) return upstream;
  // origin/main があればそれ、無ければ main。いずれも無い極端な環境はフル CI に倒す(後段で処理)。
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main'], { allowFail: true }) !== null) {
    return 'origin/main';
  }
  return git(['rev-parse', '--verify', '--quiet', 'main'], { allowFail: true });
}

// ── 3. サブコマンド実行ヘルパ ──
// pnpm run を継承 stdio で実行。非 0 終了で即座にそのコードへ exit(以降のステージは走らせない)。
function runPnpm(script) {
  if (DRY) {
    console.log(`  (dry-run) pnpm run ${script}`);
    return;
  }
  console.log(`\n▶ pnpm run ${script}`);
  // Windows では pnpm がバッチのため shell 経由で起動する。
  const res = spawnSync('pnpm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error(`✗ ${script} が失敗しました (exit ${res.status ?? 'signal'})`);
    process.exit(res.status ?? 1);
  }
}

function runFullCi(reason) {
  console.log(`\n[ci:affected] ${reason} → フル \`ci\` を実行します。`);
  runPnpm('ci');
  if (!DRY) console.log('\n[ci:affected] フル ci 完了。');
  process.exit(0);
}

// ── 4. メイン ──
if (argv.includes('--all')) runFullCi('--all 指定');

const base = resolveBase();
if (!base) runFullCi('ベース ref を解決できませんでした');

const diffRange = `${base}...HEAD`;
// `-c core.quotePath=false`: 非 ASCII パスの八進エスケープ＋引用符付き出力(`"docs/…\346…"`)を無効化し、
// UTF-8 リテラルで受け取る。これが無いと `p.startsWith('docs/')` 等の BENIGN 判定が外れ、docs だけの
// 変更でも不要にフル `ci` へフォールバックしてしまう。
const out = git(['-c', 'core.quotePath=false', 'diff', '--name-only', diffRange], { allowFail: true });
if (out === null) runFullCi(`git diff ${diffRange} に失敗しました`);

const changed = out.split('\n').filter(Boolean);
console.log(`[ci:affected] ベース: ${base}  (${diffRange})`);
console.log(`[ci:affected] 変更ファイル数: ${changed.length}`);
console.log('[ci:affected] 注: coverage 85% ゲートはフル `pnpm run ci` でのみ検査します (affected/領域別は速度優先で対象外)');

// 領域マッピング。無害でも領域でもないルート直下/共有変更を見つけたらフル CI へ。
const selected = new Set();
for (const p of changed) {
  const area = Object.keys(AREAS).find((k) => AREAS[k].match(p));
  if (area) {
    selected.add(area);
    continue;
  }
  if (BENIGN_PREFIXES.some((pre) => p.startsWith(pre))) continue;
  // 例: package.json / pnpm-lock.yaml / pnpm-workspace.yaml / vitest.config.ts / tsconfig* /
  //     biome.* / .nvmrc 等。影響範囲が全域に及び得るため安全側に倒す。
  runFullCi(`領域に紐付かない共有変更を検出 (${p})`);
}

// ── 5. 実行計画の可視化と実行 ──
const allAreas = Object.keys(AREAS);
const skipped = allAreas.filter((a) => !selected.has(a));
console.log(`[ci:affected] 実行領域: ${selected.size ? [...selected].map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
console.log(`[ci:affected] スキップ領域: ${skipped.length ? skipped.map((a) => AREAS[a].label).join(', ') : '(なし)'}`);

// 共有ゲートは領域の有無に関わらず 1 回だけ実行(comments は .ps1/.md 等も検査するため常時必要)。
runPnpm('check:comments');
runPnpm('check:ci');

if (selected.size === 0) {
  console.log('\n[ci:affected] 変更領域なし。共有ゲートのみで完了。');
  process.exit(0);
}

// 領域ごとに typecheck → test →(editor のみ)build → e2e。順序は AREAS の stages 定義どおり。
for (const area of allAreas.filter((a) => selected.has(a))) {
  for (const stage of AREAS[area].stages) runPnpm(stage);
}

console.log('\n[ci:affected] 完了。');
