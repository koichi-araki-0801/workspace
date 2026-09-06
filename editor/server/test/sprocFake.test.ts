// =============================================================================
// sprocFake.test.ts — in-memory sproc フェイクが写す不変則
// =============================================================================
// フェイクは rest e2e が見る「サーバの挙動」の下敷きなので、sproc の不変則を外すと
// e2e が偽の挙動を検証したまま緑になる。ここで固定するのはその不変則そのもので、
// SQL の書き方ではない。ゲートウェイ 7 本で実際に呼ばれる 20 操作を、1 操作 1 主張の
// 粒度で覆う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import { p, type SprocClient } from '../src/db/sproc.js';
import { SP } from '../src/db/sprocNames.js';
import { createFakeSproc, DEFAULT_USERS } from './fakes/sprocFake.js';

// 実 `buildApp()` を通す結合テストが確定領域へ触れないよう、dataRoot は一時ディレクトリへ
// 向ける(既定は隣の実データを指す)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-sproc-fake-'));
process.env.DATA_ROOT = tmp;

const HOUR = 3_600_000;

async function openSession(sproc: SprocClient, id: string, loginId: string): Promise<void> {
  await sproc.callSproc(SP.session, '作成', [
    p('セッションID', id),
    p('ログインID', loginId),
    p('有効期限', new Date(Date.now() + HOUR)),
  ]);
}
const sid = (n: number) => String(n).repeat(64).slice(0, 64);

describe('EXEC 文の解析', () => {
  it('names and positional values are paired back into arguments', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.sample, '取得', [p('ファンドコード', '510037')]);
    expect(JSON.parse(String(rows[0]?.データJSON))).toMatchObject({
      fund: { name: 'コア投資戦略ファンド（切替型）' },
      company: { code: 'AM01' },
    });
  });

  it('gives every fake its own state', async () => {
    const a = await createFakeSproc();
    const b = await createFakeSproc();
    await a.callSproc(SP.user, '作成', [
      p('公開ID', 'u-only-in-a'),
      p('ログインID', 'only-in-a'),
      p('表示名', 'A だけ'),
      p('ロール', 'editor'),
    ]);
    const listedB = await b.callSproc(SP.user, '一覧');
    expect(listedB.some((r) => r.ログインID === 'only-in-a')).toBe(false);
  });
});

describe('ユーザー', () => {
  it('一覧 returns the seeded users in creation order without any hash column', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.user, '一覧');
    expect(rows.map((r) => r.ログインID)).toEqual(DEFAULT_USERS.map((u) => u.username));
    for (const row of rows) {
      expect(row.PWハッシュ).toBeUndefined();
      expect(row.PWソルト).toBeUndefined();
    }
  });

  it('認証情報取得 returns a hash that the seed password verifies against', async () => {
    const sproc = await createFakeSproc();
    const row = (await sproc.callSproc(SP.user, '認証情報取得', [p('ログインID', 'editor')]))[0];
    expect(row).toBeDefined();
    await expect(
      verifyPassword(
        'editor',
        row?.PWハッシュ as Buffer,
        row?.PWソルト as Buffer,
        row?.PW反復回数 as number,
      ),
    ).resolves.toBe(true);
  });

  it('認証情報取得 yields no row for an unknown login id', async () => {
    const sproc = await createFakeSproc();
    await expect(
      sproc.callSproc(SP.user, '認証情報取得', [p('ログインID', 'nobody')]),
    ).resolves.toHaveLength(0);
  });

  it('作成 refuses a duplicate login id with 50409 and defaults 要パスワード変更 to 1', async () => {
    const sproc = await createFakeSproc();
    const created = (
      await sproc.callSproc(SP.user, '作成', [
        p('公開ID', 'u-new'),
        p('ログインID', 'newbie'),
        p('表示名', '新人'),
        p('ロール', 'editor'),
      ])
    )[0];
    expect(created?.要パスワード変更).toBe(1);
    await expect(
      sproc.callSproc(SP.user, '作成', [
        p('公開ID', 'u-dup'),
        p('ログインID', 'newbie'),
        p('表示名', '重複'),
        p('ロール', 'editor'),
      ]),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('更新 keeps the columns whose argument is NULL', async () => {
    const sproc = await createFakeSproc();
    const row = (
      await sproc.callSproc(SP.user, '更新', [
        p('公開ID', 'u-editor'),
        p('表示名', undefined),
        p('ロール', 'approver'),
        p('無効', undefined),
        p('要パスワード変更', undefined),
      ])
    )[0];
    expect(row?.表示名).toBe(DEFAULT_USERS[0]?.displayName);
    expect(row?.ロール).toBe('approver');
  });

  it('更新 reports an unknown 公開ID as not_found', async () => {
    const sproc = await createFakeSproc();
    await expect(
      sproc.callSproc(SP.user, '更新', [p('公開ID', 'u-ghost'), p('ロール', 'admin')]),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('PW初期化 revokes every session but the excluded one, in the same operation', async () => {
    const sproc = await createFakeSproc();
    await openSession(sproc, sid(1), 'editor');
    await openSession(sproc, sid(2), 'editor');
    await openSession(sproc, sid(8), 'approver');
    await sproc.callSproc(SP.user, 'PW初期化', [
      p('ログインID', 'editor'),
      p('PWハッシュ', Buffer.alloc(64, 1)),
      p('PWソルト', Buffer.alloc(32, 2)),
      p('PW反復回数', 120_000),
      p('除外セッションID', sid(1)),
    ]);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(1))]),
    ).resolves.toHaveLength(1);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(2))]),
    ).resolves.toHaveLength(0);
    // 失効は本人のセッションに閉じる(他人まで蹴ると全員が突然ログアウトする)。
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(8))]),
    ).resolves.toHaveLength(1);
    const listed = await sproc.callSproc(SP.user, '一覧');
    expect(listed.find((r) => r.ログインID === 'editor')?.要パスワード変更).toBe(0);
  });

  it('PWリセット revokes every session and raises 要パスワード変更', async () => {
    const sproc = await createFakeSproc();
    await openSession(sproc, sid(3), 'editor');
    await sproc.callSproc(SP.user, 'PWリセット', [
      p('公開ID', 'u-editor'),
      p('PWハッシュ', Buffer.alloc(64, 1)),
      p('PWソルト', Buffer.alloc(32, 2)),
      p('PW反復回数', 120_000),
    ]);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(3))]),
    ).resolves.toHaveLength(0);
    const listed = await sproc.callSproc(SP.user, '一覧');
    expect(listed.find((r) => r.ログインID === 'editor')?.要パスワード変更).toBe(1);
  });
});

