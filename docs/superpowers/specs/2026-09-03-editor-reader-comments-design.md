# editor コメント機能(Adobe Reader 風)と承認タブ再構成 — 設計書

- 日付: 2026-09-03
- 状態: ユーザー承認待ち(dig 記録: `2026-09-03-editor-reader-comments-dig.md`)
- 対象: `editor/`(shared / web / server)、`docs/editor/`

## 1. 目的

編集タブと承認タブに、Adobe Reader のコメント機能に相当する「注釈スレッド + 一覧 + 検索・
絞り込み」を置く。既存のパーツメモ(追記型スレッド)を**置き換えて発展させる**(併存しない)。
併せて承認タブを「精査キュー一覧」から「編集タブで開いているテンプレート 1 件(= 1 PDF)の
申請を縦に並べて 1 件ずつ決着する画面」へ再構成する。

## 2. 決定事項(dig の結論。再議論しない)

| 論点 | 決定 |
|---|---|
| 既存メモとの関係 | 置換。`PartNoteEntry` を拡張し UI を刷新する |
| アンカー | パーツ構造キー `pathKey`(現行どおり)。ページ座標は不採用 |
| 交付版⇄全体版の共有 | 廃止。投稿は書かれた版インスタンスにだけ属する |
| 構造 | `status`(open / resolved)+ `replyTo`(親投稿 id)+ `kind`(note / fix-request / question) |
| 寿命 | 版インスタンスに永続。承認後も残る。基準日をまたがない |
| 権限 | 現行維持(`editor` 以上が追加・編集・削除・解決切替。`viewer` は閲覧のみ) |
| 検索範囲 | 開いているテンプレート 1 件の中。クライアント側フィルタ(API 追加なし) |
| 承認可否との関係 | 独立。コメントは注釈で、承認・差し戻しの関所には触れない |
| 保留 | 機能ごと撤去する(状態は承認待ち / 承認済み / 却下の 3 つ) |
| 承認タブ | 編集タブで開いた id のテンプレートを対象に、申請を縦に並べて 1 件ずつ決着 |
| 移行 | ファイル形式据え置き。新フィールドは任意で、読み取り時に既定値を補う |

## 3. データモデル

### 3.1 `PartNoteEntry`(`shared/src/schemas.ts`)

既存 8 フィールドに次を足す。型名は据え置く(改名は差分が大きいだけで価値がない)。
UI 文言だけを「メモ」から「コメント」へ改める。

| フィールド | 型 | 既定値(旧データ) | 意味 |
|---|---|---|---|
| `status` | `'open' \| 'resolved'` | `'open'` | 未対応 / 解決済み。返信にも持つが、UI で切り替えるのは親投稿だけ |
| `replyTo` | `string \| null` | `null` | 親投稿の `id`。`null` なら親(スレッドの起点) |
| `kind` | `'note' \| 'fix-request' \| 'question'` | `'note'` | 種別。表示ラベルは「メモ」「修正依頼」「質問」 |

制約:

- 返信の `replyTo` は**同じ `pathKey` かつ同じファイル内**の親投稿を指す。返信への返信は
  作らない(`replyTo` が指す投稿の `replyTo` は `null` でなければならない。1 段の入れ子)。
- 親投稿を削除すると、その返信も同時に削除する(孤児を作らない。Adobe と同じ挙動)。
- 1 パーツ 200 件の上限(`MAX_NOTE_ENTRIES_PER_PART`)は返信を含めて数える。
- `status` の切替は親投稿にだけ許す。返信の `status` はサーバが親と同じ値に揃える
  (親の解決切替時に返信もまとめて書き換える)。表示・絞り込みは親の状態で判定する。

### 3.2 ファイル(`server/src/files/notesFile.ts`、web local の localStorage)

`dataRoot/notes/<templateId>.json` の `Record<pathKey, StoredNoteEntry[]>` はそのまま。
`StoredNoteEntry` に上記 3 フィールドを任意で持ち、`normalizeStored` が欠けている値に既定値を
補う(旧形式 1 パーツ 1 件からの遅延変換も同じ場所で済ませる)。書き込み時は必ず 3 フィールドを
書く。ファイル 4MB・pathKey 1000 件・1 パーツ 200 件の 3 段の上限と atomic write・ロック・
`readNotesStrict` の規律は変えない。

### 3.3 ペア共有の廃止

