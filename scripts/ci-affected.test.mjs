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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
