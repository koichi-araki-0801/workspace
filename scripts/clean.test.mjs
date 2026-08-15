// =============================================================================
// clean.test.mjs — clean.mjs の cwd 非依存性を守る回帰テスト
// =============================================================================
// `NEVER_REL` (保護 3 領域: editor/data・git-tools・native-prebuilds) は cwd に依存せず
// 常に効かなければならない (理由は `clean.mjs` 冒頭コメント)。
//
// 実リポジトリの `git-tools`/`native-prebuilds` は同梱バイナリで、削除条件に一致する
// 中身 (node_modules 等) を含まないため、実リポジトリへ素の出力文字列比較を掛けるだけでは
// cwd バグがあっても何も表示されず偽陰性になる。そのため `clean.mjs` を含む隔離済みの
// 疑似リポジトリを都度組み立て、保護 3 領域それぞれへ「deep 削除条件に一致する中身」
// (`node_modules`) を仕込んだ上で、ROOT 以外の cwd から呼んでも候補に出ないことを固定する。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN_SRC = join(REAL_ROOT, 'scripts', 'clean.mjs');

const PROTECTED_RELS = ['editor/data', 'git-tools', 'native-prebuilds'];

// 保護 3 領域それぞれの配下に `node_modules`(DEEP_WHOLE_DIR_NAMES 一致)を仕込んだ疑似
// リポジトリを一時ディレクトリへ組み立てる。`clean.mjs` は自身のファイル位置から
// ROOT を逆算する (`dirname(import.meta.url)/..`) ため、`scripts/clean.mjs` の配置も含めて
// 複製する。
function buildFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'clean-cwd-test-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(CLEAN_SRC, join(root, 'scripts', 'clean.mjs'));

  for (const p of PROTECTED_RELS) {
    const nm = join(root, ...p.split('/'), 'node_modules');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'package.json'), '{}');
  }

  // ROOT 以外の cwd (実運用でよくある起動元。ここから相対解決するとバグを再現する)。
  // `editor` は上の node_modules 仕込みで既に存在するのでそのまま使い、`graph-editor` は
  // 対応物が無いため新設する。
  mkdirSync(join(root, 'graph-editor'), { recursive: true });

  return { root };
}

const CWD_KINDS = [
  { label: 'ROOT', pick: ({ root }) => root },
  { label: 'editor/', pick: ({ root }) => join(root, 'editor') },
  { label: 'graph-editor/', pick: ({ root }) => join(root, 'graph-editor') },
];

for (const { label, pick } of CWD_KINDS) {
  test(`clean.mjs --deep のドライランは cwd=${label} でも保護領域配下の node_modules を候補に出さない`, () => {
    const fixture = buildFixtureRepo();
    try {
      const cwd = pick(fixture);
      const res = spawnSync(process.execPath, [join(fixture.root, 'scripts', 'clean.mjs'), '--deep'], {
        cwd,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `異常終了 (stderr: ${res.stderr})`);
      for (const p of PROTECTED_RELS) {
        assert.ok(
          !res.stdout.includes(p),
          `保護領域 "${p}" 配下の node_modules が dry-run 出力に含まれた (cwd=${label})\n---\n${res.stdout}`,
        );
      }
      // ドライラン (--yes 無し) なので、この疑似リポジトリの node_modules は物理的にも残る
      // (このテスト自体が削除を実行しないことの確認を兼ねる)。
      assert.ok(
        !res.stdout.includes('を解放しました'),
        `ドライランのはずが削除完了メッセージが出た (cwd=${label})`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
