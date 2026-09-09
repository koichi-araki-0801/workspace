# editor 編集画面 4 要望 + 調査で判明したバグ — dig 記録

対象: ①起動時ズーム 100% / ②コメント種別の廃止 / ③無編集でプレビューから戻ると赤入れ表示になる（バグ）/
④オフライン構築の HTTPS 取得と展開の分離 / ⑤プレビュー往復で UI 状態がリセットされる（バグ）/
⑥Undo で確定版と同一になったら「未確定」を下ろす。
前回実装は `c9350e9` で全 revert 済み（実装は履歴 `10befc4..bb95201` に参照用で残る）。

## 調査で判明した隠れた事実（Phase 1）

- **発見 A（前回実装の潜在退行）**: GrapesJS 既定 `avoidInlineStyle: true` のため
  `patchSelectedStyle` の `comp.setStyle()` は inline style ではなく `#<自動id>{…}` の CssRule に書く
  （`geom.ts` の「inline style」記述は実態と乖離）。幾何を編集したパーツは自動 id が保存内容の
  一部として必要で、前回の「明示属性に無い id を全削除」は幾何編集を再読込で失う。
  実データに `#i…` 規則は 0 件、幾何の往復保存テストも無く、検出されない形だった。
- **発見 B（実データ汚染）**: `editor-data/css/510037.css` は承認コミット `45dc044` で
  `* { box-sizing: border-box }` `body { margin: 0 }` が先頭に混入、
  `templates/AM01_510037_20240710_kr.html` に `<h2 id="i8kcl">`。canvas は protectedCss で
  border-box 前提、PDF 側 CSS には無く、canvas と PDF が元々食い違っていた。
- **発見 C（方針衝突）**: ④ の `fetch-offline-bundle.ps1` 新設はメモリ「新規 .ps1/.mjs 禁止・
  Python 第一」と衝突する。
- GrapesJS `getHtml` は `getAttributes` で「id セレクタが SelectorManager に在る」だけで自動 id を
  出力する（選択で StyleManager が空の `#id` 規則を作るため）。`cleanId` オプションは空規則でも
  id を残すので、そのままでは使えない。
- 赤入れ差分（`redlineDiff.ts`）は text / tag のみ比較で属性差分は出さない。プレビューの
  sanitize（`ADD_ATTR`）は `style` を通す。既存テンプレに inline `style` は 0 件。

## Round 1 の決定

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 幾何（幅・配置）の保存先 | **inline style 属性へ切替**（`setStyle(…, {inline:true})` または `avoidInlineStyle:false`）+ 自動 id は全削除 | 幾何がパーツと一体になりペア同期・赤入れ・構造キーが素直。既存データに `#id` 規則 0 件で移行なし | `getStyle/setStyle` 経路の総点検が要る。赤入れは `style` 差分を出さない（従来も同じ） |
| protectedCss | **`protectedCss: ''` で canvas からも外し PDF と揃える**。必要分は `canvasCss` に明示 | canvas⇄PDF の不一致を解消 | canvas の見た目が変わりうる → 実機確認・スクショ再撮影 |
| 510037 の汚染データ | **editor-data を手で直して commit**（検証環境データ） | 本番未デプロイ。承認フローで直す価値は無い | — |
| 「未確定」判定 | **内容比較 1 本**（保存内容を確定版正規形と比べる）+ `component:update` のイベントフィルタも即時応答用に残す | 1 機構で ③⑥ を解き、prop 名の許可リストへの依存を主防御にしない | 変更ごとの直列化（debounce 必須）。正規形の取り方は Round 2 |

