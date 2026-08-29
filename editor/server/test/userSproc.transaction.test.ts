// =============================================================================
// userSproc.transaction.test.ts — パスワード書換とセッション失効の不可分性
// =============================================================================
// `user.sql` のヘッダは「失効は同一トランザクションでなければならない」と宣言している。
// 実装がそれに追随しているかは Node 側からは見えない(sproc は DB 内で動く)ので、
// **SQL ソースの構造**を検査して宣言と実装の乖離を止める。
//
// 乖離が生む状態: SQL Server の既定 autocommit では文ごとに別トランザクションなので、
// 2 文目(セッション失効)が失敗すると「パスワードは新しいのに旧セッションは生きている」
// が残る。しかも呼び出し側には 500 が返るため、利用者は「変わっていない」と受け取る。
//
// ⚠ ここを緑にしても**配備済み DB は変わらない**。`server/db/apply.ps1` の再実行が要る。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'sproc', 'user.sql'),
  'utf8',
);

/** `@操作 = N'<名前>'` の分岐本文(次の分岐コメントまで)。 */
function branch(name: string): string {
  const start = sql.indexOf(`IF @操作 = N'${name}'`);
  expect(start, `分岐が見つからない: ${name}`).toBeGreaterThan(0);
  const end = sql.indexOf('/* ----', start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

describe('資格情報を書き換える分岐は明示トランザクションで包む', () => {
  it('プロシージャ全体で XACT_ABORT を立てる', () => {
    // これが無いと、エラーの種類によっては開いたまま次の文へ進み COMMIT に到達して
    // 部分適用が確定する。
    expect(sql).toMatch(/SET\s+XACT_ABORT\s+ON;/);
  });

  it.each([
    'PWリセット',
    'PW初期化',
  ])('%s は BEGIN TRAN 〜 COMMIT で 2 つの UPDATE を束ねる', (name) => {
    const b = branch(name);
    expect(b).toMatch(/BEGIN\s+TRANSACTION;/);
    expect(b).toMatch(/COMMIT\s+TRANSACTION;/);
    // ユーザー表とセッション表の更新が同じ束の中にある。
    const tranStart = b.indexOf('BEGIN TRANSACTION;');
    const tranEnd = b.indexOf('COMMIT TRANSACTION;');
    const body = b.slice(tranStart, tranEnd);
    expect(body).toContain('[PWハッシュ]');
    expect(body).toContain('[失効]');
  });

  it.each([
    'PWリセット',
    'PW初期化',
  ])('%s は失敗時に ROLLBACK し、番号を保って再送出する', (name) => {
    const b = branch(name);
    expect(b).toMatch(/BEGIN\s+CATCH/);
    expect(b).toMatch(/IF\s+XACT_STATE\(\)\s*<>\s*0\s+ROLLBACK\s+TRANSACTION;/);
    // `THROW;`(引数なし)でないと元の THROW 番号が失われ、Node 側の番号規約が壊れる。
    expect(b).toMatch(/\n\s*THROW;/);
  });
});
