// =============================================================================
// noteMasterRepo.test.ts — 注記マスタ repo が sproc の操作名・引数と戻りをどう写すか
// =============================================================================
// 操作名は本番の定数を読まず文字列で書く(定数の書き間違いを写さないため)。
import { describe, expect, it } from 'vitest';
import type { Param, Row, SprocClient } from '../src/db/sproc.js';
import { SP } from '../src/db/sprocNames.js';
import { createNoteMasterRepo } from '../src/repositories/noteMasterRepo.js';

function stub(rows: Row[] = []): {
  sproc: SprocClient;
  calls: Array<{ proc: string; op: string; params: Param[] }>;
} {
  const calls: Array<{ proc: string; op: string; params: Param[] }> = [];
  const sproc = {
    callSproc: async (proc: string, op: string, params: Param[] = []) => {
      calls.push({ proc, op, params });
      return rows;
    },
  } as unknown as SprocClient;
  return { sproc, calls };
}

const asMap = (params: Param[]): Record<string, unknown> =>
  Object.fromEntries(params.map((x) => [x.name, x.value]));

describe('noteMasterRepo', () => {
  it('upsertNoteMaster は `反映` へ 5 列を渡す', async () => {
    const { sproc, calls } = stub();
    await createNoteMasterRepo(sproc).upsertNoteMaster({
      partId: 'note-a',
      fundCode: '950037',
      editionType: '交付版',
      noteHtml: '<span>x</span>',
      actor: 'approver1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].proc).toBe(SP.noteMaster);
    expect(calls[0].op).toBe('反映');
    expect(asMap(calls[0].params)).toEqual({
      パーツID: 'note-a',
      ファンドコード: '950037',
      版種: '交付版',
      注記HTML: '<span>x</span>',
      更新者: 'approver1',
    });
  });

  // NULL の行を捨てるかはサービスが決める。repo は列を型へ写すだけで、行を減らさない。
  it('listNoteMasters は `取得` を呼び、注記HTML の NULL を null のまま返す', async () => {
    const { sproc, calls } = stub([
      { パーツID: 'note-a', 注記HTML: 'A' },
      { パーツID: 'note-b', 注記HTML: null },
    ]);
    await expect(createNoteMasterRepo(sproc).listNoteMasters('950037', '交付版')).resolves.toEqual([
      { partId: 'note-a', noteHtml: 'A' },
      { partId: 'note-b', noteHtml: null },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].proc).toBe(SP.noteMaster);
    expect(calls[0].op).toBe('取得');
    expect(asMap(calls[0].params)).toEqual({ ファンドコード: '950037', 版種: '交付版' });
  });
});
