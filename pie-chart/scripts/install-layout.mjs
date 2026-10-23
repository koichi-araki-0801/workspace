// =============================================================================
// install-layout.mjs — pie-chart の node_modules が pnpm で入ったものかを見分ける
// -----------------------------------------------------------------------------
// 依存は pnpm-lock.yaml どおりに pnpm で入れる。pie-chart のフォルダで npm を実行すると、
// node_modules が npm の構成(実体のフォルダ)で入れ直され、pnpm-lock.yaml と別の版を掴みうる。
// pnpm は `node_modules/<名前>` をストアへのリンク(Windows ではジャンクション)にするので、
// exe に同梱する subset-font がリンクかどうかで見分ける。build-exe.mjs が入口で使う。
// =============================================================================

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `pkgRoot/node_modules/subset-font` の入り方。リンクなら `'pnpm'`、実体のフォルダなら `'npm'`、
 * 無ければ `'missing'`。
 * @param {string} pkgRoot
 * @returns {'pnpm' | 'npm' | 'missing'}
 */
export function installLayout(pkgRoot) {
  try {
    return lstatSync(join(pkgRoot, 'node_modules', 'subset-font')).isSymbolicLink()
      ? 'pnpm'
      : 'npm';
  } catch {
    return 'missing';
  }
}
