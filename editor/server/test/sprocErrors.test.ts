// =============================================================================
// sprocErrors.test.ts — SQL エラー → AppError 変換で内部情報を漏らさない
// =============================================================================
// `errorHandler` は `AppError` の `kind` / `message` / `code` をクライアントへ返す
// (`cause` だけが伏せられる)。したがって `message` に何を入れるかがそのまま情報開示の
// 境界になる。2627 / 2601 は**我々の THROW ではなく SQL Server のシステムエラー**で、
// 本文に制約名・スキーマ修飾のテーブル名・重複キーの値が入る。ゲートウェイ sproc は
// DML を TRY/CATCH で包まないので、実際の一意違反はそのままここへ届く。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../src/db/pool.js', () => ({ query: (...a: unknown[]) => query(...a) }));

async function callWith(err: unknown): Promise<{ kind: string; message: string }> {
  const { callSproc } = await import('../src/db/sproc.js');
  query.mockRejectedValueOnce(err);
  try {
    await callSproc('usp_x', '作成');
    throw new Error('should have thrown');
  } catch (e) {
    return e as { kind: string; message: string };
  }
}

/** 実際に SQL Server が返す一意制約違反の本文(制約名・テーブル名・重複値を含む)。 */
const RAW_2627 =
  '[Microsoft][ODBC Driver 17 for SQL Server][SQL Server]Violation of PRIMARY KEY constraint ' +
  "'PK_Rep1_運報自動化_Editor_ユーザー'. Cannot insert duplicate key in object " +
  "'ug01.Rep1_運報自動化_Editor_ユーザー'. The duplicate key value is (admin).";

beforeEach(() => {
  query.mockReset();
});

describe('システムエラーの本文は転送しない', () => {
  it('2627 は分類だけ使い、文言は定型文にする', async () => {
    const e = await callWith({ number: 2627, message: RAW_2627 });
    expect(e.kind).toBe('conflict');
    expect(e.message).toBe('すでに存在するか、競合しています');
    expect(e.message).not.toContain('PRIMARY KEY');
    expect(e.message).not.toContain('ug01.');
    expect(e.message).not.toContain('admin');
  });

  it('2601(一意索引違反)も同じ', async () => {
    const e = await callWith({
      number: 2601,
      message:
        "[SQL Server]Cannot insert duplicate key row in object 'ug01.T' with unique index 'IX_T'.",
    });
    expect(e.kind).toBe('conflict');
    expect(e.message).toBe('すでに存在するか、競合しています');
  });

  it('原文は cause(ログ専用)に残る — 運用の調査能力は落とさない', async () => {
    const e = (await callWith({ number: 2627, message: RAW_2627 })) as { cause?: unknown };
    expect(JSON.stringify(e.cause)).toContain('PRIMARY KEY');
  });
});

describe('自前 THROW のメッセージは従来どおり転送する', () => {
  it.each([
    [50404, 'not_found', 'ユーザーが見つかりません'],
    [50409, 'conflict', 'このログインIDは既に使われています'],
    [50000, 'validation', '公開ID が必要です'],
    [50400, 'validation', '入力の形式が不正です'],
  ])('%i は本文をそのまま返す', async (num, kind, text) => {
    const e = await callWith({ number: num, message: `[SQL Server]${text}` });
    expect(e.kind).toBe(kind);
    expect(e.message).toBe(text);
  });
});

describe('番号はメッセージ本文から拾わない', () => {
  it('本文に 50404 の字面があるだけの未知エラーは汎用文言へ落ちる', async () => {
    // メッセージ由来の番号で転送分岐を選べると、「メッセージの中身が、そのメッセージを
    // 転送してよいかを決める」形になる(任意の DB エラー文をユーザーへ出せる)。
    const e = await callWith({
      message: "[SQL Server]Invalid column name '50404' in table 'ug01.秘密テーブル'.",
    });
    expect(e.kind).toBe('unexpected');
    expect(e.message).toBe('データベース処理に失敗しました');
  });

  it('構造化フィールド(odbcErrors 配列)からは従来どおり読む', async () => {
    const e = await callWith({ odbcErrors: [{ code: 50404 }], message: '[SQL Server]無い' });
    expect(e.kind).toBe('not_found');
    expect(e.message).toBe('無い');
  });
});
