/* seed: サンプルデータ (生成物 — gen-seed.ts from web fixtures) */
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'110024')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'110024', N'{"fund":{"name":"高金利ソブリンオープン","nickname":""},"company":{"code":"AM01","name":"三井住友トラスト・アセットマネジメント株式会社"}}', SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'510003')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'510003', N'{"fund":{"name":"コア投資戦略ファンド（安定型）","nickname":"コアラップ（安定型）"},"company":{"code":"AM01","name":"三井住友トラスト・アセットマネジメント株式会社"}}', SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'510037')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'510037', N'{"fund":{"name":"コア投資戦略ファンド（切替型）","nickname":"コアラップ（切替型）"},"company":{"code":"AM01","name":"三井住友トラスト・アセットマネジメント株式会社"}}', SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'510124')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'510124', N'{"fund":{"name":"ＳＭＴ ＪＰＸ日経中小型株インデックス・オープン","nickname":""},"company":{"code":"AM01","name":"三井住友トラスト・アセットマネジメント株式会社"}}', SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'510155')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'510155', N'{"fund":{"name":"コア投資戦略ファンド（切替型ワイド）","nickname":"コアラップ（切替型ワイド）"},"company":{"code":"AM01","name":"三井住友トラスト・アセットマネジメント株式会社"}}', SYSUTCDATETIME());
GO