describe('セッション', () => {
  it('取得 yields a row only while the session is neither revoked nor expired', async () => {
    const sproc = await createFakeSproc();
    await openSession(sproc, sid(4), 'approver');
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(4))]),
    ).resolves.toHaveLength(1);

    await sproc.callSproc(SP.session, '作成', [
      p('セッションID', sid(5)),
      p('ログインID', 'approver'),
      p('有効期限', new Date(Date.now() - HOUR)),
    ]);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(5))]),
    ).resolves.toHaveLength(0);

    await sproc.callSproc(SP.session, '全失効', []);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(4))]),
    ).resolves.toHaveLength(0);
  });

  it('失効 closes just the named session', async () => {
    const sproc = await createFakeSproc();
    await openSession(sproc, sid(9), 'editor');
    await openSession(sproc, sid(2), 'editor');
    await sproc.callSproc(SP.session, '失効', [p('セッションID', sid(9))]);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(9))]),
    ).resolves.toHaveLength(0);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(2))]),
    ).resolves.toHaveLength(1);
  });

  it('掃除 deletes only the rows whose expiry is past the retention window', async () => {
    const sproc = await createFakeSproc();
    await openSession(sproc, sid(6), 'editor');
    await sproc.callSproc(SP.session, '作成', [
      p('セッションID', sid(7)),
      p('ログインID', 'editor'),
      p('有効期限', new Date(Date.now() - 30 * 24 * HOUR)),
    ]);
    await sproc.callSproc(SP.session, '掃除', [p('保持日数', 7)]);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(6))]),
    ).resolves.toHaveLength(1);
    await expect(
      sproc.callSproc(SP.session, '取得', [p('セッションID', sid(7))]),
    ).resolves.toHaveLength(0);
  });
});

