// =============================================================================
// partRepo.test.ts — パーツカタログ repo が sproc の引数と戻りをどう写すか
// =============================================================================
import { describe, expect, it } from 'vitest';
import type { Param, Row, SprocClient } from '../src/db/sproc.js';
import { createPartRepo } from '../src/repositories/partRepo.js';

function stub(rows: Row[]): { sproc: SprocClient; calls: Array<{ op: string; params: Param[] }> } {
  const calls: Array<{ op: string; params: Param[] }> = [];
  const sproc = {
    callSproc: async (_name: string, op: string, params: Param[]) => {
      calls.push({ op, params });
      return rows;
    },
  } as unknown as SprocClient;
  return { sproc, calls };
}

const row = (対象版種: string | null, 委託会社コード: string | null = null): Row => ({
  パーツID: 'x',
  カテゴリ: 'c',
  大分類: 'a',
  中分類: 'b',
  小分類: 'd',
  名称: 'n',
  説明: '',
  使用上の注意: '',
  内容HTML: '',
  更新日時: null,
  更新者: null,
  同期既定: null,
  次回反映既定: null,
  対象版種,
  委託会社コード,
});

describe('partRepo', () => {
  it('editionType を 版種 として分類候補と一覧の両方へ渡す', async () => {
    const { sproc, calls } = stub([]);
    const repo = createPartRepo(sproc);
    await repo.getPartClassificationOptions({ editionType: '交付版' });
    await repo.listParts({ editionType: '交付版' });
    expect(calls.map((c) => c.op)).toEqual(['分類候補', '一覧']);
    for (const c of calls) {
      expect(c.params.find((x) => x.name === '版種')?.value).toBe('交付版');
    }
  });

  it('editionType が空・未指定なら 版種 引数を送らない', async () => {
    const { sproc, calls } = stub([]);
    const repo = createPartRepo(sproc);
    for (const q of [{}, { editionType: '' }]) {
      await repo.getPartClassificationOptions(q);
      await repo.listParts(q);
    }
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.params.some((x) => x.name === '版種')).toBe(false);
  });

  it('対象版種 を targetEdition に写し、NULL は null にする', async () => {
    const { sproc } = stub([row(null), row('全体版')]);
    const items = await createPartRepo(sproc).listParts({});
    expect(items.map((i) => i.targetEdition)).toEqual([null, '全体版']);
  });

  it('companyCode を 委託会社コード として分類候補と一覧の両方へ渡す', async () => {
    const { sproc, calls } = stub([]);
    const repo = createPartRepo(sproc);
    await repo.getPartClassificationOptions({ companyCode: '00001' });
    await repo.listParts({ companyCode: '00001' });
    expect(calls.map((c) => c.op)).toEqual(['分類候補', '一覧']);
    for (const c of calls) {
      expect(c.params.find((x) => x.name === '委託会社コード')?.value).toBe('00001');
    }
  });

  it('companyCode が空・未指定なら 委託会社コード 引数を送らない', async () => {
    const { sproc, calls } = stub([]);
    const repo = createPartRepo(sproc);
    for (const q of [{}, { companyCode: '' }]) {
      await repo.getPartClassificationOptions(q);
      await repo.listParts(q);
    }
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.params.some((x) => x.name === '委託会社コード')).toBe(false);
  });

  it('委託会社コード を RTRIM して companyCode に写し、NULL は null にする', async () => {
    const { sproc } = stub([row(null, '00001 '), row(null, null)]);
    const items = await createPartRepo(sproc).listParts({});
    expect(items.map((i) => i.companyCode)).toEqual(['00001', null]);
  });
});
