import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `sharedInlineConfig` reads `config.pdf.executableBrowser`. The config module
 * auto-detects system Edge on Windows, so we mock it to make both branches
 * (configured / unset) deterministic regardless of the host machine.
 *
 * `egressGuard.ts` も `../src/config.js` から `isLoopbackHost` を取るので、モックには
 * それも載せる(named export が欠けると ESM の読み込み自体が落ちる)。
 */
const mockConfig = (executableBrowser?: string): void => {
  vi.doMock('../src/config.js', async () => {
    const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
    // `pdf` だけ差し替える。丸ごと置き換えると `logger.ts` が読む `logging.dir` 等が消え、
    // 同じ config を辿る他モジュール(egressGuard → logger)の import ごと落ちる。
    return { ...actual, config: { ...actual.config, pdf: { executableBrowser } } };
  });
};

describe('sharedInlineConfig', () => {
  afterEach(async () => {
    const { stopEgressGuard } = await import('../src/vivliostyle/egressGuard.js');
    await stopEgressGuard();
    vi.doUnmock('../src/config.js');
    vi.resetModules();
  });

  /** egress 遮断の中継 URL。ポートは毎回変わるので形だけを見る。 */
  const EGRESS_PROXY_RE = /^http:\/\/127\.0\.0\.1:\d+$/;

  it('normalizes Windows backslashes to forward slashes', async () => {
    vi.resetModules();
    mockConfig('C:\\Edge\\Application\\msedge.exe');
    const { sharedInlineConfig } = await import('../src/vivliostyle/options.js');
    const c = await sharedInlineConfig();
    // `toEqual` の全体一致のままにして、フィールドが増減したら気付ける形を保つ。
    // `toMatchObject` へ緩めないこと。
    expect(c).toEqual({
      executableBrowser: 'C:/Edge/Application/msedge.exe',
      logLevel: 'silent',
      // Vite の `vite.config.*` 自動発見を止める(展開ツリーの `vite.config.js` が
      // バンドル・import される経路)。
      viteConfigFile: false,
      proxyServer: expect.stringMatching(EGRESS_PROXY_RE),
      proxyBypass: '127.0.0.1,localhost,[::1]',
    });
  });

  it('omits executableBrowser entirely when none is configured', async () => {
    vi.resetModules();
    mockConfig(undefined);
    const { sharedInlineConfig } = await import('../src/vivliostyle/options.js');
    const c = await sharedInlineConfig();
    expect(c).toEqual({
      logLevel: 'silent',
      viteConfigFile: false,
      proxyServer: expect.stringMatching(EGRESS_PROXY_RE),
      proxyBypass: '127.0.0.1,localhost,[::1]',
    });
    expect('executableBrowser' in c).toBe(false);
  });

  // ── egress 遮断(③)── 実際に落ちることの観測は `egressGuard.test.ts`。
  // ここでは「CLI へ渡す形」が遮断を無効化しないことだけを固定する。
  describe('egress 遮断', () => {
    it('プロキシは我々が立てた loopback の中継を指す(HTTP_PROXY へ落ちない)', async () => {
      vi.resetModules();
      mockConfig(undefined);
      const { sharedInlineConfig } = await import('../src/vivliostyle/options.js');
      const { startEgressGuard } = await import('../src/vivliostyle/egressGuard.js');
      const c = await sharedInlineConfig();
      // 空 / undefined だと CLI が `process.env.HTTP_PROXY` へフォールバックし遮断が消える。
      expect(c.proxyServer.trim().length).toBeGreaterThan(0);
      expect(c.proxyServer).toBe(await startEgressGuard());
      expect(new URL(c.proxyServer).hostname).toBe('127.0.0.1');
    });

    it('bypass は loopback だけ(外部ホストもワイルドカードも混ぜない)', async () => {
      vi.resetModules();
      mockConfig(undefined);
      const { sharedInlineConfig } = await import('../src/vivliostyle/options.js');
      const hosts = (await sharedInlineConfig()).proxyBypass.split(',');
      expect(hosts).toEqual(['127.0.0.1', 'localhost', '[::1]']);
      // `*` を混ぜると「全部 bypass = 遮断なし」へ静かに倒れる。
      expect(hosts.some((h) => h.includes('*') || h.includes('<'))).toBe(false);
    });
  });
});