describe('テンプレート・パーツ・サンプル・注記マスタ・監査ログ', () => {
  it('生成登録 is idempotent', async () => {
    const sproc = await createFakeSproc();
    const args = [
      p('テンプレートID', 'AM01_510037_20260101_交付版'),
      p('委託会社コード', 'AM01'),
      p('ファンドコード', '510037'),
      p('基準日', '20260101'),
      p('版種', '交付版'),
      p('ファイル名', 'AM01_510037_20260101_交付版.html'),
    ];
    await sproc.callSproc(SP.template, '生成登録', args);
    await sproc.callSproc(SP.template, '生成登録', args);
    const series = await sproc.callSproc(SP.template, '系列', [
      p('委託会社コード', 'AM01'),
      p('版種', '交付版'),
    ]);
    expect(series.filter((r) => r.基準日 === '20260101')).toHaveLength(1);
  });

  it('系列 returns the ledger columns for one company and edition', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.template, '系列', [
      p('委託会社コード', 'AM01'),
      p('版種', '全体版'),
    ]);
    expect(rows.map((r) => r.テンプレートID)).toEqual([
      'AM01_110024_20251117_全体版',
      'AM01_510003_20250710_全体版',
      'AM01_510037_20240710_全体版',
      'AM01_510124_20251020_全体版',
    ]);
    expect(rows[0]).toMatchObject({ ファンドコード: '110024', ファイル名: expect.any(String) });
  });

  it('系列 needs both the company and the edition', async () => {
    const sproc = await createFakeSproc();
    await expect(
      sproc.callSproc(SP.template, '系列', [p('委託会社コード', 'AM01')]),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('候補 narrows only by the choices above each level', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.template, '候補', [
      p('委託会社コード', 'AM01'),
      p('ファンドコード', '510037'),
      p('基準日', undefined),
      p('版種', undefined),
    ]);
    const pick = (区分: string) => rows.filter((r) => r.区分 === 区分).map((r) => String(r.値));
    expect(pick('基準日')).toEqual(['20240710']);
    expect(pick('版種').sort()).toEqual(['交付版', '全体版']);
    // 上位はより狭い選択に潰れない(潰れると別のファンドへ戻せなくなる)。
    expect(pick('ファンド').length).toBeGreaterThan(1);
  });

  it('注記マスタ 反映 upserts by (パーツID, ファンドコード, 版種)', async () => {
    const sproc = await createFakeSproc();
    const key = [p('パーツID', 'p-note-tax'), p('ファンドコード', '510037'), p('版種', '交付版')];
    await sproc.callSproc(SP.noteMaster, '反映', [
      ...key,
      p('注記HTML', '<p>旧</p>'),
      p('更新者', 'approver'),
    ]);
    await sproc.callSproc(SP.noteMaster, '反映', [
      ...key,
      p('注記HTML', '<p>新</p>'),
      p('更新者', 'approver'),
    ]);
    const rows = await sproc.callSproc(SP.noteMaster, '取得', [
      p('ファンドコード', '510037'),
      p('版種', '交付版'),
    ]);
    expect(rows).toEqual([{ パーツID: 'p-note-tax', 注記HTML: '<p>新</p>' }]);
    // 版種が違えば別行(ペアの版種へ勝手に波及しない)。
    await expect(
      sproc.callSproc(SP.noteMaster, '取得', [p('ファンドコード', '510037'), p('版種', '全体版')]),
    ).resolves.toHaveLength(0);
  });

  it('パーツ 一覧 filters by the classification arguments', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.part, '一覧', [
      p('カテゴリ', '注記'),
      p('大分類', undefined),
      p('中分類', undefined),
      p('小分類', undefined),
    ]);
    expect(rows.map((r) => r.パーツID)).toEqual(['p-note-tax']);
    expect(rows[0]).toMatchObject({ 内容HTML: expect.any(String), 同期既定: null });
  });

  it('パーツ 分類候補 cascades from the chosen category', async () => {
    const sproc = await createFakeSproc();
    const rows = await sproc.callSproc(SP.part, '分類候補', [
      p('カテゴリ', '注記'),
      p('大分類', undefined),
      p('中分類', undefined),
      p('小分類', undefined),
    ]);
    const pick = (区分: string) => rows.filter((r) => r.区分 === 区分).map((r) => String(r.値));
    expect(pick('カテゴリ')).toEqual(['表紙', '注記']);
    expect(pick('大分類')).toEqual(['税制']);
  });

  it('サンプルデータ 取得 yields nothing for a fund outside the master', async () => {
    const sproc = await createFakeSproc();
    await expect(
      sproc.callSproc(SP.sample, '取得', [p('ファンドコード', '999999')]),
    ).resolves.toHaveLength(0);
  });

  it('監査ログ 登録 needs the event, the outcome and the actor', async () => {
    const sproc = await createFakeSproc();
    await expect(
      sproc.callSproc(SP.audit, '登録', [
        p('イベント', 'auth.login'),
        p('結果', 'success'),
        p('実行者', 'editor'),
      ]),
    ).resolves.toEqual([]);
    await expect(
      sproc.callSproc(SP.audit, '登録', [p('イベント', 'auth.login'), p('結果', 'success')]),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('未知の操作', () => {
  it('rejects an unknown 操作 as a validation error', async () => {
    const sproc = await createFakeSproc();
    await expect(sproc.callSproc(SP.user, '削除')).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});

// ── 実配線(`buildApp({ sproc })`)への結合テスト ──
//
// 上の describe が主張するのは「フェイクが sproc の不変則を写している」ことで、
// 「サーバがそのフェイクで実際に動く」ことではない。rest e2e はまさに後者に乗るので、
// 本番と同じ `buildApp()` へ差し込み、ログイン → セッション cookie → `/auth/me` の
// 往復が成立することをここで押さえる。
describe('buildApp へ差し込んだフェイク', { timeout: 60_000 }, () => {
  let app: FastifyInstance | null = null;
  const previousAuth = process.env.AUTH_REQUIRED;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  afterAll(() => {
    if (previousAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = previousAuth;
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('logs the seed user in and answers /auth/me from the session cookie', async () => {
    // rest 配備の姿勢(認証あり・dataRoot は一時ディレクトリ)で読み直す。
    process.env.AUTH_REQUIRED = 'true';
    vi.resetModules();
    const { buildApp } = await import('../src/app.js');
    app = buildApp({ sproc: await createFakeSproc() });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost' },
      payload: { username: 'editor', password: 'editor' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { username: 'editor' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(cookie).toMatch(/^editor\.sid=[0-9a-f]{64}$/);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { host: 'localhost', cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: 'editor', role: 'editor' });
  });
});
