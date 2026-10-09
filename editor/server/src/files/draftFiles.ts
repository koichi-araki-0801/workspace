// =============================================================================
// draftFiles.ts — 自動保存ドラフトの作業コピー(ディスク I/O)
// =============================================================================
// 自動保存(autosave)のドラフト作業コピーをディスク上に持つ
// (`<dataRoot>/drafts/<id>.{html,css}`)。ドラフトは template ごとに 1 件で、
// autosave のたびに上書きする。

import { config } from '../config.js';
import { createIdPairStore } from './idPairStore.js';

// 検査と I/O は `createIdPairStore` が持つ。`templateId` は request 由来のまま渡ってくるが、
// ストアが連結の前に必ず検査するので、`../templates/<確定版>` で承認ゲートを迂回できない。
const store = createIdPairStore(() => config.draftsDir);

export function writeDraft(templateId: string, html: string, css: string): Promise<void> {
  return store.write(templateId, html, css);
}

/**
 * 下書きの HTML/CSS を読む。規約外の id と HTML の ENOENT は null(下書き無し)、CSS の ENOENT は
 * 空文字に倒し、それ以外の読み取り失敗は例外にする — 一過性の失敗を `''` へ倒すと、空で復元された
 * 下書きが次の自動保存で上書きされる。
 */
export async function readDraft(templateId: string): Promise<{ html: string; css: string } | null> {
  const found = await store.read(templateId);
  return found && { html: found.html, css: found.css };
}

/**
 * template の下書き(HTML)が存在するか。台帳を引かずファイル有無で判定する。
 * テストから直接検証するために公開する。
 * @public
 */
export async function draftExists(templateId: string): Promise<boolean> {
  return (await store.mtime(templateId)) !== null;
}

/** 下書き(HTML)の最終更新時刻(ISO)。無ければ(id が規約外なら)null。 */
export function draftMtime(templateId: string): Promise<string | null> {
  return store.mtime(templateId);
}

/**
 * 下書きの作業コピー(HTML/CSS)を破棄する。確定保存せずメニューへ戻った際に
 * 未確定の編集を消すため呼ぶ。既に無ければ no-op。
 * id が規約外なら削除する前に例外にする(任意ファイル削除の経路を塞ぐ)。
 */
export function deleteDraft(templateId: string): Promise<void> {
  return store.remove(templateId);
}

/** 下書きのある `templateId` の一覧(本体の `.html` があるもの)。規約外の名前は捨てる。 */
export function listDraftIds(): Promise<string[]> {
  return store.listIds();
}
