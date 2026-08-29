# PdfToSvg: 辞書置換の箇所単位の戻し / 単件適用 — 設計

日付: 2026-08-17 / 対象: `pdf-to-svg/`

## 1. 背景と目的

辞書の再適用（`reapplyDict` / `reapplyDictPage`）は N 件の置換を 1 つの Undo マクロとして
積むため、置換の取り消しは「ページ（または全ファイル）まとめて」しかできない。
1 ページの中に「置き換えたい箇所」と「置き換えたくない箇所」が混在するケースがあり、
確認一覧（手順 2）から**箇所ごとに**戻せる必要がある。

要件:

1. 1 ページ内で置換する箇所・しない箇所を箇所単位で選べる（戻す / 単件で置換する）。
2. 戻しはその場限りで、次の「再適用」ではまた置換される（恒久除外のフラグは持たない。
   検討の末チェックボックス案は不採用）。
3. 同じ語がページ内に複数あっても、一覧の行がページ上のどこかを識別できる
   （番号マーカー + 行ホバーで該当箇所を強調）。

## 2. 設計

### 2.1 モデル（`src/model/elements.py`）

- `DictRevertInfo`（dataclass）: 置換前の `text` / `bbox` / `wrap_align` / `origin_y` と、
  折返し畳み込みで論理削除した後続行の id 一覧 `extra_ids: List[int]`。
- `TextElement.dict_revert: Optional[DictRevertInfo] = None` — 置換が当たっている間だけ保持し、
  戻すときの復元元にする。要素自身が復元情報を持つのは、コマンドはマクロ内に埋まっていて
  外から個別に辿れず、Undo 深さ上限で捨てられもするため。

### 2.2 置換計画（`src/dictionary/apply.py`）

- `plan_replacements` は無改変。戻した箇所は text が元に戻るので、次の再適用・確認一覧の
  候補計算で自然に再び候補になる。
- `apply_replacement`（テスト・バッチ用ヘルパ）は `dict_revert` も書く（Command と同じ状態に揃える）。

### 2.3 コマンド（`src/web/commands.py`）

- `ReplaceTextCommand(..., extras: List[TextElement] = ())`: `redo` で `el.dict_revert` に
  置換前状態を書き、`undo` で `dict_revert` を元の値（通常 None）へ戻す。
  `_apply_plans` は `rep.extras` を渡す（後続行の `DeleteCommand` はこれまでどおり別 push）。
- 新 `RevertDictMatchCommand(el, extras)`: `redo` = `dict_revert` から `text` / `bbox` /
  `wrap_align` / `origin_y` を復元し、`dict_match = None`、`dict_revert = None`、`extras` を
  `deleted = False`。`undo` = 逆（置換状態へ戻す）。通常の Undo/Redo に乗る。

### 2.4 RPC（`src/web/rpc_methods.py`）

- `planPage` 拡張: 各行に `state: "applied" | "pending"` を追加。
  `applied` = 現在 `dict_match` が付いている要素（従来どおり）。`pending` =
  `plan_replacements(pg, store)` の候補で未適用のもの（戻した箇所・まだ当てていない箇所）。
  並び順は要素の出現順（`page.elements` 順）で両者を混ぜる。行の通し番号（1 始まり）は
  この並び順で UI が振る。
- 新 `revertDictMatch {fileIndex, pageInFile, elId}`: 該当要素に `dict_revert` が無ければ no-op。
  あれば `RevertDictMatchCommand` を push。
- 新 `applyDictMatch {fileIndex, pageInFile, elId}`: `plan_replacements(pg, store)`
  から `elId` の候補を 1 件選び `_apply_plans` に渡す（1 件のマクロ）。
- `state` の `changed2`: 「置換が当たっている」または「未適用の候補がある」ページを true に
  する（戻したページが一覧から消えないように。`_page_has_replacements(page, store)`）。
- `reapplyDict` / `reapplyDictPage`: 変更なし（戻した箇所もまた置換される）。

### 2.5 UI（`resources/web/app.js` / `styles.css`）

確認ペイン（手順 2）の `renderConfirm`:

- バナー: 1 行目「このページで N 件を置換」、2 行目「未置換 M 件」（M=0 なら 2 行目を出さない）、
  3 行目は説明文「番号はページ上のマーカーと対応します」。
- 各行: 先頭に通し番号バッジ `.num`（applied=アクセント色 / pending=薄色）、場所、`source → target`、
  幅超過バッジ、右端にボタン 1 つ:
  - `applied` 行: 「戻す」`.act-revert` → `revertDictMatch`。
  - `pending` 行: 「置換」`.act-apply` → `applyDictMatch`。行は破線枠 + くぼみ地、`source` は
    打消し線なし、`target` は薄色、「未置換」バッジ `.state`。
- **番号マーカー**: `renderConfirm` 後に `drawChangeMarkers(changes)` が表示中の SVG
  （`#doc-master svg`）へ `<g data-editor-marks>` を追加し、各 `[data-el]` の左上に
  番号入り円（`getBBox` の座標。SVG 座標系なのでズームに追随）を描く。色は行の `.num` と同じ。
  再描画のたびに旧 `<g>` を除いて引き直す。表示用 DOM への挿入だけで、書き出し SVG（`exportSvg`
  RPC の結果）には入らない。
- **ホバー強調**: 行の `mouseenter` で該当要素に `sel-box`（既存 `flashElement` の持続版
  `highlightElement(hostId, elId, on)`）を出し、`mouseleave` で消す。行クリックのフラッシュは維持。
  ボタンは `stopPropagation`。
- 操作後は `invalidate(page)` → `reloadState()` → `render()`（既存の再適用ボタンと同じ流れ）。
- 置換 0 件かつ候補 0 件のときのみ「このページに置換はありません」。

### 2.6 ドキュメント

- `docs/pdf-to-svg/src/操作手順書.md`: 4 章の確認手順に「戻す / 置換」と番号マーカーの読み方を追記。
- `docs/pdf-to-svg/src/PdfToSvg_仕様一覧.md`: RPC 2 本と UI 操作を追加。
- `docs/pdf-to-svg/src/設計書.md`: `dict_revert` と `RevertDictMatchCommand` を追記。
- 生成: `python docs/_build/build_all.py --project pdf-to-svg`。

## 3. テスト

- `test/test_web_rpc.py`
  - 単独行の `revertDictMatch`: text / bbox / dict_match が復元され `planPage` の行が
    `pending` に変わる。Undo で置換状態へ戻り、Redo で再度戻る。
  - 折返し畳み込みの `revertDictMatch`: 後続行が `deleted=False` に戻り bbox / origin_y /
    wrap_align が復元される。
  - `applyDictMatch` が 1 件だけ置換し、他要素は不変。
  - 戻した後の `reapplyDictPage` でまた置換される。
  - `state.changed2` が戻した後も true。
- `test/test_wrap_header.py`: `apply_replacement` が `dict_revert` を書く。
- `test/app_flow.e2e.ts`: 再適用 → 行の「戻す」→ 行が未置換表示になる → 「置換」で戻る、の往復。
  番号マーカー数 = 行数。

## 4. 前提・非目標

- 恒久除外フラグ（「今後も置換しない」）は持たない。
- 置換行の並び替え・検索は対象外。
- Undo スタックの構造（マクロ・深さ上限）は変更しない。
