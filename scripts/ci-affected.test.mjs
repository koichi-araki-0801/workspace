// =============================================================================
// ci-affected.test.mjs — 領域マッピングと実行計画を dry-run 出力で固定する
// =============================================================================
// affected ランナーの実害は「走ったつもりで一段も走っていない」形で出る
// (offline が BENIGN 入りしていた期間が実例)。段の欠落は実行しても静かに通ってしまうため、
// `--dry-run` の出力を実行計画のスナップショットとして固定し、領域定義から段が落ちた瞬間に
// 落ちるようにする。
//
// 領域ごとの検証は、実リポジトリの diff に依存させると「今たまたま何を触っているか」で
// 結果が変わってしまう。そこで `ci-affected.mjs` を含む疑似リポジトリを都度組み立て、
// 検証したいパスだけを 1 コミットで変更して `--base` を指定する (`ci-affected.mjs` は
// 自身のファイル位置から ROOT を逆算するので、`scripts/` 配下への複製で足りる)。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyChanges } from './ci-affected.mjs';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REAL_ROOT, 'scripts', 'ci-affected.mjs');

// 共有ゲート。領域の有無に関わらず必ずこの順で先頭に並ぶ。
const SHARED_GATES = ['check:comments', 'check:claude-hooks', 'check:ci', 'test:scripts'];

// 疑似リポジトリのコミットは、実行環境の git 設定 (`user.name` 未設定・環境変数の混入) に
// 左右されないよう毎回明示する。`core.autocrlf` を切るのは改行の警告でテスト出力を
// 埋めないためで、判定は `diff --name-only` のパス名だけを使うので中身の改行は関係ない。
const GIT_IDENTITY = [
  '-c',
  'user.name=ci-affected test',
  '-c',
  'user.email=ci-affected@example.invalid',
  '-c',
  'core.autocrlf=false',
];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

