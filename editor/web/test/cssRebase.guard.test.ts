// =============================================================================
// cssRebase.guard.test.ts — web でリクエスト CSS を付け替える場所を 2 か所に固定する
// =============================================================================
// 付け替えは冪等ではない。編集キャンバス(GrapesJS の setStyle)で付け替えると、付け替え済みの
// CSS が getCss() 経由で下書き・申請・確定 CSS に保存され、サーバの入口でもう一度掛かって
// `css/css/fonts/…` になる。だから付け替えてよいのは「表示用の文書を組み立てる 2 か所」だけ。
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

describe('web の CSS 付け替えの配線', () => {
  it('rebaseCssUrls を使うのは nunjucksRender.ts と reviewCompareDocs.ts だけ', () => {
    const users = sourceFiles(WEB_SRC)
      .filter((f) => /\brebaseCssUrls\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(WEB_SRC, f).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual([
      'features/reviews/services/reviewCompareDocs.ts',
      'lib/nunjucksRender.ts',
    ]);
  });
});
