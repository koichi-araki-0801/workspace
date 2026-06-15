import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAppError, validation } from '@editor/shared';
import StreamZip from 'node-stream-zip';
import { config } from '../config.js';

/** A vivliostyle project extracted from an uploaded zip. */
export interface ExtractedProject {
  /** Root dir holding the extracted files. Remove via `cleanupProject`. */
  dir: string;
  /** Absolute path of `vivliostyle.config.*` when present (preferred entry). */
  configPath?: string;
  /** Number of files written. */
  fileCount: number;
}

const CONFIG_NAMES = new Set([
  'vivliostyle.config.js',
  'vivliostyle.config.cjs',
  'vivliostyle.config.mjs',
]);

/**
 * Resolve a zip entry name to a safe absolute path under `root`.
 * Rejects absolute paths, Windows drive letters, and `..` traversal so a
 * malicious archive cannot write outside the extraction dir (zip-slip).
 */
export function safeEntryPath(root: string, name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw validation(`不正なエントリパスです: ${name}`);
  }
  const dest = path.resolve(root, normalized);
  const rel = path.relative(root, dest);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw validation(`不正なエントリパスです: ${name}`);
  }
  return dest;
}

/**
 * Extract an uploaded vivliostyle project zip into a fresh temp directory.
 * The caller owns the lifecycle and must call `cleanupProject(dir)` when done
 * (after the PDF is read, or when a preview session is stopped).
 *
 * The size ceiling is normally enforced upstream by `express.raw({ limit })`
 * (→ 413); the empty-archive guards here keep the contract explicit.
 */
export async function extractProjectZip(zip: Buffer): Promise<ExtractedProject> {
  if (zip.length === 0) throw validation('プロジェクト zip が空です');

  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(config.tmpDir, `vivlio-${stamp}`);
  const zipPath = `${dir}.zip`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(zipPath, zip);

  let fileCount = 0;
  try {
    const archive = new StreamZip.async({ file: zipPath });
    try {
      const entries = await archive.entries();
      for (const entry of Object.values(entries)) {
        if (entry.isDirectory) continue;
        const dest = safeEntryPath(dir, entry.name);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await archive.extract(entry, dest);
        fileCount++;
      }
    } finally {
      await archive.close();
      await fs.rm(zipPath, { force: true });
    }

    if (fileCount === 0) throw validation('プロジェクト zip にファイルがありません');

    // The temp dir lives under this repo, whose package.json sets "type":"module".
    // A `vivliostyle.config.js` using CommonJS `module.exports` (the default
    // scaffold) would then fail to load as ESM. When the project ships no
    // package.json of its own, drop a CommonJS-default one at the root so Node's
    // nearest-package.json resolution pins `.js` to CommonJS.
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) await fs.writeFile(pkg, '{}\n', 'utf8');

    const configPath = await findConfig(dir);
    return { dir, configPath, fileCount };
  } catch (e) {
    // Never leak a half-extracted dir (e.g. on a rejected zip-slip entry).
    await cleanupProject(dir);
    // A corrupt or malicious archive is bad input → 400, not 500. node-stream-zip
    // raises its own "Malicious entry" guard; surface all such failures as validation.
    if (isAppError(e)) throw e;
    throw validation('プロジェクト zip の展開に失敗しました', { cause: e });
  }
}

/** Remove an extracted project directory (best-effort). */
export async function cleanupProject(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Find the first `vivliostyle.config.*` in the extracted tree (shallow-first),
 * so projects zipped either flat or under a single top-level folder both work.
 */
async function findConfig(root: string): Promise<string | undefined> {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (CONFIG_NAMES.has(e.name)) return full;
    }
  }
  return undefined;
}
