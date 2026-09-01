# パーツメモのスレッド化とペア版種共有 — 設計書

- 日付: 2026-09-01
- 対象: editor のパーツ単位メモ（`shared/src/repositories/NoteRepository.ts` /
  `server/src/files/notesFile.ts` / `web/src/features/editor/usePartNote.ts` ほか）

## 1. 背景と目的

編集画面のメモ欄が「わかりにくい動き」をしている。原因は次の 2 点。

1. メモは版インスタンス（`templateId` = 委託会社/ファンドコード/基準日/版種）単位で完結し、
   交付版で書いたメモが全体版に出てこない。パーツ構造キー（`partKey.ts`）は版を跨いで安定に
   作ってあるにもかかわらず、その安定性を使っていない。
2. メモが 1 本のテキストの上書き方式で、誰がいつ何を書いたかが残らない。上書きされた時点で
   前の記述が消える。

対応方針（ユーザー確定済み）:

- メモを**追記型スレッド**にする。投稿ごとに書いた人・日時・版種が残る。
- スレッドは**ペア版種（交付版⇄全体版）で共有**する。同一の委託会社・ファンドコード・基準日で
  版種だけが異なる 2 版が対象で、これは既存のパーツ自動同期のペア定義（`EDITION_SYNC_PAIRS`）と
  同一。
- **基準日をまたぐ繰り越しは行わない。** 基準日が進んだ版は別のスレッドになる。
- 投稿の編集・削除は誰でもできる（所有者による制限は設けない）。
- 継承であることを示すバッジは出さない。代わりに**全投稿に版種名を表示**して出所を示す。

## 2. 保存先と読み取り（採用案）

保存は現行どおり `dataRoot/notes/<templateId>.json` を維持し、**読み取り時にペア版のファイルも
読んで 1 本のスレッドへマージする**。

この形を採る理由:

- ペア表に無い版種（`kr` / `zr` 等の残存資産）が従来どおり動く。ペア単位ファイルへ集約すると
  ペア対象外の版種のために 2 系統を併存させることになる。
- パス検証（`assertTemplateId`）・ファイルロック（`withNotesLock`）・サイズ上限
  （`MAX_NOTES_FILE_BYTES`）・読み取りの degrade と書き込みの strict 読みという既存の不変則を
  そのまま維持できる。保存先の粒度が変わらないため、これらの守りに手を入れずに済む。
- 既存メモの一括変換が不要になる（後述の遅延変換で済む）。

書き込み（追加・編集・削除）は**投稿が属する版のファイル**に対して行う。ペア側の投稿を編集・
削除するときはペア側の `templateId` を宛先にする。ロックは書き込む実ファイル単位なので、
ペア 2 版への同時操作は互いに干渉しない。

## 3. データモデル

### ファイル形式（新）

```json
{
  "<pathKey>": [
    {
      "id": "<uuid>",
      "content": "本文",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "createdBy": "ログインID",
      "updatedAt": null,
      "updatedBy": null
    }
  ]
}
```

`templateId` はファイル名から自明なのでファイル内には持たない（同じ事実を 2 箇所で持つと
片方だけがずれる）。API 応答には `templateId` を含める（web が編集・削除の宛先に使うため）。

`createdBy` / `updatedBy` に入れる値は既存の実装を踏襲する。REST 実装はセッションのログイン ID
（`request.user.username`）、local 実装は `currentUser().displayName`。local はサーバを持たない
体験用の実装で、両者を揃えるための変更は本件の範囲に含めない。

### 旧形式からの遅延変換

読み取り時に値が配列でなくオブジェクトで `content` を持つなら、旧形式（`Record<pathKey,
PartNote>`）と判定し、投稿 1 件へ変換して返す。変換後の `id` は固定値 `legacy` とする
（旧形式は 1 パーツにつき 1 件しか持てないので衝突しない）。ランダム ID を都度振ると読むたびに
編集・削除の宛先が変わってしまう。`createdAt` / `createdBy` には旧 `updatedAt` / `updatedBy` を
充てる。

ファイルは次回の書き込み時に新形式で保存される。一括移行スクリプトは作らない。dataRoot の
メモは git 管理外なので、読み取り互換を保ったまま自然に移行させるほうが安全。

### 型（`shared/src/schemas.ts`）

- `PartNoteEntry` を新設する: `id` / `templateId` / `pathKey` / `content` / `createdAt` /
  `createdBy` / `updatedAt`（null 可） / `updatedBy`（null 可）。
- 既存 `PartNote` は廃止する（web / server とも利用箇所を置き換える）。
- `SaveNoteRequest` を廃止し、`AddNoteRequest` = `{ pathKey, content }` /
  `UpdateNoteRequest` = `{ content }` を新設する。`content` は
  `.min(1).max(MAX_NOTE_CONTENT_CHARS)` とし、**空文字は拒否**する。削除は DELETE で明示的に
  行う（「空文字＝削除」という暗黙の契約をやめる）。

