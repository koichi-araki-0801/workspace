// =============================================================================
// config.paths.test.ts — dataRoot を基準にした *_DIR 既定の解決
// =============================================================================
// `DATA_ROOT` だけを移した運用(ネットワークドライブ・可搬配置)で、テンプレ実体・CSS・
// drafts などの置き場が既定のまま取り残されないことを固定する。個別の env / appconfig
// 指定は従来どおり dataRoot より優先される。
// env を差し替えて評価し直すため、モジュールは毎回 `vi.resetModules()` してから動的
// import する(`config.ts` は import 時に env を読んで値を確定する)。
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type ConfigModule = typeof import('../src/config.js');

/** 既定を観測するため、パス系 env をすべて外してから差し替え分だけを設定する。 */
const PATH_ENV_KEYS = [
  'DATA_ROOT',
  'TEMPLATES_DIR',
  'CSS_DIR',
  'ASSETS_DIR',
  'DRAFTS_DIR',
  'PENDING_DIR',
  'REVIEWS_DIR',
  'SYNC_DIR',
  'GIT_REPO_DIR',
] as const;

/** env を一時的に差し替えて `config.ts` を評価し直す(評価後に env は元へ戻す)。 */
async function importConfigWithEnv(
  env: Partial<Record<(typeof PATH_ENV_KEYS)[number], string>>,
): Promise<ConfigModule> {
  const saved = new Map(PATH_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of PATH_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  try {
    return await import('../src/config.js');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const DATA_ROOT = path.resolve(path.sep, 'tmp', 'editor-data-root-test');

describe('config paths', () => {
  it('derives every data directory from DATA_ROOT', async () => {
    const { config } = await importConfigWithEnv({ DATA_ROOT });

    expect(config.dataRoot).toBe(DATA_ROOT);
    expect(config.templatesDir).toBe(path.join(DATA_ROOT, 'templates'));
    expect(config.cssDir).toBe(path.join(DATA_ROOT, 'css'));
    expect(config.assetsDir).toBe(path.join(DATA_ROOT, 'assets'));
    expect(config.draftsDir).toBe(path.join(DATA_ROOT, 'drafts'));
    expect(config.pendingDir).toBe(path.join(DATA_ROOT, 'pending'));
    expect(config.reviewsDir).toBe(path.join(DATA_ROOT, 'reviews'));
    expect(config.syncDir).toBe(path.join(DATA_ROOT, 'sync'));
    expect(config.gitRepoDir).toBe(DATA_ROOT);
  });

  it('lets an explicit per-directory env win over DATA_ROOT', async () => {
    const templatesDir = path.resolve(path.sep, 'tmp', 'editor-templates-elsewhere');
    const { config } = await importConfigWithEnv({ DATA_ROOT, TEMPLATES_DIR: templatesDir });

    expect(config.templatesDir).toBe(templatesDir);
    // 指定しなかった置き場は dataRoot 起点のまま。
    expect(config.cssDir).toBe(path.join(DATA_ROOT, 'css'));
  });

  it('keeps the built-in default when DATA_ROOT is unset', async () => {
    const { config } = await importConfigWithEnv({});

    expect(config.templatesDir).toBe(path.join(config.dataRoot, 'templates'));
    expect(config.gitRepoDir).toBe(config.dataRoot);
  });
});
