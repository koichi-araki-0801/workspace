/* seed: 共通サンプル (生成物 — gen-seed.ts / commonSampleSeed.ts) */
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON; -- 計算列に索引がある表への書き込みに必要(sqlcmd の既定は OFF)
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'' + NCHAR(31) + N'' + NCHAR(31) + N'' + NCHAR(31) + N'')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (NULL, NULL, NULL, NULL,
    N'{"company":{"code":"AM01","name":"サンプル委託会社","address":"〒000-0000　東京都千代田区サンプル一丁目1番1号","url":"https://www.example.com/"},"fund":{"code":"000000","name":"サンプルファンド","nickname":"サンプル愛称","category":"追加型投信／内外／資産複合","nav":"12,345","navChange":58,"netAssets":"123,456","returnRate":"12.3","distribution":"100","redemptionNav":"12,345.67"},"report":{"editionType":"交付版","baseDate":"2025年12月31日","term":"第1期","settlementDate":"2025年12月31日","period":"2025年1月1日～2025年12月31日","termStartNav":"12,000","termEndNav":"12,345","redemptionDate":"2026年3月31日"},"commentary":"当期の基準価額は、各資産の値動きを反映してサンプルの水準で推移しました。本文はパーツ別共通のダミーテキストです。実データはファンドごとに差し替えてご利用ください。"}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'ファンドの仕組み' + NCHAR(31) + N'商品概要' + NCHAR(31) + N'商品概要の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'ファンドの仕組み', N'商品概要', N'商品概要の表', N'標準',
    N'{"product":{"category":"追加型投信／内外／資産複合","trustPeriod":"2020年1月1日から無期限","policy":"投資信託財産の中長期的な成長を目指して運用を行います。","mainTarget":"サンプルマザーファンド","distributionPolicy":"毎決算時に委託会社が基準価額水準・市況動向などを勘案して分配金額を決定します。","investmentLimit":"投資信託証券への投資割合に制限を設けません。株式への直接投資は行いません。"}}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'ファンドの仕組み' + NCHAR(31) + N'主要運用対象' + NCHAR(31) + N'主要運用対象の一覧' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'ファンドの仕組み', N'主要運用対象', N'主要運用対象の一覧', N'標準',
    N'{"mainAssets":[{"name":"サンプル マザーファンド1"},{"name":"サンプル マザーファンド2"},{"name":"サンプル マザーファンド3"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'運用経過の説明' + NCHAR(31) + N'基準価額等の推移' + NCHAR(31) + N'推移グラフ' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'運用経過の説明', N'基準価額等の推移', N'推移グラフ', N'標準',
    N'{"navHistory":[{"label":"25/1","nav":"12,000"},{"label":"25/3","nav":"12,100"},{"label":"25/5","nav":"12,200"},{"label":"25/7","nav":"12,250"},{"label":"25/9","nav":"12,300"},{"label":"25/12","nav":"12,345"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'運用経過の説明' + NCHAR(31) + N'期間別騰落率' + NCHAR(31) + N'騰落率の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'運用経過の説明', N'期間別騰落率', N'騰落率の表', N'標準',
    N'{"performance":[{"period":"1ヶ月","return":"1.2"},{"period":"6ヶ月","return":"6.5"},{"period":"1年","return":"12.3"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'運用経過の説明' + NCHAR(31) + N'分配金の推移' + NCHAR(31) + N'分配金の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'運用経過の説明', N'分配金の推移', N'分配金の表', N'標準',
    N'{"distributions":[{"term":"第1期","date":"2025/4/30","amount":"10"},{"term":"第2期","date":"2025/8/31","amount":"10"},{"term":"第3期","date":"2025/12/31","amount":"10"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'投資対象ファンドの状況' + NCHAR(31) + N'資産配分' + NCHAR(31) + N'配分の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'投資対象ファンドの状況', N'資産配分', N'配分の表', N'標準',
    N'{"allocation":[{"name":"国内株式","weight":"30.0"},{"name":"先進国株式","weight":"30.0"},{"name":"国内債券","weight":"20.0"},{"name":"先進国債券","weight":"20.0"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'当ファンドのデータ' + NCHAR(31) + N'組入上位銘柄' + NCHAR(31) + N'銘柄の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'当ファンドのデータ', N'組入上位銘柄', N'銘柄の表', N'標準',
    N'{"holdings":[{"name":"サンプル銘柄1","asset":"国内株式","country":"日本","weight":"12.3","ret":"1.2"},{"name":"サンプル銘柄2","asset":"先進国株式","country":"アメリカ","weight":"10.0","ret":"2.3"},{"name":"サンプル銘柄3","asset":"先進国債券","country":"イギリス","weight":"8.0","ret":"3.4"},{"name":"サンプル銘柄4","asset":"新興国株式","country":"その他","weight":"6.0","ret":"4.5"},{"name":"サンプル銘柄5","asset":"コモディティ","country":"日本","weight":"4.0","ret":"5.6"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'当ファンドのデータ' + NCHAR(31) + N'通貨別配分' + NCHAR(31) + N'配分の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'当ファンドのデータ', N'通貨別配分', N'配分の表', N'標準',
    N'{"currencyAllocation":[{"name":"米ドル","weight":"40.0"},{"name":"ユーロ","weight":"30.0"},{"name":"円","weight":"20.0"},{"name":"その他","weight":"10.0"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'当ファンドのデータ' + NCHAR(31) + N'国別配分' + NCHAR(31) + N'配分の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'当ファンドのデータ', N'国別配分', N'配分の表', N'標準',
    N'{"countryAllocation":[{"name":"アメリカ","weight":"40.0"},{"name":"イギリス","weight":"30.0"},{"name":"ドイツ","weight":"20.0"},{"name":"その他","weight":"10.0"}]}', SYSUTCDATETIME(), N'seed');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] WHERE [分類キー] = N'費用および運用コメント' + NCHAR(31) + N'費用明細' + NCHAR(31) + N'費用の表' + NCHAR(31) + N'標準')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (N'費用および運用コメント', N'費用明細', N'費用の表', N'標準',
    N'{"costs":[{"item":"(a) 信託報酬","amount":"123","rate":"1.234"},{"item":"(b) 売買委託手数料","amount":"12","rate":"0.123"},{"item":"(c) その他費用","amount":"1","rate":"0.012"}],"costTotal":{"amount":"136","rate":"1.369"}}', SYSUTCDATETIME(), N'seed');
GO
