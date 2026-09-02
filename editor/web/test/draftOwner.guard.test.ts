// =============================================================================
// draftOwner.guard.test.ts — 「下書きを採用する経路は所属判定の関門を通る」ガード
// =============================================================================
// 編集セッションはブラウザタブの寿命で、別タブが残した下書きは採用しない。この関門を
// 編集経路(`loadForEdit`)にだけ置いた版では、プレビュー経路(`loadForPreview`)が
// `getDraft` を無条件採用しており、ブックマークや直 URL で編集画面を経由せず来ると別タブの
// 下書きがそのまま申請本文になった。守りを足すときは「その関門を通らない経路」を列挙し、
// 列挙を機械検証として置く(設計正典の中核原則)。ここがその列挙にあたる:
//
//   下書きの実体を取りに行く(`getDraft` を呼ぶ)アプリコードは、必ず所属判定
//   (`belongsToSession`)も参照している。
//
// repository 実装(`api/local` / `api/rest`)は `getDraft` の**定義側**で、採用の判断を
// しないため対象外にする。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');

/** `web/src` 配下の `.ts` / `.vue` を全部集める(除外リストを作らない = 見落としを作らない)。 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|vue)$/.test(name)) found.push(full);
  }
  return found;
}

/**
 * コメントを落とす。固定したいのは**コード上の形**で、理由を説明する散文まで数えると
 * 「コメントに `belongsToSession` と書いただけ」で通ってしまう。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ALL_SOURCES = sourceFiles(WEB_SRC);

/** `getDraft` の定義側(repository 実装)。採用の判断はしないので関門の対象外。 */
const DEFINITION_SIDE = [path.join(WEB_SRC, 'api/local'), path.join(WEB_SRC, 'api/rest')];

function isDefinitionSide(file: string): boolean {
  return DEFINITION_SIDE.some((dir) => file.startsWith(dir + path.sep));
}

describe('下書きの所属判定ガード — getDraft を呼ぶ経路は関門を通る', () => {
  it('走査対象を実際に読めている(セルフテスト)', () => {
    // 収集に失敗していると以下が素通りして「常に緑」になる。
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
    const callers = ALL_SOURCES.filter(
      (f) => !isDefinitionSide(f) && /\bgetDraft\s*\(/.test(stripComments(readFileSync(f, 'utf8'))),
    ).map((f) => path.relative(WEB_SRC, f).replaceAll('\\', '/'));
    // 現在の採用経路は編集とプレビューの 2 本。増減したらここが落ち、レビューへ上がる。
    expect(callers.sort()).toEqual([
      'features/editor/services/templateEditorService.ts',
      'features/preview/services/templatePreviewService.ts',
    ]);
  });

  it('getDraft を呼ぶファイルは belongsToSession も参照している', () => {
    const offenders = ALL_SOURCES.filter((file) => {
      if (isDefinitionSide(file)) return false;
      const code = stripComments(readFileSync(file, 'utf8'));
      return /\bgetDraft\s*\(/.test(code) && !/\bbelongsToSession\b/.test(code);
    }).map((f) => path.relative(WEB_SRC, f).replaceAll('\\', '/'));
    expect(offenders, `所属判定を通らずに下書きを取っている: ${offenders.join(', ')}`).toEqual([]);
  });
});