## Round 2 の決定

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 確定版正規形の取り方（⑥ の基準） | **確定版から開いた初回に `getBodyHtml/getCss` を取り localStorage へ永続**。キーにテンプレの `updatedAt` を含め承認更新で無効化。無ければ canvas 二重 load へフォールバック | 通常経路で parse 2 回を避ける | 永続キーが 1 つ増える（30〜40KB）。`updatedAt` が null の版は毎回フォールバック |
| UI 状態の保持先（⑤） | **localStorage 永続**（倍率・ページ表示・右ペインタブ・赤入れ表示・guide）。**`allowEdit` と選択はメモリのみ** | 「リロードは同一セッション」原則と整合しつつ、編集許可の安全側既定 OFF を保つ | — |
| ④ fetch の言語 | **`.ps1`（`offline/fetch-offline-bundle.ps1` + `.bat`）**。取得 → 検証 → 配置は `offline/lib/fetch.ps1` に切り出し Pester で固定（ユーザー判断で Python 案を覆した） | setup と同じ言語で `verify.ps1`（`.sha256` 検証）を共有し二重実装を避ける。fetch 側端末に Python を要求しない | 「新規 .ps1 禁止・Python 第一」方針の例外（offline 配布スクリプト群は .ps1 で統一） |
| 起動倍率と resize（①） | **起動 100% 固定、resize は倍率据え置き（overlay と縦配置だけ追随）、フィットは Ctrl+0 / % ボタンのみ** | 要望①の趣旨 | 狭い画面では横スクロール。既存 e2e「ズーム」は初期フィット前提なので書き換え |
| ⑥ 同一判定時の draft | **「未確定」を下ろし draft も削除。進行中 autosave を待ち、待機中に再編集が入れば削除しない** | プレビューの「変更なし」・申請不可と整合。消してはいけない draft を消さない | — |
| ② `kind` の撤去範囲 | **スキーマ・API・UI から撤去、旧データの `kind` は読み捨て** | 実データに kind 値 0 件 | OpenAPI 再生成・docs 更新が伴う |
| ④ bk\ 退避 | **「直下のバンドルを使った回」に退避** | 従来の結果と同じ | — |

## Round 3 の決定

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 旧データ（自動 id・protectedCss 混入済みの Undo ミラー / REST draft） | **Undo ミラー形式の版数を上げて旧ミラーを捨てる**（`undoStacksKey` の版数）。REST draft は手で消す（検証環境 1 件、混入 0 件を確認済み） | 自動 id は load で明示属性になりテンプレ由来 id と機械判別できない。正規化コードを恒久化しない | 開発端末の Undo 履歴が 1 回消える |
| 退行網の置き場 | **unit（jsdom で GrapesJS を実体起動）で機構を固定、e2e は ③⑤⑥ の往復統合 2 本** | 発見 A を逃した原因は「幾何の往復保存」テストの欠落。CI 時間を増やさず機構ごとに固定 | 実ブラウザ差は e2e 2 本頼み |
| コミット分割 | **6 コミット**: ④ fetch（.ps1）/ 保存形式（幾何 inline 化 + 自動 id 除去 + protectedCss）/ dirty 機構（③⑥）/ ① 起動 100% + スクショ再撮影 / ⑤ UI 状態 / ② kind 撤去。editor-data の汚染修正は別リポで 1 commit | 保存形式の変更を単独で bisect できる | 保存形式のコミット直後は「選択だけで未確定」が残る（次コミットで解消） |
| `canvasCss` に残す規則 | **計画の先頭に canvas⇄PDF の実機比較 spike を置いて決める** | protectedCss を外した後の見た目は実機でしか判断できない | spike の結果で `canvasCss` の内容と ① のスクショが変わる |

## Dig Summary

### Investigation Overview

- Rounds completed: 3
- Questions asked: 14
- Assumptions challenged: 9（A1〜A8 + 旧データ）
- Decisions made: 15

### Key Discoveries

1. **幾何編集は自動 id に依存していた（発見 A）**。GrapesJS 既定 `avoidInlineStyle: true` により
   `comp.setStyle()` は `#<自動id>{…}` CssRule へ書く。前回実装の「明示属性に無い id を全削除」は
   幾何編集を再読込で失う退行を含んでいた。実データに `#i…` 規則 0 件・往復保存テスト無しで検出
   されない形だった。→ 幾何を inline style 属性へ切替え、自動 id への依存を断つ。
