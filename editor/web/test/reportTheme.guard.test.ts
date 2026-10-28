// =============================================================================
// reportTheme.guard.test.ts — 正テーマ CSS の複製と、本番コードの fixtures 非依存を固定する
// =============================================================================
// `PartPreview.vue` が読む正テーマ(`assets/reportTheme.css`)は、テスト用 fixtures の CSS を
// バイトのまま写したもの。本番バンドルへ fixtures を引き込まないために複製を持つので、
// 片方だけ直すと見た目がずれる。ずれたら落とし、どちらを正とするかを人が決める。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');
const FIXTURE_CSS_DIR = path.resolve(HERE, '../../fixtures/css');

// local モードは fixtures を静的 import と glob で読む。local を消すまでは走査から外す。
const EXCLUDED_UNTIL_LOCAL_REMOVED = ['api/local/'];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|vue)$/.test(name)) found.push(full);
  }
  return found;
}

/** import/export の `from`、動的 `import()`、`import.meta.glob()` の指定子を拾う。 */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]/g))
    out.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of source.matchAll(/import\.meta\.glob\(\s*['"]([^'"]+)/g)) out.push(m[1]);
  return out;
}

describe('正テーマ CSS(assets/reportTheme.css)', () => {
  it('fixture の正テーマとバイト一致する', () => {
    // 架空化でファイル名のコードが変わっても追従するよう、末尾一致で探す。
    const matches = readdirSync(FIXTURE_CSS_DIR).filter((n) => n.endsWith('_510037_交付版.css'));
    expect(matches).toHaveLength(1);
    const theme = readFileSync(path.join(WEB_SRC, 'assets/reportTheme.css'));
    const fixture = readFileSync(path.join(FIXTURE_CSS_DIR, matches[0]));
    expect(theme.equals(fixture)).toBe(true);
  });
});

describe('本番コードは editor/fixtures を読まない', () => {
  const files = sourceFiles(WEB_SRC).filter((file) => {
    const rel = path.relative(WEB_SRC, file).replace(/\\/g, '/');
    return !EXCLUDED_UNTIL_LOCAL_REMOVED.some((dir) => rel.startsWith(dir));
  });

  it('走査対象を実際に読めている(セルフテスト)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('web/src から fixtures を import しない', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.includes('fixtures')) offenders.push(`${path.relative(WEB_SRC, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
