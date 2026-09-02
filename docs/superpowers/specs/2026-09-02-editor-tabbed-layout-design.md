# editor: 編集・プレビュー画面のタブ内展開とヘッダ帯の 1 行統合 — 設計

- 日付: 2026-09-02
- 対象: `editor/web`（`MainLayout` / `EditorView` / `PreviewView` / router / e2e）
- 状態: 設計承認待ち

## 1. 目的

編集画面（`/edit/:id`）とプレビュー画面（`/preview/:id`）は現在 `MainLayout` の外にある
フルスクリーンの別ルートで、一覧からテンプレートを選ぶとアプリのヘッダとタブが消える。
これを「タブで選んだあとはタブの下に展開される」形に改め、常にアプリヘッダとタブが見える
状態で編集・プレビューできるようにする。

タブ内に入れると縦の予算をアプリヘッダ（56px）とタブ帯（約 46px）の 2 段分失うため、
併せてアプリヘッダとタブを 1 行（56px）に統合し、損失を半減させる。

## 2. 決定事項（利用者の選択）

| 論点 | 決定 |
|---|---|
| タブ内展開の実装形 | ルート子化（`/edit/:id` と `/preview/:id` を `MainLayout` の children へ移す） |
| 対象画面 | 編集・プレビューの両方（精査 `review-detail` は既に children） |
| 本文の最大幅 | 全画面で `max-w-[1400px]` → `max-w-[1760px]` へ拡張 |
| 縦のスクロールモデル | `MainLayout` を `h-screen` 化し、全タブを内側スクロールにする |
| ヘッダ帯 | アプリヘッダとタブナビを 1 行 56px に統合 |
| 編集中に他タブを押したとき | 編集を保持したままタブを行き来させる（破棄確認は出さない） |
| 「編集」タブへ戻ったとき | 直前に見ていた画面（一覧 or 編集中テンプレート）へ戻る |
| 未確定編集の破棄契機 | ブラウザタブを閉じたとき（セッション中は破棄しない） |
| 閉じるときの警告 | 未確定編集があるときだけブラウザ標準の離脱警告を出す |
| `EditorTopBar` 自身の 1 行化 | 保留（上記を入れた実機を見てから判断） |

## 3. 画面構造とルーティング

```
現行                                変更後
/edit          MainLayout 内         /edit          MainLayout 内
/create        MainLayout 内         /create        MainLayout 内
/edit/:id      MainLayout の外       /edit/:id      MainLayout 内（子化）
/preview/:id   MainLayout の外       /preview/:id   MainLayout 内（子化）
/reviews/:id   MainLayout 内         /reviews/:id   MainLayout 内
```

- `router/index.ts` の `editor` / `preview` レコードを `MainLayout` の `children` へ移す。
  `path` は `edit/:id` / `preview/:id`（先頭の `/` を落として相対にする）。`name` と
  `meta.access` は変えない。
- URL は不変なので、既存の遷移コード（`EditTabView.openEditor` / `CreateTabView` /
  `PreviewView` の `BackButton` fallback / `ReviewDiffView` の編集復帰）は無改修。直 URL・
  ブックマーク・e2e の `page.goto('/edit/<id>')` もそのまま通る。
- `EditorView` / `PreviewView` の root は `h-screen` → `h-full`（親の `main` が高さを決める）。

## 4. ヘッダ帯の 1 行統合と寸法

### 4.1 構成

```
[RET] [編集][テンプレート作成][承認]│[結合PDF][比較]│[履歴]            [管理者][🌙][user ▾]
```

- 現行の 2 段（`h-14` ヘッダ + `border-t` のタブ `nav`）を 1 つの `header` にまとめる。
  ロゴ（`RET` のみ。副文言「Report Edit Tool」は落とす）→ タブ群 → 右端（管理者 / テーマ /
  ユーザー）の順。高さは 56px 固定。
- タブの見た目（`RouterLink` の class・グループ区切り・承認待ち件数バッジ）は現行を保つ。
- 幅の概算は約 1189px（ロゴ 174 + タブ 672 + 右 271 + 余白 72）。1760px 枠には収まる。
  ビューポート 1229px 未満で溢れる場合は `header` 全体を `overflow-x-auto` にする（現行の
  `nav` と同じ作法。要素を隠さない）。

### 4.2 最大幅

