/* ============================================================================
 *  editor フェーズ2 — CHECK 制約 (列挙値の妥当性)
 *  冪等(OBJECT_ID で存在チェック)。UTF-8 BOM。SQL Server 2012 互換。
 *  注意: 列挙値を変更するときは「存在すれば DROP → ADD」で作り直すこと。
 *  存在チェックだけの追記では、適用済みの既存 DB に新しい値が反映されない。
 * ==========================================================================*/

SET NOCOUNT ON;

/* 台帳.状態 ∈ {draft, published} */
IF OBJECT_ID(N'[ug01].[CK_台帳_状態]', N'C') IS NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
    ADD CONSTRAINT [CK_台帳_状態]
      CHECK ([状態] IN (N'draft', N'published'));
GO

/* ユーザー.ロール ∈ {admin, approver, editor, viewer}
 * approver 追加(承認ワークフロー)に伴い DROP+ADD で作り直す。既定の WITH CHECK で
 * 既存行も検証されるが、旧 3 値はすべて新列挙に含まれるため通る。 */
IF OBJECT_ID(N'[ug01].[CK_ユーザー_ロール]', N'C') IS NOT NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_ユーザー]
    DROP CONSTRAINT [CK_ユーザー_ロール];
GO
ALTER TABLE [ug01].[Rep1_運報自動化_Editor_ユーザー]
  ADD CONSTRAINT [CK_ユーザー_ロール]
    CHECK ([ロール] IN (N'admin', N'approver', N'editor', N'viewer'));
GO

/* 監査ログ.結果 ∈ {success, failure} */
IF OBJECT_ID(N'[ug01].[CK_監査_結果]', N'C') IS NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_監査ログ]
    ADD CONSTRAINT [CK_監査_結果]
      CHECK ([結果] IN (N'success', N'failure'));
GO