- `server/src/repositories/noteRepo.ts` と `web/src/api/local/noteRepo.ts` から
  `pairedTemplateId` によるマージを外し、`listNotes(templateId)` は自版の投稿だけを返す。
- `updateNote` / `deleteNote` の宛先は引き続き `entry.templateId` だが、常に自版と一致する。
  `NoteBubble.vue` の `entryKey`(`templateId/id` の対)は `legacy:` id の衝突対策として残す。
- 相手版に書かれていた投稿はその版を開いたときにだけ見える。移行コピーはしない。
- `pairedTemplateId` 自体はパーツ自動同期(`pairSyncService`)が使うので削除しない。

### 3.4 API(`server/src/routes/notes.routes.ts`、`apiPaths.notes`)

| メソッド | 変更 |
|---|---|
| `GET /templates/:templateId/notes` | 応答に 3 フィールドが乗る。マージ無し |
| `POST …/notes` | `AddNoteRequest` に `replyTo?: string`、`kind?: NoteKind`(既定 `note`)を足す。`replyTo` の親が同一 `pathKey` に無い・親が返信である場合は 400 |
| `PATCH …/notes/:entryId` | `UpdateNoteRequest` を `{ content?: string; status?: NoteStatus }` の部分更新にする(少なくとも一方が必要)。`status` は親投稿にだけ許し、返信に指定したら 400 |
| `DELETE …/notes/:entryId` | 親なら返信も連鎖削除 |

`ROUTE_POLICY`(`routes/routeGuards.ts`)の必要ロールは現行どおり(`GET` = auth、変更系 = editor)。
`NoteRepository` 契約(`shared/src/repositories/NoteRepository.ts`)は次の形にする。

```ts
addNote(templateId, pathKey, content, opts?: { replyTo?: string; kind?: NoteKind })
updateNote(templateId, entryId, patch: { content?: string; status?: NoteStatus })
deleteNote(templateId, entryId)
listNotes(templateId)
```

## 4. 編集タブ

### 4.1 右ペインの「コメント」タブ

右ペイン(`Inspector.vue` を載せている 312px の領域)の最上位に「プロパティ | コメント」の
切替を置く。「コメント」の中身は新規コンポーネント `CommentPanel.vue`
(`web/src/features/editor/comments/`)で、テンプレート全体のコメント一覧を Adobe の
コメントリストと同じ形で出す。

- **新規コメントの入力欄**を一覧の上に 1 つ置く(選択パーツ宛。種別の選択付き。未選択・
  解決不能なら無効)。現行 `Inspector.vue` の「メモを追加」セクションはここへ移し、
  `Inspector.vue` からは外す。**新規の入口はここ 1 つ**、スレッド内の操作(返信・解決・編集・
  削除)は吹き出し側、という分担で「入口を 2 つ持たない」原則を保つ。
- **検索**: 本文と投稿者の部分一致(1 つのテキスト欄)。
- **絞り込み**: 状態(すべて / 未対応 / 解決済み)、種別(3 種の多重選択)、投稿者(一覧から
  選ぶ)、パーツ(選択中のパーツだけ)。既定は「未対応」。
- **並び**: 更新日時の降順 / パーツの出現順(`partEls` の順)の 2 つ。
- 一覧の行 = 親投稿 1 件(返信数と最終更新をバッジで出す)。クリックでそのパーツを選択し、
  canvas をスクロールして吹き出しを開く(現行 `noteMarkers` の座標経路を使う)。
- 幅 312px に収める。検索欄と絞り込みは 2 行に折り返してよいが、一覧の行は 1 行を
  「種別アイコン + 本文の先頭 + 投稿者 + 日時」に収め、溢れは省略記号にする。
- フィルタと並びは純関数 `commentFilter.ts` に切り出す(入力: 投稿配列 + 条件、出力: 親投稿の
  配列)。

### 4.2 吹き出し(`NoteBubble.vue`)

選択パーツのスレッドを「親投稿 → その返信(字下げ)」の入れ子で出す。各親投稿に「返信」
「解決 / 未対応に戻す」「編集」「削除」を置き、返信には「編集」「削除」だけを置く。返信の
入力欄は親投稿の下に開く。解決済みの親投稿は薄く表示し、既定では折りたたむ。既存の位置決め
(`noteBubbleLayout.ts`)と「ページの大きさ・倍率を変えない」原則は変えない。

