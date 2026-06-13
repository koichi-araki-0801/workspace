/* seed: パーツカタログ (生成物 — gen-seed.ts from web fixtures) */
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-section-basic')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-section-basic', N'レイアウト', N'コンテナ', N'セクション', N'標準',
    N'基本セクション', N'見出しと本文を含む標準的なセクションです。文章のまとまりごとに使います。', N'ページ先頭の表紙には使用しないでください。見出しは1セクションに1つを目安にします。', N'<section class="section" style="padding:16px"><h2>見出し</h2><p>本文</p></section>', CONVERT(datetime2(3), N'2026-05-01T09:00:00.000'), N'山田 太郎');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-section-spacious')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-section-spacious', N'レイアウト', N'コンテナ', N'セクション', N'余白広め',
    N'広めセクション', N'上下の余白を広く取ったセクションです。区切りを強調したいときに使います。', N'余白が大きいため、短い注記だけを入れる用途には向きません。', N'<section class="section" style="padding:40px 16px"><h2>見出し</h2><p>本文</p></section>', CONVERT(datetime2(3), N'2026-05-10T09:00:00.000'), N'山田 太郎');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-columns-2')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-columns-2', N'レイアウト', N'コンテナ', N'カラム', N'2カラム',
    N'2カラムレイアウト', N'左右に内容を並べる2カラムの枠です。図と説明を横に並べるときに使います。', N'印刷時に横幅が狭くなると読みにくくなるため、長文には使わないでください。', N'<div style="display:flex;gap:16px"><div style="flex:1"><p>左の内容</p></div><div style="flex:1"><p>右の内容</p></div></div>', CONVERT(datetime2(3), N'2026-04-20T09:00:00.000'), N'佐藤 花子');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-divider-solid')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-divider-solid', N'レイアウト', N'区切り', N'線', N'実線',
    N'区切り線', N'内容のまとまりを区切る横線です。', N'多用すると紙面が分断されすぎるため、大きな区切りにのみ使います。', N'<hr />', CONVERT(datetime2(3), N'2026-03-15T09:00:00.000'), N'佐藤 花子');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-table-basic')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-table-basic', N'レイアウト', N'表', N'データ表', N'2列',
    N'基本テーブル', N'項目と値を並べる2列の表です。数値や項目の一覧に使います。', N'1行目（ヘッダー）の項目名は短くしてください。列幅が崩れる原因になります。', N'<table class="tbl"><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>—</td><td>—</td></tr></tbody></table>', CONVERT(datetime2(3), N'2026-05-05T09:00:00.000'), N'山田 太郎');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-heading-h2')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-heading-h2', N'テキスト', N'見出し', N'セクション見出し', N'大見出し',
    N'見出し', N'セクションの先頭に置く見出しです。', N'本文より目立たせるための要素です。長い文章は入れないでください。', N'<h2>見出し</h2>', CONVERT(datetime2(3), N'2026-04-01T09:00:00.000'), N'佐藤 花子');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-paragraph-basic')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-paragraph-basic', N'テキスト', N'本文', N'段落', N'標準',
    N'段落', N'標準的な本文テキストの段落です。', N'1段落が長くなりすぎないよう、適度に区切ってください。', N'<p>本文テキスト</p>', CONVERT(datetime2(3), N'2026-04-01T09:00:00.000'), N'佐藤 花子');
GO
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ] WHERE [パーツID] = N'part-image-basic')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (N'part-image-basic', N'メディア', N'画像', N'単体画像', N'標準',
    N'画像', N'1枚の画像を配置します。挿入後にダブルクリックで画像を差し替えます。', N'解像度の低い画像は印刷時に粗くなります。十分な大きさの画像を使ってください。', N'<img/>', CONVERT(datetime2(3), N'2026-05-12T09:00:00.000'), N'山田 太郎');
GO
