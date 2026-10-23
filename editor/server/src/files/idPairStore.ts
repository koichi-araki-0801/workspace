// =============================================================================
// idPairStore.ts — `<dir>/<id>.{html,css}` の対で持つ作業コピーの入れ物
// =============================================================================
// 下書き(`draftFiles.ts`)と pending(`pendingFiles.ts`)は置き場だけが違う同じ形のストア。
// `id` は request 由来のまま渡ってくる。ディレクトリと連結する前にここで必ず検査する —
// 検査を呼び出し側へ委ねると、`../templates/<確定版>` を渡すだけで承認ゲートを迂回して
// 確定ファイルを書ける。テンプレート(3 つ区切り)と値入り HTML(4 つ区切り)のどちらの id も受ける。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertAnyTemplateId, isValidAnyTemplateId } from '@editor/shared';
import { atomicWrite } from './atomic.js';
import { readOrMissing, statMtime } from './fsHelpers.js';

interface IdPairStore {
  /** 書き込む。規約外の id は例外にし、ディレクトリも作らない。 */
  write(id: string, html: string, css: string): Promise<void>;
  /**
   * 読む。規約外の id と HTML の ENOENT は null、CSS の ENOENT は空文字(`cssFound` が false)。
   * それ以外の読み取り失敗は例外にする。
   */
  read(id: string): Promise<{ html: string; css: string; cssFound: boolean } | null>;
  /** 本体の `.html` があるものの id 一覧。規約外の名前は捨てる。 */
  listIds(): Promise<string[]>;
  /** HTML の最終更新時刻(ISO)。無ければ(id が規約外なら)null。 */
  mtime(id: string): Promise<string | null>;
  /** 破棄する。既に無ければ no-op、id が規約外なら例外。 */
  remove(id: string): Promise<void>;
}

/**
 * ここが `atomicWrite` の書き込み口なので、任意の `dir` を受ける `createIdPairStore` の利用者は
 * `confirmedWrite.guard.test.ts` で `draftFiles.ts` と `pendingFiles.ts` だけに固定している。
 * `dir` は呼び出しごとに評価する(設定の差し替えをテストで効かせるため)。
 */
export function createIdPairStore(dir: () => string): IdPairStore {
  const pathOrNull = (id: string, ext: 'html' | 'css'): string | null =>
    isValidAnyTemplateId(id) ? path.join(dir(), `${id}.${ext}`) : null;

  return {
    async write(id, html, css) {
      // 検査を先に済ませてからディレクトリを作る(不正 id でディレクトリだけ生える副作用を避ける)。
      const valid = assertAnyTemplateId(id);
      await fs.mkdir(dir(), { recursive: true });
      await atomicWrite(path.join(dir(), `${valid}.html`), html);
      await atomicWrite(path.join(dir(), `${valid}.css`), css);
    },

    async read(id) {
      const htmlPath = pathOrNull(id, 'html');
      if (!htmlPath) return null;
      const html = await readOrMissing(htmlPath, null);
      if (html === null) return null;
      // HTML 側の検査を通った id は CSS 側も通る(同じ検査)。
      const css = await readOrMissing(path.join(dir(), `${id}.css`), null);
      return { html, css: css ?? '', cssFound: css !== null };
    },

    async listIds() {
      const entries = await fs.readdir(dir()).catch(() => [] as string[]);
      return entries
        .filter((f) => f.endsWith('.html'))
        .map((f) => f.slice(0, -'.html'.length))
        .filter((id) => isValidAnyTemplateId(id));
    },

    async mtime(id) {
      const p = pathOrNull(id, 'html');
      return p ? statMtime(p) : null;
    },

    async remove(id) {
      const valid = assertAnyTemplateId(id);
      await Promise.all([
        fs.rm(path.join(dir(), `${valid}.html`), { force: true }),
        fs.rm(path.join(dir(), `${valid}.css`), { force: true }),
      ]);
    },
  };
}
