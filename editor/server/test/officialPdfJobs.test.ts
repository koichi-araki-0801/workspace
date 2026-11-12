// =============================================================================
// officialPdfJobs.test.ts — 正式 PDF ジョブ(id ごとに 1 本・組版中の要求は 1 回に畳む)
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { createOfficialPdfJobs } from '../src/generate/officialPdfJobs.js';

const T1 = new Date('2026-11-11T01:00:00.000Z');
const D0 = '2026-11-11T00:00:00.000Z';

interface Ref {
  hash: string;
  date: string;
}
const C0: Ref = { hash: 'c0', date: D0 };
const C1: Ref = { hash: 'c1', date: '2026-11-11T02:00:00.000Z' };

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// git の偽物。filled の方が新しいかどうかは、祖先関係の答えとして与える
function setup(build: (id: string) => Promise<void>) {
  const pdf: { value: Ref | null } = { value: C0 };
  const filled: { value: Ref | null } = { value: null };
  const filledIsNewer = { value: false };
  const jobs = createOfficialPdfJobs({
    build,
    pdfCommit: async () => pdf.value,
    filledCommit: async () => filled.value,
    isAncestorOrSame: async (a, b) => a === b || !filledIsNewer.value,
    now: () => T1,
  });
  return { jobs, pdf, filled, filledIsNewer };
}

