// =============================================================================
// sea_packaging.test.ts — 配布 exe が「外部に何も見に行かない」ことの実機検査
// -----------------------------------------------------------------------------
// 既定では **skip**(exe ビルドを伴い数分かかるため)。有効化は次の 2 手順:
//   1. node scripts/build-exe.mjs --allow-unsigned   # dist-exe/pie-chart.exe を作る
//   2. PIECHART_SEA_TEST=1 npx vitest run test/sea_packaging.test.ts
//
// 主張するのは **迂回入力で失敗しないこと** ではなく、迂回入力が**何の影響も与えない**こと。
// 具体的には、exe の隣・1 つ上・2 つ上に偽 `node_modules/subset-font` と偽 `fonts/` を置いて
// なお、出力 SVG が開発版(tsx)と byte 一致し、偽モジュールが実行されないことを見る。
// 現行実装以前の exe はここで落ちる(偽モジュールを実行し、あるいはフルフォントへ静かに
// 落ちて出力が肥大する)= 退行検出器として正しく機能する。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.PIECHART_SEA_TEST === '1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exeSrc = join(root, 'dist-exe', process.platform === 'win32' ? 'pie-chart.exe' : 'pie-chart');
const SAMPLE = 'asset_gbca_pdf_like';

/** 偽 `subset-font`。読み込まれたら痕跡ファイルを残す(= 検出可能にする)。 */
const HOSTILE_INDEX = [
  "const { writeFileSync } = require('fs');",
  "const { join } = require('path');",
  "writeFileSync(join(process.env.PIECHART_MARKER_DIR, 'PWNED.marker'), 'evil');",
  'module.exports = async (buf) => buf;',
].join('\n');

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe.skipIf(!enabled)('配布 exe の閉包(PIECHART_SEA_TEST=1 のときだけ実行)', () => {
  let work: string;

  beforeAll(() => {
    if (!existsSync(exeSrc)) {
      throw new Error(
        `${exeSrc} がありません。先に node scripts/build-exe.mjs を実行してください。`,
      );
    }
    work = mkdtempSync(join(tmpdir(), 'piechart-sea-'));
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('配布物は exe と .cer と OFL と SIGNING-INFO だけ(sidecar が無い)', () => {
    const allowed = new Set([
      'pie-chart.exe',
      'pie-chart',
      'pie-chart-codesign.cer',
      'OFL-BIZUDPGothic.txt',
      'SIGNING-INFO.txt',
    ]);
    const entries = readdirRecursive(join(root, 'dist-exe'));
    const unexpected = entries.filter((e) => e.isDir || !allowed.has(e.name));
    expect(unexpected.map((e) => e.path)).toEqual([]);
  });

  it('隣・1 つ上・2 つ上の偽モジュールと偽フォントを一切見ない', () => {
    // 深い階層へ exe を置き、3 階層すべてに偽物を仕込む(Node の解決は親を遡るため)。
    const exeDir = join(work, 'outer', 'inner');
    mkdirSync(exeDir, { recursive: true });
    const exe = join(exeDir, 'pie-chart.exe');
    cpSync(exeSrc, exe);
    for (const dir of [exeDir, join(work, 'outer'), work]) {
      const pkgDir = join(dir, 'node_modules', 'subset-font');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        '{"name":"subset-font","version":"9.9.9","main":"index.js"}',
      );
      writeFileSync(join(pkgDir, 'index.js'), HOSTILE_INDEX);
    }
    // sidecar 解決へ戻ると読んでしまう exe 隣の fonts/ にも別物を置く。
    mkdirSync(join(exeDir, 'fonts'), { recursive: true });
    writeFileSync(join(exeDir, 'fonts', 'BIZUDPGothic-Regular.woff2'), 'NOT-A-FONT');

    const exeSvg = join(work, 'exe.svg');
    execFileSync(exe, ['one', '--sample', SAMPLE, '--output-file', exeSvg], {
      cwd: exeDir,
      env: { ...process.env, PIECHART_MARKER_DIR: work },
      stdio: 'pipe',
    });

    // 偽モジュールが読まれていない。
    expect(existsSync(join(work, 'PWNED.marker'))).toBe(false);
    // 偽フォントが使われていない = 開発版と byte 一致(フルフォント fallback も起きていない)。
    const devSvg = join(work, 'dev.svg');
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(root, 'src', 'cli.ts'),
        'one',
        '--sample',
        SAMPLE,
        '--output-file',
        devSvg,
      ],
      { cwd: root, stdio: 'pipe' },
    );
    expect(sha256(exeSvg)).toBe(sha256(devSvg));
  });

  it('fonts も node_modules も無い空ディレクトリで exe 単体でも同じ出力', () => {
    const solo = join(work, 'solo');
    mkdirSync(solo, { recursive: true });
    const exe = join(solo, 'pie-chart.exe');
    cpSync(exeSrc, exe);
    const out = join(work, 'solo.svg');
    execFileSync(exe, ['one', '--sample', SAMPLE, '--output-file', out], {
      cwd: solo,
      stdio: 'pipe',
    });
    expect(sha256(out)).toBe(sha256(join(work, 'dev.svg')));
  });

  it('exe 版の DB 入力は非対応として非ゼロ終了する', () => {
    const solo = join(work, 'solo');
    let failed = false;
    let out = '';
    try {
      const args = ['one', '--sql', 'SELECT a, b FROM t', '--output-file', join(work, 'sql.svg')];
      execFileSync(join(solo, 'pie-chart.exe'), args, {
        cwd: solo,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      failed = true;
      out = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(failed).toBe(true);
    expect(out).toMatch(/not available in the packaged executable/);
  });
});

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

/** 隠しファイルとリパースポイントも含めて配布ディレクトリを列挙する。 */
function readdirRecursive(dir: string): Entry[] {
  const out: Entry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    out.push({ name: d.name, path: p, isDir: d.isDirectory() });
    if (d.isDirectory()) out.push(...readdirRecursive(p));
  }
  return out;
}
