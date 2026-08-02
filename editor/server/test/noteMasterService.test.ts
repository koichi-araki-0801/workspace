// =============================================================================
// noteMasterService.test.ts — 注記マスタ書き戻し・生成時適用の単体テスト
// =============================================================================
// DB(sproc)・ファイル I/O・カタログは部分モックで差し替え、サービスの規約
// (`反映` パーツのみ / 先頭出現を正 / 適用は全出現 / 失敗はベストエフォート)を検証する。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/sproc.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/db/sproc.js')>();
  return { ...orig, callSproc: vi.fn() };
});
vi.mock('../src/repositories/partRepo.js', () => ({ listParts: vi.fn() }));
vi.mock('../src/files/templateFiles.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/templateFiles.js')>();
  return { ...orig, readTemplateHtml: vi.fn() };
});

import type { PartCatalogItem, PartMasterReflectDefault } from '@editor/shared';
import { callSproc, type Param } from '../src/db/sproc.js';
import { SP } from '../src/db/sprocNames.js';
import { readTemplateHtml } from '../src/files/templateFiles.js';
import { listParts } from '../src/repositories/partRepo.js';
import {
  applyNoteMasterToHtml,
  reflectNoteMasterAfterConfirm,
} from '../src/sync/noteMasterService.js';

const callSprocMock = vi.mocked(callSproc);
const listPartsMock = vi.mocked(listParts);
const readTemplateHtmlMock = vi.mocked(readTemplateHtml);

const part = (id: string, text: string): string =>
  `<section data-part-id="${id}"><p>${text}</p></section>`;
const doc = (...parts: string[]): string =>
  `<html><body><div class="page">\n${parts.join('\n')}\n</div></body></html>`;

/** テストに要る 2 列以外は素通しの詰め物でカタログ 1 行を作る。 */
const catalogItem = (
  id: string,
  masterReflectDefault: PartMasterReflectDefault | null,
): PartCatalogItem => ({
  id,
  classification: { category: 'c', majorClass: 'ma', middleClass: 'mi', minorClass: 's' },
  name: id,
  description: '',
  usageNotes: '',
  updatedAt: null,
  updatedBy: null,
  content: '',
  syncDefault: null,
  masterReflectDefault,
});

