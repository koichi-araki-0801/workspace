// =============================================================================
// mergeInput.ts — 複数文書の結合 build 入力を一時ディレクトリへ実体化する
// =============================================================================
// `POST /api/build/merge` の裏方。レンダリング済み HTML+CSS の配列を `doc-000.html` …の
// 連番ファイルへ書き出し、`entry` 配列を持つ `vivliostyle.config.cjs` を生成する。複数
// entry のビルドは vivliostyle が book(単一 spine)として組版し、CSS Paged Media の
// `page` カウンタが文書境界でリセットされず継続する — これが「通しページ番号」の土台。
// ライフサイクルは `projectInput.ts` と同じで、呼び出し側が `cleanupProject(dir)` を持つ。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { stageDocAssets } from './docAssets.js';
import { collectDocumentAssetRefs } from './docRefs.js';
import { inlineCss } from './inlineCss.js';
import { DEFAULT_DOC_BASE } from './previewProxy.js';
import type { SafeProjectConfig } from './projectConfig.js';
import { cleanupProject } from './projectInput.js';

/** 結合対象の 1 文書(レンダリング済み HTML + 文書スコープの CSS)。 */
export interface MergeDocument {
  html: string;
  css: string;
}

/**
 * 通しページ番号を印字する共通 CSS。各文書の CSS 末尾へ付加する。テンプレ CSS は現状
 * ページ番号印字を持たないため、結合 PDF での連番表示はこの 1 箇所が担う。
 */
export const MERGE_PAGE_COUNTER_CSS = `@page {
  @bottom-center {
    content: counter(page);
    font-size: 8pt;
  }
}`;

/**
 * テンプレ CSS 中の `page` カウンタのリセット/セット宣言を除去する(通し番号の継続を守る)。
 * 宣言値のどこかに単語 `page` を含む `counter-reset` / `counter-set` を丸ごと落とす
 * ヒューリスティックであり、`counter-reset: chapter page` のような複合宣言は他カウンタごと
 * 消える。現行テンプレ CSS にこの種の宣言は無く、将来の混入への予防線として許容する。
 */
export function stripPageCounterReset(css: string): string {
  return css.replace(/counter-(?:reset|set)\s*:[^;{}]*\bpage\b[^;{}]*;?/gi, '');
}

/**
 * `entry` 配列を持つ config オブジェクトを組む。**ファイルには書かない** — CLI へは
 * `configData` で渡すため、リポジトリから実行可能な vivliostyle config が 1 つも無くなる。
 * `size` は CLI オプションでなく config に一元化する(CLI 側 `size` は entry 毎設定を
 * 上書きし得るため)。
 */
export function mergeConfigObject(entries: string[], size?: string): SafeProjectConfig {
  return {
    entry: entries,
    ...(size ? { size } : {}),
    // 文書の配信 path はサーバ側で固定する(`projectConfig.parseProjectConfig` と同じ値)。
    base: DEFAULT_DOC_BASE,
  };
}

/**
 * 文書群を一時ディレクトリへ実体化し、CLI へ渡す config オブジェクトを返す。呼び出し側は
 * build 完了後に必ず `cleanupProject(dir)` を呼ぶこと(このモジュールは途中失敗時のみ
 * 自前で掃除する)。
 *
 * - 各文書は `doc-000.html` からのゼロ埋め連番で書き出す(entry 順 = 配列順を字面でも保証)。
 * - CSS は `stripPageCounterReset` + `MERGE_PAGE_COUNTER_CSS` を経て各 HTML へインライン化。
 */
export async function materializeMergeProject(
  documents: MergeDocument[],
  size?: string,
): Promise<{ dir: string; config: SafeProjectConfig }> {
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(config.tmpDir, `vivlio-merge-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  try {
    // 同梱資産は文書より先に置く。`inlineCss` が `<link>`/`<script src>` を残すかどうかを
    // 「配信ルートに実体があるか」で決めるため、集合が先に確定していないと全部落ちる。
    // 参照集合は**全文書の和**にする(1 つの配信ルートを全文書が共有するため)。
    const referenced = new Set<string>();
    for (const doc of documents) {
      for (const rel of collectDocumentAssetRefs(doc.html, doc.css)) referenced.add(rel);
    }
    const served = await stageDocAssets(dir, { referenced });
    const entries: string[] = [];
    for (const [i, doc] of documents.entries()) {
      const name = `doc-${String(i).padStart(3, '0')}.html`;
      const css = `${stripPageCounterReset(doc.css)}\n${MERGE_PAGE_COUNTER_CSS}`;
      await fs.writeFile(
        path.join(dir, name),
        inlineCss(doc.html, css, { servedAssets: served }),
        'utf8',
      );
      entries.push(name);
    }
    return { dir, config: mergeConfigObject(entries, size) };
  } catch (e) {
    // 中途書き出しのディレクトリを決して漏らさない(成功時の掃除は呼び出し側の責務)。
    await cleanupProject(dir);
    throw e;
  }
}
