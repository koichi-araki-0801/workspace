// =============================================================================
// ci-affected.mjs — 変更領域だけ CI を走らせる affected ランナー
// =============================================================================
// `git diff` で変更ファイルを領域(editor / pie-chart など)へマッピングし、
// 触れた領域の CI ステージだけ実行する。`pnpm run ci:affected` で起動するほか、
// `.husky/pre-push` から直接呼ばれる。フル `ci`(coverage 閾値ゲート込み)は手動
// `pnpm run ci` と GitHub Actions が担うため、ここでは速度優先で coverage 無しの
// テストのみ走らせる。
//
// なぜ affected か: 常設ブランチは重量物含め広大で、常にフル実行だと pie-chart の 1 ファイル
// 変更でも editor の build/e2e まで毎回走って push が遅い。push 前段で「触った領域」へ絞る。
//
// 安全側の判断:
//   - 領域に紐付かないルート直下の共有変更(package.json / lockfile / 各種 config)を検出したら
//     フル `ci` にフォールバックする(影響範囲が読めないため取りこぼさない)。
//   - 何が走り何をスキップしたかを冒頭に出力する(silent に絞ったように見せない)。
//   - README / `.gitignore` だけの変更は領域 CI を起こさない(`BENIGN_FILES`)。`scripts/` /
//     `.husky/` は段を持たない領域 `ci-machinery` として出力に名前を出す。

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 領域定義 — トップレベルディレクトリ単位 ──
// editor(shared+server+web)は密結合のため 1 領域。各領域の CI ステージを順に並べる。
// `pnpm run <script>` をそのまま呼ぶので、定義の正典はルート `package.json` の scripts 側。
export const AREAS = {
  editor: {
    label: 'editor (shared+server+web)',
    match: (p) => p.startsWith('editor/'),
    // `test:editor` は shared / server / web-dom(jsdom)/ web-node の 4 project を選ぶ
    // (web の dom/node 分割は `editor/web/vitest.dom.config.ts` を参照)。
    stages: ['typecheck:editor', 'test:editor', 'build:editor', 'e2e:editor'],
  },
  'pie-chart': {
    label: 'pie-chart',
    match: (p) => p.startsWith('pie-chart/'),
    // batch + batch:diff を含めるのは、SVG 出力のバイト不変が pie-chart の鉄則であり、
    // vitest には出力バイトを見る検査が無いため(baseline との SHA256 比較はこの 2 段が唯一)。
    // 83 サンプルのレンダで実測 30 秒台と、領域 CI へ載せて許容できる範囲に収まる。
    stages: ['typecheck:pie-chart', 'test:pie-chart', 'pie-chart:batch', 'pie-chart:batch:diff'],
  },
  offline: {
    label: 'offline',
    match: (p) => p.startsWith('offline/'),
    stages: ['ci:offline'],
  },
  docs: {
    label: 'docs (_build エンジン)',
    // 原稿(`docs/<project>/`)は下の BENIGN_PREFIXES へ落ちる。ここで拾うのは HTML 生成
    // エンジン側だけで、front-matter 解釈やトークン walker の退行は pytest でしか出ない。
    match: (p) => p.startsWith('docs/_build/'),
    stages: ['test:docs'],
  },
  'ci-machinery': {
    label: 'CI 機構 (共有ゲートのみ)',
    // `scripts/` と `.husky/` は固有の段を持たない。`check:comments` と `test:scripts`
    // (`ci-affected.test.mjs` を含む)は共有ゲートとして毎回走っており、フル `ci` が足す
    // coverage / build / e2e は `scripts/` の正しさと無関係なのでフル fallback へは回さない。
    // stages を空にした領域として持つのは、出力に領域名を出して「静かに何も走らなかった」
    // 状態を作らないため。
    match: (p) => p.startsWith('scripts/') || p.startsWith('.husky/'),
    stages: [],
  },
};
// `.claude/` は領域として持たない: `.gitignore` で git 追跡外のため、変更が `git diff` に
// 現れず領域発火の判定材料にならない。代わりに `check:claude-hooks` を下の共有ゲートへ
// 無条件実行として組み込み、diff に関わらず毎回検査する。

// 単独で変わっても領域 CI を要しないファイル(完全一致)。**領域判定より先に**評価する:
// `editor/README.md` は editor 領域の `match` にも当たるが、README だけの修正で editor の
// typecheck / vitest / build / e2e を走らせない。`.gitattributes` は含めない(eol の前提が
// 変わると Biome の整形結果が全域で動きうるので、フル fallback に倒す)。
export const BENIGN_FILES = new Set(['README.md', 'editor/README.md', 'pie-chart/README.md', '.gitignore']);

// 領域 CI を持たない無害ディレクトリ(前方一致)。これらだけの変更なら共有ゲート
// (comments/biome/test:scripts)のみで足りる。
// `docs/` を残すのは原稿(`docs/<project>/src/*.md`・生成 HTML・画像)のためで、生成エンジン
// (`docs/_build/`)は上の `docs` 領域が先に拾う(領域判定は BENIGN_PREFIXES より先に走る)。
// 無害扱いにしてよいのは CI 領域を持たないディレクトリだけ。
// `offline/` はここへ含めない: 署名検証・requirements 許可リストの実装本体
// (offline/lib/verify.ps1)には固有の検査があり、無害入りしていると 1 段も起動しない
// (comments 検査は .ps1 の BOM/併設しか見ず、実装のロジックは見ない)。
// `scripts/` / `.husky/` は上の `ci-machinery` 領域が拾う(ここに置くと出力に現れない)。
export const BENIGN_PREFIXES = ['docs/', '.github/'];

