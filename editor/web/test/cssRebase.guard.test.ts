// =============================================================================
// cssRebase.guard.test.ts — web でリクエスト CSS を付け替える場所を 2 か所に固定する
// =============================================================================
// 付け替えは入口で 1 回だけ。編集キャンバス(GrapesJS の setStyle)で付け替えると、付け替え済みの
// CSS が getCss() 経由で下書き・申請・確定 CSS に保存され、サーバの入口でもう一度掛かる。だから
// 付け替えてよいのは「表示用の文書を組み立てる 2 か所」だけで、どちらも文書基準
// (`rebaseCssForDoc`)を使う。
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

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function usersOf(name: string): string[] {
  const re = new RegExp(`\\b${name}\\b`);
  return sourceFiles(WEB_SRC)
    .filter((f) => re.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => path.relative(WEB_SRC, f).replace(/\\/g, '/'))
    .sort();
}

describe('web の CSS 付け替えの配線', () => {
  it('rebaseCssForDoc を使うのは nunjucksRender.ts と reviewCompareDocs.ts だけ', () => {
    expect(usersOf('rebaseCssForDoc')).toEqual([
      'features/reviews/services/reviewCompareDocs.ts',
      'lib/nunjucksRender.ts',
    ]);
  });

  // 文書側の資産参照の解決は `resolveDocAssetPath` だけを通す。基準なしの `resolveServedAssetPath`
  // (配信ルート直下基準)を web の文書側コードに残すと、`../` の形を解けず「プレビューだけ画像が
  // 出ない」ずれを作る。サーバ側の許可リストは `server/test/docAssetRefs.guard.test.ts`。
  it('web は resolveServedAssetPath を使わない(文書側の参照は resolveDocAssetPath だけ)', () => {
    expect(usersOf('resolveServedAssetPath')).toEqual([]);
  });
});
