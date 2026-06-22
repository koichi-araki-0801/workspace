/* ============================================================================
 *  editor フェーズ2 — CHECK 制約 (列挙値の妥当性)
 *  冪等(OBJECT_ID で存在チェック)。UTF-8 BOM。SQL Server 2012 互換。
 * ==========================================================================*/

SET NOCOUNT ON;

/* 台帳.状態 ∈ {draft, published} */
IF OBJECT_ID(N'[ug01].[CK_台帳_状態]', N'C') IS NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
    ADD CONSTRAINT [CK_台帳_状態]
      CHECK ([状態] IN (N'draft', N'published'));
GO

/* ユーザー.ロール ∈ {admin, editor, viewer} */
IF OBJECT_ID(N'[ug01].[CK_ユーザー_ロール]', N'C') IS NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_ユーザー]
    ADD CONSTRAINT [CK_ユーザー_ロール]
      CHECK ([ロール] IN (N'admin', N'editor', N'viewer'));
GO

/* 履歴.種別: 履歴テーブル廃止に伴い制約も撤去。 */

/* 監査ログ.結果 ∈ {success, failure} */
IF OBJECT_ID(N'[ug01].[CK_監査_結果]', N'C') IS NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_監査ログ]
    ADD CONSTRAINT [CK_監査_結果]
      CHECK ([結果] IN (N'success', N'failure'));
GO
