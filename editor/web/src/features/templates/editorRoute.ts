// =============================================================================
// editorRoute.ts — 編集画面への遷移先(2 系統のどちらで開くかの規則。純関数)
// =============================================================================
// 編集画面は編集経路(query なし)と作成経路(`?created=1`)の 2 系統で、経路の判定は
// `route.query.created === '1'` だけという原則は変えない。変えるのは「その query を誰が
// 出すか」で、一覧・承認タブ・プレビューに散らすと、どれか 1 つが取りこぼしたときだけ
// `status:'draft'` のテンプレートが編集経路で開く。ここへ集めて取りこぼしを無くす。

import type { TemplateMeta } from '@editor/shared';
import type { RouteLocationRaw } from 'vue-router';

/**
 * 編集画面への遷移先。編集画面へ `created` query を出す唯一の場所(作成タブ・テンプレ一覧・
 * 承認タブ・プレビューの「戻る」がここを通る。`EditorView` がプレビューへ渡す `created` は
 * 受け取った query の素通しで、経路を決めてはいない)。
 * 編集経路では query を持たせない(空の `query` を付けると URL に `?` が残り、
 * 「query なし = 編集経路」の見分けに余計な形が混ざる)。
 */
export function editorRoute(id: string, opts: { created: boolean }): RouteLocationRaw {
  return { name: 'editor', params: { id }, ...(opts.created ? { query: { created: '1' } } : {}) };
}

/**
 * そのテンプレートを作成経路で開くか。`status:'draft'` は作成タブが生成しただけで値入り
 * HTML(`filled/`)を持たない成果物で、編集経路で開くと値入り HTML が無いまま申請へ進み
 * server の `assertFilledPresentForEdit` に拒否される。
 */
export function opensAsCreate(meta: Pick<TemplateMeta, 'status'>): boolean {
  return meta.status === 'draft';
}