- `MainLayout` の 3 か所（ヘッダ・本文）の `max-w-[1400px]` を `max-w-[1760px]` へ。
  根拠: 編集画面の左ペイン 272px + 右ペイン 312px = 584px が固定で、1400px 枠（内容幅
  1360px）に入れると canvas が 776px となりページ実体 794px を下回る。1760px 枠（内容幅
  1720px）なら canvas は 1136px。
- 設計正典の「1400px を狭めない」は絞り込みバーの要件から来る**下限**であり、拡張は抵触
  しない。`MainLayout.vue` のコメントは新しい根拠（下限 1400 / 上限 1760 の理由）へ書き換える。

### 4.3 実測（2026-09-02 スパイク、1920×1080、seed テンプレート）

| 構成 | フィット倍率 | 備考 |
|---|---|---|
| 現行（フルスクリーン） | 86% | canvas 1336px |
| 1760px 枠 + 1 行帯 | 81% | 帯 56px の分だけ縦が減る |
| 1400px 枠 + 1 行帯 | 78% | `EditorTopBar` が折り返し「プレビュー」が 2 行目へ落ちる |
| 上限なし + 1 行帯 | 81% | 1760px と同じ（フィットは縦で決まる） |

フィット倍率は縦（帯の 56px）で決まり、横幅 200px の差は倍率に影響しない。1400px のままだと
`EditorTopBar` が溢れるため 1760px への拡張は必須。

## 5. スクロールモデル

- `MainLayout` の root: `min-h-screen` → `flex h-screen flex-col overflow-hidden`。
- `main`: `flex-1 min-h-0 overflow-auto`。`mx-auto max-w-[1760px] px-5` は保つ。
  編集・プレビューでは `pt-6 pb-16` の余白が邪魔になるため、`route.meta.flush === true`
  のときだけ余白を落とす（`px-0 pt-0 pb-0`）。`flush` を宣言するのは `editor` と `preview` の
  2 レコードのみ。
- 全タブが内側スクロールになる。検索一覧・比較・履歴のスクロール位置はページではなく
  `main` に付く。両ヘッダとも `print:hidden` は現行どおりで、印刷は影響を受けない。
- `EditorView` の canvas overlay は `noScroll: true`（`boundingClientRect` 基準）で座標を
  取っているため、スクロールコンテナが変わっても座標計算は変わらない。`ResizeObserver` +
  `fitToView` が高さの変化を吸収する。

## 6. 編集セッションの生存規則

### 6.1 原則

セッション = **ブラウザタブの寿命**。セッション中（タブ遷移・プレビュー往復・リロード）は
未確定編集を保持し、ブラウザタブを閉じたら破棄する。

```
リロード          → 復元
タブ内遷移        → 保持
プレビュー往復    → 保持
ブラウザタブを閉じる → 未確定があれば警告 → 閉じたら次回オープン時に破棄
確定保存（申請）  → セッション終了
```

### 6.2 仕組み

ブラウザを閉じる瞬間にサーバへ破棄要求を届ける手段は不確実（`beforeunload` 内の通信は
ベストエフォート、クラッシュや電源断では何も送れない）。閉じる瞬間には頼らず、**次回
オープン時に破棄を成立させる**。

- セッショントークン: `sessionStorage` に乱数トークンを 1 つ持つ（キー
  `editor:tab-session`）。無ければ生成する。タブを閉じると消え、リロードとタブ内遷移では残る。
- draft の所属: `localStorage` に `Record<templateId, token>` を持つ（`storageKeys.K` に
  `draftOwner: 'editor:draft:owner'` を追加。Undo ミラーと同じくユーザースコープ付き）。
  autosave で draft を書くたびに現在のトークンを記録する。
- `loadForEdit`（`templateEditorService.ts`）で draft が見つかったとき:
  - 所属トークン = 現在のトークン → 復元（現行どおり `hasDraft` で dirty を復帰）。
  - 不一致または未記録 → `discardDraft` を呼んでから確定版で開く。所属の記録も消す。
- `onBeforeRouteLeave`（`useTemplateEditor.ts`）から破棄確認ダイアログ・`discardDraft`・
  `sessionStore.clear` を撤去する。`autosave.settled()` の待ち合わせと Undo ミラーの確定は残す。
- `beforeUnload` の警告条件を「autosave が pending / saving / error」から
  「**`dirty` または** autosave が pending / saving / error」へ広げる。未確定が無ければ
  警告しない。文言はブラウザ標準（カスタム不可）。
