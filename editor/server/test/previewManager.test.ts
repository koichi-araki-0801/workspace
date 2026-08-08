import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PreviewActor,
  PreviewManager,
  type PreviewServerHandle,
  type PreviewSpec,
  proxyViewerUrl,
} from '../src/vivliostyle/previewManager.js';

const TTL = 1000;

/** 既定の操作主体。所有者検査そのものは `previewOwnership.test.ts` が受け持つ。 */
const OWNER: PreviewActor = { loginId: 'editor1', isAdmin: false };

function fakeHandle(port: number): PreviewServerHandle & { close: ReturnType<typeof vi.fn> } {
  return { port, close: vi.fn(async () => {}) };
}

function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prev-test-'));
}

function makeManager(maxSessions = 3) {
  const handles: Array<ReturnType<typeof fakeHandle>> = [];
  let nextPort = 13000;
  const starter = vi.fn(async (_spec: PreviewSpec) => {
    const h = fakeHandle(nextPort++);
    handles.push(h);
    return h;
  });
  const mgr = new PreviewManager({ idleTtlMs: TTL, maxSessions, host: '127.0.0.1', starter });
  return { mgr, handles, starter };
}

async function startOne(mgr: PreviewManager): Promise<{ id: string; dir: string }> {
  const dir = await tmpDir();
  const meta = await mgr.start(
    { mode: 'inline', input: 'x', workDir: dir, docBase: '/vivliostyle' },
    OWNER,
  );
  return { id: meta.id, dir };
}

describe('proxyViewerUrl', () => {
  it('rewrites the cli origin (viewer + #src) to the proxy prefix', () => {
    const cli =
      'http://127.0.0.1:13001/__vivliostyle-viewer/index.html' +
      '#src=http://127.0.0.1:13001/vivliostyle/index.html&bookMode=true&renderAllPages=true';
    expect(proxyViewerUrl('abc', cli)).toBe(
      '/api/preview/abc/__vivliostyle-viewer/index.html' +
        '#src=/api/preview/abc/vivliostyle/index.html&bookMode=true&renderAllPages=true',
    );
  });

  it('falls back to the proxy root when no viewer URL was captured', () => {
    expect(proxyViewerUrl('abc', undefined)).toBe('/api/preview/abc/');
    expect(proxyViewerUrl('abc', 'not-a-url')).toBe('/api/preview/abc/');
  });
});

describe('PreviewManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exposes session metadata and port after start', async () => {
    const { mgr } = makeManager();
    const dir = await tmpDir();
    const meta = await mgr.start(
      { mode: 'inline', input: 'x', workDir: dir, docBase: '/vivliostyle' },
      OWNER,
    );
    expect(meta.url).toBe(`/api/preview/${meta.id}/`);
    expect(meta.mode).toBe('inline');
    expect(mgr.get(meta.id, OWNER)).toEqual(meta);
    expect(mgr.list(OWNER)).toHaveLength(1);
    expect(mgr.resolveFor(meta.id, OWNER)).toEqual({ port: 13000, docBase: '/vivliostyle' });
    await mgr.disposeAll();
  });

  it('auto-stops a session after the idle TTL', async () => {
    const { mgr, handles } = makeManager();
    const { id } = await startOne(mgr);

    await vi.advanceTimersByTimeAsync(TTL);

    expect(mgr.get(id, OWNER)).toBeUndefined();
    expect(handles[0].close).toHaveBeenCalledOnce();
  });

  it('stop() closes the server and removes the temp dir', async () => {
    const { mgr, handles } = makeManager();
    const { id, dir } = await startOne(mgr);
    expect(existsSync(dir)).toBe(true);

    expect(await mgr.stop(id, OWNER)).toBe(true);

    expect(mgr.get(id, OWNER)).toBeUndefined();
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(existsSync(dir)).toBe(false);
  });

  it('touch extends the TTL', async () => {
    const { mgr, handles } = makeManager();
    const { id } = await startOne(mgr);

    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(mgr.touch(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(mgr.get(id, OWNER), 'alive: each idle gap stayed under TTL').toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(mgr.get(id, OWNER)).toBeUndefined();
    expect(handles[0].close).toHaveBeenCalledOnce();
  });

  it('evicts the least-recently-used session at capacity', async () => {
    const { mgr, handles } = makeManager(2);
    const a = await startOne(mgr);
    await vi.advanceTimersByTimeAsync(10);
    const b = await startOne(mgr);
    await vi.advanceTimersByTimeAsync(10);
    mgr.touch(a.id); // a becomes MRU, b is now LRU

    const c = await startOne(mgr); // at capacity (2) → evict b

    expect(
      mgr
        .list(OWNER)
        .map((m) => m.id)
        .sort(),
    ).toEqual([a.id, c.id].sort());
    expect(handles[1].close).toHaveBeenCalledOnce(); // b's server closed
    expect(existsSync(b.dir)).toBe(false);
    await mgr.disposeAll();
  });

  it('disposeAll stops everything; stop() returns false for unknown ids', async () => {
    const { mgr, handles } = makeManager();
    await startOne(mgr);
    await startOne(mgr);

    await mgr.disposeAll();

    expect(mgr.list(OWNER)).toHaveLength(0);
    expect(handles.every((h) => h.close.mock.calls.length === 1)).toBe(true);
    expect(await mgr.stop('nope', OWNER)).toBe(false);
  });
});
