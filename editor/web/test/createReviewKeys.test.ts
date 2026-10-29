// =============================================================================
// createReviewKeys.test.ts — 作成経路の申請で、右欄の行のキーとサーバの照合のキーが一致すること
// =============================================================================
// 作成経路の申請では、承認タブの右欄の行(判定を送るキー)は値入り HTML の本文の差分
// (`reviewDiffService.ts`: worker の linkedom で `buildHtmlDiff('', 本文)`)から作り、サーバは
// 判定の保存と最終確定で Jinja 原文のパーツ(`extractReviewParts`)と照合する
// (`server/src/repositories/reviewRepo.ts` の `decidablePartKeys`、shared の
// `buildCreateReviewedHtml`)。両者が食い違うと、画面で押した判定が 400 で拒まれる。テスト用の全
// fixture(Jinja 原文 `fixtures/templates/` と値入り `fixtures/filled/` の組)で同じキーになることを
// 固定する。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildHtmlDiff, extractReviewParts } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { getBodyInner } from '@/lib/templateDoc';
import { linkedomParser } from '@/workers/htmlWorkerImpl';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const names = readdirSync(path.join(FIXTURES, 'templates')).filter((n) => n.endsWith('.html'));
const read = (dir: string, n: string) => readFileSync(path.join(FIXTURES, dir, n), 'utf8');

/** 右欄の行のキー(作成経路は比較元が空なので、すべて追加のブロック)。 */
function screenKeys(filled: string): string[] {
  const diff = buildHtmlDiff('', getBodyInner(filled), linkedomParser);
  expect(diff.truncated).toBe(false);
  return [
    ...new Set(
      diff.pages.flatMap((p) => p.blocks.filter((b) => b.status !== 'same').map((b) => b.partKey)),
    ),
  ];
}

describe('作成経路の申請の判定のキー', () => {
  it('Jinja 原文と値入りの組が 1 件以上ある', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(readdirSync(path.join(FIXTURES, 'filled'))).toContain(n);
  });

  it.each(names)('%s: 右欄の行のキー = Jinja 原文のパーツのキー = 値入りのパーツのキー', (n) => {
    const source = extractReviewParts(read('templates', n)).map((p) => p.partKey);
    const filled = read('filled', n);
    expect(source.length).toBeGreaterThan(0);
    expect(extractReviewParts(filled).map((p) => p.partKey)).toEqual(source);
    expect(new Set(screenKeys(filled))).toEqual(new Set(source));
  });
});
