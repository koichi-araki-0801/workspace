// =============================================================================
// layering.guard.test.ts — server の層(routes → repositories → db)を飛ばす import を止める
// =============================================================================
// db 層(`db/` 配下の sproc ゲートウェイ)を値として import してよいのは、repositories/ と
// db/ 自身、組み立て(合成ルート)、監査ログ複写を動的 import する `logger.ts` だけにする。
// サービス(`auth/`・`sync/` など)が db を直接呼ぶと、DB の呼び方が repositories の外へ
// 散り、差し替えやテストの差し込み口が複数になる。
//
// 本ファイルはソースの字面を読む(書き方は `guardCoverage.guard.test.ts` に揃える)。
// `import type` だけの行は実行時の依存を作らないので数えない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.join(HERE, '..', 'src');

/** 拡張子で絞ってソースを再帰列挙する(生成物は見ない)。 */
function sourceFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      out.push(...sourceFiles(full, exts));
      continue;
    }
    if (exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `./db/…`・`../db/…`・`../../db/…` のような、db 層を指す相対指定子。
 * ESM の指定子は拡張子 `.js` まで書く前提なので、`.js` で終わるものだけを拾う。
 */
const DB_SPECIFIER = String.raw`['"]\.\.?\/(?:\.\.\/)*db\/[^'"]+\.js['"]`;

// 値として db 層を読む形を 3 つ数える。
//   - `import { a, type B } from '../db/x.js'`(`import type` で始まるものは除く)
//   - `export { a } from '../db/x.js'`(`export type` で始まるものは除く)
//   - `import '../db/x.js'` と `import('../db/x.js')`(副作用 import と動的 import)
// 句の部分に引用符と `;` を許さないことで、別の import 文から次の文の指定子までを
// 1 つの文として誤って跨がないようにする。
const DB_VALUE_IMPORT = new RegExp(
  [
    String.raw`\b(?:import|export)\s+(?!type\s)[^'";]*?\bfrom\s*${DB_SPECIFIER}`,
    String.raw`\bimport\s*${DB_SPECIFIER}`,
    String.raw`\bimport\(\s*${DB_SPECIFIER}\s*\)`,
  ].join('|'),
);

/** db 層を値として import している `src/` 相対のファイル名(区切りは `/`)。 */
function importersOfDb(): string[] {
  return sourceFiles(SERVER_SRC, ['.ts'])
    .filter((file) => DB_VALUE_IMPORT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SERVER_SRC, file).split(path.sep).join('/'))
    .sort();
}

describe('db 層を import してよいファイル', () => {
  it('db 層を値として import するのは repositories/・db/・合成ルート・logger だけ', () => {
    const allowed = (rel: string) =>
      rel.startsWith('repositories/') ||
      rel.startsWith('db/') ||
      ['app.ts', 'deps.ts', 'serve.ts', 'logger.ts'].includes(rel);
    expect(importersOfDb().filter((rel) => !allowed(rel))).toEqual([]);
  });

  // 字面の検出が緩すぎて何も拾わないと、上のテストは常に通ってしまう。既知の importer を
  // 拾えていることで検出そのものが働いていることを確かめる。
  it('検出は静的・動的の両方の import を拾い、import type だけのファイルは拾わない', () => {
    const found = importersOfDb();
    expect(found).toContain('app.ts');
    expect(found).toContain('logger.ts');
    expect(found).toContain('repositories/partRepo.ts');
    expect(found).not.toContain('deps.ts');
    expect(found).not.toContain('serve.ts');
  });
});

const SERVER_SCRIPTS = path.join(HERE, '..', 'scripts');

/** 第 2 引数(操作名)が文字列リテラルの `callSproc` 呼び出しを `ファイル:行` で集める。 */
function literalOpCalls(): string[] {
  const hits: string[] = [];
  for (const file of [
    ...sourceFiles(SERVER_SRC, ['.ts']),
    ...sourceFiles(SERVER_SCRIPTS, ['.ts']),
  ]) {
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : '';
        const op = node.arguments[1];
        if (
          name === 'callSproc' &&
          op !== undefined &&
          (ts.isStringLiteral(op) || ts.isNoSubstitutionTemplateLiteral(op))
        ) {
          const line = sf.getLineAndCharacterOfPosition(op.getStart(sf)).line + 1;
          hits.push(
            `${path.relative(path.join(HERE, '..'), file).split(path.sep).join('/')}:${line}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits.sort();
}

describe('操作名は OP の定数で渡す', () => {
  it('callSproc の第 2 引数に文字列リテラルを直書きしない', () => {
    expect(literalOpCalls()).toEqual([]);
  });

  // 読み取り専用の許可リストは `${SP.x}/${OP.x.y}` の形で組む。操作名を直書きすると、
  // 区切りの `/` 以外の文字がテンプレートの文字列部分に残る。
  it('measure-review-gates の READ_ONLY_OPS は操作名を直書きしない', () => {
    const file = path.join(SERVER_SCRIPTS, 'measure-review-gates.ts');
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const literals: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'READ_ONLY_OPS' &&
        node.initializer !== undefined
      ) {
        const set = node.initializer;
        if (
          ts.isNewExpression(set) &&
          set.arguments?.[0] &&
          ts.isArrayLiteralExpression(set.arguments[0])
        ) {
          for (const el of set.arguments[0].elements) {
            if (ts.isTemplateExpression(el)) {
              literals.push(...el.templateSpans.map((s) => s.literal.text));
            } else if (ts.isNoSubstitutionTemplateLiteral(el) || ts.isStringLiteral(el)) {
              literals.push(el.text);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(literals.length).toBeGreaterThan(0);
    // 区切りの `/` と、最後の `${…}` の後ろに残る末尾スパンの空文字だけを許す。
    expect(literals.filter((s) => !/^\/?$/.test(s))).toEqual([]);
  });
});