describe('officialPdfJobs', () => {
  it('runs one build per id and reports done', async () => {
    const d = deferred();
    const build = vi.fn(() => d.promise);
    const { jobs } = setup(build);
    jobs.request('A');
    expect((await jobs.status('A')).state).toBe('queued');
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    expect((await jobs.status('A')).state).toBe('building');
    d.resolve();
    await jobs.settled();
    expect(await jobs.status('A')).toEqual({
      id: 'A',
      state: 'done',
      updatedAt: D0,
      error: null,
    });
  });

  it('coalesces requests that arrive while building', async () => {
    const ds = [deferred(), deferred()];
    const build = vi.fn(() => ds[build.mock.calls.length - 1].promise);
    const { jobs } = setup(build);
    jobs.request('A');
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    jobs.request('A');
    jobs.request('A');
    jobs.request('A');
    ds[0].resolve();
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect((await jobs.status('A')).state).toBe('building');
    ds[1].resolve();
    await jobs.settled();
    expect(build).toHaveBeenCalledTimes(2);
    expect((await jobs.status('A')).state).toBe('done');
  });

  it('ends done when an approval commits filled during a build', async () => {
    const C2: Ref = { hash: 'c2', date: '2026-11-11T03:00:00.000Z' };
    let calls = 0;
    const state = setup(async () => {
      calls += 1;
      if (calls === 1) {
        // 組版の最中に承認が filled をコミットし、正式 PDF を要求する。判定は stale を見て落ちる
        state.filled.value = C1;
        state.filledIsNewer.value = true;
        state.jobs.request('A');
        throw new Error('not recorded');
      }
      // 畳まれた組み直しが新しい filled から PDF を作って記録する
      state.pdf.value = C2;
      state.filledIsNewer.value = false;
    });
    state.jobs.request('A');
    await state.jobs.settled();
    expect(calls).toBe(2);
    expect(await state.jobs.status('A')).toMatchObject({ state: 'done', error: null });
  });

  it('records failure message', async () => {
    const build = vi.fn(async () => {
      throw Object.assign(new Error('x'), { kind: 'unexpected', code: 'REPORT_RUN_FAILED' });
    });
    const { jobs, pdf } = setup(build);
    pdf.value = null;
    jobs.request('A');
    await jobs.settled();
    const st = await jobs.status('A');
    expect(st.state).toBe('failed');
    expect(st.error).toBe('x');
  });

  it('hides the raw message of an unclassified error', async () => {
    const { jobs, pdf } = setup(async () => {
      throw new Error('secret detail');
    });
    pdf.value = null;
    jobs.request('A');
    await jobs.settled();
    const { error } = await jobs.status('A');
    expect(error).toBeTruthy();
    expect(error).not.toContain('secret');
  });

  it('hides a non-Error throw too', async () => {
    const { jobs, pdf } = setup(async () => {
      throw 'secret text';
    });
    pdf.value = null;
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).error).not.toContain('secret');
  });

  it('derives status from git records when nothing is recorded', async () => {
    const { jobs, pdf, filled, filledIsNewer } = setup(async () => {});
    pdf.value = null;
    filled.value = C0;
    expect(await jobs.status('A')).toEqual({
      id: 'A',
      state: 'missing',
      updatedAt: null,
      error: null,
    });
    pdf.value = C0;
    expect(await jobs.status('A')).toMatchObject({ state: 'done', updatedAt: D0 });
    filled.value = C1;
    filledIsNewer.value = true;
    expect(await jobs.status('A')).toMatchObject({ state: 'stale', updatedAt: D0 });
    filled.value = null;
    expect((await jobs.status('A')).state).toBe('done');
  });

  it('treats ids case-insensitively', async () => {
    const ds = [deferred(), deferred()];
    const build = vi.fn(() => ds[build.mock.calls.length - 1].promise);
    const { jobs } = setup(build);
    jobs.request('AbC');
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    jobs.request('abc');
    expect((await jobs.status('ABC')).state).toBe('building');
    ds[0].resolve();
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    ds[1].resolve();
    await jobs.settled();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('runs again for a request arriving right after a build resolves', async () => {
    const ds = [deferred(), deferred()];
    const build = vi.fn(() => ds[build.mock.calls.length - 1].promise);
    const { jobs } = setup(build);
    jobs.request('A');
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    ds[0].resolve();
    queueMicrotask(() => jobs.request('A'));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    ds[1].resolve();
    await jobs.settled();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('starts a new build when requested after done', async () => {
    const build = vi.fn(async () => {});
    const { jobs } = setup(build);
    jobs.request('A');
    await jobs.settled();
    jobs.request('A');
    await jobs.settled();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('releases the id even if recording itself throws', async () => {
    const build = vi.fn(async () => {});
    const jobs = createOfficialPdfJobs({
      build,
      pdfCommit: async () => null,
      filledCommit: async () => null,
      isAncestorOrSame: async () => true,
      now: () => {
        throw new Error('clock');
      },
    });
    jobs.request('A');
    await jobs.settled();
    jobs.request('A');
    await jobs.settled();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('uses the real clock by default', async () => {
    const jobs = createOfficialPdfJobs({
      build: async () => {
        throw new Error('x');
      },
      pdfCommit: async () => null,
      filledCommit: async () => null,
      isAncestorOrSame: async () => true,
    });
    jobs.request('A');
    await jobs.settled();
    const st = await jobs.status('A');
    expect(st.state).toBe('failed');
    expect(Math.abs(Date.parse(st.updatedAt ?? '') - Date.now())).toBeLessThan(60_000);
  });

  it('re-derives done from git so a newer filled commit shows stale', async () => {
    const { jobs, pdf, filled, filledIsNewer } = setup(async () => undefined);
    pdf.value = C0;
    filled.value = C0;
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).state).toBe('done');
    filled.value = C1;
    filledIsNewer.value = true;
    expect((await jobs.status('A')).state).toBe('stale');
  });

  it('keeps failed while the pdf commit is unchanged, re-derives once it differs', async () => {
    const build = vi.fn(async () => {
      throw new Error('x');
    });
    const { jobs, pdf, filled } = setup(build);
    pdf.value = null;
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).state).toBe('failed');
    filled.value = C0;
    expect((await jobs.status('A')).state).toBe('failed');
    pdf.value = C1;
    expect(await jobs.status('A')).toMatchObject({ state: 'done', updatedAt: C1.date });
  });

  it('replaces failed once a pdf that existed before the failure is recommitted', async () => {
    const { jobs, pdf } = setup(async () => {
      throw new Error('x');
    });
    pdf.value = C0;
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).state).toBe('failed');
    pdf.value = C1;
    expect((await jobs.status('A')).state).toBe('done');
  });
});
