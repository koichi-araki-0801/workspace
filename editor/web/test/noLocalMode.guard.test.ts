// =============================================================================
// noLocalMode.guard.test.ts — web のデータ経路は REST だけ(local モードの再流入を止める)
// =============================================================================
// local モード(fixtures + localStorage)は二系統の保守をやめるために削除した。
// `VITE_API_MODE` の分岐が戻ると、開発者のシェルに残った `VITE_API_MODE=local` で
// 黙って別経路へ落ちる。Undo のキーも local の固定スコープへ戻らないことを固定する。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setUndoUserScope, undoStacksKey } from '@/lib/storageKeys';

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

/** コメントを落とす。理由を説明する散文まで数えると、説明に名前を書いただけで落ちる。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('local モードの不在', () => {
  it('web/src のコードは VITE_API_MODE を参照しない', () => {
    const files = sourceFiles(WEB_SRC);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes('VITE_API_MODE'))
      .map((f) => path.relative(WEB_SRC, f));
    expect(offenders).toEqual([]);
  });

  it('api/local ディレクトリが存在しない', () => {
    expect(existsSync(path.join(WEB_SRC, 'api/local'))).toBe(false);
  });
});

describe('Undo ミラーのキーのスコープ', () => {
  afterEach(() => setUndoUserScope(null));

  it('ログインしていなければ匿名スコープ、ログインすればそのユーザーのスコープ', () => {
    setUndoUserScope(null);
    expect(undoStacksKey()).toBe('editor:session:undo:v2:anonymous');
    setUndoUserScope('u1');
    expect(undoStacksKey()).toBe('editor:session:undo:v2:u1');
  });
});