2. **canvas と PDF は元々食い違っていた（発見 B）**。canvas は protectedCss `*{box-sizing:border-box}`
   `body{margin:0}` 前提、PDF 側 CSS には無い。承認 `45dc044` で 510037 の確定 CSS にこれが混入し、
   PDF 側の見た目まで変わった。→ `protectedCss: ''` で canvas を PDF に揃え、必要分は実機比較で決める。
3. **「未確定」の判定を内容比較 1 本に寄せる**と ③（選択だけで未確定）と ⑥（Undo で同一なら下ろす）が
   同じ機構で解ける。イベントフィルタ（`SAVE_NEUTRAL_PROPS`）は即時応答用の補助に降格する。
4. ④ の fetch は **`.ps1`** で書く（ユーザー判断。setup と同じ言語で `verify.ps1` を共有し、`.sha256` 検証の二重実装を避ける。発見 C の方針衝突は「offline 配布スクリプト群は .ps1 で統一」の例外として受け入れる）。

### All Decisions

| # | 論点 | 決定 | 根拠 | リスク | 備考 |
|---|---|---|---|---|---|
| Q1 | 幾何の保存先 | inline style 属性（`{inline:true}` or `avoidInlineStyle:false`）+ 自動 id 全削除 | パーツと一体・id 依存ゼロ | 中 | `getStyle/setStyle` 経路の総点検。赤入れは `style` 差分を出さない（従来同様） |
| Q2 | protectedCss | `protectedCss: ''`、必要分は `canvasCss` に明示 | canvas⇄PDF を揃える | 中 | Q14 の spike で内容確定 |
| Q2' | 510037 汚染 | editor-data を手で直して commit | 検証環境データ・本番未デプロイ | 低 | `css/510037.css` 先頭 2 規則、`templates/AM01_510037_20240710_kr.html` の `id="i8kcl"` |
| Q3 | 未確定判定 | 内容比較 1 本 + イベントフィルタは即時応答用 | 1 機構で ③⑥、prop 名依存を主防御にしない | 低 | 直列化は debounce |
| Q4 | 確定版正規形 | 初回に取って localStorage 永続（キーに `updatedAt`）。無ければ二重 load | 通常経路で parse 2 回を避ける | 低 | `updatedAt` null は毎回フォールバック |
| Q5 | UI 状態の保持先 | localStorage 永続。`allowEdit` と選択はメモリのみ | 「リロードは同一セッション」と安全側既定 OFF の両立 | 低 | — |
| Q6 | fetch の言語 | `.ps1` + `.bat`（`lib/fetch.ps1` を Pester で固定） | setup と同言語・`verify.ps1` 共有 | 低 | Python 第一方針の例外（ユーザー判断） |
| Q7 | 起動倍率・resize | 100% 固定・resize 据え置き・フィットは手動のみ | 要望① | 低 | 既存 e2e「ズーム」を書き換え |
| Q8 | ⑥ の draft | 未確定を下ろし draft 削除。進行中 autosave を待ち、待機中の再編集で削除しない | 「変更なし」バッジ・申請不可と整合 | 低 | — |
| Q9 | `kind` 撤去範囲 | スキーマ・API・UI から撤去、旧データは読み捨て | 実データに kind 値 0 件 | 低 | OpenAPI 再生成・docs |
| Q10 | bk\ 退避 | 直下のバンドルを使った回に退避 | 従来と同じ結果 | 低 | — |
| Q11 | 旧ミラー / 旧 draft | ミラー版数を上げて捨てる。REST draft は手で消す | id は機械判別不能 | 低 | 開発端末の Undo が 1 回消える |
| Q12 | 退行網 | unit（jsdom + GrapesJS 実体）主、e2e 往復統合 2 本 | 発見 A の再発防止、CI 時間 | 低 | — |
| Q13 | コミット分割 | 6 コミット + editor-data 1 commit | 保存形式を単独で bisect | 低 | 順序は下記 |
| Q14 | `canvasCss` の残し方 | 計画先頭の実機比較 spike で決める | 見た目は実機でしか判断できない | 中 | ① のスクショは spike 後に撮る |

