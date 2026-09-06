// =============================================================================
// e2e-rest-paths.ts — rest e2e のサーバ起動と spec が共有する固定値(副作用なし)
// =============================================================================
// 起動スクリプト(`e2e-rest-server.ts`)本体から分けてあるのは、spec 側がこの値だけを
// import できるようにするため。起動スクリプトは import しただけで env を書き換え・
// dataRoot を消して作り直し・ポートを掴むので、そこから export すると spec の import が
// 実行中の dataRoot を巻き添えに消す。ここは定数の算出だけを持つ。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * rest e2e の dataRoot。`os.tmpdir()` の乱数ディレクトリではなく gitignore 済みの固定パスに
 * するのは、spec が「今回起動した分」を prefix 走査で推測せずに済ませるため(前回異常終了の
 * 残骸と混同する余地を作らない)。
 */
export const E2E_REST_DATA_ROOT = path.join(repoRoot, '.tmp', 'e2e-rest-dataroot');

/** rest e2e のサーバ待受ポート。通常の dev サーバ(24680)と衝突させない。 */
export const E2E_REST_PORT = 24690;
