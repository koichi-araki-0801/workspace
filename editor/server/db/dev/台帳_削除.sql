/* 既存環境で不要になったテンプレート台帳を消す(任意。editor は読まない)。
   sqlcmd -S <host\instance> -d usrap -E -b -f 65001 -i server\db\dev\台帳_削除.sql */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]', N'U') IS NOT NULL
  DROP TABLE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳];
GO
