// =============================================================================
// audit.test.ts — 監査ログ複写の実行面の差し替え(setAuditSink)を検証する
// =============================================================================
// D4 で `auditToDb` の呼び先がモジュール変数 `sink` になったので、`setAuditSink` で
// フェイクへ差し替えたときに `SP.audit` の `登録` 操作へ正しく引数が渡ることを見る。
import { describe, expect, it } from 'vitest';
import { auditToDb, setAuditSink } from '../src/db/audit.js';
import type { Row, SprocClient } from '../src/db/sproc.js';
import { SP } from '../src/db/sprocNames.js';

describe('auditToDb', () => {
  it('setAuditSink で差し込んだ実行面へ SP.audit の登録として複写する', async () => {
    const calls: Array<{ proc: string; op: string; params: unknown[] }> = [];
    const fake: SprocClient = {
      callSproc: async <T = Row>(
        proc: string,
        操作: string,
        params?: { name: string; value: unknown }[],
      ) => {
        calls.push({ proc, op: 操作, params: params ?? [] });
        return [] as T[];
      },
    };
    setAuditSink(fake);

    await auditToDb({
      event: 'template.save',
      outcome: 'success',
      actor: 'tester',
      ip: '127.0.0.1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.proc).toBe(SP.audit);
    expect(calls[0]?.op).toBe('登録');
    expect(calls[0]?.params).toEqual(
      expect.arrayContaining([
        { name: 'イベント', value: 'template.save' },
        { name: '結果', value: 'success' },
        { name: '実行者', value: 'tester' },
      ]),
    );
  });
});
