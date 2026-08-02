/* ============================================================================
 *  seed: 管理ユーザー (生成物 — hash-password.ts。平文は含まない)
 *  ログインID=admin / ロール=admin / 要パスワード変更=1
 * ==========================================================================*/
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_ユーザー] WHERE [ログインID] = N'admin')
  INSERT INTO [ug01].[Rep1_運報自動化_Editor_ユーザー]
    ([公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更],
     [PWハッシュ], [PWソルト], [PW反復回数])
  VALUES
    (N'867daa3c-f8bd-4d48-a51e-867d7a21efff', N'admin', N'管理者', N'admin', 0, 1,
     0x66769F5B42FFCDDEEE6F31182F5E5815C0C4DB3BAE43F4EDAAC3DEC70DF447A31CA43E0A2F5583D0472E9316A6FEEC9B99F681BFA75DECA4FDA5455C21E53C35, 0x8621C25399D0F21B57355F3D18A019484B27E6D0A526CF7A2362713B390E9F54, 120000);
GO