### 却下案と理由（再提案しない）

- **自動 id を「明示属性に無ければ全削除」だけで済ませる（幾何は CssRule のまま）**: 幾何編集が
  再読込で消える（発見 A）。
- **自動 id の削除条件を「非空の `#id` 規則が無い」に絞る（CssRule 方式を温存）**: 幾何を持つ
  パーツの構造キーが自動 id 化して版再生成で消え、ペア同期はパーツ HTML だけ転写するので幾何が
  転写されない。inline 化の方が根本的。
- **GrapesJS `cleanId` オプション**: 選択で作られる空の `#id` 規則でも id を残すため、単独では
  「選択だけで id 混入」を止められない。
- **`getCss({avoidProtected:true})` のみ**: 保存は守れるが canvas⇄PDF の食い違い（発見 B）が残る。
- **「未確定」を Undo スタック底 = 確定版の構造判定で決める**: 永続ミラー上限 20 を超えると底が
  確定版でなく、手戻し編集も検出できない。
- **確定版正規形を毎回 canvas 二重 load で取る**: draft ありの再オープン毎に parse 2 回、刈り取り
  トースト抑止ハックが要る。フォールバックとしてのみ残す。
- **UI 状態を Pinia メモリのみに置く**: 「リロードは同一セッション」原則と不整合（Undo は残るのに
  倍率は戻る）。
- **`allowEdit` を永続する**: リロード後も編集許可が ON のままになり、安全側の既定 OFF が崩れる。
- **fetch を Python で書く**: `.sha256` 検証が `verify.ps1` と二重実装になり、fetch 側端末に Python を要求する。offline 配布スクリプト群は .ps1 で統一する（ユーザー判断。Python 第一方針の例外）。
- **fetch は取得のみ、検証は setup 側だけ**: 破損した取得物が直下に置かれ、次回 setup が
  「手元のバンドルを使う」経路で `.sha256` 検証を経ずに使う。
- **旧ミラーを load 時の正規化で救う**: protectedCss ブロックは剥がせても、明示属性化した自動 id は
  テンプレ由来 id と判別できない。恒久コードも増える。
- **e2e 主体の退行網**: pre-push CI（11〜12 分）がさらに伸び、負荷 flake が増える。

### 残リスク

- **canvas の見た目変化**（Q2/Q14）: protectedCss を外すと `body` 既定 margin 8px・content-box に
  なる。spike で確認するまで `canvasCss` の最終形は未定。ページ枠 210mm 内の見た目に影響しうる。
- **`updatedAt` が null の版**は確定版正規形のキャッシュが効かず毎回二重 load（性能のみ）。
- **狭い画面での横スクロール**（Q7）: 起動 100% 固定のため、canvas 幅 < 794px + 余白の環境では
  横スクロールになる。Ctrl+0 / % ボタンで手動フィット。
- **赤入れは inline `style` の差分を出さない**: 幾何だけを変えた編集は赤入れに現れない。従来
  （CssRule 方式）も同じで、本件では仕様として明記する。
- **自動 id 除去の条件は「明示属性に無い id」**: `attributes` hook で落とす。symbol / script 付き
  component（本アプリでは未使用）が将来入ると id が要るが、現状は対象外。

### 次工程（brainstorming → writing-plans）への引き渡し事項

**Spike（計画の先頭に置く）**: `protectedCss: ''` を当てた canvas と、同一テンプレの PDF / プレビューを
実機で並べ、`canvasCss` に残す規則（`body{margin:0}` の要否、`box-sizing` の要否）を決める。
結論は設計正典「中核原則」へ「canvas に GrapesJS の protectedCss を当てない（PDF と同じ CSS で描く）」
として追記する。結果によって ① のスクリーンショットが変わるため、① のコミットは spike 後。