/**
 * 変更パスの配列から実行計画の材料を決める。`areas` は `AREAS` の定義順(= 実行順)。
 * どの判定にも当たらないパスを見つけた時点で `fullCi` に理由を入れて返す(以降のパスは
 * 見ない。影響範囲が読めない変更が 1 つでもあればフル `ci` なので、続きを見る意味が無い)。
 * git を呼ばない純関数で、`ci-affected.test.mjs` がここを直接固定する。
 */
export function classifyChanges(paths) {
  const selected = new Set();
  const benign = [];
  for (const p of paths) {
    if (BENIGN_FILES.has(p)) {
      benign.push(p);
      continue;
    }
    const area = Object.keys(AREAS).find((k) => AREAS[k].match(p));
    if (area) {
      selected.add(area);
      continue;
    }
    if (BENIGN_PREFIXES.some((pre) => p.startsWith(pre))) {
      benign.push(p);
      continue;
    }
    // 例: package.json / pnpm-lock.yaml / pnpm-workspace.yaml / vitest.config.ts / tsconfig* /
    //     biome.* / .nvmrc / .gitattributes 等。影響範囲が全域に及び得るため安全側に倒す。
    return {
      areas: Object.keys(AREAS).filter((a) => selected.has(a)),
      benign,
      fullCi: `領域に紐付かない共有変更を検出 (${p})`,
    };
  }
  return { areas: Object.keys(AREAS).filter((a) => selected.has(a)), benign, fullCi: null };
}

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
  // `ci`(package.json)は GitHub Actions(ubuntu)とも共用のため、Windows 限定の Pester
  // (`ci:offline`)を含められない。ローカルの pre-push が唯一の Pester ゲートなので、フル CI へ
  // 倒れる経路でも取りこぼさないよう続けて走らせる(offline/ の変更と共有ファイルの変更が同じ
  // push に混ざると、領域別の発火だけでは Pester が一度も走らない)。
  runPnpm('ci:offline');
  if (!DRY) console.log('\n[ci:affected] フル ci 完了。');
  process.exit(0);
}

// ── 4. メイン ──
// 直接起動時のみ実行する。テストは `classifyChanges` を import するだけで git に触れない。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  if (argv.includes('--all')) runFullCi('--all 指定');

  const base = resolveBase();
  if (!base) runFullCi('ベース ref を解決できませんでした');

  const diffRange = `${base}...HEAD`;
  // `-c core.quotePath=false`: 非 ASCII パスの八進エスケープ＋引用符付き出力(`"docs/…\346…"`)を
  // 無効化し、UTF-8 リテラルで受け取る。これが無いと `p.startsWith('docs/')` 等の BENIGN 判定が
  // 外れ、docs だけの変更でも不要にフル `ci` へフォールバックしてしまう。
  const out = git(['-c', 'core.quotePath=false', 'diff', '--name-only', diffRange], { allowFail: true });
  if (out === null) runFullCi(`git diff ${diffRange} に失敗しました`);

  const changed = out.split('\n').filter(Boolean);
  console.log(`[ci:affected] ベース: ${base}  (${diffRange})`);
  console.log(`[ci:affected] 変更ファイル数: ${changed.length}`);
  console.log('[ci:affected] 注: coverage 85% ゲートはフル `pnpm run ci` でのみ検査します (affected/領域別は速度優先で対象外)');

  // 領域マッピング。無害でも領域でもないルート直下/共有変更を見つけたらフル CI へ。
  const { areas, benign, fullCi } = classifyChanges(changed);
  if (fullCi) runFullCi(fullCi);

  // ── 5. 実行計画の可視化と実行 ──
  const selected = new Set(areas);
  const skipped = Object.keys(AREAS).filter((a) => !selected.has(a));
  console.log(`[ci:affected] 実行領域: ${areas.length ? areas.map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
  console.log(`[ci:affected] スキップ領域: ${skipped.length ? skipped.map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
  if (benign.length) console.log(`[ci:affected] 領域 CI 不要の変更: ${benign.length} 件 (${benign.join(', ')})`);

  // 共有ゲートは領域の有無に関わらず 1 回だけ実行(comments は .ps1/.md 等も検査するため常時必要)。
  // claude-hooks も同列: `.claude/` は git 追跡外で diff に現れないため領域発火の対象にできず、
  // diff の中身に関わらず常時検査する側に置くしかない。test:scripts も同列: `scripts/` の
  // `ci-machinery` 領域は段を持たず、`scripts/*.test.mjs` はここで常時実行する。
  runPnpm('check:comments');
  runPnpm('check:claude-hooks');
  runPnpm('check:ci');
  runPnpm('test:scripts');

  if (areas.length === 0) {
    console.log('\n[ci:affected] 変更領域なし。共有ゲートのみで完了。');
    process.exit(0);
  }

  // 領域ごとに typecheck → test →(editor のみ)build → e2e。順序は AREAS の stages 定義どおり。
  for (const area of areas) {
    for (const stage of AREAS[area].stages) runPnpm(stage);
  }

  console.log('\n[ci:affected] 完了。');
}