### 上限

- `MAX_NOTES_FILE_BYTES`（4MB）・`MAX_NOTES_PER_TEMPLATE`（1000 = pathKey 件数）は現行のまま。
- `MAX_NOTE_ENTRIES_PER_PART = 200` を新設する。1 パーツあたりの投稿数上限。これが無いと
  1 パーツだけでファイル上限に到達でき、そのテンプレの**全メモが保存不能**になる
  （設計正典「件数上限はサイズ上限を守れない」と同じ形）。上限に達したときの追加は
  `validation` で拒否し、既存投稿の編集と削除は上限に関わらず必ず通す。

## 4. API（`shared/src/api-paths.ts` / `server/src/routes/notes.routes.ts`）

- `GET /api/templates/:templateId/notes` — 自版とペア版をマージした `PartNoteEntry[]`。
  並びは `createdAt` 昇順、同値なら `templateId` → `id` で安定化する。
- `POST /api/templates/:templateId/notes` — 追加。body は `AddNoteRequest`。201 で作成した
  エントリを返す。
- `PATCH /api/templates/:templateId/notes/:entryId` — 本文の編集。body は `UpdateNoteRequest`。
  更新後のエントリを返す。`updatedAt` / `updatedBy` を設定する。
- `DELETE /api/templates/:templateId/notes/:entryId` — 削除。204。
- 既存の `PUT /api/templates/:templateId/notes` は廃止する（OpenAPI 未記載の web 専用面であり、
  外部クライアントの契約ではない）。

`entryId` から対象を引くときはファイル内の全 `pathKey` を走査する（実物は 1 版あたり数十
パーツ × 数投稿）。`pathKey` をリクエストに含めて宛先を二重に指定すると、両者が食い違ったときの
挙動を定義しなければならなくなる。

ロールは `GET` = `auth`、`POST` / `PATCH` / `DELETE` = `editor`。`routeGuards.ROUTE_POLICY` へ
4 経路を登録する（未登録ルートはサーバ起動時に落ちる）。

## 5. Repository 契約（`shared/src/repositories/NoteRepository.ts`）

```ts
interface NoteRepository {
  /** 自版とペア版をマージしたスレッド（作成日時の昇順）。無ければ空配列。 */
  listNotes(templateId: string): Promise<Result<PartNoteEntry[]>>;
  /** 投稿を追加する。空文字は拒否。 */
  addNote(templateId: string, pathKey: string, content: string): Promise<Result<PartNoteEntry>>;
  /** 投稿の本文を編集する。`templateId` は投稿が属する版。 */
  updateNote(templateId: string, entryId: string, content: string): Promise<Result<PartNoteEntry>>;
  /** 投稿を削除する。`templateId` は投稿が属する版。 */
  deleteNote(templateId: string, entryId: string): Promise<Result<void>>;
}
```

local 実装（`web/src/api/local/noteRepo.ts`）は `editor:notes` の localStorage 構造を
`Record<templateId, Record<pathKey, PartNoteEntry[]>>` へ変え、REST 実装と同じ挙動（ペアの
マージ・旧形式の遅延変換・上限）を持つ。ペア解決には shared の `pairedTemplateId` を使い、
版種対応表を web 側に複製しない。

## 6. web の変更

### `usePartNote.ts`

- 保持する形を `Record<pathKey, PartNoteEntry[]>` にする。
- 公開するのは `entries`（選択パーツのスレッド）/ `notedKeys`（投稿が 1 件以上ある pathKey）/
  `canNote` / `reload` / `add` / `update` / `remove`。
- **debounce 永続化と `flush` を廃止する。** 追加・編集・削除がいずれも明示操作になるため、
  保留中の保存という状態自体が不要になる。呼び出し側（`useTemplateEditor.ts` /
  `EditorView.vue`）の `flush` 呼び出しも取り除く。

### 表示は「キャンバス余白の吹き出し」・追加は「右ペイン」

メモの読み書きは表計算ソフトのセルコメントと同じ操作感にする。既存のメモは右ペインの中では
なく、**キャンバスの余白に吹き出しとして出す**。パーツを選ぶとそのパーツのスレッドが開く。

- **吹き出し（新規 `NoteBubble.vue`）**: 選択パーツの右側、ページの外の余白に置き、パーツ右端
  から水平のリーダー線で結ぶ。ヘッダは「メモ」＋件数＋閉じる。中身は投稿リスト（作成日時の
  昇順）で、1 件は「名前 ・ 日時 ・ 版種名」の見出し行と本文（改行を保持）、および編集・削除の
  操作から成る。版種名は `templateId` を `parseTemplateFileName` で解いて得る（保存はしない）。
  編集はインラインの textarea と「保存」「取消」、削除は共通の確認ダイアログ
  （`components/ui/confirm.ts` の `confirm()`）を経る。**吹き出しの中に追加欄は置かない**
  （追加の入口を 1 つに保つ）。
