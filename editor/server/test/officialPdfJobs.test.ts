// =============================================================================
// officialPdfJobs.test.ts — 正式 PDF ジョブ(id ごとに 1 本・組版中の要求は 1 回に畳む)
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { createOfficialPdfJobs } from '../src/generate/officialPdfJobs.js';

const T0 = new Date('2026-11-11T00:00:00.000Z');
const T1 = new Date('2026-11-11T01:00:00.000Z');

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(build: (id: string) => Promise<void>) {
  const pdf: { value: Date | null } = { value: T0 };
  const filled: { value: Date | null } = { value: null };
  const jobs = createOfficialPdfJobs({
    build,
    pdfMtime: async () => pdf.value,
    filledMtime: async () => filled.value,
    now: () => T1,
  });
  return { jobs, pdf, filled };
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
      updatedAt: T0.toISOString(),
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

  it('records failure message', async () => {
    const build = vi.fn(async () => {
      throw Object.assign(new Error('x'), { kind: 'unexpected', code: 'REPORT_RUN_FAILED' });
    });
    const { jobs } = setup(build);
    jobs.request('A');
    await jobs.settled();
    const st = await jobs.status('A');
    expect(st.state).toBe('failed');
    expect(st.error).toBe('x');
  });

  it('hides the raw message of an unclassified error', async () => {
    const { jobs } = setup(async () => {
      throw new Error('secret detail');
    });
    jobs.request('A');
    await jobs.settled();
    const { error } = await jobs.status('A');
    expect(error).toBeTruthy();
    expect(error).not.toContain('secret');
  });

  it('hides a non-Error throw too', async () => {
    const { jobs } = setup(async () => {
      throw 'secret text';
    });
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).error).not.toContain('secret');
  });

  it('derives status from files when nothing is recorded', async () => {
    const { jobs, pdf, filled } = setup(async () => {});
    pdf.value = null;
    filled.value = T0;
    expect(await jobs.status('A')).toEqual({
      id: 'A',
      state: 'missing',
      updatedAt: null,
      error: null,
    });
    pdf.value = T1;
    expect(await jobs.status('A')).toMatchObject({ state: 'done', updatedAt: T1.toISOString() });
    const older = new Date(T0.getTime() - 1000);
    pdf.value = older;
    expect(await jobs.status('A')).toMatchObject({
      state: 'stale',
      updatedAt: older.toISOString(),
    });
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
      pdfMtime: async () => null,
      filledMtime: async () => null,
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
      pdfMtime: async () => null,
      filledMtime: async () => null,
    });
    jobs.request('A');
    await jobs.settled();
    const st = await jobs.status('A');
    expect(st.state).toBe('failed');
    expect(Math.abs(Date.parse(st.updatedAt ?? '') - Date.now())).toBeLessThan(60_000);
  });

  it('re-derives done from the files so a rewritten filled shows stale', async () => {
    const { jobs, pdf, filled } = setup(async () => undefined);
    pdf.value = T0;
    filled.value = T0;
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).state).toBe('done');
    filled.value = T1;
    expect((await jobs.status('A')).state).toBe('stale');
  });

  it('shows done after a failure once a newer pdf appears', async () => {
    const build = vi.fn(async () => {
      throw new Error('x');
    });
    const { jobs, pdf, filled } = setup(build);
    jobs.request('A');
    await jobs.settled();
    expect((await jobs.status('A')).state).toBe('failed');
    pdf.value = T0;
    filled.value = T0;
    expect((await jobs.status('A')).state).toBe('failed');
    pdf.value = new Date(T1.getTime() + 1000);
    expect((await jobs.status('A')).state).toBe('done');
  });
});
