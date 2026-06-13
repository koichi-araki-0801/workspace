/* seed: サンプルデータ (生成物 — gen-seed.ts from web fixtures) */
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'510037')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'510037', N'{
  "company": { "code": "AM01", "name": "アセットマネジメント株式会社" },
  "fund": { "code": "510037", "name": "日本株式オープン", "nav": "12,345", "navChange": 58 },
  "report": { "baseDate": "2024-07-10", "editionType": "kr" },
  "holdings": [
    { "name": "トヨタ自動車", "weight": "5.2" },
    { "name": "ソニーグループ", "weight": "4.8" },
    { "name": "三菱UFJ", "weight": "3.9" },
    { "name": "キーエンス", "weight": "3.1" },
    { "name": "東京エレクトロン", "weight": "2.7" }
  ],
  "performance": [
    { "period": "1ヶ月", "return": "1.2" },
    { "period": "3ヶ月", "return": "4.5" },
    { "period": "1年", "return": "12.8" }
  ]
}
', SYSUTCDATETIME());
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ] WHERE [ファンドコード] = N'510155')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード],[データJSON],[更新日時])
  VALUES (N'510155', N'{
  "company": { "code": "AM01", "name": "アセットマネジメント株式会社" },
  "fund": { "code": "510155", "name": "グローバル債券ファンド", "nav": "9,870", "navChange": -12 },
  "report": { "baseDate": "2024-07-10", "editionType": "kr" },
  "holdings": [
    { "name": "米国債10年", "weight": "8.1" },
    { "name": "独国債", "weight": "6.4" },
    { "name": "豪州債", "weight": "5.0" }
  ],
  "performance": [
    { "period": "1ヶ月", "return": "-0.3" },
    { "period": "1年", "return": "3.2" }
  ]
}
', SYSUTCDATETIME());
GO