### 4.3 マーカー(`useCanvasMarkers.ts`)

パーツに未対応の親投稿があれば現行の amber、全部解決済みなら灰色で出す。件数バッジは
親投稿の数(返信は数えない)。

### 4.4 composable(`usePartNote.ts` → `useComments.ts`)

`all` を保持し `entries`(選択パーツ)と `notedKeys` を導く構造は同じ。`add(content, opts)`、
`reply(parent, content)`、`setStatus(parent, status)`、`update`、`remove` を持つ。
`reply` は `add` の `replyTo` 指定に薄く包んだもの。

## 5. 承認タブ

### 5.1 対象テンプレートの決め方

`/reviews` の中身を `ReviewQueueView.vue` から新規 `ReviewTabView.vue` に置き換える。
対象テンプレート id は次の順で決める(純関数 `resolveReviewTarget.ts` に切り出す)。

1. `route.query.template`(承認待ちバッジ・上部バーからの遷移が渡す)
2. `tabMemory` の「編集」タブ直前画面が `/edit/:id` ならその `id`
3. どちらも無ければ空状態「編集タブでテンプレートを開いてから、承認タブを押してください」
   +「編集タブへ」ボタン

対象が決まっても申請が 1 件も無ければ空状態「このテンプレートには申請がありません」。

### 5.2 状態の要約と絞り込み

画面上部に現行キューと同じ形の要約箱を **3 つ**(承認待ち / 承認済み / 却下)置き、箱の
クリックで絞り込む(同じ箱の再クリックで解除)。既定は「承認待ち」。保留(`held`)は
機能ごと撤去する(5.6 節)。

### 5.6 保留機能の撤去

申請の状態は `pending` / `approved` / `rejected` の 3 つにする。保留は判断を先送りする
だけで決着に寄与せず、承認タブが「テンプレート 1 件の申請を 1 件ずつ決着する」形になると
「承認待ちに留めたまま承認者のコメントを残す」用途はコメント機能(5.4 節)が引き受ける。

- `ReviewStatus` から `held` を外し、`ReviewRequestMeta` の `heldBy` / `heldAt` /
  `holdComment` を削除する。`ReviewRepository.holdReview` と `POST …/reviews/:reqId/hold`
  ルート、`ROUTE_POLICY` の該当行、OpenAPI の記述を消す。
- 既存データの `meta.json` に `status: 'held'` が残っていることがあるため、
  `server/src/files/reviewFiles.ts` の読み取りで **`held` を `pending` に正規化**し、保留の
  3 フィールドは読み捨てる(書き戻しはしない。次の決着で自然に消える)。web local の
  localStorage も同じ正規化を `api/local/reviewRepo.ts` で行う。
- `useReviewDiff.ts` / `ReviewDetail.vue`(旧 `ReviewDiffView.vue`)から保留ボタン・
  保留メモのプリフィル・`canDecide` の `held` 判定を外す。承認者のコメント欄は
  「差し戻し理由(差し戻し時は必須)」のみに文言を改める。
- `pendingReviews.ts` の集計は `pending` だけを数える。`TemplateTable.vue` の承認待ちバッジと
  `EditorTopBar.vue` のバッジ文言はそのまま。
- `egressGuard.ts` の `held` はポート probe を保持する配列名で無関係なので触らない。
- 手引き(`操作手順書.md`)と設計書 8 章から保留の記述を削る。

### 5.3 申請の縦積み

絞り込み後の申請を新しい順に**アコーディオン**で縦に並べる。

- ヘッダ(常時表示): 申請者・申請日時・状態バッジ・変更概要(`changedSummary`)。決着済みなら
  決着者・日時・差し戻し理由も出す。
- 展開したセクションだけに現行 `ReviewDiffView.vue` の本体(見た目比較 / 文字差分のタブ、
  通知バー、差し戻し理由の欄、承認・差し戻しのボタン)を載せる。本体は `ReviewDetail.vue`
  として `ReviewDiffView.vue` から切り出し、`reqId` を props で受ける。
- 既定で展開するのは先頭 1 件。**同時に展開できるのは 2 件まで**。3 件目を開くと最も古く
  開いたセクションを閉じる(見た目比較は組版 iframe を 2 面持つため、上限が無いと申請数に
  比例して承認者のブラウザが固まる)。