**6 コミットの順序と各コミットのテスト**:

1. **④ fetch（.ps1）**（`offline/fetch-offline-bundle.ps1` + `.bat`。取得 → `.sha256` 検証 → 配置は
   `offline/lib/fetch.ps1` の `Save-VerifiedReleaseBundle`（downloader 差し替え可）。`setup-offline.ps1`
   から取得経路（`-Owner/-Repo/-Tag`・`Download-File`）を撤去し、直下にも `bk\` にも無ければ fetch を
   案内して停止。bk\ 退避は「直下のバンドルを使った回」）
   - テスト: Pester（`verify.Tests.ps1` に追加: 検証失敗・取得失敗のどちらでも配置先を汚さない /
     一時ディレクトリを残さない / 3 つの URL）。`scripts/check-comments.py` の dot-source ライブラリ
     免除リストに `offline/lib/fetch.ps1` を加える。`.ps1` は UTF-8 BOM + CRLF、`.bat` は ASCII + CRLF。
   - docs: `offline/README-offline.txt`・ルート `README.md`（入口スクリプト一覧）・デプロイ運用手順書を
     2 段手順（fetch → setup）へ。`.bat` は CRLF（メモリ `bat-files-need-crlf`）。
   - 実機 E2E: `C:\Users\Public\offline-verify\workspace-e2e`（clone → fetch → setup。`DATA_ROOT` 上書き）。
2. **保存形式**（幾何 inline 化 + 自動 id 除去 + protectedCss）
   - `useGrapes`: `protectedCss: ''`（spike の結論の `canvasCss`）、`patchSelectedStyle` / `selectedStyle` を
     inline（`{inline:true}`）へ、`getBodyHtml` は `getHtml({ attributes })` で明示属性に無い id を落とす、
     `getCss` は変更不要（protectedCss が空）。`geom.ts` の「inline style」記述を実態に合わせる。
   - `editorSession`: Undo ミラーの版数を上げて旧ミラーを捨てる（`storageKeys.ts`）。
   - テスト（unit、jsdom + GrapesJS 実体起動）: 幾何編集 → `getBodyHtml/getCss` → `load` で幾何が
     残る（発見 A の退行網）/ 選択だけでは `getBodyHtml` に id が現れない / `getCss` に
     `box-sizing` が現れない / テンプレ由来の明示 id は残る / 旧版数のミラーは読まない。
   - 移行: editor-data（別リポ）で `css/510037.css` 先頭 2 規則と `templates/AM01_510037_20240710_kr.html`
     の `id="i8kcl"` を手で直して 1 commit。REST draft（`editor-data/drafts/`）は手で消す。
3. **dirty 機構（③⑥）**
   - `useTemplateEditor`: 確定版正規形を初回に取り localStorage へ永続（キー = templateId +
     `updatedAt`）、無ければ二重 load（`load` の `quiet`）。変更のたび debounce で内容比較し、同一なら
     `dirty` を下ろして autosave を取り消し、進行中の保存を待ってから `discardDraft`（待機中に再編集が
     入れば削除しない）。`grapesEvents`: `component:update` の `changed` が `SAVE_NEUTRAL_PROPS` だけ
     なら dirty/autosave へ流さない（即時応答用）。`partLabels` は `pageEls` にも依存させる。
   - テスト（unit）: 選択のみで dirty にならない / 編集 → Undo で dirty が下り draft が消える /
     待機中の再編集で draft を消さない / `updatedAt` が変わると正規形キャッシュを使わない。
     e2e 1 本目: 編集 → プレビュー往復 → 赤入れが編集箇所だけ / コメント宛先が「削除済み」にならない /
     Undo で「変更なし」。
4. **① 起動 100% + スクショ再撮影**
   - `grapesEvents` の `fitToView` 呼び出しを `applyInitialZoom`（100%）へ、`EditorView` の
     ResizeObserver は `userZoomed` に関わらず倍率据え置きで overlay と縦配置だけ追随。
   - テスト: 既存 e2e「ズーム」を「起動 100% → 拡大 → 画面に合わせるでフィット」へ書き換え。
   - `e2e:editor` で `docs/editor/images` を再撮影し、`py -3.13 docs/_build/build_all.py --project editor`
     で HTML を作り直してコミット。手引きの「起動時は画面に合わせる」記述があれば更新。
5. **⑤ UI 状態**
   - `editorSession` に `ui`（倍率・ページ表示・現在ページ・右ペインタブ・赤入れ表示・guide は
     localStorage 永続 / `allowEdit`・選択キーはメモリのみ）。`useTemplateEditor` / `EditorView` は
     変わるたび写し、マウント時はそこから始める。倍率は `load` より前に渡し、選択はページ列挙確定後に
     `selectPartByKey`。
   - テスト（unit）: `editorSession.dom.test.ts` に保持・永続・`clear`・`allowEdit` 非永続。
     e2e 2 本目: 編集許可 ON・赤入れ OFF・コメントタブ・倍率変更・全ページ表示・選択 → プレビュー往復で
     全部残る。
6. **② kind 撤去**
   - `PartNoteEntry` / `AddNoteRequest` から `kind`（`NoteKind` 削除）。旧データ・旧クライアントの
     `kind` は読み取り・受信で捨てる（server `notesFile.withCommentDefaults` / web local `noteRepo`）。
     `CommentPanel` の種別セレクト・チェックボックス撤去、バッジは状態表示。`commentFilter` の `kinds`
     撤去。OpenAPI 再生成。操作手順書・設計書・設計正典から種別の記述を外し HTML 再生成。
   - テスト: shared / server / web の種別依存を「種別を持たない・旧 kind は捨てる」へ。

**設計正典（`docs/editor/src/設計正典.md`「中核原則」）への追記点**:
- 幾何は inline `style` 属性に保存する（CssRule `#id` は使わない）。保存する HTML に GrapesJS の
  自動 id を出さない（明示属性に無い id は `getBodyHtml` が落とす）。
