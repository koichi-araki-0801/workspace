// =============================================================================
// vivliostyleCliContract.test.ts — CLI へ config **ファイル**を渡さないことの機械固定
// =============================================================================
// 本改修の中心は「CLI に config を探させない」ことにある。次に触る人が `configPath` を
// 渡す形へ戻すと、`locateVivliostyleConfig` の大小文字ヒットと JSONC パーサが同時に復活し、
// 我々の許可リストは無関係になる。ここではソースを走査して**その退行を静的に落とす**。
//
// 実 CLI を起動する契約テスト(configData / viteConfigFile:false が本当に効くか)は、
// オフライン CI での chromium 取得と ~11s の import を避けるためここには置かない。
// 代わりに「我々のコードが CLI へ何を渡しているか」を型と静的検査の 2 段で固定する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sharedInlineConfig } from '../src/vivliostyle/options.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vivliostyle');

const read = (name: string): string => fs.readFileSync(path.join(SRC, name), 'utf8');

describe('@vivliostyle/cli への渡し方', () => {
  it.each([
    'build.ts',
    'previewServer.ts',
  ])('%s は configData で渡し、config パスを渡さない', (f) => {
    const text = read(f);
    expect(text).toContain('configData:');
    // `config: <パス>` を CLI へ渡す形が戻っていないこと。`configData:` は別語なので
    // 単語境界で見る。
    expect(/\bconfig:\s*(?:input|spec)\./.test(text)).toBe(false);
  });

  it('sharedInlineConfig は必ず viteConfigFile:false を含む', () => {
    // CLI 既定は `viteConfigFile ?? true`。ここが落ちると展開ツリーの `vite.config.*` が
    // Vite に読まれる(vivliostyle 側の config 許可リストは Vite の探索に及ばない)。
    expect(sharedInlineConfig().viteConfigFile).toBe(false);
  });

  it('CLI を import するのは previewServer.ts だけ(build は worker 経由)', () => {
    // 駆動点を数え上げておくと、新しい呼び出し元が増えたときに「そこも configData か」を
    // 必ずレビューへ載せられる。build 側は worker プロセス(`buildWorkerServer`)が読む。
    const drivers = fs
      .readdirSync(SRC)
      .filter((n) => n.endsWith('.ts'))
      .filter((n) => /(?:from|import\()\s*'@vivliostyle\/cli'/.test(read(n)));
    expect(drivers.sort()).toEqual(['previewServer.ts']);
  });
});
