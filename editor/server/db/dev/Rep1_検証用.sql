/* 検証用: LocalDB に Rep1 と仮の 2 テーブルを作る(本番では流さない)。
   sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -f 65001 -i server\db\dev\Rep1_検証用.sql */
IF DB_ID(N'Rep1') IS NULL CREATE DATABASE [Rep1];
GO
USE [Rep1];
GO
IF OBJECT_ID(N'[dbo].[Rep1_投委託会社]', N'U') IS NULL
  CREATE TABLE [dbo].[Rep1_投委託会社] (
    [委託会社コード] CHAR(5)       NOT NULL PRIMARY KEY,  -- 末尾空白の除去を確かめるため CHAR
    [委託会社名]     NVARCHAR(128) NOT NULL,
    [委託会社略称]   NVARCHAR(32)  NOT NULL
  );
IF OBJECT_ID(N'[dbo].[Rep1_投信ファンド属性]', N'U') IS NULL
  CREATE TABLE [dbo].[Rep1_投信ファンド属性] (
    [ファンドコード]   CHAR(8)       NOT NULL PRIMARY KEY,
    [委託会社コード]   CHAR(5)       NOT NULL,
    [ファンド名]       NVARCHAR(256) NOT NULL,
    [シリーズコード]   NVARCHAR(32)  NULL
  );
GO
DELETE FROM [dbo].[Rep1_投信ファンド属性];
DELETE FROM [dbo].[Rep1_投委託会社];
INSERT INTO [dbo].[Rep1_投委託会社] VALUES
  ('00001', N'架空アセットマネジメント株式会社（ダミー）', N'XX01'),
  ('00002', N'検証用アセット', N'XX02');
INSERT INTO [dbo].[Rep1_投信ファンド属性] VALUES
  ('910024', '00001', N'ダミー高利回り債券オープン', NULL),
  ('950003', '00001', N'ダミーバランスファンド（安定型）', N'CORE'),
  ('950037', '00001', N'ダミーバランスファンド（切替型）', N'CORE'),
  ('950124', '00001', N'ダミーＡＭ 日本中小型株式インデックス・オープン', NULL),
  ('950155', '00001', N'ダミーバランスファンド（切替型ワイド）', N'CORE'),
  ('900001', '00002', N'検証用ファンド', NULL);
GO
