import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import { sharedInlineConfig } from './options.js';
import { PreviewManager, type PreviewServerHandle, type PreviewSpec } from './previewManager.js';

/** The cli colors its output; strip ANSI escapes before matching the URL. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** Match the cli's "Preview URL" in the (ANSI-stripped) captured output. */
const VIEWER_URL_RE = /https?:\/\/[^\s]*__vivliostyle-viewer[^\s]*/;

/**
 * Run `fn` while capturing everything written to stdout/stderr, returning the
 * captured text alongside the result. The cli prints its "Preview URL" box via
 * clack (bypassing the `logger` option), so this is the only reliable way to
 * read it. The wrap is global, hence callers serialize (see `startChain`).
 */
async function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  let output = '';
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown): boolean => {
    output += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

// Serializes preview starts so the global stdout/stderr wrap in captureStdio
// can't be clobbered by a concurrent start.
let startChain: Promise<unknown> = Promise.resolve();

/**
 * Real preview starter backed by `@vivliostyle/cli`'s `preview()`. This is the
 * only place (besides build.ts) that imports the cli, keeping vivliostyle usage
 * consolidated under `vivliostyle/`.
 *
 * The Vite preview server binds loopback (`host`); Express reverse-proxies to it
 * so only :3001 is exposed and auth applies. HMR is disabled (`vite.server.hmr`)
 * because the uploaded input is a snapshot — nothing to live-reload — which keeps
 * the proxy pure HTTP (no WebSocket tunnel). The port is left to Vite so
 * concurrent previews auto-increment; the actual port and the viewer URL are read
 * back after startup.
 */
const vivliostylePreviewStarter = (
  spec: PreviewSpec,
  host: string,
): Promise<PreviewServerHandle> => {
  const run = async (): Promise<PreviewServerHandle> => {
    const { preview } = await import('@vivliostyle/cli');
    // `cwd` is set in both cases so entries resolve relative to the project dir.
    const entry = spec.configPath
      ? { config: spec.configPath, cwd: spec.cwd }
      : { cwd: spec.cwd, input: spec.input };

    const { result: server, output } = await captureStdio(() =>
      preview({
        ...entry,
        ...(spec.size ? { size: spec.size } : {}),
        ...(spec.singleDoc ? { singleDoc: true } : {}),
        openViewer: false,
        host,
        vite: { server: { hmr: false } },
        ...sharedInlineConfig(),
        logLevel: 'info', // so the cli emits the "Preview URL" we capture
      } as Parameters<typeof preview>[0]),
    );

    const addr = server.httpServer?.address() as AddressInfo | string | null;
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    return {
      port,
      viewerUrl: output.replace(ANSI_RE, '').match(VIEWER_URL_RE)?.[0],
      close: async () => {
        await server.close();
      },
    };
  };

  const result = startChain.then(run, run);
  startChain = result.catch(() => undefined);
  return result;
};

/** Process-wide preview session manager (wired with the real cli starter). */
export const previewManager = new PreviewManager({
  idleTtlMs: config.vivliostyle.preview.idleTtlMs,
  maxSessions: config.vivliostyle.preview.maxSessions,
  host: config.vivliostyle.preview.host,
  starter: vivliostylePreviewStarter,
});
