import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAppError } from '@editor/shared';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  cleanupProject,
  extractProjectZip,
  safeEntryPath,
} from '../src/vivliostyle/projectInput.js';

const created: string[] = [];
afterEach(async () => {
  while (created.length) await cleanupProject(created.pop() as string);
});

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('safeEntryPath', () => {
  const root = path.join(config.tmpDir, 'safe-root');

  it('resolves nested and Japanese names under root', () => {
    expect(safeEntryPath(root, 'manuscript/本文.md')).toBe(
      path.resolve(root, 'manuscript/本文.md'),
    );
  });

  it('rejects parent traversal, absolute and drive-letter paths', () => {
    for (const bad of ['../evil.txt', '../../x', '/etc/passwd', 'C:\\windows\\x', 'a/../../b']) {
      expect(() => safeEntryPath(root, bad), bad).toThrow();
    }
  });

  it('rejects backslash-escaped traversal', () => {
    expect(() => safeEntryPath(root, '..\\evil')).toThrow();
  });
});

describe('extractProjectZip', () => {
  it('extracts files (incl. Japanese names) and detects the config', async () => {
    const buf = await zipOf({
      'vivliostyle.config.js': 'module.exports = {};',
      'manuscript/本文.md': '# こんにちは',
    });
    const project = await extractProjectZip(buf);
    created.push(project.dir);

    expect(project.fileCount).toBe(2);
    expect(project.configPath).toBe(path.join(project.dir, 'vivliostyle.config.js'));
    expect(existsSync(path.join(project.dir, 'manuscript', '本文.md'))).toBe(true);
    expect(await fs.readFile(path.join(project.dir, 'manuscript', '本文.md'), 'utf8')).toContain(
      'こんにちは',
    );
  });

  it('detects a config nested under a top-level folder, leaves configPath undefined otherwise', async () => {
    const nested = await zipOf({ 'proj/vivliostyle.config.cjs': 'module.exports={};' });
    const a = await extractProjectZip(nested);
    created.push(a.dir);
    expect(a.configPath).toBe(path.join(a.dir, 'proj', 'vivliostyle.config.cjs'));

    const noConfig = await zipOf({ 'index.html': '<p>x</p>' });
    const b = await extractProjectZip(noConfig);
    created.push(b.dir);
    expect(b.configPath).toBeUndefined();
  });

  it('rejects a zip-slip entry and writes nothing outside root', async () => {
    const buf = await zipOf({ '../escape.txt': 'pwned', 'ok.txt': 'fine' });
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
    expect(existsSync(path.join(config.tmpDir, 'escape.txt'))).toBe(false);
  });

  it('rejects an empty archive', async () => {
    const buf = await zipOf({});
    await expect(extractProjectZip(buf)).rejects.toSatisfy(isAppError);
  });
});
