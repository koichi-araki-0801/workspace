# PdfToSvg: 辞書置換の箇所単位の戻し / 単件適用 / 恒久除外 — 設計

日付: 2026-08-17 / 対象: `pdf-to-svg/`

## 1. 背景と目的

辞書の再適用（`reapplyDict` / `reapplyDictPage`）は N 件の置換を 1 つの Undo マクロとして
積むため、置換の取り消しは「ページ（または全ファイル）まとめて」しかできない。
1 ページの中に「置き換えたい箇所」と「置き換えたくない箇所」が混在するケースがあり、
確認一覧（手順 2）から**箇所ごとに**戻せる必要がある。

要件:

1. 1 ページ内で置換する箇所・しない箇所を箇所単位で選べる（戻す / 単件で置換する）。
2. 「今後も置換しない」（再適用でスキップ）はチェックボックスで指定する。**既定は OFF**
   （OFF なら次の再適用でまた置換される）。

## 2. 設計

### 2.1 モデル（`src/model/elements.py`）

- `DictRevertInfo`（dataclass）: 置換前の `text` / `bbox` / `wrap_align` / `origin_y` と、
  折返し畳み込みで論理削除した後続行の id 一覧 `extra_ids: List[int]`。
- `TextElement.dict_revert: Optional[DictRevertInfo] = None` — 置換が当たっている間だけ保持し、
  戻すときの復元元にする。要素自身が復元情報を持つのは、コマンドはマクロ内に埋まっていて
  外から個別に辿れず、Undo 深さ上限で捨てられもするため。
- `TextElement.dict_skip: bool = False` — 「今後も置換しない」チェックの実体。
  文書のメモリ内でのみ有効（辞書 JSON・書き出し SVG には残さない）。Undo 対象外の単純フラグ。

### 2.2 置換計画（`src/dictionary/apply.py`）

- `plan_replacements(page, store, include_skipped=False)`: 既定では `dict_skip=True` の要素を
  候補から外す（折返しグループは先頭要素の `dict_skip` で判定し、グループごと外す）。
  `include_skipped=True` は確認一覧の表示用（skip 中の候補も並べる）。
- `apply_replacement`（テスト・バッチ用ヘルパ）は `dict_revert` も書く（Command と同じ状態に揃える）。

### 2.3 コマンド（`src/web/commands.py`）

- `ReplaceTextCommand(..., extras: List[TextElement] = ())`: `redo` で `el.dict_revert` に
  置換前状態を書き、`undo` で `dict_revert` を元の値（通常 None）へ戻す。
  `_apply_plans` は `rep.extras` を渡す（後続行の `DeleteCommand` はこれまでどおり別 push）。
- 新 `RevertDictMatchCommand(el, extras)`: `redo` = `dict_revert` から `text` / `bbox` /
  `wrap_align` / `origin_y` を復元し、`dict_match = None`、`dict_revert = None`、`extras` を
  `deleted = False`。`undo` = 逆（置換状態へ戻す）。通常の Undo/Redo に乗る。

### 2.4 RPC（`src/web/rpc_methods.py`）

- `planPage` 拡張: 各行に `state: "applied" | "pending"` と `skip: bool` を追加。
  `applied` = 現在 `dict_match` が付いている要素（従来どおり）。`pending` =
  `plan_replacements(pg, store, include_skipped=True)` の候補で未適用のもの（戻した箇所・
  skip 中の箇所）。並び順は要素の出現順（`page.elements` 順）で両者を混ぜる。
- 新 `revertDictMatch {fileIndex, pageInFile, elId}`: 該当要素に `dict_revert` が無ければ no-op。
  あれば `RevertDictMatchCommand` を push。
- 新 `applyDictMatch {fileIndex, pageInFile, elId}`: `plan_replacements(..., include_skipped=True)`
  から `elId` の候補を 1 件選び `_apply_plans` に渡す（1 件のマクロ）。明示操作なので
  `dict_skip` に関わらず適用する。
- 新 `setDictSkip {fileIndex, pageInFile, elId, value}`: `dict_skip` を書く。Undo 対象外。
- `state` の `changed2`: 「置換が当たっている」または「未適用の候補がある」ページを true に
  する（戻したページが一覧から消えないように。`_page_has_replacements(page, store)`）。
- `reapplyDict` / `reapplyDictPage`: 変更なし（skip は `plan_replacements` 側で除外される）。

### 2.5 UI（`resources/web/app.js` / `styles.css`）

確認ペイン（手順 2）の `renderConfirm`:

- 見出し: 「このページで N 件を置換（未置換 M 件）」。M=0 なら括弧を省く。
- 各行に操作を追加:
  - `applied` 行: 「戻す」ボタン → `revertDictMatch`。
  - `pending` 行: 「置換」ボタン → `applyDictMatch`。行は `source` のみを地の色で表示
    （打消し線なし・矢印と `target` は薄色）。
  - 両状態: チェックボックス「今後も置換しない」（`dict_skip`）→ `setDictSkip`。
    `applied` 行で ON にしても即時には戻さない（次の再適用から効く）。
- 操作後は `invalidate(page)` → `reloadState()` → `render()`（既存の再適用ボタンと同じ流れ）。
- 行クリック（該当箇所フラッシュ）は維持。ボタン・チェックは `stopPropagation`。
- 置換 0 件かつ候補 0 件のときのみ「このページに置換はありません」。

### 2.6 ドキュメント

- `docs/pdf-to-svg/src/操作手順書.md`: 4 章の確認手順に「戻す / 置換 / 今後も置換しない」を追記。
- `docs/pdf-to-svg/src/PdfToSvg_仕様一覧.md`: RPC 3 本と UI 操作を追加。
- `docs/pdf-to-svg/src/設計書.md`: `dict_revert` / `dict_skip` と `RevertDictMatchCommand` を追記。
- 生成: `python docs/_build/build_all.py --project pdf-to-svg`。

## 3. テスト

- `test/test_web_rpc.py`
  - 単独行の `revertDictMatch`: text / bbox / dict_match が復元され `planPage` の行が
    `pending` に変わる。Undo で置換状態へ戻り、Redo で再度戻る。
  - 折返し畳み込みの `revertDictMatch`: 後続行が `deleted=False` に戻り bbox / origin_y /
    wrap_align が復元される。
  - `applyDictMatch` が 1 件だけ置換し、他要素は不変。
  - `setDictSkip` 後の `reapplyDictPage` がその要素をスキップし、`planPage` は
    `pending` + `skip=True` で返す。
  - `state.changed2` が戻した後も true。
- `test/test_wrap_header.py`（または `test_store_matcher.py`）: `plan_replacements` の
  `dict_skip` 除外（単独行 / 折返しグループ）と `include_skipped=True`。
- `test/app_flow.e2e.ts`: 再適用 → 行の「戻す」→ 行が未置換表示になる → 「置換」で戻る、の往復。

## 4. 前提・非目標

- `dict_skip` の永続化（辞書 JSON への保存）はしない。
- 置換行の並び替え・検索は対象外。
- Undo スタックの構造（マクロ・深さ上限）は変更しない。
