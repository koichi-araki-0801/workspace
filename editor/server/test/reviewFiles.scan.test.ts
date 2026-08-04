// =============================================================================
// reviewFiles.scan.test.ts — 承認一覧の走査上限の degrade 方向
// =============================================================================
// 申請ディレクトリ名は `randomUUID` 由来で時系列順ではない。readdir 順のまま `slice` すると、
// 上限に達したとき「どれが落ちるか」が名前の辞書順という利用者から見て無意味な軸で決まり、
// **承認待ちの新しい申請が消える**。degrade は「古いものから見えなくなる」でなければならない。
// よって本テストは「新しい申請が上限超過でも一覧に残る」ことを主張する形で書く。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const reviewsDir = path.join(
  os.tmpdir(),
  `editor-reviews-scan-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
);
process.env.REVIEWS_DIR = reviewsDir;

// 走査上限を実際に超えさせたいので、pino のログは黙らせる(警告そのものは出る)。
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  audit: vi.fn(),
  actorFromReq: () => ({}),
  auditedRethrow: async (_r: unknown, _e: unknown, fn: () => unknown) => fn(),
}));

const { listReviewMetas, MAX_REVIEW_SCAN } = await import('../src/files/reviewFiles.js');

/** meta.json だけを持つ申請ディレクトリを作る(本体は一覧に不要)。 */
async function makeReview(id: string, mtime: Date): Promise<void> {
  const dir = path.join(reviewsDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      id,
      templateId: 'T1',
      requestedBy: 'editor',
      requestedAt: mtime.toISOString(),
      status: 'pending',
    }),
    'utf8',
  );
  await fs.utimes(dir, mtime, mtime);
}

describe('listReviewMetas の走査上限', () => {
  beforeAll(async () => {
    await fs.mkdir(reviewsDir, { recursive: true });
    // 上限を 1 件だけ超える。古い側の名前が辞書順で先に来るように `a…` を付ける
    // (readdir 順のまま切ると、新しい `zz-newest` が確実に落ちる形)。
    const old = new Date('2020-01-01T00:00:00Z');
    await Promise.all(
      Array.from({ length: MAX_REVIEW_SCAN }, (_, i) =>
        makeReview(`aa-old-${String(i).padStart(5, '0')}`, old),
      ),
    );
    await makeReview('zz-newest', new Date('2026-08-05T00:00:00Z'));
  }, 120_000);

  afterAll(async () => {
    await fs.rm(reviewsDir, { recursive: true, force: true }).catch(() => {});
  });

  it('上限を超えても最新の申請は一覧に残る(古い側から見えなくなる)', async () => {
    const metas = await listReviewMetas();
    expect(metas).toHaveLength(MAX_REVIEW_SCAN);
    expect(metas.map((m) => m.id)).toContain('zz-newest');
  }, 120_000);
});
