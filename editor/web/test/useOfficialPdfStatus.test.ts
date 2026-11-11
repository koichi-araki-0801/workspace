// =============================================================================
// useOfficialPdfStatus.test.ts — 正式 PDF の状態の問い合わせ(開始・停止・作り直し)
// =============================================================================
import { err, type OfficialPdfStatus, ok } from '@editor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { pollOfficialPdf, useOfficialPdfStatus } from '@/lib/useOfficialPdfStatus';

const repo = vi.hoisted(() => ({ officialPdfStatus: vi.fn(), rebuildOfficialPdf: vi.fn() }));
vi.mock('@/api/repositories', () => ({ useTemplateRepo: () => repo }));

const st = (state: OfficialPdfStatus['state']): OfficialPdfStatus => ({
  id: 'X',
  state,
  updatedAt: null,
  error: null,
});

beforeEach(() => {
  vi.useFakeTimers();
  repo.officialPdfStatus.mockReset();
  repo.rebuildOfficialPdf.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pollOfficialPdf', () => {
  it('queued / building の間だけ間隔を置いて繰り返し、done で止まる', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok(st('queued')))
      .mockResolvedValueOnce(ok(st('building')))
      .mockResolvedValue(ok(st('done')));
    const seen: string[] = [];
    pollOfficialPdf(f, (s) => seen.push(s.state), 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(['queued', 'building', 'done']);
  });

  it('問い合わせが失敗したら止まる(失敗・例外とも)', async () => {
    const f = vi.fn().mockResolvedValue(err({ message: 'x' }));
    pollOfficialPdf(f, vi.fn(), 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f).toHaveBeenCalledTimes(1);
    const g = vi.fn().mockRejectedValue(new Error('boom'));
    pollOfficialPdf(g, vi.fn(), 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('止める関数で以降の問い合わせをやめる', async () => {
    const f = vi.fn().mockResolvedValue(ok(st('building')));
    const stop = pollOfficialPdf(f, vi.fn(), 1000);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('応答待ちの間に止めたら通知しない', async () => {
    let resolve: (v: unknown) => void = () => {};
    const f = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const onUpdate = vi.fn();
    const stop = pollOfficialPdf(f as never, onUpdate, 1000);
    stop();
    resolve(ok(st('done')));
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe('useOfficialPdfStatus', () => {
  it('start で状態を取り、stop で止める', async () => {
    repo.officialPdfStatus.mockResolvedValue(ok(st('building')));
    const h = useOfficialPdfStatus(ref('X'), { intervalMs: 1000 });
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status.value?.state).toBe('building');
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.officialPdfStatus).toHaveBeenCalledTimes(2);
    h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(repo.officialPdfStatus).toHaveBeenCalledTimes(2);
  });

  it('rebuild は状態を queued にして問い合わせを再開する', async () => {
    repo.rebuildOfficialPdf.mockResolvedValue(ok(st('queued')));
    let release: (v: unknown) => void = () => {};
    repo.officialPdfStatus.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const h = useOfficialPdfStatus(ref('X'), { intervalMs: 1000 });
    await h.rebuild();
    expect(repo.rebuildOfficialPdf).toHaveBeenCalledWith('X');
    expect(h.status.value?.state).toBe('queued');
    release(ok(st('done')));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status.value?.state).toBe('done');
  });

  it('rebuild が失敗したら状態を変えない', async () => {
    repo.rebuildOfficialPdf.mockResolvedValue(err({ message: 'x' }));
    const h = useOfficialPdfStatus(ref('X'));
    await h.rebuild();
    expect(h.status.value).toBeNull();
    expect(repo.officialPdfStatus).not.toHaveBeenCalled();
  });
});