- **選択されていないメモ持ちパーツ**: 既存のメモ目印（`useCanvasMarkers` の `NoteMarker`）を
  そのまま使い、パーツ右上隅の小さな目印だけを出す。折りたたみの吹き出しは出さない。
- **右ペイン（`Inspector.vue`）**: メモセクションは**追加専用**にする。件数バッジ・textarea・
  「追加」ボタン・説明文（「既存のメモはキャンバス右側の吹き出しに表示します。交付版と全体版で
  共有（基準日ごとに独立）」）だけを持ち、投稿リストは持たない。メモが 0 件のパーツへ最初の
  1 件を書く動線もここになる。

### 吹き出しの配置（`useCanvasMarkers.ts` の拡張）

座標は既存の目印と同じ経路で測る。`editor.Canvas.getElementPos(el, { noScroll: true })` で
選択パーツの rect を取り、非スクロールの overlay 層へ重ねる（`refreshNoteMarkers` と同じ
前提。ズーム・スクロール・ページ切替に追随する）。配置規則は次のとおり。

- 既定は「ページ右端の外側」。縦はパーツ上端に合わせ、canvas の上下からはみ出す分はクランプ
  する（クランプで縦がずれたときのリーダーは L 字にする）。
- **右余白が吹き出しの幅に足りないときはページの上に重ねる**（ズームを上げると余白は消える。
  表計算ソフトのコメントと同じ挙動で、余白の有無に依存しない）。
- 吹き出しは常に 1 つだけ開く（選択パーツのもの）。閉じるボタンで隠し、再度選択で開く。

新規ファイルは `NoteBubble.vue` のみとし、位置計算は `useCanvasMarkers.ts` へ足す
（選択 rect・目印と同じ計測器を 2 つに分けない）。

### コメントの是正

`Inspector.vue` の `note` prop コメント（「選択パーツの**版を跨ぐ**メモ本文」）と `.memo-area`
の CSS コメント（「版を跨ぐパーツ単位」）は、現行の実装（版ごとに独立）と食い違っている
（`useCanvasMarkers.ts` の「版を跨ぐメモ」という記述も同じ）。
今回の変更で「ペア版種の間では跨ぐ / 基準日は跨がない」に実態が変わるため、
両方を新しい事実へ書き直す。`NoteRepository.ts` / `notesFile.ts` / `schemas.ts` /
`partKey.ts` / local `noteRepo.ts` の「別の基準日/版種の版へは引き継がない」という記述も同様。

## 7. テスト

- `server/test/notesFile.test.ts`: 新形式の read/write、旧形式の遅延変換（`legacy` ID の固定）、
  `readNotesStrict` が読めない実体で例外にすること、サイズ上限。
- `server/test/noteRepo.test.ts`（新規）: ペアのマージ順、ペア対象外版種では自版のみ、
  編集・削除が宛先の版のファイルだけを変えること、投稿数上限（追加は拒否・編集と削除は通る）、
  存在しない `entryId` の扱い。
- `server/test/notes.limits.test.ts`: 新 API に合わせて改訂（`content` の空文字拒否を含む）。
- `web/test/noteRepo.test.ts`: local 実装のマージ・遅延変換・上限。
- `web/test/usePartNote.test.ts`: 追加・編集・削除の反映、`notedKeys`、`canNote`。
- 吹き出しの配置（余白が足りないときにページへ重ねる分岐・縦クランプ）は
  `useCanvasMarkers` の純粋な位置計算として切り出し、単体テストを置く。
- e2e（`editor/e2e`）: 現状メモ欄を操作する spec は無いため改訂対象は無い。ただし
  `capture_docs.spec.ts` はメモ欄を含む画面を撮影するため、スクリーンショットに差分が出る。
- カバレッジの `include` 列挙へ新規ファイルを追加する。

## 8. ドキュメント

- `docs/editor/src/設計正典.md`: メモが版ごとに独立という前提の記述を、ペア共有 + 基準日独立へ
  改める。「件数上限はサイズ上限を守れない」の節へ投稿数上限の観点を足す。
- `docs/editor/src/設計書.md`: メモ機能の節を追記型スレッドの記述へ改訂する。
- 画面が変わるため、`docs/editor/images` のスクリーンショットは e2e の
  `capture_docs.spec.ts` による再撮影分をコミットし、`build_all.py --project editor` で HTML を
  作り直す。

## 9. 非目標（今回やらないこと）

- 基準日をまたぐメモの繰り越し（ユーザー判断で不採用）。
- メモの DB 化。メモは注釈であり「本体=ファイル/git、DB=台帳」の方針を変えない
  （メモ自体は git 管理外のまま）。
- 投稿への返信ツリー・メンション・既読管理。スレッドは平坦な列に留める。
- 承認フロー（申請・精査画面）へのメモの露出。今回は編集画面の中で完結させる。
