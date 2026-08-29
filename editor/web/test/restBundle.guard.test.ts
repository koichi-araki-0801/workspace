// =============================================================================
// restBundle.guard.test.ts — 「api/local/ への import は既知の 3 箇所のみ」ガード
// =============================================================================
// `api/local/**` は fixtures(`users.json` の平文パスワード込み)+ localStorage 一式の
// local モックグラフで、`rest` モードでは使わない想定。しかし静的 import は build 時の
// 条件分岐にならないため、`api/local/` を import するファイルが増えるほど rest ビルドへ
// このグラフが引き込まれる足がかりが増える。増える先を機械的に固定する。
//
// 許可される 3 箇所:
//   - `api/repositories.ts` — local/rest 実装の DI 合成ルート(唯一の正当な集約点)。
//   - `main.ts` — `VITE_API_MODE` に応じて local 専用初期化(`migrateStore`/
//     `seedCompareFixtures`)を呼ぶ配線コード。
//   - `api/rest/http.ts` — `attempt`(throw→Result シーム)だけを再利用する。
//     `attempt.ts` は `@editor/shared` のみに依存する葉モジュールで、fixtures/store の
//     グラフを引き込まない(コード上の意図はファイル冒頭コメントに明記)。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|vue)$/.test(name)) found.push(full);
  }
  return found;
}

const ALL_SOURCES = sourceFiles(WEB_SRC);

/** import/export の `from '...'` と動的 `import('...')` の specifier を拾う。 */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]/g))
    out.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** specifier を `WEB_SRC` 相対の POSIX パスへ正規化する(拡張子なし)。解決できなければ null。 */
function resolveToWebSrc(fileDir: string, spec: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2);
  if (spec.startsWith('.')) {
    const abs = path.posix.normalize(
      `${path.relative(WEB_SRC, fileDir).replace(/\\/g, '/')}/${spec}`,
    );
    return abs.replace(/^\.\//, '');
  }
  return null; // bare package import(node_modules) は対象外
}

const ALLOWED = new Set(['api/repositories.ts', 'main.ts', 'api/rest/http.ts']);

describe('rest バンドル分離ガード — api/local/ への import 経路', () => {
  it('走査対象を実際に読めている(セルフテスト)', () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
  });

  it('api/local/ を import しているファイルは既知の 3 箇所のみ', () => {
    const offenders = new Set<string>();
    for (const file of ALL_SOURCES) {
      const rel = path.relative(WEB_SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('api/local/')) continue; // local 配下同士の相互参照は対象外
      const dir = path.dirname(file);
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        const resolved = resolveToWebSrc(dir, spec);
        if (resolved?.startsWith('api/local/') && !ALLOWED.has(rel)) offenders.add(rel);
      }
    }
    expect([...offenders], `api/local/ を import している想定外ファイル`).toEqual([]);
  });

  it('main.ts に useRest によるガード分岐が存在する(seed 系を rest で実行しない)', () => {
    const source = readFileSync(path.join(WEB_SRC, 'main.ts'), 'utf8');
    expect(source).toMatch(/if\s*\(\s*!useRest\s*\)\s*\{[^}]*migrateStore/);
    expect(source).toMatch(/seedCompareFixtures/);
  });
});
