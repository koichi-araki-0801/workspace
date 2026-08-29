/**
 * Generate the admin-user seed SQL (or any single user) with a PBKDF2 hash.
 *
 * The plaintext password never lands in a committed file: run this at deploy
 * time to (re)generate `server/db/seed/管理ユーザー.sql` with 0x VARBINARY
 * literals. Idempotent INSERT (IF NOT EXISTS on ログインID).
 *
 * Usage:
 *   tsx server/scripts/hash-password.ts <ログインID> <パスワード> [表示名] [ロール] [出力先.sql]
 *   tsx server/scripts/hash-password.ts admin 'S3cret!' 管理者 admin
 *
 * Output file is written as UTF-8 with BOM (Japanese identifiers / sqlcmd).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth/password.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [loginId, password, displayName = loginId, role = 'admin', outArg] = process.argv.slice(2);

if (!loginId || !password) {
  console.error(
    'usage: tsx hash-password.ts <ログインID> <パスワード> [表示名] [ロール] [出力先.sql]',
  );
  process.exit(1);
}
if (!['admin', 'approver', 'editor', 'viewer'].includes(role)) {
  console.error(`ロールは admin|approver|editor|viewer のいずれか: ${role}`);
  process.exit(1);
}

// `hashPassword` は非同期(`promisify(pbkdf2)`)。ESM の top-level await で受ける。
// 同期版へ戻すとログイン経路がイベントループを塞ぐため、こちら側が await へ追随する。
// このスクリプトは `tsconfig.json` の `include` (`src/**/*`) の外にあり `tsc -b` の
// 型検査が届かない。`src/auth/password.ts` のシグネチャを変えたらここも手で追随すること。
const { hash, salt, iterations } = await hashPassword(password);
const publicId = randomUUID();
const hex = (b: Buffer) => `0x${b.toString('hex').toUpperCase()}`;

const T = '[ug01].[Rep1_運報自動化_Editor_ユーザー]';
const sql = `\
/* ============================================================================
 *  seed: 管理ユーザー (生成物 — hash-password.ts。平文は含まない)
 *  ログインID=${loginId} / ロール=${role} / 要パスワード変更=1
 * ==========================================================================*/
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM ${T} WHERE [ログインID] = N'${loginId}')
  INSERT INTO ${T}
    ([公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更],
     [PWハッシュ], [PWソルト], [PW反復回数])
  VALUES
    (N'${publicId}', N'${loginId}', N'${displayName}', N'${role}', 0, 1,
     ${hex(hash)}, ${hex(salt)}, ${iterations});
GO
`;

const outPath = outArg
  ? path.resolve(process.cwd(), outArg)
  : path.resolve(__dirname, '..', 'db', 'seed', '管理ユーザー.sql');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
// Prepend a UTF-8 BOM so sqlcmd reads Japanese identifiers correctly.
fs.writeFileSync(outPath, `﻿${sql}`, 'utf8');
console.log(`[hash-password] wrote ${outPath} (公開ID=${publicId})`);