- セッション終了は確定保存（申請）成立時。既存の `sessionStore.clear` はそのまま。
  明示的な「編集を破棄」導線は置かない。

### 6.3 非サポート（現行と同じ）

同一テンプレートを複数のブラウザタブ・複数の利用者が同時に編集すること。後から開いた側の
トークンが一致しないため、先に開いていた側の draft を破棄しうる。

## 7. タブ復帰（直前に見ていた画面へ戻る）

- Pinia ストア `stores/tabMemory.ts`: `Record<tabName, fullPath>` を in-memory で持つ
  （リロード後はルート自体が復元されるので永続化は不要）。
- `router.afterEach` で、遷移先が `MainLayout` の children なら `tabOf(route)`（§8）の
  タブ名をキーに `fullPath` を記録する。
- `MainLayout` のタブ `RouterLink` の `to` は、記憶があればその `fullPath`、無ければ
  `{ name: tab.name }`。
- 例: 編集中に「比較」→「編集」と押すと編集中のテンプレートへ戻る。一覧を見ていた状態で
  「比較」→「編集」なら一覧へ戻る。

## 8. タブ点灯の写像と 2 系統の原則

- 純関数 `tabOf(route): TabName` を `features/layout/tabOf.ts` に置く。
  - `editor` / `preview` → `route.query.created === '1'` なら `create`、でなければ `edit`。
  - `review-detail` → `reviews`。
  - それ以外は `route.name`。
- `MainLayout` の `activeName` と §7 の記録キーは、どちらもこの関数を使う（判定を 2 か所に
  書かない）。
- 2 系統の原則（設計正典「中核原則」）との関係: 経路判定の根拠が `route.query.created === '1'`
  のみである点は変わらない。`tabOf` はその根拠を**表示上のタブ点灯へ写す**だけで、値の
  差し込みやハイライトの出し分けには関与しない。`web/test/twoSystems.guard.test.ts` に
  写像のテスト（`created=1` の編集ルートは「テンプレート作成」タブ、query なしは「編集」
  タブ）を追加し、設計正典に「タブ点灯もこの query から写す」旨を追記する。

## 9. 回帰網と後始末

### 9.1 先行して直すもの

`e2e/header_layout.spec.ts` の `headerRows()` は `document.querySelector('header')` で
測っている。子化するとこれがアプリヘッダに一致し、`EditorTopBar` でない要素を測って
**緑のまま通る**。着手前に `EditorTopBar` を一意に選ぶセレクタ（例:
`header:has([aria-label="一覧へ戻る"])`）へ改め、統合前後で同じものを測ることを保証する。

### 9.2 追加するテスト

- `web/test/tabOf.test.ts`: §8 の写像。
- `web/test/twoSystems.guard.test.ts`: §8 の追加ケース。
- `web/test/tabMemory.test.ts`: §7 の記録と復帰。
- `web/test/draftOwner.test.ts`（または `templateEditorService` のテストへ追加）: §6.2 の
  「トークン一致で復元 / 不一致で破棄」。
- `e2e/header_layout.spec.ts`: 統合ヘッダが 1440px / 1600px / 1920px で 1 行に収まること
  （`EditorTopBar` の既存検証に加えて、アプリヘッダ側の行数も測る）。
- `e2e/smoke.spec.ts`: 編集画面でアプリヘッダとタブが見えること、タブ遷移で破棄確認が
  出ないこと、「編集」タブで編集中テンプレートへ戻ること。

### 9.3 後始末

- `capture_docs.spec.ts` の `editor.png` / `editor-parts.png` / `preview.png` が変わる →
  `py -3.13 docs/_build/build_all.py --project editor` を再実行し、HTML を作り直して
  コミットに含める。
- `docs/editor/src/設計正典.md`: 「本文の最大幅」の項を 1400（下限）/ 1760（上限）の
  2 値で書き直す。編集セッションの生存規則（§6）と、タブ点灯の写像（§8）を追記する。
- `docs/editor/src/設計書.md` の画面遷移の記述を更新する。

## 10. 対象外・保留

- `EditorTopBar` 自身の 1 行化（左ゾーンの「ファンド名 + バッジ」行と「属性チップ」行の
  縦 2 段）。統合後の実機を見て判断する。
- ログイン・パスワード初期化画面（`MainLayout` の外）は変更しない。
- 精査画面（`ReviewDiffView`）は既に `MainLayout` 内で、変更しない。
