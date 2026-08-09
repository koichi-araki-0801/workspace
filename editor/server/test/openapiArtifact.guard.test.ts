// =============================================================================
// openapiArtifact.guard.test.ts — コミット済み openapi.json の陳腐化を CI で落とす
// =============================================================================
// `openapi/openapi.json` は `scripts/gen-openapi.ts` の生成物だが、生成は手動なので
// **再生成し忘れても誰も気付かない**。実際に、`Username` の
// 形式検査・本文サイズ上限(`maxLength`)・`TemplateId`・`POST /build/merge` といった契約の
// 変更が数コミット分そのまま取り残された実例がある(再生成で 652 行追加 / 107 行削除)。
//
// この生成物は**外部クライアント向けの公開契約**である(`docs/editor/src/設計正典.md` の
// 「vivliostyle build/preview API は外部公開面」)。古い JSON は「単に古い」では済まず、
// 認証が要る `/auth/init-password` を `security: []` のまま見せる・一時パスワードを運ぶ
// 応答形(`CreatedUser` / `PasswordResetResult`)を旧契約のまま見せる、といった**実装と
// 食い違う安全側でない記述**を配る。ゆえにドリフトはテストで落とす。
//
// 検査は 2 段:
//   1. 意味(パースした構造)の一致 — 契約そのもの。差分はパスを列挙して原因を示す。
//   2. バイトの一致 — 手編集や整形ツールの混入を落とす。`openapi.json` は生成物なので
//      biome の対象外にしてある(`biome.json` の `files.includes` に否定エントリ)。
//      これが無いと biome が短い配列を 1 行へ畳み、生成器の出力と恒久的にずれる。
//
// なお本テストの `@editor/shared` は vitest の alias で **source** を解決するのに対し、
// `openapi:gen`(tsx)は package exports 経由で `shared/dist` を解決する。したがって
// `shared/dist` が古いだけでもここは赤くなる。再生成コマンドに shared のビルドを含めるのは
// そのため。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/document.js';

const artifactPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'openapi',
  'openapi.json',
);

/** 失敗時にそのまま貼れる再生成コマンド(読み手に探させない)。 */
const REGEN_COMMAND =
  'pnpm --filter @editor/shared run build && pnpm --filter server run openapi:gen';

/** `scripts/gen-openapi.ts` と同一の直列化(2 space + 末尾改行)。 */
const serialize = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

/** 差分 1 件の右辺。巨大な description で出力が埋まらないよう頭だけ見せる。 */
const brief = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 構造差分を JSON Pointer 風のパスで列挙する。`toEqual` の生の diff は 3300 行の文書では
 * 読めないため、「どの契約がずれたか」だけを行として返す。
 */
const collectDifferences = (committed: unknown, generated: unknown, at: string): string[] => {
  if (JSON.stringify(committed) === JSON.stringify(generated)) return [];
  if (isPlainObject(committed) && isPlainObject(generated)) {
    const keys = new Set([...Object.keys(committed), ...Object.keys(generated)]);
    return [...keys].flatMap((key) => {
      const where = `${at}/${key}`;
      if (!(key in committed)) return [`+ ${where} = ${brief(generated[key])}`];
      if (!(key in generated)) return [`- ${where} = ${brief(committed[key])}`];
      return collectDifferences(committed[key], generated[key], where);
    });
  }
  if (Array.isArray(committed) && Array.isArray(generated)) {
    const length = Math.max(committed.length, generated.length);
    return Array.from({ length }, (_, i) => i).flatMap((i) => {
      const where = `${at}[${i}]`;
      if (i >= committed.length) return [`+ ${where} = ${brief(generated[i])}`];
      if (i >= generated.length) return [`- ${where} = ${brief(committed[i])}`];
      return collectDifferences(committed[i], generated[i], where);
    });
  }
  return [`~ ${at}: ${brief(committed)} -> ${brief(generated)}`];
};

describe('コミット済み openapi.json は生成物と一致する', () => {
  const committedText = fs.readFileSync(artifactPath, 'utf8');
  const generatedText = serialize(buildOpenApiDocument());

  it('公開契約(パース結果)がソースから生成した document と一致する', () => {
    const differences = collectDifferences(
      JSON.parse(committedText),
      // 直列化を通してから比較する。`undefined` のプロパティは JSON に載らないので、
      // 生の document と突き合わせると「消えたキー」を偽の差分として拾う。
      JSON.parse(generatedText),
      '',
    );
    // 全件出すと巨大 description で流れるため、先頭 20 件だけを提示する。
    expect(
      differences.slice(0, 20),
      `openapi.json がソースと食い違っている(差分 ${differences.length} 件)。` +
        `\`${REGEN_COMMAND}\` を実行し、生成結果をコミットすること。`,
    ).toEqual([]);
  });

  it('バイト列も生成器の出力そのままである(手編集・整形ツールの混入を落とす)', () => {
    expect(
      committedText,
      `openapi.json は生成物であり手で編集しない。整形だけの差でも ` +
        `\`${REGEN_COMMAND}\` を実行して結果をコミットすること。`,
    ).toBe(generatedText);
  });
});