- 決着(承認 / 差し戻し)しても画面に留まり、そのセクションが決着済み表示に変わる。要約箱の
  件数もその場で更新する。絞り込みが「承認待ち」のままなら決着した申請は一覧から外れる。
- 対象テンプレートの承認待ちが 0 件になったら「編集タブへ戻る」ボタンを一覧の下に出す。

### 5.4 コメントパネル

展開したセクションの右側に 4.1 と同じ `CommentPanel.vue` を置く(対象テンプレートの
コメント。承認者も追加・返信・解決できる)。行のクリックは見た目比較の該当パーツへ
`gotoAnchor`(`shared/src/preview/hostProtocol.ts` の既存命令)で移動する。吹き出しは出さない
(承認画面は opaque iframe で DOM に触れないため、スレッドの表示・操作はパネル内で完結
させる。パネル内の行を開くと返信一覧と返信入力欄が展開する)。

### 5.5 導線の統一

- `EditTabView.openReview` と `EditorTopBar` の承認待ちバッジは、件数に関わらず
  `{ name: 'reviews', query: { template: id } }` へ遷移する(1 件ならキュー、複数なら詳細、の
  分岐を撤去)。
- `/reviews/:reqId`(`review-detail`)は廃止し、ルートを消す。`tabOf.ts` の `review-detail`
  分岐も外す。
- `ReviewQueueView.vue` と `reviewQueueView.test.ts` は削除する。

## 6. サーバ

- `repositories/noteRepo.ts`: マージ撤去、3 フィールドの検証と既定値補完、返信の親検証、
  連鎖削除、`status` の親限定と返信への伝播。
- `routes/notes.routes.ts`: `PATCH` の部分更新、`POST` の `replyTo` / `kind`。
- レビュー API は変更しない(テンプレート単位の絞り込みは既存 `pendingReviews.byTemplate` と
  同じくクライアント側で行う。ただし承認済み・却下も要るので `listReviews({})` の全件を
  `templateId` で絞る)。

## 7. テスト

- shared: スキーマの既定値と制約(返信の 1 段制約は文書化のみ。実行時検証はサーバ)。
- server: `notesFile` の既定値補完、`noteRepo` のマージ廃止・親検証・連鎖削除・`status` 伝播、
  `notes.routes` の 400 条件、`ROUTE_POLICY` の網羅則。`reviewFiles` の `held` → `pending`
  正規化、`reviews.routes` から hold ルートが消えていること(`ROUTE_POLICY` の起動時検査)。
- web 単体: `commentFilter`、`resolveReviewTarget`、`useComments`、`tabOf`(`review-detail`
  除去)、`pendingReviews.store`、`localReviewRepo`、`noteRepo.test`(マージ廃止)。
- e2e: `note_bubble.spec.ts` を返信・解決に拡張、`comment_panel.spec.ts`(検索・絞り込み・
  行クリックの canvas 追従)、`review_tab.spec.ts`(対象の解決 3 段、要約箱、アコーディオン
  上限、決着後の表示)、`tabbed_layout.spec.ts` / `header_layout.spec.ts` の維持。
- ガード: `twoSystems.guard.test.ts` ほか既存ガードは無変更で通す。

## 8. ドキュメント

- `docs/editor/src/設計正典.md`: 「パーツメモ」の中核原則を「コメント」へ書き換える(ペア共有
  廃止・Adobe 準拠の構造・承認タブの再構成・同時展開 2 件の理由)。却下済み設計に「ページ座標
  アンカー」「精査キュー一覧の復活」「全テンプレート横断検索 API」を足す。
- `docs/editor/src/設計書.md` 8 章(申請・承認)と `NoteRepository` の説明、手引きの承認・
  コメント操作。スクリーンショットは `capture_docs.spec.ts` で再撮影し `build_all` を再実行する。

## 9. 却下した代替案

- 全申請を同時にマウントする縦積み: iframe が申請数 × 2 面になり承認者のブラウザが固まる。
- ページ座標アンカー: 技術的には成立するが、本文編集でずれ、ペア版種で共有できない。
- 全テンプレート横断の検索 API: `notes/*.json` の全走査で応答時間と件数上限の設計が要る。
- 承認タブでの吹き出し表示: opaque iframe の DOM に触れないため、パネル内で完結させる。
- 返信の多段入れ子: 表示・削除・上限の規則が増える割に、帳票のレビューでは 1 段で足りる。