// 指定パスだけを変更した 2 コミットの疑似リポジトリを作り、初期コミットの sha を返す。
function buildFixtureRepo(paths) {
  const root = mkdtempSync(join(tmpdir(), 'ci-affected-test-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(SRC, join(root, 'scripts', 'ci-affected.mjs'));
  git(root, ['init', '--quiet']);
  git(root, [...GIT_IDENTITY, 'add', '-A']);
  git(root, [...GIT_IDENTITY, 'commit', '--quiet', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);

  for (const rel of paths) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x\n', 'utf8');
  }
  git(root, [...GIT_IDENTITY, 'add', '-A']);
  git(root, [...GIT_IDENTITY, 'commit', '--quiet', '-m', 'change']);
  return { root, base };
}

// dry-run を実行し、計画された `pnpm run <script>` を順序どおりの配列で返す。
function planFor(root, args) {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'ci-affected.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('(dry-run) pnpm run '))
    .map((l) => l.slice('(dry-run) pnpm run '.length));
}

function planForChanges(paths) {
  const { root, base } = buildFixtureRepo(paths);
  try {
    return planFor(root, ['--dry-run', '--base', base]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// dry-run の標準出力をそのまま返す。実行計画(`planFor`)には現れない「領域名の表示」を見る
// テスト用(`ci-machinery` は stages が空なので計画には 1 行も出ない)。
function dryRunOutput(paths) {
  const { root, base } = buildFixtureRepo(paths);
  try {
    const res = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'ci-affected.mjs'), '--dry-run', '--base', base],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    return res.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('--all のフル CI 計画は ci と ci:offline の 2 段', () => {
  // `ci` は GitHub Actions (ubuntu) と共用で Windows 限定の Pester を含められないため、
  // フル CI へ倒れる経路では `ci:offline` を続けて走らせる必要がある。
  // `check:claude-hooks` は `ci` 自身が含むので、ここで重ねない。
  const plan = planFor(REAL_ROOT, ['--all', '--dry-run']);
  assert.deepEqual(plan, ['ci', 'ci:offline']);
});

test('領域に紐付かない共有変更はフル CI へ倒れる', () => {
  assert.deepEqual(planForChanges(['package.json']), ['ci', 'ci:offline']);
});

test('docs 原稿だけの変更は共有ゲートのみ (非 ASCII パス込み)', () => {
  // 非 ASCII パスは `core.quotePath=false` が効いていないと BENIGN 判定を外し、
  // 原稿 1 行の修正でフル CI へ倒れる。
  assert.deepEqual(planForChanges(['docs/editor/src/設計書.md']), SHARED_GATES);
});

test('docs/_build の変更は docs 領域の pytest を起動する', () => {
  assert.deepEqual(planForChanges(['docs/_build/md2html.py']), [...SHARED_GATES, 'test:docs']);
});

test('pie-chart は typecheck・vitest に加えて batch の byte 比較まで走る', () => {
  assert.deepEqual(planForChanges(['pie-chart/src/config.ts']), [
    ...SHARED_GATES,
    'typecheck:pie-chart',
    'test:pie-chart',
    'pie-chart:batch',
    'pie-chart:batch:diff',
  ]);
});

test('offline は ci:offline (Pester) を起動する', () => {
  assert.deepEqual(planForChanges(['offline/lib/verify.ps1']), [...SHARED_GATES, 'ci:offline']);
});

test('editor は typecheck・vitest・build・e2e の 4 段', () => {
  assert.deepEqual(planForChanges(['editor/web/src/main.ts']), [
    ...SHARED_GATES,
    'typecheck:editor',
    'test:editor',
    'build:editor',
    'e2e:editor',
  ]);
});

test('複数領域の変更は領域定義の順に連結される', () => {
  assert.deepEqual(planForChanges(['pie-chart/src/config.ts', 'offline/lib/verify.ps1']), [
    ...SHARED_GATES,
    'typecheck:pie-chart',
    'test:pie-chart',
    'pie-chart:batch',
    'pie-chart:batch:diff',
    'ci:offline',
  ]);
});

// ── 領域判定の純関数(git を経由しない) ──
// `classifyChanges` は「何が走るか」を決める唯一の関数で、上の dry-run テストは
// それを実行計画の形で見ている。ここでは判定そのものを直接固定する。

test('classifyChanges: scripts/ だけの変更は ci-machinery 領域(段は無し)', () => {
  assert.deepEqual(classifyChanges(['scripts/x.mjs']), {
    areas: ['ci-machinery'],
    benign: [],
    fullCi: null,
  });
});

test('classifyChanges: README だけの editor 変更は領域を発火しない', () => {
  // `editor/README.md` は editor 領域の `match` にも当たるが、BENIGN_FILES を領域判定より
  // 先に評価するので editor の typecheck / vitest / build / e2e は走らない。
  assert.deepEqual(classifyChanges(['editor/README.md']), {
    areas: [],
    benign: ['editor/README.md'],
    fullCi: null,
  });
});

test('classifyChanges: .gitattributes はフル CI へ倒れる', () => {
  // eol の前提は Biome の整形結果を全域で変えうるため、無害ファイルに含めない。
  const r = classifyChanges(['.gitattributes']);
  assert.equal(r.areas.length, 0);
  assert.match(r.fullCi, /\.gitattributes/);
});

test('classifyChanges: ルート README と editor ソースの同時変更は editor 領域だけ', () => {
  assert.deepEqual(classifyChanges(['README.md', 'editor/web/src/x.ts']), {
    areas: ['editor'],
    benign: ['README.md'],
    fullCi: null,
  });
});

test('scripts/ だけの変更は共有ゲートのみで、領域名は ci-machinery と表示される', () => {
  assert.deepEqual(planForChanges(['scripts/x.mjs']), SHARED_GATES);
  const out = dryRunOutput(['scripts/x.mjs']);
  assert.match(out, /実行領域: CI 機構 \(共有ゲートのみ\)/);
  assert.doesNotMatch(out, /変更領域なし/);
});

test('editor/README.md だけの変更は共有ゲートのみ', () => {
  assert.deepEqual(planForChanges(['editor/README.md']), SHARED_GATES);
});

// ── GitHub Actions の段と `ci` の同期 ──
// `.github/workflows/ci.yml` は `pnpm run ci` と同じ段を並べる決まりだが、手で同期している限り
// 片方だけに足した段は静かに抜ける(実例: `test:scripts` が yml に無かった)。yml を行ベースで
// 読み、各 step の `run:` を `package.json` の script 名へ写像して「yml の段 ⊆ ci の段」と
// 「相対順序が同じ」を固定する。YAML パーサはルートから import できないので使わない。

const CI_YML = join(REAL_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * `- name:` で step を区切り、`run:` の値を返す。`run: |` の継続行は 1 つの文字列に連結する
 * (行はインデントが `run:` より深い間だけ続く)。`- uses:` だけの step は `run` を持たない。
 */
function parseWorkflowSteps(text) {
  const steps = [];
  let cur = null;
  let block = null; // { indent } — `run: |` の継続行を読んでいる間だけ非 null
  for (const raw of text.split(/\r?\n/)) {
    const indent = raw.match(/^ */)[0].length;
    if (block) {
      if (raw.trim() === '' || indent > block.indent) {
        if (raw.trim() !== '') cur.run = cur.run ? `${cur.run}\n${raw.trim()}` : raw.trim();
        continue;
      }
      block = null;
    }
    const item = raw.match(/^ *- (name|uses):\s*(.*?)\s*$/);
    if (item) {
      cur = { name: item[1] === 'name' ? item[2] : `(uses) ${item[2]}`, run: null };
      steps.push(cur);
      continue;
    }
    const run = cur && raw.match(/^( *)run:\s*(.*?)\s*$/);
    if (run) {
      if (run[2] === '|' || run[2] === '>') {
        block = { indent: run[1].length };
        cur.run = '';
      } else {
        cur.run = run[2];
      }
    }
  }
  return steps;
}

// yml の `run` 1 行 → `ci` の段名。導入系(pnpm install / playwright install / pip install)と
// キャッシュ鍵の解決(`echo "version=…"`)は段ではない。写像に無いコマンドは例外にする —
// 新しい step を足したらこの表を更新する、が同期の手順そのもの。
const RUN_TO_STAGE = [
  [/^pnpm run (\S+)$/, (m) => m[1]],
  [/^python scripts\/check-comments\.py$/, () => 'check:comments'],
  [/^python -m pytest docs\/_build$/, () => 'test:docs'],
];
const NON_STAGE_RUN = /^(pnpm install\b|pnpm exec playwright install\b|pip install\b|echo "version=)/;

function stagesOfRun(run) {
  const stages = [];
  for (const line of run.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (NON_STAGE_RUN.test(line)) continue;
    const hit = RUN_TO_STAGE.find(([re]) => re.test(line));
    if (!hit) throw new Error(`ci.yml の run を段へ写像できません: ${line}`);
    stages.push(hit[1](line.match(hit[0])));
  }
  return stages;
}

function ciStages() {
  const pkg = JSON.parse(readFileSync(join(REAL_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts.ci.split('&&').map((s) => s.trim().replace(/^pnpm run /, ''));
}

// `ci` にあって GH に無い段。理由が消えたらここから外して yml へ足す。
const GH_EXEMPT = {
  'check:claude-hooks': '.claude/ は git 追跡外で、GH の checkout には検査対象が無い(exit 0 になるだけ)',
  'pie-chart:batch': 'out/_baseline はローカル生成物で GH に存在しない',
  'pie-chart:batch:diff': 'out/_baseline はローカル生成物で GH に存在しない',
};

test('ci.yml の段は ci の段の部分列で、免除リスト外の欠落が無い', () => {
  const ci = ciStages();
  const yml = parseWorkflowSteps(readFileSync(CI_YML, 'utf8'))
    .filter((s) => s.run !== null)
    .flatMap((s) => stagesOfRun(s.run));
  assert.ok(yml.length > 0, 'yml から段を 1 つも読めていない(パーサか yml の形が変わった)');

  // yml ⊆ ci
  const unknown = yml.filter((s) => !ci.includes(s));
  assert.deepEqual(unknown, [], `ci に無い段が yml にある: ${unknown.join(', ')}`);

  // ci − yml ⊆ 免除
  const missing = ci.filter((s) => !yml.includes(s) && !(s in GH_EXEMPT));
  assert.deepEqual(missing, [], `yml に無く免除もされていない段: ${missing.join(', ')}`);

  // 免除は生きているものだけ(ci から消えた段を免除し続けない)
  for (const s of Object.keys(GH_EXEMPT)) assert.ok(ci.includes(s), `免除 ${s} は ci に無い`);

  // 相対順序: yml の段を ci の添字に写すと単調増加
  const idx = yml.map((s) => ci.indexOf(s));
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `yml の順序が ci と違う: ${yml[i - 1]} → ${yml[i]}`);
  }
});

test('ci:offline は ci の段にも yml の run: 段にも無い(Windows 限定の Pester は ci:affected が別途呼ぶ)', () => {
  // 検査対象は「実行される段」であって散文ではない。ファイル全文の文字列一致にすると、
  // このコメント自身が理由説明のために `ci:offline` と書いた瞬間に赤くなってしまう
  // (実際、コメントに書いただけで発火した実績がある)。よって `run:` から写像した段名だけを見る。
  assert.ok(!ciStages().includes('ci:offline'));
  const steps = parseWorkflowSteps(readFileSync(CI_YML, 'utf8')).filter((s) => s.run !== null);
  const stages = steps.flatMap((s) => stagesOfRun(s.run));
  assert.ok(!stages.includes('ci:offline'), 'ci.yml の run: が ci:offline を実行している');
});

test('parseWorkflowSteps は run: | の継続行を連結し uses だけの step を run 無しにする', () => {
  const steps = parseWorkflowSteps(
    [
      '      - uses: actions/checkout@abc # v5',
      '        with:',
      '          persist-credentials: false',
      '      - name: A',
      '        run: pnpm run check:ci',
      '      - name: B',
      '        run: |',
      '          pip install -r x.txt',
      '          python -m pytest docs/_build',
      '      - name: C',
      '        uses: actions/upload-artifact@def # v7',
    ].join('\n'),
  );
  assert.deepEqual(
    steps.map((s) => [s.name, s.run]),
    [
      ['(uses) actions/checkout@abc # v5', null],
      ['A', 'pnpm run check:ci'],
      ['B', 'pip install -r x.txt\npython -m pytest docs/_build'],
      ['C', null],
    ],
  );
  assert.deepEqual(stagesOfRun(steps[2].run), ['test:docs']);
});
