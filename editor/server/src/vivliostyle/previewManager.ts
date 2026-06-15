import crypto from 'node:crypto';
import { cleanupProject } from './projectInput.js';

/** A running preview server, abstracted so the manager is cli-agnostic (DI). */
export interface PreviewServerHandle {
  /** Actual port the preview (Vite) server listens on. */
  port: number;
  /**
   * Absolute viewer URL the cli generated (origin + `/__vivliostyle-viewer/...`
   * `#src=<absolute source URL>`). The manager rewrites its origin to the proxy
   * prefix so the browser reaches both the viewer and its source via :3001.
   */
  viewerUrl?: string;
  /** Stop the server and release the port. */
  close: () => Promise<void>;
}

/**
 * Rewrite the cli's absolute viewer URL so every same-origin reference (the
 * viewer page and the `#src=` document) points at the reverse-proxy prefix.
 * Falls back to the proxy root when no viewer URL was captured.
 */
export function proxyViewerUrl(id: string, viewerUrl: string | undefined): string {
  const prefix = `/api/preview/${id}`;
  if (!viewerUrl) return `${prefix}/`;
  try {
    const origin = new URL(viewerUrl).origin;
    return viewerUrl.split(origin).join(prefix);
  } catch {
    return `${prefix}/`;
  }
}

/** What to preview, plus the temp dir the manager must remove on stop. */
export interface PreviewSpec {
  mode: 'inline' | 'project';
  /** Entry file (inline html, or project entry when there is no config). */
  input?: string;
  /** `vivliostyle.config.*` path (project, preferred). */
  configPath?: string;
  /** Project root (cwd) when building from an entry file. */
  cwd?: string;
  size?: string;
  singleDoc?: boolean;
  /** Temp dir removed when the session stops. */
  workDir: string;
}

/** Starts a preview server for a spec. Injected so tests avoid a real browser. */
export type PreviewStarter = (spec: PreviewSpec, host: string) => Promise<PreviewServerHandle>;

/** Public, serializable view of a preview session (no server internals). */
export interface PreviewSessionMeta {
  id: string;
  mode: 'inline' | 'project';
  createdAt: string;
  expiresAt: string;
  url: string;
}

interface Session {
  meta: PreviewSessionMeta;
  handle: PreviewServerHandle;
  workDir: string;
  lastAccessMs: number;
  timer: NodeJS.Timeout;
}

export interface PreviewManagerOptions {
  idleTtlMs: number;
  maxSessions: number;
  host: string;
  starter: PreviewStarter;
}

/**
 * Tracks live vivliostyle preview servers: bounded count, idle auto-expiry, and
 * deterministic cleanup of both the server and its temp dir. In-memory only —
 * sessions do not survive a process restart, which is fine for a single-box
 * deployment.
 */
export class PreviewManager {
  private readonly sessions = new Map<string, Session>();
  private readonly opts: PreviewManagerOptions;

  constructor(opts: PreviewManagerOptions) {
    this.opts = opts;
  }

  /** Start a preview; evicts the least-recently-used session when at capacity. */
  async start(spec: PreviewSpec): Promise<PreviewSessionMeta> {
    if (this.sessions.size >= this.opts.maxSessions) await this.evictOldest();

    let handle: PreviewServerHandle;
    try {
      handle = await this.opts.starter(spec, this.opts.host);
    } catch (e) {
      // The server never came up — drop the temp dir we were handed.
      await cleanupProject(spec.workDir);
      throw e;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const meta: PreviewSessionMeta = {
      id,
      mode: spec.mode,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.idleTtlMs).toISOString(),
      url: proxyViewerUrl(id, handle.viewerUrl),
    };
    this.sessions.set(id, {
      meta,
      handle,
      workDir: spec.workDir,
      lastAccessMs: now,
      timer: this.arm(id),
    });
    return meta;
  }

  /** Listen port for the proxy; undefined if the session is unknown. */
  portOf(id: string): number | undefined {
    return this.sessions.get(id)?.handle.port;
  }

  get(id: string): PreviewSessionMeta | undefined {
    return this.sessions.get(id)?.meta;
  }

  list(): PreviewSessionMeta[] {
    return [...this.sessions.values()].map((s) => s.meta);
  }

  /** Refresh idle TTL on access (called by the proxy). False if unknown. */
  touch(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    clearTimeout(s.timer);
    const now = Date.now();
    s.lastAccessMs = now;
    s.meta.expiresAt = new Date(now + this.opts.idleTtlMs).toISOString();
    s.timer = this.arm(id);
    return true;
  }

  /** Stop a session: clear timer, close server, remove temp dir. */
  async stop(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    clearTimeout(s.timer);
    await Promise.allSettled([s.handle.close(), cleanupProject(s.workDir)]);
    return true;
  }

  /** Stop every session (process shutdown). */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }

  private arm(id: string): NodeJS.Timeout {
    const t = setTimeout(() => void this.stop(id), this.opts.idleTtlMs);
    // An idle preview must not keep the process alive on its own.
    t.unref?.();
    return t;
  }

  private async evictOldest(): Promise<void> {
    let oldest: Session | undefined;
    for (const s of this.sessions.values()) {
      if (!oldest || s.lastAccessMs < oldest.lastAccessMs) oldest = s;
    }
    if (oldest) await this.stop(oldest.meta.id);
  }
}
