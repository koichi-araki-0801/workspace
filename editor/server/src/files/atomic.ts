/**
 * Atomic file write: write to a temp sibling then rename over the target, so a
 * reader never sees a half-written file and a crash mid-write leaves the old
 * content intact. Used for template/draft/snapshot bodies (phase 2 keeps the
 * large text on disk; the DB only indexes it).
 */
import fs from 'node:fs/promises';

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}
