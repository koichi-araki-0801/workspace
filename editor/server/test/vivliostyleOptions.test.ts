import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `sharedInlineConfig` reads `config.pdf.executableBrowser`. The config module
 * auto-detects system Edge on Windows, so we mock it to make both branches
 * (configured / unset) deterministic regardless of the host machine.
 */
describe('sharedInlineConfig', () => {
  afterEach(() => {
    vi.doUnmock('../src/config.js');
    vi.resetModules();
  });

  it('normalizes Windows backslashes to forward slashes', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: { pdf: { executableBrowser: 'C:\\Edge\\Application\\msedge.exe' } },
    }));
    const { sharedInlineConfig } = await import('../src/vivliostyle/options.js');
    expect(sharedInlineConfig()).toEqual({
      executableBrowser: 'C:/Edge/Application/msedge.exe',
      logLevel: 'silent',
      // Vite の `vite.config.*` 自動発見を止める(展開ツリーの `vite.config.js` が
      // バンドル・import される経路)。`toEqual` の全体一致のままにして、フィールドが
      // 増減したら気付ける形を保つ。`toMatchObject` へ緩めないこと。
      viteConfigFile: false,
    });
  });

  it('omits executableBrowser entirely when none is configured', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({ config: { pdf: { executableBrowser: undefined } } }));
    const { sharedInlineConfig } = await import('../src/vivliostyle/options.js');
    const c = sharedInlineConfig();
    expect(c).toEqual({ logLevel: 'silent', viteConfigFile: false });
    expect('executableBrowser' in c).toBe(false);
  });
});
