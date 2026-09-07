// =============================================================================
// sprocClient.test.ts — sproc 実行面の組み立てと SQL エラー変換
// =============================================================================
// `createSprocClient` は「EXEC 文の組み立て」と「SQL エラー → `AppError` 変換」だけを持つ
// 継ぎ目で、実行面(`QueryFn`)は本番がプール、テストが in-memory フェイクを渡す。ここで
// 主張するのは (1) `@操作` が必ず先頭に来て値は位置指定で渡ること、(2) 値を SQL へ
// 文字列補間しないこと、(3) 生 SQL エラーの番号だけで種別が決まることの 3 点。
import { describe, expect, it, vi } from 'vitest';
import { createSprocClient, p, type Row } from '../src/db/sproc.js';

const PROC = '[ug01].[Rep1_運報自動化_Editor_usp_ユーザー]';

describe('createSprocClient', () => {
  it('puts 操作 first and binds every value positionally', async () => {
    const query = vi.fn(async (): Promise<Row[]> => []);
    const sproc = createSprocClient(query);
    await sproc.callSproc(PROC, '作成', [p('ログインID', 'admin'), p('無効', undefined)]);
    expect(query).toHaveBeenCalledWith(`EXEC ${PROC} @操作=?, @ログインID=?, @無効=?`, [
      '作成',
      'admin',
      null,
    ]);
  });

  it('returns the rows the query function resolves', async () => {
    const rows: Row[] = [{ ログインID: 'admin' }];
    const sproc = createSprocClient(async () => rows);
    await expect(sproc.callSproc(PROC, '一覧')).resolves.toEqual(rows);
  });

  it('maps a raw 50409 SQL error to conflict and keeps our own message', async () => {
    const sproc = createSprocClient(async () => {
      throw Object.assign(new Error('[Microsoft][SQL Server]このログインIDは既に使われています'), {
        number: 50409,
      });
    });
    await expect(sproc.callSproc(PROC, '作成')).rejects.toMatchObject({
      kind: 'conflict',
      message: 'このログインIDは既に使われています',
    });
  });

  it('hides the message of a system error (2627) behind the fixed wording', async () => {
    const sproc = createSprocClient(async () => {
      throw Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_x'."), {
        number: 2627,
      });
    });
    await expect(sproc.callSproc(PROC, '作成')).rejects.toMatchObject({
      kind: 'conflict',
      message: 'すでに存在するか、競合しています',
    });
  });
});
