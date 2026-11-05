// =============================================================================
// cli_input_source.test.ts — `one` の入力ソース指定の固定
// =============================================================================
// 入力ソースは --sample / --data-file / --data-json / ストアドの 4 系統。それ以外のフラグで
// 入力を指定したつもりの呼び出しは、黙って成功せず「入力が無い」で止まることを実プロセスで
// 確かめる(input_limits.test.ts の `--data-file` と同じ tsx 起動の型)。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('one の入力ソース', () => {
  it('--xlsx は未知フラグとして警告され、入力未指定で止まる', () => {
    const work = mkdtempSync(join(tmpdir(), 'piechart-input-source-'));
    try {
      const outputFile = join(work, 'out.svg');
      let stderr = '';
      let failed = false;
      try {
        execFileSync(
          process.execPath,
          [
            join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
            join(root, 'src', 'cli.ts'),
            'one',
            '--xlsx',
            join(work, 'book.xlsx'),
            '--sheet',
            'Sheet1',
            '--range',
            'A2:B11',
            '--output-file',
            outputFile,
          ],
          { cwd: root, stdio: 'pipe', encoding: 'utf8' },
        );
      } catch (err) {
        failed = true;
        stderr = String((err as { stderr?: string }).stderr ?? '');
      }
      expect(failed).toBe(true);
      expect(stderr).toMatch(/知らないフラグを無視しました: --xlsx, --sheet, --range/);
      expect(stderr).toMatch(
        /Provide one input source: --sample \/ --data-file \/ --data-json \/ --fund/,
      );
      expect(existsSync(outputFile)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