- canvas に GrapesJS の protectedCss を当てない（PDF と同じ CSS で描く。`canvasCss` の内容は spike で
  確定）。
- 「未確定」は保存内容と確定版正規形の内容比較で決める。イベントフィルタは即時応答用の補助で
  主防御にしない。同一なら draft を消す。
- 起動倍率は 100%、resize で倍率を変えない。UI 状態はセッション永続、`allowEdit` と選択は除く。
- 「してはならないこと」へ: 自動 id を保存内容に載せる / protectedCss を保存 CSS に載せる /
  `allowEdit` を永続する / 旧ミラーを正規化で救う。

**コミット運用**: `editor/**` 変更のコミット前に `pnpm exec biome check --write editor/<対象>` を先行実行。
push はユーザーに依頼（pre-push CI 11〜12 分 > 背景実行 10 分）。前回の revert 履歴
`10befc4..bb95201` は参照用（そのまま cherry-pick しない: 発見 A の退行を含む）。

### Phase 5 チェックリスト

- [x] 高リスクの仮定（A1〜A8・旧データ）はすべて明示的に扱った
- [x] 主要論点で 2 段以上掘った（幾何の保存先 → inline 化の影響範囲 / protectedCss → 汚染データ → canvasCss の残し方 / 未確定判定 → 正規形の取り方 → 旧データ）
- [x] 未回答の「New Questions Surfaced」は無い
- [x] トレードオフを明示した（却下案の節）
- [x] 重要経路の失敗モードを扱った（検証失敗時の配置先・進行中 autosave との競合・`updatedAt` null・旧ミラー）
- [x] 本書が全決定を反映している
