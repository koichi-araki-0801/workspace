// =============================================================================
// docAssetRefs.guard.test.ts — 文書側の資産参照は resolveDocAssetPath だけを通す
// =============================================================================
// 文書の参照(`../css/x.css`)は文書の位置を基準に解く。配信ルート直下基準で解くと
// ルートの外として落ち、`<link>`/`<script src>` が黙って消える。ルート引数は復号済みなので
// `resolveServedRoutePath` で検め、それを使う場所はこの台帳に理由つきで足す。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) found.push(full);
  }
  return found;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ALL = sourceFiles(SRC).map((f) => ({
  rel: path.relative(SRC, f).replace(/\\/g, '/'),
  code: stripComments(readFileSync(f, 'utf8')),
}));

/** ルート引数の正規化に使う場所。文書の参照を解く場所は入れない。 */
const ROUTE_PARAM_USERS = [
  'routes/fundAssets.routes.ts', // GET /fund-assets/images/:file・:dir/:file の経路の正規化
  'vivliostyle/previewHost.ts', // GET /api/preview-host/* の経路の正規化
];

describe('文書側の資産参照の解決', () => {
  it('resolveServedRoutePath を使うのはルート引数の正規化だけ', () => {
    const users = ALL.filter(({ code }) => /\bresolveServedRoutePath\b/.test(code)).map(
      (a) => a.rel,
    );
    expect(users.sort()).toEqual(ROUTE_PARAM_USERS);
  });

  it.each([
    'vivliostyle/docAssets.ts',
    'vivliostyle/docRefs.ts',
    'vivliostyle/inlineCss.ts',
    'vivliostyle/inlineDocScripts.ts',
  ])('%s は文書基準の resolveDocAssetPath で参照を解く', (file) => {
    const code = ALL.find((a) => a.rel === file)?.code ?? '';
    expect(code).toMatch(/\bresolveDocAssetPath\(/);
  });
});
