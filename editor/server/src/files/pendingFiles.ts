// =============================================================================
// pendingFiles.ts — 新規生成テンプレの未確定(pending)実体(ディスク I/O)
// =============================================================================
// `POST /api/generate` の成果物を置く場所(`pending/<id>.{html,css}`、git 管理外)。
// 確定ディレクトリ(templatesDir)へは生成経路から一切書かないという不変則の受け皿で、
// 確定への昇格は承認(`repositories/confirmedWrite.ts`)だけが行う。
//
// pending の内容が確定へ流れる経路は「人が編集して申請 → 承認」以外に無い。
// 「承認時に pending が在ればそれを使う」といった最適化を足すと、そこが承認ゲートを
// 迂回する第 2 経路になるので入れないこと。

import { config } from '../config.js';
import { createIdPairStore } from './idPairStore.js';

// 検査と I/O は `createIdPairStore` が持つ。`templateId` は request 由来のまま渡ってくるが、
// ストアが連結の前に必ず検査するので、`../templates/<確定版>` で承認ゲートを迂回できない。
const store = createIdPairStore(() => config.pendingDir);

export function writePending(templateId: string, html: string, css: string): Promise<void> {
  return store.write(templateId, html, css);
}

/**
 * pending 実体を読む。HTML が無ければ null、CSS が無ければ空文字(どちらも ENOENT のときだけ)。
 * それ以外の読み取り失敗は例外にする — null へ倒すと「pending が無い」と読まれて実行コード
 * 不変性の基準が空になり、CSS を `''` へ倒すと空の CSS で開いた編集がそのまま申請・承認される。
 * `cssFound` は CSS のファイルがあったか(無いときは `css` が空文字で、呼び出し側が警告へ使う)。
 */
export function readPending(
  templateId: string,
): Promise<{ html: string; css: string; cssFound: boolean } | null> {
  return store.read(templateId);
}

/**
 * pending 実体の `templateId` 一覧。編集タブの一覧はここを確定分と合成する — 混ぜないと
 * 生成直後のテンプレが検索に出ず、id を知る術が UI から消える(作成タブは生成後に
 * `/edit/:id` へ 1 回遷移するだけで、履歴タブは遷移経路を持たない)。
 * 規約外の名前は捨てる(`pendingDir` は git 管理外で、手で置かれた物が混ざりうる)。
 */
export function listPendingIds(): Promise<string[]> {
  return store.listIds();
}

export function pendingMtime(templateId: string): Promise<string | null> {
  return store.mtime(templateId);
}

/** 承認で確定へ昇格した後の後始末。既に無ければ no-op。id が規約外なら例外にする。 */
export function deletePending(templateId: string): Promise<void> {
  return store.remove(templateId);
}
