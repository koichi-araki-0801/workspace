# バグ修正 v2 進捗（自動再開用の状態ファイル）

> 本ファイルは実行状態の正典。指揮者（Fable 5 セッション）が Task 完了ごとに更新する。
> git にはコミットしない（untracked のまま運用）。
>
> **再開手順（このセッションが死んだ場合、新セッションで）:**
> 1. `docs/superpowers/plans/2026-08-20-repo-wide-bugfix-v2-all.md`（プラン本文）と本ファイルを読む。
> 2. `git log --oneline -20` で本ファイルの「完了 Task」欄と実コミットの整合を確認する
>    （報告済みでもコミットが無い Task は未完了として扱う）。
> 3. 状態が `in-progress` の Task はテストを実行して成否を判定し、未達なら同 Task からやり直す。
> 4. 実装は `model: "opus"` のサブエージェントへ委譲し、指揮者は diff 精読・テスト再実行・
>    reflog 検証を行う（プラン末尾「実行プロトコル」参照）。
> 5. Wave 完了ごとにユーザーへ報告する。

## 現在地

- **全 Wave（A〜H）完了（2026-08-20）**。
- 最終コミット: 35e8758（Wave H 完了・指揮者検証済み）
- ⚠ 未 push: 3b9f52e〜35e8758 の 10 コミットが auto-push 未発火で origin 未反映（remote = 5ecaa35）。
  push 時は pre-push がフル CI へ倒れる（11〜12 分）。ユーザーの `!git push` で実行する。
  editor テストは初回実行で 1 file フレークすることがある（単独再実行 green で判定。既知の実機 8GB 負荷фレーク）。
- 最終コミット: e0b7b1b（Wave G 完了・指揮者検証済み）
- ⚠ 未 push: Wave G の 5 コミット（3b9f52e〜e0b7b1b）は auto-push 未発火のため origin 未反映。
  push 時は pre-push が package.json 変更を検知してフル CI へ倒れる（11〜12 分）。
  ユーザーの `!git push` で実行する（フック未発火の原因は /hooks で要確認）。
- Wave G への引き継ぎ: coverage include 候補 = `web/src/lib/useLatest.ts` / `lib/routeQuery.ts` / `lib/sessionExpiry.ts`（Wave C 新設・テスト有り）

## Task 状態

| Task | 状態 | コミット |
|---|---|---|
| A1 削除一覧「戻す」要素単位化 | done（検証済） | 161d983 |
| A2 dictAdd/dictDelete 後 reloadState | done（検証済） | 806f020 |
| A3 undo/redo 全ページ invalidate | done（検証済） | c7fb1e2 |
| A4 ショートカットのガード | done（検証済） | 72f2507 |
| A5 ZIP 失敗通知と分割 | done（検証済） | c7f84ff |
| A6 mountPage 競合 | done（検証済） | 5641979 |
| A7 addFiles 途中失敗 | done（検証済） | 831f851 |
| A8 selFor/collapsed 残留 | done（検証済） | b44a77a |
| A9 一覧取得失敗の旧ペイン残留 | done（検証済） | 320ce09 |
| A10 辞書チェーン後の戻し | done（検証済） | 94cd2fe |
| B1 _auto を STATE_FIELDS へ | done（検証済） | e3f7080 |
| B2 %表示を実文字列ベースへ | done（検証済） | 2f5806f |
| B3 全円ガード | done（検証済） | 2a228f4 |
| B4 ファイル切替確認 | done（検証済） | c3dcb28 |
| B5 ショートカット scope 3 分割 | done（検証済・承認済） | b288249 |
| B6 端点再スナップ | done（検証済） | 7ea7460 |
| B7 abortLoad 表示残留 | done（検証済） | a27c314 |
| C1 Redo 順序破壊 | done（検証済） | 3d1722a |
| C2 無編集 dirty ①blur | done（検証済） | a011729 |
| C3 無編集 dirty ②遷移 | done（検証済） | 7ea3ecb |
| C4 無編集 dirty ③begin/commit/cancel | done（検証済） | 647e161 |
| C5 draft 破棄競合 | done（検証済） | b9c3b66 |
| C6 Undo ミラー分離 | done（検証済） | 56c8da3 |
| C7 stale 応答 4 経路 | done（検証済） | 2b5b71d |
| C8 二重送信ガード | done（検証済） | a6ea55e |
| C9 認証導線 | done（検証済・承認済） | 90d219b |
| C10 小物（tx 相乗り方式・承認済） | done（検証済） | 1a6ea2f + e5a5a89 |
| D1 DATA_ROOT 連動 | done（検証済） | 631525b |
| D2 補償で新規ファイル削除 | done（検証済） | fb46006 |
| D3 snapshot の templateId 特定（API 拡張・承認済） | done（検証済） | 939c2fd |
| D4 重複 partId 同期対象外 | done（検証済） | 81eb753 |
| D5 ペア側先行を競合記録 | done（検証済） | d893869 |
| D6 申請入口の帰属検査 | done（検証済） | ddd9c1f |
| D7 I/O 例外方針統一 | done（検証済） | c31d9ca |
| D 補: docs 再撮影同期 | done | aec2480 |
| E1 topBand 積み上げ規約整合 | done（検証済・目視済） | 4b0de14 |
| E2 batch 掃除 + exit 1 | done（検証済） | d4072ac |
| E3 JSON NaN 明示エラー | done（検証済） | b513a61 |
| E4 MAX_DB_ROWS | done（検証済） | a2f16d7 |
| E5 小物（db.ts 追随含む・承認済） | done（検証済） | 19f5cf7 |
| F1 md2html front-matter | done（検証済） | 7b9292f |
| F2 content-key fallback（テスト期待値修正・承認済） | done（検証済） | 5ecaa35 |
| F3 auto-push フック | done（検証済・追跡外） | なし |
| F4 comment-reminder 拡張（正典側整合・承認済） | done（検証済・追跡外） | なし |
| G1 CI 配線（領域定義 + 実行計画テスト） | done（検証済） | 3b9f52e |
| G2 coverage include 整備 | done（検証済） | d052f22 |
| G3 署名検証チェーン Pester | done（検証済） | 12cbc01 |
| G4 ガードテスト射程拡大 | done（検証済） | f281f1d |
| G5 hostGuard 配線検査 | done（検証済） | e0b7b1b |

| H1 load.ts テスト追加（被覆 99%） | done（検証済） | dd80a1d |
| H2 値欠落の明示エラー化（xlsx/DB へ射程拡大・承認済） | done（検証済） | 99acb4a |
| H3 pin 検証の大小区別 | done（検証済） | fe7f2ae |
| H4 buildApp() 工場化 + 統合テスト | done（検証済） | 9e8a4bf |
| H5 履歴行 id 一意化 | done（検証済） | 35e8758 |

Phase 3 候補はすべて Wave H で消化済み。残件なし。

## 特記事項

- セッション上限に当たった場合: 見張り cron（毎時 23 分・セッション内）がリセット後に再開を促す。
  REPL ごと終了した場合は上記「再開手順」を新セッションで実施する。
- Wave G の G1（e2e の CI 配線）は Wave A〜E の修正完了が前提。先に配線しない。