/** callSproc 呼び出しのパラメータ配列を `名前 → 値` の平易な形に写す(検証用)。 */
const paramMap = (params: Param[]): Record<string, unknown> =>
  Object.fromEntries(params.map((x) => [x.name, x.value]));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reflectNoteMasterAfterConfirm', () => {
  it('反映=対象パーツの先頭出現のみを、ファンド・版種つきで upsert する', async () => {
    readTemplateHtmlMock.mockResolvedValue(
      doc(part('note-a', '一回目'), part('other', 'X'), part('note-a', '二回目')),
    );
    listPartsMock.mockResolvedValue([catalogItem('note-a', '反映'), catalogItem('other', null)]);
    callSprocMock.mockResolvedValue([]);

    const res = await reflectNoteMasterAfterConfirm('AM01_510037_20240710_交付版', 'approver1');

    expect(res).toEqual({ updated: ['note-a'], error: null });
    expect(callSprocMock).toHaveBeenCalledTimes(1);
    const [proc, op, params] = callSprocMock.mock.calls[0];
    expect(proc).toBe(SP.noteMaster);
    expect(op).toBe('反映');
    expect(paramMap(params ?? [])).toEqual({
      パーツID: 'note-a',
      ファンドコード: '510037',
      版種: '交付版',
      注記HTML: part('note-a', '一回目'),
      更新者: 'approver1',
    });
  });

  it('非反映・未判断(null)のパーツは書き戻さない', async () => {
    readTemplateHtmlMock.mockResolvedValue(doc(part('no', 'X'), part('undecided', 'Y')));
    listPartsMock.mockResolvedValue([catalogItem('no', '非反映'), catalogItem('undecided', null)]);

    const res = await reflectNoteMasterAfterConfirm('AM01_510037_20240710_交付版', 'approver1');

    expect(res).toEqual({ updated: [], error: null });
    expect(callSprocMock).not.toHaveBeenCalled();
  });

  it('テンプレ ID が解決できなければ null(何もしない)', async () => {
    const res = await reflectNoteMasterAfterConfirm('壊れたID', 'approver1');
    expect(res).toBeNull();
    expect(readTemplateHtmlMock).not.toHaveBeenCalled();
  });

  it('DB 失敗は throw せず error 付き summary に倒す(承認は成立済みの前提)', async () => {
    readTemplateHtmlMock.mockResolvedValue(doc(part('note-a', 'A')));
    listPartsMock.mockResolvedValue([catalogItem('note-a', '反映')]);
    callSprocMock.mockRejectedValue(new Error('DB 停止中'));

    const res = await reflectNoteMasterAfterConfirm('AM01_510037_20240710_交付版', 'approver1');
    expect(res).toEqual({ updated: [], error: 'DB 停止中' });
  });

  it('カタログ取得の失敗も同様に error summary へ倒す', async () => {
    readTemplateHtmlMock.mockResolvedValue(doc(part('note-a', 'A')));
    listPartsMock.mockRejectedValue(new Error('カタログ不達'));

    const res = await reflectNoteMasterAfterConfirm('AM01_510037_20240710_交付版', 'approver1');
    expect(res).toEqual({ updated: [], error: 'カタログ不達' });
  });

  it('Error でない失敗値も文字列化して error へ載せる', async () => {
    readTemplateHtmlMock.mockResolvedValue(doc(part('note-a', 'A')));
    listPartsMock.mockRejectedValue('文字列 reject');

    const res = await reflectNoteMasterAfterConfirm('AM01_510037_20240710_交付版', 'approver1');
    expect(res).toEqual({ updated: [], error: '文字列 reject' });
  });
});

describe('applyNoteMasterToHtml', () => {
  it('マスタ行がある partId の全出現を置換し、非対象パーツはバイト不変', async () => {
    const master = part('note-a', '承認済みの新文言');
    callSprocMock.mockResolvedValue([{ パーツID: 'note-a', 注記HTML: master }]);
    const html = doc(part('note-a', '生成器の旧文言'), part('b', 'B'), part('note-a', '別出現'));

    const res = await applyNoteMasterToHtml(html, '510037', '交付版');

    expect(res).toBe(doc(master, part('b', 'B'), master));
    const [, op, params] = callSprocMock.mock.calls[0];
    expect(op).toBe('取得');
    expect(paramMap(params ?? [])).toEqual({ ファンドコード: '510037', 版種: '交付版' });
  });

  it('マスタが空なら入力をそのまま返す', async () => {
    callSprocMock.mockResolvedValue([]);
    const html = doc(part('note-a', 'A'));
    await expect(applyNoteMasterToHtml(html, '510037', '交付版')).resolves.toBe(html);
  });

  it('注記HTML が NULL の行は適用対象にしない', async () => {
    callSprocMock.mockResolvedValue([{ パーツID: 'note-a', 注記HTML: null }]);
    const html = doc(part('note-a', 'A'));
    await expect(applyNoteMasterToHtml(html, '510037', '交付版')).resolves.toBe(html);
  });

  it('マスタ行の partId が生成 HTML に無ければそのまま返す', async () => {
    callSprocMock.mockResolvedValue([{ パーツID: 'ghost', 注記HTML: part('ghost', 'G') }]);
    const html = doc(part('note-a', 'A'));
    await expect(applyNoteMasterToHtml(html, '510037', '交付版')).resolves.toBe(html);
  });

  it('DB 失敗は throw せず未適用のまま返す(生成をブロックしない)', async () => {
    callSprocMock.mockRejectedValue(new Error('DB 停止中'));
    const html = doc(part('note-a', 'A'));
    await expect(applyNoteMasterToHtml(html, '510037', '交付版')).resolves.toBe(html);
  });
});
