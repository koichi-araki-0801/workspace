// =============================================================================
// vivliostyleRoutes.entry.test.ts — `?entry=` の封じ込め(HTTP 経路)
// =============================================================================
// `reviews.routes.test.ts` と同じ流儀で、最小の Fastify に `vivliostyleRoutes` だけを載せて
// `app.inject()` で叩く。PDF ビルドは実行せず、`buildProjectPdf` に渡った `entry` を捕まえて
// 「展開ディレクトリ配下の絶対パスに解決されているか」「不正値は CLI へ届かないか」を見る。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 展開ディレクトリの残骸を数える検査は、tmp を他のテストファイルと共有していると
// 成立しない(並行して走る `projectInput.test.ts` 等も `vivlio-*` を作り、増分として
// 写り込む = 実測でフレークした)。config が env を読む前に専用 tmp を割り当てて隔離する。
// テストファイルごとにプロセスが分かれる(vitest の既定 pool)ため、この代入は漏れない。
const TEST_TMP_DIR = path.join(
  os.tmpdir(),
  `editor-entry-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
);
process.env.TMP_DIR = TEST_TMP_DIR;

/** `buildProjectPdf` へ渡った引数(最後の 1 回)。実 CLI は起動しない。 */
const calls: { dir: string; entry?: string }[] = [];

vi.mock('../src/vivliostyle/build.js', () => ({
  buildProjectPdf: async (input: { dir: string; entry?: string }) => {
    calls.push(input);
    return Buffer.from('%PDF-1.4 fake');
  },
  buildInlinePdf: async () => Buffer.from('%PDF-1.4 fake'),
  buildMergedPdf: async () => Buffer.from('%PDF-1.4 fake'),
  prepareInlineDoc: async () => ({ dir: '', entry: '' }),
}));

const { config } = await import('../src/config.js');

/** 展開ディレクトリの残骸(拒否時に残っていないことの確認用)。 */
async function tmpProjectDirs(): Promise<string[]> {
  const names = await fs.readdir(config.tmpDir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('vivlio-') && !n.endsWith('.zip'));
}

describe('POST /build/project entry containment', () => {
  let app: FastifyInstance;
  let zip: Buffer;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    app = Fastify();
    app.setErrorHandler(errorHandler);
    // app.ts と同じく zip は Buffer のまま body に載せる。
    app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    await app.register(vivliostyleRoutes);
    await app.ready();

    const z = new JSZip();
    z.file('index.html', '<p>x</p>');
    zip = await z.generateAsync({ type: 'nodebuffer' });
  });
  afterAll(async () => {
    await app.close();
    await fs.rm(TEST_TMP_DIR, { recursive: true, force: true }).catch(() => {});
  });
  beforeEach(() => {
    calls.length = 0;
  });

  const post = (query: string) =>
    app.inject({
      method: 'POST',
      url: `/build/project${query}`,
      headers: { 'content-type': 'application/zip' },
      payload: zip,
    });

  // 隔離が崩れる(例: `config` を静的 import へ変え、代入より先に評価される)と、残骸検査は
  // 他ファイルの `vivlio-*` を拾って「たまに落ちる」テストへ静かに退化する。ここで固定する。
  it('runs against an isolated tmp dir so leftover checks cannot see other test files', () => {
    expect(config.tmpDir).toBe(TEST_TMP_DIR);
  });

  it('resolves a relative entry into the extracted directory', async () => {
    const res = await post('?entry=index.html');
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].entry).toBe(path.resolve(calls[0].dir, 'index.html'));
  });

  it('leaves entry unset when the query is absent or empty', async () => {
    expect((await post('')).statusCode).toBe(200);
    expect(calls[0].entry).toBeUndefined();
    expect((await post('?entry=')).statusCode).toBe(200);
    expect(calls[1].entry).toBeUndefined();
  });

  it.each([
    '?entry=http://127.0.0.1:9200/_cat/indices',
    '?entry=file:///etc/passwd',
    '?entry=data:text/html,<script>1</script>',
    '?entry=../../../../etc/passwd',
    '?entry=C:/Users/Public/report.html',
    '?entry=//attacker/share/x.html',
  ])('rejects %s with 400 and never reaches the CLI', async (query) => {
    const before = await tmpProjectDirs();
    const res = await post(query);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    // 400 で終わる経路でも展開ディレクトリを残さない。tmp は上で隔離済みなので増分の
    // 発生源はこのリクエストだけ。成功経路の後片付けは応答送出と競合しうる(直前のテストの
    // 残骸が baseline に写る)ため、全件一致ではなく増分を見る。
    expect((await tmpProjectDirs()).filter((n) => !before.includes(n))).toEqual([]);
  });
});
