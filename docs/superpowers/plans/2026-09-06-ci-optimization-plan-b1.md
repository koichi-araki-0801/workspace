# CI 最適化 計画 B1(e2e と注入)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サーバの DB 呼出(`callSproc`)を `buildApp({ sproc })` から注入できる形にして in-memory の
sproc フェイクを持ち、rest モードの e2e(playwright project `rest`)で「ログイン → 一覧 → 申請 → 承認 →
確定ファイル + git コミット」と「ユーザー作成」を実機の HTTP 経路で検証し、既存 e2e の固定待ち
(`waitForTimeout`)を状態待ちへ置き換えて GitHub Actions の `retries` を 0 にし、未到達の画面
(`/merge`・承認クリック・作成フロー)に挙動 spec を足す。

**Architecture:** DB 継ぎ目は `db/sproc.ts` の `createSprocClient(query)` 1 点に集約し、real =
`createSprocClient(pool.query)`、fake = `createSprocClient(fakeQuery)`。`buildApp` がセッション
ストアとリポジトリをファクトリで生成し、`app.decorate('sessionStore', …)` と `register(routes,
{ prefix, deps })` で配る(ガード関数の参照同一性は保つ)。プロセスのライフサイクルは `src/serve.ts`
の `startServer({ sproc? })` に抽出し、`index.ts` と `scripts/e2e-rest-server.ts` が共用する。
rest e2e は `E2E_REST=1` のときだけ playwright の projects / webServer が切り替わり、ポートは
24690 / 24691 で local と分離する。

**Tech Stack:** pnpm 11 / Node 24 / Fastify 5 / vitest 4.1.11 / @playwright/test 1.62 / tsx /
TypeScript 6 / GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-06-ci-optimization-design.md`(1 章、6.1 の `rest` project、
6.2、6.3、7 章、9 章の `retries: 0`、10 章の B1 完了条件)。決定の記録は
`docs/superpowers/specs/2026-09-06-ci-optimization-dig.md`(Round 2〜3)。前計画:
`docs/superpowers/plans/2026-09-06-ci-optimization-plan-a.md`(完了。`chromium` / `docs` project、
`test:e2e` のポート検査、`e2e:editor` は既存)。

## Global Constraints

- **本番コードに検証専用の分岐を入れない**: 注入は既定値引数(`buildApp({ sproc = realSproc })`)と
  ファクトリで行い、`pool.ts` に env 分岐を置かない。`db/audit.ts` の `setAuditSink` だけは
  logger がグローバルなため setter になる(唯一の例外。`buildApp` 以外から呼ばない)。
- **ガード関数の参照同一性を保つ**: `routes/routeGuards.ts` の `levelOf` が
  `preHandlers.includes(requireAuth)` で照合し、`ROUTE_POLICY` の起動時検査もこれに依存する。
  `requireAuth` 系をクロージャ化・ファクトリ化しない。セッションストアは `request.server.sessionStore`
  から読む。
- **認証・資格情報のガードは `config.requireAuth` を参照しない**(設計正典)。パスワード書き換えと
  旧セッション失効は同一操作(フェイクも同じ semantics を写す)。
- **フェイクは生 SQL エラー相当を throw する**(`number` フィールド付き)。`mapSqlError` は
  `createSprocClient` の中で 1 回だけ通る。フェイクは `AppError` を直接投げない。
- **rest e2e は opt-in**: `E2E_REST=1` のときだけ project `rest` が `projects` に入り、webServer が
  rest 版(server `PORT=24690` / vite `--port 24691`、proxy 先 `API_PROXY_TARGET`)に切り替わる。
  `reuseExistingServer: false`、`workers: 1`。`DATA_ROOT` は一時ディレクトリ。`AUTH_REQUIRED=true`、
  `AUDIT_DB=true`。
- **`waitForTimeout` の撤去は「撤去 → `CI=1` で 3 回連続緑 → `retries: 0`」の順**(逆にしない)。
  `smoke.spec.ts` のリサイズ嵐の 100ms は待ちではないので残す。
- **`editor/**` を変更したコミットの前に** `pnpm exec biome check --write editor/<対象>` を先行実行する。
  型検査は `pnpm run typecheck`(shared 先行ビルド込み)。`server/tsconfig.json` の include は
  `src/**` のまま(dist へ emit するため広げない)。フェイクと e2e エントリは
  `server/tsconfig.tools.json`(`noEmit`)で検査し、`typecheck` / `typecheck:editor` の両方に足す。
- **コメントは `docs/コメント規約.md`**(なぜ / 日本語散文 + 英語ドメイン用語 / 経緯・日付・所見番号を
  書かない)。ドキュメントは通常の丁寧な日本語。
- **既存のガードテストを壊さない**: `ssti.guard.test.ts`(`allow-same-origin` 無し等)、
  `guardCoverage.guard.test.ts`、`config.security.test.ts`(`app.ts` の `const gateUrl =
  preAuthGateUrl(request);` の字面)、`loginRateLimit.test.ts`(`trustProxy` 不在)、
  `confirmedWrite.guard.test.ts`(import 集合)、`mustChangePassword.test.ts`(3 経路の例外)。
- **コミットは小さく**(タスクごと)。メッセージは日本語の conventional commit。push は auto-push
  フック(merge コミットでは発火しない → 手動)。pre-push は `ci:affected`(editor 領域 ≈ 3〜4 分)。
- **同 checkout に別セッションのコミットが挟まる**ことがある。レビューパッケージは実装者の base SHA を
  明示して切る。

---
## タスクの順序と依存

| 順 | タスク | 依存 | 効果 |
|---|---|---|---|
| 1 | D1 `createSprocClient(query)` の継ぎ目 | なし | DB 呼出の差し替え点を 1 つに |
| 2 | D2 セッションストアのファクトリ化 + `app.decorate` | D1 | ガードの参照同一性を保ったまま注入 |
| 3 | D3 リポジトリのファクトリ化 + ルートへ `deps` | D2 | `buildApp({ sproc })` で全経路が注入済みに |
| 4 | D4 `setAuditSink` | D3 | 監査ログの DB 複写も差し替え可能に |
| 5 | D5 `serve.ts` へライフサイクル抽出 | D3 | e2e-rest-server と index.ts が同じ起動経路 |
| 6 | D6 sproc フェイク + semantics テスト + `tsconfig.tools.json` | D1〜D3 | rest e2e の DB 相当 |
| 7 | D7 移行用の別名を落とす | D6 | `callSproc` の直 import を根絶 |
| 8 | E1 `e2e/helpers.ts` 集約 | なし | 8 spec の重複ヘルパーを 1 本に(R4/R5 も使う) |
| 9 | E2 `note_bubble.spec.ts` の固定待ち撤去 | E1 | flaky 要因の最大群 |
| 10 | E3 `capture_docs.spec.ts` の固定待ち撤去 | E1 | docs project の安定化(画像再撮影 + build_all) |
| 11 | E4 挙動 spec 追加(merge / approve / create) | E1 | 未到達画面の退行網 |
| 12 | R1 `API_PROXY_TARGET` | なし | rest 用サーバを別ポートで前に置ける |
| 13 | R2 `e2e-rest-server.ts`(seed + フェイク + startServer) | D5, D6 | rest e2e のサーバ |
| 14 | R3 playwright `rest` project + `e2e:rest` | R1, R2 | opt-in の起動切替 |
| 15 | R4 `approval.rest.spec.ts` | R3, E1 | 実機 HTTP で申請→承認→確定ファイル + git |
| 16 | R5 `users.rest.spec.ts` | R3, E1 | ユーザー作成 → 初回パスワード変更 |
| 17 | R6 docs(README / 設計正典) | R5 | 運用の記録 |
| 18 | E5 `CI=1` で 3 回緑 → `retries: 0` | E2〜E4, R5 | GH の flaky 隠蔽をやめる |

seed の契約(D6 が作り、R2 / R4 / R5 が使う): ユーザーは `editor` / `approver` / `admin` の 3 名、
パスワードはユーザー名と同じ、`mustChangePassword: false`(local fixtures の `users.json` と同じ規約。
e2e の `login(page, user)` が local / rest で同じ引数で通る)。ファンドと テンプレート ID は
`editor/web/src/api/fixtures/sample/*.json` / `templates/*.html` と一致させる。

`login(page, user = 'admin', { clearSession = true } = {})` は E1 が定義する(`editor/e2e/helpers.ts`)。
R4 / R5 はこのシグネチャを使う(rest では `clearSession` の localStorage 消去は無害)。

---

### D 系列の前提

> 前提: 本節のタスクは計画冒頭の **Global Constraints** をすべて満たすこと。とくに
> 「本番コードに検証専用の分岐を入れない」「ガード関数の参照同一性を保つ」「フェイクは
> 生 SQL エラー相当を throw する」の 3 点は各タスクの受入条件に含まれる。
>
> 設計との差分(実装を読んで判明): 設計 7.1 は `createNoteMasterService(partRepo)` と
> 書いているが、`sync/noteMasterService.ts` は `listParts` に加えて
> `callSproc(SP.noteMaster, …)` を直接呼ぶため、**sproc も要る**。よって本計画では
> `createNoteMasterService({ sproc, parts })` とする。`createPairSyncService(partRepo)` は
> 設計どおり(sproc 非依存)。

---

### Task D1: `db/sproc.ts` に `createSprocClient` の継ぎ目を作る

**Files:**
- `editor/server/src/db/sproc.ts`(1-40 行目のヘッダとエントリ部を書き換え。42 行目以降の
  行値変換・`mapSqlError` はそのまま)
- `editor/server/test/sprocClient.test.ts`(新規)

**Interfaces:**

Consumes:
- `query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>`(`db/pool.ts:40`。
  内部で `getPool()` を呼ぶので、参照を渡すだけでは接続は開かない)
- `mapSqlError(e: unknown): AppError`(`db/sproc.ts:88`。module private のまま)

Produces:
- `export type Row = Record<string, unknown>;`
- `export type QueryFn = (sql: string, values: unknown[]) => Promise<Row[]>;`
- `export interface SprocClient { callSproc<T = Row>(proc: string, 操作: string, params?: Param[]): Promise<T[]>; }`
- `export function createSprocClient(query: QueryFn): SprocClient;`
- `export const realSproc: SprocClient;`
- `export const callSproc: SprocClient['callSproc'];`(移行用の別名。D7 で削除)

**Steps:**

- [ ] 失敗するテストを先に書く。`editor/server/test/sprocClient.test.ts` を新規作成する。

  ```ts
  // =============================================================================
  // sprocClient.test.ts — sproc 実行面の組み立てと SQL エラー変換
  // =============================================================================
  // `createSprocClient` は「EXEC 文の組み立て」と「SQL エラー → `AppError` 変換」だけを持つ
  // 継ぎ目で、実行面(`QueryFn`)は本番がプール、テストが in-memory フェイクを渡す。ここで
  // 主張するのは (1) `@操作` が必ず先頭に来て値は位置指定で渡ること、(2) 値を SQL へ
  // 文字列補間しないこと、(3) 生 SQL エラーの番号だけで種別が決まることの 3 点。
  import { describe, expect, it, vi } from 'vitest';
  import { createSprocClient, p, type Row } from '../src/db/sproc.js';

  const PROC = '[ug01].[Rep1_運報自動化_Editor_usp_ユーザー]';

  describe('createSprocClient', () => {
    it('puts 操作 first and binds every value positionally', async () => {
      const query = vi.fn(async (): Promise<Row[]> => []);
      const sproc = createSprocClient(query);
      await sproc.callSproc(PROC, '作成', [p('ログインID', 'admin'), p('無効', undefined)]);
      expect(query).toHaveBeenCalledWith(`EXEC ${PROC} @操作=?, @ログインID=?, @無効=?`, [
        '作成',
        'admin',
        null,
      ]);
    });

    it('returns the rows the query function resolves', async () => {
      const rows: Row[] = [{ ログインID: 'admin' }];
      const sproc = createSprocClient(async () => rows);
      await expect(sproc.callSproc(PROC, '一覧')).resolves.toEqual(rows);
    });

    it('maps a raw 50409 SQL error to conflict and keeps our own message', async () => {
      const sproc = createSprocClient(async () => {
        throw Object.assign(
          new Error('[Microsoft][SQL Server]このログインIDは既に使われています'),
          { number: 50409 },
        );
      });
      await expect(sproc.callSproc(PROC, '作成')).rejects.toMatchObject({
        kind: 'conflict',
        message: 'このログインIDは既に使われています',
      });
    });

    it('hides the message of a system error (2627) behind the fixed wording', async () => {
      const sproc = createSprocClient(async () => {
        throw Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_x'."), {
          number: 2627,
        });
      });
      await expect(sproc.callSproc(PROC, '作成')).rejects.toMatchObject({
        kind: 'conflict',
        message: 'すでに存在するか、競合しています',
      });
    });
  });
  ```

- [ ] 赤を確認する。

  ```
  pnpm exec vitest run --project server test/sprocClient
  ```

  期待: `Error: [vitest] No "createSprocClient" export is defined on the "../src/db/sproc.js" mock`
  ではなく、素の `SyntaxError`/`TypeError: createSprocClient is not a function`(4 件失敗)。

- [ ] `editor/server/src/db/sproc.ts` の 1-35 行目を差し替える。ヘッダの説明を実体に合わせ、
  エントリを `createSprocClient` へ移す。

  ```ts
  // =============================================================================
  // sproc.ts — ゲートウェイ sproc 呼び出し + SQL エラー→`AppError` 変換 + 行値変換
  // =============================================================================
  // 各 repository は注入された `SprocClient` の `callSproc(SP.x, '操作', [...])` を呼ぶ。
  // パラメータは位置指定(`@name=?`)でバインドし、値を SQL へ文字列補間しない
  // (インジェクション回避)。実行面は `QueryFn` 1 本に閉じており、本番は `pool.query`、
  // テストと rest e2e は in-memory フェイクを渡す。`mapSqlError` を通る経路が 1 本に
  // なるので、フェイク側は生 SQL エラー相当(`number` 付き)を throw すればよい。
  // SQL エラーは `server/db/sproc/*.sql` の THROW 番号規約に従って共有の `AppError`
  // 種別へ変換する:
  //   50404 → not_found, 50409 / 2627 / 2601 → conflict, 50000 / 50400 → validation。
  // メッセージをユーザーへ転送するのは**自前 THROW の番号だけ**(`mapSqlError` の注記)。
  import { type AppError, conflict, notFound, unexpected, validation } from '@editor/shared';
  import { query } from './pool.js';

  export interface Param {
    name: string;
    value: unknown;
  }

  /** 結果セットの 1 行。列名は SQL 側の日本語物理名がそのまま来る。 */
  export type Row = Record<string, unknown>;

  /** sproc の実行面。差し替え点はここ 1 つに限る。 */
  export type QueryFn = (sql: string, values: unknown[]) => Promise<Row[]>;

  /** repository が受け取る sproc 呼び出し口。 */
  export interface SprocClient {
    callSproc<T = Row>(proc: string, 操作: string, params?: Param[]): Promise<T[]>;
  }

  /** パラメータ要素を作る。`undefined` は `callSproc` が SQL NULL へ正規化する。 */
  export const p = (name: string, value: unknown): Param => ({ name, value: value ?? null });

  /** 実行面から sproc 呼び出し口を組む。`@操作` を先頭にして呼び、結果セットの行を返す。 */
  export function createSprocClient(query: QueryFn): SprocClient {
    return {
      async callSproc<T = Row>(proc: string, 操作: string, params: Param[] = []): Promise<T[]> {
        const all: Param[] = [{ name: '操作', value: 操作 }, ...params];
        const assigns = all.map((x) => `@${x.name}=?`).join(', ');
        const values = all.map((x) => x.value ?? null);
        try {
          return (await query(`EXEC ${proc} ${assigns}`, values)) as T[];
        } catch (e) {
          throw mapSqlError(e);
        }
      },
    };
  }

  /**
   * 本番の実行面。`pool.query` は最初の呼び出しでプールを開くので、ここでは接続を張らない
   * (`local` モードはネイティブドライバを require しないまま起動できる)。
   */
  export const realSproc: SprocClient = createSprocClient((sql, values) => query(sql, values));

  /** 注入をまだ受けていない呼び出し元のための別名。注入面が揃った時点で削除する。 */
  export const callSproc: SprocClient['callSproc'] = realSproc.callSproc;

  /** 先頭行、無ければ null(単一行取得ヘルパ)。 */
  export function firstRow<T>(rows: T[]): T | null {
    return rows.length > 0 ? rows[0] : null;
  }
  ```

  以降(`// ── 1. 行値の変換` 以下、旧 42-133 行目)は無変更。

- [ ] 緑を確認する。既存の `sprocErrors.test.ts`(`pool.js` をモックして `callSproc` を叩く)
  も同時に通ることを見る — 別名 export が生きているので無改修で通るはず。

  ```
  pnpm exec vitest run --project server test/sprocClient test/sprocErrors
  ```

  期待: `Test Files  2 passed (2)` / `Tests  4 passed` + `sprocErrors` の既存件数。

- [ ] 型検査。

  ```
  pnpm run typecheck:editor
  ```

  期待: exit 0(出力なし)。

- [ ] biome を先行実行してからコミットする。

  ```
  pnpm exec biome check --write editor/server/src/db/sproc.ts editor/server/test/sprocClient.test.ts
  git add editor/server/src/db/sproc.ts editor/server/test/sprocClient.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(editor): sproc の実行面を createSprocClient の継ぎ目へ集約する

  repository が呼ぶ `callSproc` を `SprocClient` として型で表し、実行面 (`QueryFn`) を
  引数で受け取る `createSprocClient` を追加する。本番は `pool.query` を渡す `realSproc`
  で、テストと rest e2e は in-memory のフェイクを渡す。`mapSqlError` を通る経路が 1 本に
  なるため、フェイクは生 SQL エラー相当を throw するだけでよい。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task D2: セッションストアをファクトリ化し、`app` に載せる

**Files:**
- `editor/server/src/auth/session.ts`(15-94 行目を再構成。`cookieOptions` / `sessionIdFrom` は
  モジュール直下の export のまま)
- `editor/server/src/middleware/auth.ts`(15 行目の import、26-30 行目の `loadUser`)
- `editor/server/src/app.ts`(23-47 行目の import、85-88 行目の `buildApp` 冒頭)
- `editor/server/src/index.ts`(15 行目の import、60-82 行目の `invalidateSessionsOnBoot`、
  95 行目の呼び出し)
- `editor/server/test/helpers/sessionStub.ts`(新規)
- `editor/server/test/session.test.ts`(16-27 行目)
- `editor/server/test/auth.failureFloor.test.ts`(32-38・52 行目)
- `editor/server/test/auth.loginIdAlphabet.test.ts`(39-45・72 行目)
- `editor/server/test/auth.loginRateLimit.test.ts`(36-42・63 行目)
- `editor/server/test/auth.initPassword.test.ts`(29-47・63 行目)
- `editor/server/test/auth.localMode.test.ts`(47-53・70 行目)
- `editor/server/test/mustChangePassword.test.ts`(16-38 行目)
- `editor/server/test/routeGuards.test.ts`(25-43・72 行目)
- `editor/server/test/generate.routes.test.ts`(33-46・73 行目)

**Interfaces:**

Consumes:
- `SprocClient` / `realSproc` / `p` / `firstRow`(D1)
- `rowToUser(r: Record<string, unknown>): User`(`repositories/userRepo.ts:21`)
- `SP.session`(`db/sprocNames.ts`)

Produces:
- `export interface SessionStore { createSession(loginId: string): Promise<string>; getSessionUser(sessionId: string): Promise<User | null>; destroySession(sessionId: string): Promise<void>; invalidateAllSessions(): Promise<void>; purgeExpiredSessions(retentionDays?: number): Promise<void>; }`
- `export function createSessionStore(sproc: SprocClient): SessionStore;`
- `declare module 'fastify' { interface FastifyInstance { sessionStore: SessionStore } }`
- `export interface BuildAppOptions { sproc?: SprocClient }`(`app.ts`)
- `export function buildApp(options?: BuildAppOptions)`(戻り型は従来どおり推論)
- テスト用: `createSessionStub(opts?)` / `decorateSessionStore(app, store)` / `withSessionStore(request, store)`

**Steps:**

- [ ] `editor/server/src/auth/session.ts` の 11-13 行目の import と 30-56・92-94 行目を
  差し替える。純粋ヘルパ(`cookieOptions` 22-28 行目 / `sessionIdFrom` 59-84 行目)は動かさない。

  ```ts
  import { randomBytes } from 'node:crypto';
  import type { User } from '@editor/shared';
  import type { CookieSerializeOptions } from '@fastify/cookie';
  import { config } from '../config.js';
  import { firstRow, p, realSproc, type SprocClient } from '../db/sproc.js';
  import { SP } from '../db/sprocNames.js';
  import { rowToUser } from '../repositories/userRepo.js';

  const TTL_MS = config.auth.sessionTtlHours * 3_600_000;

  /**
   * セッションのライフサイクル。実体は DB で、`buildApp` が組み立てて
   * `app.decorate('sessionStore', …)` でインスタンスへ載せる。`middleware/auth.ts` の
   * `loadUser` は `request.server.sessionStore` から読む — ガード関数
   * (`requireAuth` 等)は `routes/routeGuards.ts` の `levelOf` が `preHandlers.includes()`
   * で参照同一性を見るため、クロージャ化・ファクトリ化できない。
   */
  export interface SessionStore {
    createSession(loginId: string): Promise<string>;
    getSessionUser(sessionId: string): Promise<User | null>;
    destroySession(sessionId: string): Promise<void>;
    invalidateAllSessions(): Promise<void>;
    purgeExpiredSessions(retentionDays?: number): Promise<void>;
  }

  declare module 'fastify' {
    interface FastifyInstance {
      /** `buildApp` が載せるセッションストア。ガードはここから読む。 */
      sessionStore: SessionStore;
    }
  }

  export function createSessionStore(sproc: SprocClient): SessionStore {
    return {
      async createSession(loginId: string): Promise<string> {
        const id = randomBytes(32).toString('hex');
        await sproc.callSproc(SP.session, '作成', [
          p('セッションID', id),
          p('ログインID', loginId),
          p('有効期限', new Date(Date.now() + TTL_MS)),
        ]);
        return id;
      },

      /** 有効(未期限切れ・未失効)なセッションに紐づくユーザー、無ければ null。 */
      async getSessionUser(sessionId: string): Promise<User | null> {
        const row = firstRow(
          await sproc.callSproc(SP.session, '取得', [p('セッションID', sessionId)]),
        );
        return row ? rowToUser(row) : null;
      },

      async destroySession(sessionId: string): Promise<void> {
        await sproc.callSproc(SP.session, '失効', [p('セッションID', sessionId)]);
      },

      /**
       * 生存中の全セッションを失効させる。サーバ起動フックで呼び、再起動をまたいだ旧
       * セッション(DB は再起動耐性なので残る)を無効化して全員に再ログインを強制する。
       */
      async invalidateAllSessions(): Promise<void> {
        await sproc.callSproc(SP.session, '全失効', []);
      },

      /**
       * 期限切れ・失効済みのセッション行を物理削除する。`失効` / `全失効` は論理フラグを
       * 立てるだけなので、放置すると行はログインのたびに単調増加する。起動時と定期実行で回す。
       * 削除の境界は「有効期限が保持日数ぶん過去」— `有効期限 < now` にすると、期限内の
       * 行まで巻き込む書き方に一歩で退行しうる(全員が突然ログアウトする可用性事故)。
       */
      async purgeExpiredSessions(retentionDays = 7): Promise<void> {
        await sproc.callSproc(SP.session, '掃除', [p('保持日数', retentionDays)]);
      },
    };
  }

  /** 注入を受けていない呼び出し元(`repositories/authRepo.ts`)のための既定ストア。 */
  const defaultStore = createSessionStore(realSproc);
  export const createSession = defaultStore.createSession;
  export const destroySession = defaultStore.destroySession;
  ```

  旧 30-56 行目(`createSession` / `getSessionUser` / `destroySession` /
  `invalidateAllSessions`)と 86-94 行目(`purgeExpiredSessions`)は削除する。

- [ ] `editor/server/src/middleware/auth.ts` の 15 行目と 26-30 行目を差し替える。

  ```ts
  import { sessionIdFrom } from '../auth/session.js';
  ```

  ```ts
  /**
   * ログイン中ユーザをセッション cookie から解決する(未ログイン/失効時は null)。
   * ストアはインスタンスに載っている(`app.ts` の `decorate`)。ここでモジュールを直接
   * 掴まないのは、注入したフェイクが素通りしてしまうため。
   */
  export async function loadUser(req: FastifyRequest): Promise<User | null> {
    const sid = sessionIdFrom(req.headers.cookie);
    if (!sid) return null;
    return req.server.sessionStore.getSessionUser(sid);
  }
  ```

- [ ] `editor/server/src/app.ts` に import を足し(32 行目 `logger` の直後あたり)、
  85-88 行目の `buildApp` 冒頭を差し替える。

  ```ts
  import { createSessionStore } from './auth/session.js';
  import { realSproc, type SprocClient } from './db/sproc.js';
  ```

  ```ts
  export interface BuildAppOptions {
    /** DB 実行面。既定は本番のプール接続で、テストと rest e2e は in-memory フェイクを渡す。 */
    sproc?: SprocClient;
  }

  /**
   * プラグイン・ルート・入口フックを配線した Fastify インスタンスを返す。ready 化も listen も
   * しないので、呼び出し側が `listen()`(本番)か `inject()`(テスト)でブートする。
   */
  export function buildApp({ sproc = realSproc }: BuildAppOptions = {}) {
    const app = Fastify(buildServerOptions());
    // `requireAuth` が解決して埋めるユーザ。型は `middleware/auth.ts` の module augmentation を参照。
    app.decorateRequest('user', undefined);
    // セッションストアはインスタンスへ載せる。ガード関数は参照同一性を保つ必要があるため
    // (`routes/routeGuards.ts` の `levelOf`)、注入はガードの引数でなくここで行う。
    app.decorate('sessionStore', createSessionStore(sproc));
  ```

- [ ] `editor/server/src/index.ts` の 15 行目を削り、60-82 行目の
  `invalidateSessionsOnBoot` を `app` 引数受け取りへ、95 行目を呼び出し形へ変える。

  ```ts
  // 15 行目の `import { invalidateAllSessions, purgeExpiredSessions } from './auth/session.js';`
  // は削除する。
  ```

  ```ts
  // 起動時に全セッションを失効させ、再起動をまたいだ旧セッションでの再ログイン不要化を断つ。
  // 認証なし(local)では DB 未接続なので呼ばない。失敗してもプロセスは継続するが、失効漏れ
  // は「再起動後もログイン状態が残る」形へ戻る退行なので error で目立たせる。
  async function invalidateSessionsOnBoot(app: ReturnType<typeof buildApp>): Promise<void> {
    if (!config.requireAuth) return;
    try {
      await app.sessionStore.invalidateAllSessions();
      logger.info('[server] 全セッションを失効しました(起動時) — 再ログインを強制します');
    } catch (e) {
      logger.error(
        { err: e },
        '[server] 起動時の全セッション失効に失敗 — 旧セッションが残存する恐れ',
      );
    }
    // 失効は論理フラグなので行は消えない。起動時と 6 時間ごとに保持期間切れを物理削除する。
    // `unref` でこのタイマーがプロセスを生かし続けないようにする。
    const purge = async (): Promise<void> => {
      try {
        await app.sessionStore.purgeExpiredSessions();
      } catch (e) {
        logger.warn({ err: e }, '[server] 期限切れセッションの掃除に失敗しました');
      }
    };
    await purge();
    setInterval(() => void purge(), 6 * 3_600_000).unref();
  }
  ```

  95 行目: `await invalidateSessionsOnBoot();` → `await invalidateSessionsOnBoot(app);`

- [ ] `editor/server/test/helpers/sessionStub.ts` を新規作成する。

  ```ts
  // =============================================================================
  // sessionStub.ts — テストが載せるセッションストア
  // =============================================================================
  // 本番は `buildApp` が `app.decorate('sessionStore', …)` で載せ、`loadUser` は
  // `request.server.sessionStore` から読む。テストは自前の Fastify を組むので、同じ名前で
  // 最小のストアを載せる。手製 request でガードを直接呼ぶ場合は `withSessionStore` で
  // `request.server` を作る。
  import type { User } from '@editor/shared';
  import type { FastifyInstance } from 'fastify';
  import type { SessionStore } from '../../src/auth/session.js';

  export interface SessionStubOptions {
    /** セッション id → ユーザー。null / 未指定は未ログイン扱い。 */
    getSessionUser?: (sessionId: string) => Promise<User | null> | User | null;
  }

  export function createSessionStub(opts: SessionStubOptions = {}): SessionStore {
    return {
      createSession: async () => 'sid',
      destroySession: async () => {},
      invalidateAllSessions: async () => {},
      purgeExpiredSessions: async () => {},
      getSessionUser: async (sessionId) => (await opts.getSessionUser?.(sessionId)) ?? null,
    };
  }

  /** 本番と同じ名前でインスタンスへ載せる。 */
  export function decorateSessionStore(app: FastifyInstance, store: SessionStore): void {
    app.decorate('sessionStore', store);
  }

  /** 手製 request にストアを載せる(`request.server.sessionStore` の最小形)。 */
  export function withSessionStore<T extends object>(request: T, store: SessionStore): T {
    return Object.assign(request, { server: { sessionStore: store } });
  }
  ```

- [ ] `editor/server/test/session.test.ts` の 16-20 行目のモックを削り、ストアの単体検証を
  足す。23-27 行目の `beforeAll` は `createSessionStore` も取り込む形にする。

  ```ts
  import type { SprocClient } from '../src/db/sproc.js';

  const callSproc = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
  const sproc: SprocClient = { callSproc: (...args) => callSproc(...(args as [])) };

  const SID = 'a'.repeat(64);
  let sessionIdFrom: (header: string | undefined) => string | undefined;
  let createSessionStore: typeof import('../src/auth/session.js').createSessionStore;

  beforeAll(async () => {
    ({ sessionIdFrom, createSessionStore } = await import('../src/auth/session.js'));
  });
  ```

  末尾に describe を 1 本足す。

  ```ts
  // ストアは注入された実行面しか触らない(実 DB へ降りない)。`取得` は「有効なら 1 行、
  // でなければ 0 行」という sproc の契約をそのまま写す形なので、Node 側は行の有無だけを見る。
  describe('createSessionStore', () => {
    it('creates a 64 hex session id and passes it with the login id', async () => {
      callSproc.mockReset();
      callSproc.mockResolvedValue([]);
      const id = await createSessionStore(sproc).createSession('admin');
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      const [proc, 操作, params] = callSproc.mock.calls[0] as [string, string, { name: string }[]];
      expect(proc).toContain('セッション');
      expect(操作).toBe('作成');
      expect(params.map((x) => x.name)).toEqual(['セッションID', 'ログインID', '有効期限']);
    });

    it('returns null when the sproc yields no row (revoked or expired)', async () => {
      callSproc.mockReset();
      callSproc.mockResolvedValue([]);
      await expect(createSessionStore(sproc).getSessionUser(SID)).resolves.toBeNull();
    });

    it('passes the retention window to the purge operation', async () => {
      callSproc.mockReset();
      callSproc.mockResolvedValue([]);
      await createSessionStore(sproc).purgeExpiredSessions(3);
      expect(callSproc.mock.calls[0]?.[2]).toContainEqual({ name: '保持日数', value: 3 });
    });
  });
  ```

- [ ] `editor/server/test/auth.failureFloor.test.ts`: 32-38 行目の
  `vi.mock('../src/auth/session.js', …)` を丸ごと削除し、52 行目 `app = Fastify();` の直後へ
  1 行足す。import も 1 行足す。

  ```ts
  import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';
  ```

  ```ts
      app = Fastify();
      // `authRoutes` の init-password 経路は `requireAuth` → `loadUser` を通り、
      // `request.server.sessionStore` を読む。本番と同じ形にするため載せておく。
      decorateSessionStore(app, createSessionStub());
      app.setErrorHandler(errorHandler);
  ```

- [ ] `editor/server/test/auth.loginIdAlphabet.test.ts`: 39-45 行目のモックを削除し、
  72 行目 `app = Fastify();` の直後へ同じ 2 行(コメント + `decorateSessionStore`)を足す。
  import も同様。

- [ ] `editor/server/test/auth.loginRateLimit.test.ts`: 36-42 行目のモックを削除し、
  63 行目 `app = Fastify();` の直後へ同じ 2 行を足す。import も同様。

- [ ] `editor/server/test/auth.initPassword.test.ts`: 29-47 行目のモックを、`sessionIdFrom`
  だけを上書きする部分モックへ縮める。ユーザー解決はストア側へ移す。

  ```ts
  // cookie `editor.sid=<username>` を「その名前のユーザ」とみなす最小の偽装。実装の
  // `sessionIdFrom` は 64 桁 hex しか受けないので、id の取り出しだけを差し替える。
  vi.mock('../src/auth/session.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/auth/session.js')>()),
    sessionIdFrom: (cookie?: string) => cookie?.match(/editor\.sid=([^;]+)/)?.[1],
  }));
  ```

  63-65 行目(`app = Fastify(); app.decorateRequest(...); app.setErrorHandler(...)`)の間へ
  ストアを載せる。

  ```ts
      app = Fastify();
      app.decorateRequest('user', undefined);
      decorateSessionStore(
        app,
        createSessionStub({
          getSessionUser: (sid) => ({
            id: sid,
            username: sid,
            displayName: sid,
            role: 'editor',
            disabled: false,
            // `must:` 前置きのセッションは「初期パスワードのまま」= `requireAuth` が他経路を
            // 止める状態。パスワード変更だけは通らないと復旧不能になるのでここで確かめる。
            mustChangePassword: sid.startsWith('must:'),
          }),
        }),
      );
      app.setErrorHandler(errorHandler);
  ```

- [ ] `editor/server/test/auth.localMode.test.ts`: 47-53 行目のモックを削除(cookie を
  送らないテストなので実装の `sessionIdFrom` で足りる)し、70-72 行目へストアを足す。

  ```ts
      app = Fastify();
      app.decorateRequest('user', undefined);
      decorateSessionStore(app, createSessionStub());
      app.setErrorHandler(errorHandler);
  ```

- [ ] `editor/server/test/mustChangePassword.test.ts`: 16-30 行目のモックを部分モックへ
  縮め、33-38 行目の `reqFor` に `server` を持たせる。

  ```ts
  import { createSessionStub, withSessionStore } from './helpers/sessionStub.js';

  /** cookie の値をそのままセッション id として扱う(実装は 64 桁 hex しか受けない)。 */
  vi.mock('../src/auth/session.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/auth/session.js')>()),
    sessionIdFrom: (cookie?: string) => cookie,
  }));

  const store = createSessionStub({
    getSessionUser: (sid) => ({
      id: sid,
      username: sid,
      displayName: sid,
      role: 'admin',
      disabled: false,
      // cookie に `must:` を付けたセッションだけ「初期パスワードのまま」とみなす。
      mustChangePassword: sid.startsWith('must:'),
    }),
  });

  /** `routeOptions.url` は登録時のパターン。ルートは `/api` prefix 付きで登録される。 */
  const reqFor = (sid: string, routeUrl: string): FastifyRequest =>
    withSessionStore(
      {
        headers: { cookie: sid },
        routeOptions: { url: routeUrl },
        url: routeUrl,
      },
      store,
    ) as unknown as FastifyRequest;
  ```

  79-82 行目の手製 request(`routeOptions` 不在のケース)も `withSessionStore` で包む。

  ```ts
    it('falls back to the raw path when routeOptions is absent (query stripped)', async () => {
      const request = withSessionStore(
        { headers: { cookie: 'must:admin' }, url: '/api/auth/me?x=1' },
        store,
      ) as unknown as FastifyRequest;
      await expect(requireAuth(request, reply)).resolves.toBeUndefined();
    });
  ```

- [ ] `editor/server/test/routeGuards.test.ts`: 25-43 行目のモックを部分モックへ縮め、
  72-74 行目でストアを載せる。

  ```ts
  // セッションは cookie `editor.sid=<role>` を「そのロールのユーザ」とみなす最小の偽装。
  // 実 DB へは降りないので、ここで観測できるのは preHandler の判定だけになる。
  vi.mock('../src/auth/session.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/auth/session.js')>()),
    sessionIdFrom: (cookie?: string) => cookie?.match(/editor\.sid=([^;]+)/)?.[1],
  }));
  ```

  ```ts
    app = Fastify();
    app.decorateRequest('user', undefined);
    decorateSessionStore(
      app,
      createSessionStub({
        getSessionUser: (sid) => ({
          id: sid,
          username: sid,
          displayName: sid,
          role: sid as UserRole,
          disabled: false,
          mustChangePassword: false,
        }),
      }),
    );
    app.setErrorHandler(errorHandler);
  ```

  47-56 行目の `vi.mock('../src/db/sproc.js', …)` は D3 で扱うので**このタスクでは残す**。

- [ ] `editor/server/test/generate.routes.test.ts`: 33-46 行目のモックから `getSessionUser`
  を外し(`sessionIdFrom` のみ残す)、73-74 行目でストアを載せる。

  ```ts
  // `AUTH_REQUIRED=true` の経路を実際に通したいので、セッション解決だけを差し替える
  // (ロール検査ではなく「認証済み利用者が確定領域へ書けないこと」が本テストの関心)。
  vi.mock('../src/auth/session.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/auth/session.js')>()),
    sessionIdFrom: () => 'test-session',
  }));
  ```

  ```ts
      app = Fastify();
      decorateSessionStore(
        app,
        createSessionStub({
          getSessionUser: () => ({
            id: 'editor',
            username: 'editor',
            displayName: 'editor',
            role: 'editor',
            disabled: false,
            mustChangePassword: false,
          }),
        }),
      );
      app.setErrorHandler(errorHandler);
  ```

- [ ] server プロジェクト全件を通す。

  ```
  pnpm exec vitest run --project server
  ```

  期待: 全ファイル緑。とくに `mustChangePassword`(3 経路の例外)・`routeGuards`
  (ロール別の実挙動)・`auth.initPassword` が緑であること。

- [ ] 型検査。

  ```
  pnpm run typecheck:editor
  ```

  期待: exit 0。

- [ ] コミットする。

  ```
  pnpm exec biome check --write editor/server/src editor/server/test
  git add editor/server/src editor/server/test
  git commit -m "$(cat <<'EOF'
  refactor(editor): セッションストアをファクトリ化して Fastify インスタンスへ載せる

  `auth/session.ts` のライフサイクル 5 関数を `createSessionStore(sproc)` に畳み、
  `buildApp` が `app.decorate('sessionStore', …)` で載せる。`middleware/auth.ts` の
  `loadUser` は `request.server.sessionStore` から読む。ガード関数
  (`requireAuth` 系)はクロージャ化せず参照同一性を保つため、`routes/routeGuards.ts` の
  `levelOf` と `ROUTE_POLICY` の起動時検査はそのまま効く。`cookieOptions` と
  `sessionIdFrom` は純粋ヘルパなのでモジュール直下の export に残す。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task D3: リポジトリをファクトリ化し、ルートへ `deps` で配る

**Files:**
- `editor/server/src/repositories/partRepo.ts`(26-59 行目)
- `editor/server/src/repositories/userRepo.ts`(17-18・32-87 行目。`rowToUser` 21-30 行目は据置)
- `editor/server/src/repositories/templateRepo.ts`(21-29 の import・74-250 行目。
  `applyConfirmedSave` 191-206 行目はモジュール直下の export のまま)
- `editor/server/src/repositories/authRepo.ts`(29-34 の import・42-107 行目)
- `editor/server/src/sync/noteMasterService.ts`(16-20 の import・30-103 行目)
- `editor/server/src/sync/pairSyncService.ts`(20-26 の import・33-130 行目)
- `editor/server/src/repositories/reviewRepo.ts`(26-39 の import・84-263 行目。
  `withReviewLock`(47-60 行目)はモジュール直下のまま)
- `editor/server/src/deps.ts`(新規)
- `editor/server/src/routes/auth.routes.ts`(25・32・34-168 行目)
- `editor/server/src/routes/generate.routes.ts`(32-34・40-119 行目)
- `editor/server/src/routes/parts.routes.ts`(10-11・28-58 行目)
- `editor/server/src/routes/reviews.routes.ts`(19-101 行目)
- `editor/server/src/routes/templates.routes.ts`(14-15・32-94 行目)
- `editor/server/src/routes/users.routes.ts`(13-68 行目)
- `editor/server/src/app.ts`(85-100・175-184 行目)
- `editor/server/test/helpers/offlineSproc.ts`(新規)
- `editor/server/test/authRepo.test.ts`(13-39・62-63・122・134・156・168 行目)
- `editor/server/test/generate.routes.test.ts`(17-27・71-81 行目)
- `editor/server/test/noteMasterService.test.ts`(8-30 行目)
- `editor/server/test/reviews.test.ts`(15-23・50-52 行目)
- `editor/server/test/reviews.routes.test.ts`(18-26・49-65 行目)
- `editor/server/test/reviews.metaFailure.test.ts`(25-33・69-71 行目)
- `editor/server/test/routeGuards.test.ts`(47-56・82-105 行目)

**Interfaces:**

Consumes:
- `SprocClient` / `realSproc`(D1)、`SessionStore` / `createSessionStore`(D2)
- 既存のファイル層(`files/*.ts`)・`git/gitRepo.ts`・`security/templateScripts.ts` はすべて無変更

Produces:
- `partRepo.ts`: `export interface PartRepo { getPartClassificationOptions(q: PartClassificationQuery): Promise<PartClassificationOptions>; listParts(q: PartClassificationQuery): Promise<PartCatalogItem[]>; }` / `export function createPartRepo(sproc: SprocClient): PartRepo`
- `userRepo.ts`: `export interface UserRepo { listUsers(): Promise<User[]>; createUser(input: Omit<User, 'id'>): Promise<CreatedUser>; updateUser(id: string, patch: Partial<Omit<User, 'id'>>): Promise<User>; resetUserPassword(id: string): Promise<PasswordResetResult>; }` / `export function createUserRepo(sproc: SprocClient): UserRepo`
- `templateRepo.ts`: `export interface TemplateRepo { getDropdownOptions(q: DropdownQuery): Promise<DropdownOptions>; listTemplates(q: DropdownQuery): Promise<TemplateMeta[]>; listSeriesFunds(companyCode: string, editionType: string): Promise<TemplateMeta[]>; getTemplate(id: string): Promise<Template>; saveDraft(templateId: string, html: string, css: string, loginId: string): Promise<void>; getDraft(templateId: string): Promise<TemplateDraft | null>; discardDraft(templateId: string): Promise<void>; getSampleData(fundCode: string): Promise<SampleData>; registerGenerated(attributes: TemplateAttributes, id: string): Promise<void>; }` / `export function createTemplateRepo(sproc: SprocClient): TemplateRepo`
- `authRepo.ts`: `export interface AuthRepo { login(loginId: string, password: string): Promise<{ result: LoginResult; sessionId: string }>; logout(sessionId: string | undefined): Promise<void>; initPassword(loginId: string, req: Pick<PasswordInitRequest, 'currentPassword' | 'newPassword'>, exceptSessionId?: string): Promise<void>; }` / `export function createAuthRepo(deps: { sproc: SprocClient; sessionStore: SessionStore }): AuthRepo`
- `noteMasterService.ts`: `export interface NoteMasterService { reflectNoteMasterAfterConfirm(templateId: string, actor: string): Promise<NoteMasterReflectSummary | null>; applyNoteMasterToHtml(html: string, fundCode: string, editionType: string): Promise<string>; }` / `export function createNoteMasterService(deps: { sproc: SprocClient; parts: PartRepo }): NoteMasterService`
- `pairSyncService.ts`: `export interface PairSyncService { getPairSyncStatus(templateId: string): Promise<PairSyncStatus>; syncPairAfterConfirm(sourceTemplateId: string, actor: string): Promise<PairSyncSummary | null>; }` / `export function createPairSyncService(parts: PartRepo): PairSyncService`
- `reviewRepo.ts`: `export interface ReviewRepo { submitReview(req: SubmitReviewRequest, actor: ReviewActor): Promise<ReviewRequestMeta>; listReviews(filter: { status?: ReviewStatus }, actor: ReviewActor): Promise<ReviewRequestMeta[]>; getReview(reqId: string, actor: ReviewActor): Promise<ReviewRequest>; approveReview(reqId: string, decision: ReviewDecisionRequest, actor: ReviewActor): Promise<ApproveReviewResult>; rejectReview(reqId: string, decision: ReviewDecisionRequest, actor: ReviewActor): Promise<ReviewRequestMeta>; }` / `export function createReviewRepo(deps: { noteMaster: NoteMasterService; pairSync: PairSyncService }): ReviewRepo`
- `deps.ts`: `export interface Deps { auth: AuthRepo; users: UserRepo; templates: TemplateRepo; parts: PartRepo; reviews: ReviewRepo; pairSync: PairSyncService; noteMaster: NoteMasterService }` / `export function createDeps(sproc: SprocClient, sessionStore: SessionStore): Deps`
- 各ルート: `FastifyPluginAsync<{ deps: Pick<Deps, …> }>`

**Steps:**

- [ ] `editor/server/src/repositories/partRepo.ts` の 14-15 行目の import と 26-59 行目を
  ファクトリへ畳む。`classParams`(17-24 行目)は module private のまま。

  ```ts
  import { asIso, asString, asStringOrNull, type Param, p, type SprocClient } from '../db/sproc.js';
  import { SP } from '../db/sprocNames.js';
  ```

  ```ts
  export interface PartRepo {
    getPartClassificationOptions(q: PartClassificationQuery): Promise<PartClassificationOptions>;
    listParts(q: PartClassificationQuery): Promise<PartCatalogItem[]>;
  }

  export function createPartRepo(sproc: SprocClient): PartRepo {
    return {
      async getPartClassificationOptions(q) {
        const rows = await sproc.callSproc(SP.part, '分類候補', classParams(q));
        const pick = (kbn: string) =>
          rows.filter((r) => asString(r.区分) === kbn).map((r) => asString(r.値));
        return {
          categories: pick('カテゴリ'),
          majorClasses: pick('大分類'),
          middleClasses: pick('中分類'),
          minorClasses: pick('小分類'),
        };
      },

      async listParts(q) {
        const rows = await sproc.callSproc(SP.part, '一覧', classParams(q));
        return rows.map((r) => ({
          id: asString(r.パーツID),
          classification: {
            category: asString(r.カテゴリ),
            majorClass: asString(r.大分類),
            middleClass: asString(r.中分類),
            minorClass: asString(r.小分類),
          },
          name: asString(r.名称),
          description: asString(r.説明),
          usageNotes: asString(r.使用上の注意),
          updatedAt: asIso(r.更新日時),
          updatedBy: asStringOrNull(r.更新者),
          content: asString(r.内容HTML),
          // 値域は DDL の CHECK([CK_パーツ_同期既定] 等)が保証するため cast で写す。NULL = 未判断。
          syncDefault: asStringOrNull(r.同期既定) as PartSyncDefault | null,
          masterReflectDefault: asStringOrNull(r.次回反映既定) as PartMasterReflectDefault | null,
        }));
      },
    };
  }
  ```

- [ ] `editor/server/src/repositories/userRepo.ts` の 18 行目の import を
  `import { asBool, asString, firstRow, p, type SprocClient } from '../db/sproc.js';` に変え、
  32-87 行目をファクトリへ畳む。`rowToUser`(21-30 行目)は据え置き。

  ```ts
  export interface UserRepo {
    listUsers(): Promise<User[]>;
    createUser(input: Omit<User, 'id'>): Promise<CreatedUser>;
    updateUser(id: string, patch: Partial<Omit<User, 'id'>>): Promise<User>;
    resetUserPassword(id: string): Promise<PasswordResetResult>;
  }

  export function createUserRepo(sproc: SprocClient): UserRepo {
    const listUsers = async (): Promise<User[]> => {
      const rows = await sproc.callSproc(SP.user, '一覧');
      return rows.map(rowToUser);
    };

    return {
      listUsers,

      async createUser(input) {
        const id = randomUUID();
        // 初期パスワードは払い出しごとに新しいランダム値。初回ログインで変更を強制する。
        const temporaryPassword = generateTemporaryPassword();
        const { hash, salt, iterations } = await hashPassword(temporaryPassword);
        const row = firstRow(
          await sproc.callSproc(SP.user, '作成', [
            p('公開ID', id),
            p('ログインID', input.username),
            p('表示名', input.displayName),
            p('ロール', input.role),
            p('無効', input.disabled ? 1 : 0),
            p('要パスワード変更', input.mustChangePassword ? 1 : 0),
            p('PWハッシュ', hash),
            p('PWソルト', salt),
            p('PW反復回数', iterations),
          ]),
        );
        if (!row) throw notFound('作成したユーザーを取得できません');
        return { user: rowToUser(row), temporaryPassword };
      },

      async updateUser(id, patch) {
        const bit = (b: boolean | undefined) => (b == null ? null : b ? 1 : 0);
        const row = firstRow(
          await sproc.callSproc(SP.user, '更新', [
            p('公開ID', id),
            p('表示名', patch.displayName),
            p('ロール', patch.role),
            p('無効', bit(patch.disabled)),
            p('要パスワード変更', bit(patch.mustChangePassword)),
          ]),
        );
        if (!row) throw notFound(`ユーザーが見つかりません: ${id}`);
        return rowToUser(row);
      },

      async resetUserPassword(id) {
        // 存在しない公開ID への無言 no-op を避けるため、先に一覧で実在を確かめる。
        const user = (await listUsers()).find((u) => u.id === id);
        if (!user) throw notFound(`ユーザーが見つかりません: ${id}`);
        const temporaryPassword = generateTemporaryPassword();
        const { hash, salt, iterations } = await hashPassword(temporaryPassword);
        await sproc.callSproc(SP.user, 'PWリセット', [
          p('公開ID', id),
          p('PWハッシュ', hash),
          p('PWソルト', salt),
          p('PW反復回数', iterations),
        ]);
        return { temporaryPassword };
      },
    };
  }
  ```

- [ ] `editor/server/src/repositories/templateRepo.ts` の 21-29 行目の import を
  `SprocClient` 付きへ変え、74-190 行目と 208-250 行目を `createTemplateRepo` の中へ移す。
  `rowToMeta`(48-62)・`queryParams`(64-72)・`metaMatches`(86-94)・`parseFundMaster`
  (208-227)は module private のまま。`applyConfirmedSave`(191-206)は**モジュール直下の
  export のまま残す**(sproc 非依存で、`createReviewRepo` の引数を増やさない)。

  ```ts
  import {
    asIso,
    asString,
    asStringOrNull,
    firstRow,
    type Param,
    p,
    type SprocClient,
  } from '../db/sproc.js';
  ```

  ```ts
  export interface TemplateRepo {
    getDropdownOptions(q: DropdownQuery): Promise<DropdownOptions>;
    listTemplates(q: DropdownQuery): Promise<TemplateMeta[]>;
    listSeriesFunds(companyCode: string, editionType: string): Promise<TemplateMeta[]>;
    getTemplate(id: string): Promise<Template>;
    saveDraft(templateId: string, html: string, css: string, loginId: string): Promise<void>;
    getDraft(templateId: string): Promise<TemplateDraft | null>;
    discardDraft(templateId: string): Promise<void>;
    getSampleData(fundCode: string): Promise<SampleData>;
    registerGenerated(attributes: TemplateAttributes, id: string): Promise<void>;
  }

  export function createTemplateRepo(sproc: SprocClient): TemplateRepo {
    return {
      async getDropdownOptions(q) {
        const rows = await sproc.callSproc(SP.template, '候補', queryParams(q));
        const pick = (kbn: string) =>
          rows.filter((r) => asString(r.区分) === kbn).map((r) => asString(r.値));
        return {
          companyCodes: pick('会社'),
          fundCodes: pick('ファンド'),
          baseDates: pick('基準日'),
          editionTypes: pick('版種'),
        };
      },

      // 既存テンプレの一覧は台帳でなく `data/templates`(確定)と `data/pending`(生成直後の
      // 未確定実体)のファイル走査から導く。**pending も混ぜ、`status` で区別する。**
      //
      // 混ぜない設計は不成立: 作成タブは生成後に `/edit/:id` へ 1 回遷移するだけで、履歴タブは
      // 遷移経路を持たない。一覧から外すと、生成直後にブラウザを閉じた時点でその id へ到達する
      // 手段が UI から消え、同一属性の再生成も台帳の `UQ_台帳_属性4` に当たって復旧できない。
      //
      // 未承認の内容を扱ってはいけない画面(比較タブ・結合 PDF)は**呼び出し側**で
      // `status === 'published'` に絞る。一覧側で落とすと上記の到達不能が再発する。
      async listTemplates(q) {
        const files = await listTemplateFiles();
        const confirmed = (await Promise.all(files.map(fileToMeta))).filter(
          (m): m is TemplateMeta => m !== null,
        );
        const confirmedIds = new Set(confirmed.map((m) => m.id));
        // 承認で確定へ昇格した後も pending が消し残る場合がある(削除はベストエフォート)。
        // 同一 id が両方に在るときは確定を採る — 一覧が二重に出るのを防ぐ。
        const pendingIds = (await listPendingIds()).filter((id) => !confirmedIds.has(id));
        const pending = (
          await Promise.all(
            pendingIds.map(async (id): Promise<TemplateMeta | null> => {
              const meta = await fileToMeta(`${id}.html`);
              return meta && { ...meta, status: 'draft', updatedAt: await pendingMtime(id) };
            }),
          )
        ).filter((m): m is TemplateMeta => m !== null);
        return [...confirmed, ...pending]
          .filter((m) => metaMatches(m, q))
          .sort((a, b) => a.fileName.localeCompare(b.fileName));
      },

      async listSeriesFunds(companyCode, editionType) {
        const rows = await sproc.callSproc(SP.template, '系列', [
          p('委託会社コード', companyCode),
          p('版種', editionType),
        ]);
        return rows.map(rowToMeta);
      },

      // 1 件取得。メタはファイル名規約、本体はファイル(台帳は引かない)。
      //
      // **確定を先に見る順序が契約**である。① 確定ファイルが在れば `status:'published'`、
      // ② 無く pending(生成直後の未確定実体)が在れば `status:'draft'`、③ どちらも無ければ 404。
      // 逆順にすると pending を書ける者が承認済みテンプレの表示内容を差し替えられ、編集画面・
      // 結合 PDF・比較タブが揃って汚染される。
      async getTemplate(id) {
        const fileName = `${id}.html`;
        const meta = await fileToMeta(fileName);
        if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
        if (await templateExists(fileName)) {
          const html = await readTemplateHtml(fileName);
          const css = await readFundCss(meta.attributes.fundCode);
          // 記入済みの静的コピーはサーバ側に保持しない。エディタが読み込み時に再差込する。
          return { meta, html, css, filled: '' };
        }
        const pending = await readPending(id);
        if (!pending) throw notFound(`テンプレートが見つかりません: ${id}`);
        return {
          meta: { ...meta, status: 'draft', updatedAt: await pendingMtime(id) },
          html: pending.html,
          css: pending.css,
          filled: '',
        };
      },

      /** 自動保存ドラフトはファイルのみ(`data/drafts`、git 管理外)。台帳は引かない。 */
      async saveDraft(templateId, html, css, _loginId) {
        await writeDraft(templateId, html, css);
      },

      async getDraft(templateId) {
        if (!(await draftExists(templateId))) return null;
        const { html, css } = await readDraft(`${templateId}.html`, `${templateId}.css`);
        // 保存者はファイルからは判らない(下書きは作業コピー)。保存日時は mtime で代用。
        return { templateId, html, css, savedAt: (await draftMtime(templateId)) ?? '', savedBy: '' };
      },

      /** 確定保存せずメニューへ戻った際に、未確定の下書き作業コピーを破棄する。 */
      async discardDraft(templateId) {
        await deleteDraft(templateId);
      },

      // プレビュー文脈のサンプルデータ。本体はパーツ別共通ダミー(`sampleCommon`)で、
      // DB の台帳からはファンド固有の名称/会社だけを解決して被せる。版種(ファイル名由来)は
      // テンプレを開く web 側(`applyTemplateAttributes`)で上書きする。
      async getSampleData(fundCode) {
        const row = firstRow(
          await sproc.callSproc(SP.sample, '取得', [p('ファンドコード', fundCode)]),
        );
        const master = parseFundMaster(row ? asStringOrNull(row.データJSON) : null);
        return buildSampleData(master, fundCode);
      },

      /** 新規生成したテンプレートを `台帳` に登録する(status=draft)。 */
      async registerGenerated(attributes, id) {
        await sproc.callSproc(SP.template, '生成登録', [
          p('テンプレートID', id),
          p('委託会社コード', attributes.companyCode),
          p('ファンドコード', attributes.fundCode),
          p('基準日', attributes.baseDate),
          p('版種', attributes.editionType),
          p('ファイル名', templateFileName(attributes)),
        ]);
      },
    };
  }
  ```

- [ ] `editor/server/src/repositories/authRepo.ts` の 29-34 行目の import と 42-107 行目を
  ファクトリへ畳む。ファイル冒頭 1-20 行目のヘッダコメントは維持する。

  ```ts
  import { hashPassword, verifyPassword } from '../auth/password.js';
  import type { SessionStore } from '../auth/session.js';
  import { asBool, asBuffer, asNumberOrNull, firstRow, p, type SprocClient } from '../db/sproc.js';
  import { SP } from '../db/sprocNames.js';
  import { audit } from '../logger.js';
  import { rowToUser } from './userRepo.js';

  export interface AuthRepo {
    login(loginId: string, password: string): Promise<{ result: LoginResult; sessionId: string }>;
    logout(sessionId: string | undefined): Promise<void>;
    initPassword(
      loginId: string,
      req: Pick<PasswordInitRequest, 'currentPassword' | 'newPassword'>,
      exceptSessionId?: string,
    ): Promise<void>;
  }

  export function createAuthRepo({
    sproc,
    sessionStore,
  }: {
    sproc: SprocClient;
    sessionStore: SessionStore;
  }): AuthRepo {
    return {
      // 資格情報を検証しセッションを開く。結果と新しい session id を返す。
      //
      // `loginId` は `canonicalLoginId` の戻り値を受け取る(`LoginRequest` を丸ごと受けると
      // 「正規化前の値を DB へ渡す」経路が型の上で作れてしまう)。
      async login(loginId, password) {
        const row = firstRow(
          await sproc.callSproc(SP.user, '認証情報取得', [p('ログインID', loginId)]),
        );
        const disabled = row ? asBool(row.無効) : false;
        const ok = row
          ? await verifyPassword(
              password,
              asBuffer(row.PWハッシュ),
              asBuffer(row.PWソルト),
              asNumberOrNull(row.PW反復回数),
            )
          : false;
        if (!row || !ok || disabled) {
          // 無効アカウントへの試行は応答からは判別できないが、運用が追えるよう証跡は残す。
          if (row && ok && disabled)
            audit({
              event: 'auth.login',
              outcome: 'failure',
              actor: loginId,
              error: 'account_disabled',
            });
          throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
        }

        const user = rowToUser(row);
        const sessionId = await sessionStore.createSession(user.username);
        return { result: { user, mustChangePassword: user.mustChangePassword }, sessionId };
      },

      async logout(sessionId) {
        if (sessionId) await sessionStore.destroySession(sessionId);
      },

      // 自分自身のパスワードを変更する。宛先 `loginId` はルート側が**セッション所有者から**
      // 導出して渡す(body からは取らない)。ここでは現行パスワードによる所有証明を検証する。
      //
      // `PW初期化` は同一トランザクション内でそのユーザーの他セッションを失効させる
      // (`db/sproc/user.sql`)。Node 側で 2 回 sproc を呼ぶ形にすると、間で落ちたときに
      // 「パスワードは変わったが旧セッションは生きている」という最悪の中間状態が残る。
      async initPassword(loginId, req, exceptSessionId) {
        const row = firstRow(
          await sproc.callSproc(SP.user, '認証情報取得', [p('ログインID', loginId)]),
        );
        const disabled = row ? asBool(row.無効) : false;
        const owns = row
          ? await verifyPassword(
              req.currentPassword,
              asBuffer(row.PWハッシュ),
              asBuffer(row.PWソルト),
              asNumberOrNull(row.PW反復回数),
            )
          : false;
        if (!row || !owns || disabled) throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
        // 閾値は UI と同じ `PASSWORD_MIN_LENGTH`。空白のみ(実質空)も弾くため trim 後で測る。
        if (req.newPassword.trim().length < PASSWORD_MIN_LENGTH)
          throw validation('新しいパスワードが短すぎます');
        const { hash, salt, iterations } = await hashPassword(req.newPassword);
        await sproc.callSproc(SP.user, 'PW初期化', [
          p('ログインID', loginId),
          p('PWハッシュ', hash),
          p('PWソルト', salt),
          p('PW反復回数', iterations),
          p('除外セッションID', exceptSessionId ?? null),
        ]);
      },
    };
  }
  ```

- [ ] `editor/server/src/sync/noteMasterService.ts` の 16-20 行目の import と 30-103 行目を
  ファクトリへ畳む。**設計 7.1 との差**: この層は `listParts` に加えて
  `callSproc(SP.noteMaster, …)` を直接呼ぶので `sproc` も受け取る。

  ```ts
  import { asString, asStringOrNull, p, type SprocClient } from '../db/sproc.js';
  import { SP } from '../db/sprocNames.js';
  import { readTemplateHtml } from '../files/templateFiles.js';
  import { logger } from '../logger.js';
  import type { PartRepo } from '../repositories/partRepo.js';
  import { applyOps, extractSyncParts } from './partSync.js';

  export interface NoteMasterService {
    reflectNoteMasterAfterConfirm(
      templateId: string,
      actor: string,
    ): Promise<NoteMasterReflectSummary | null>;
    applyNoteMasterToHtml(html: string, fundCode: string, editionType: string): Promise<string>;
  }

  export function createNoteMasterService({
    sproc,
    parts,
  }: {
    sproc: SprocClient;
    parts: PartRepo;
  }): NoteMasterService {
    return {
      // 承認確定した `templateId` から `次回反映既定`=`反映` のパーツを抽出し、そのファンド・
      // 版種の注記マスタへ upsert する。テンプレ ID が解決できなければ null(UI は表示なし)。
      // 失敗は throw せず `error` 付き summary で返す(承認自体は成立済み)。
      // 書き戻しの契機は「承認」のみ: ペア同期で機械転写された側の版種は、その版種自身が
      // 承認されたときに書き戻す(承認を経ない内容をマスタへ昇格させない)。
      async reflectNoteMasterAfterConfirm(templateId, actor) {
        const attrs = parseTemplateFileName(`${templateId}.html`);
        if (!attrs) return null;

        try {
          const [html, catalog] = await Promise.all([
            readTemplateHtml(`${templateId}.html`),
            parts.listParts({}),
          ]);
          const reflectIds = new Set(
            catalog.filter((c) => c.masterReflectDefault === '反映').map((c) => c.id),
          );
          const updated: string[] = [];
          // 同一 partId が複数出現する場合は文書内の先頭出現(`#1`)を正とする(マスタは
          // 1 パーツ = 1 行のため。注記パーツは実務上 1 回しか現れない想定の安全側規約)。
          for (const part of extractSyncParts(html)) {
            if (!reflectIds.has(part.partId) || !part.key.endsWith('#1')) continue;
            await sproc.callSproc(SP.noteMaster, '反映', [
              p('パーツID', part.partId),
              p('ファンドコード', attrs.fundCode),
              p('版種', attrs.editionType),
              p('注記HTML', part.html),
              p('更新者', actor),
            ]);
            updated.push(part.partId);
          }
          return { updated, error: null };
        } catch (e) {
          logger.warn({ err: e }, '注記マスタへの書き戻しに失敗しました(承認自体は成立)');
          return { updated: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      // 生成直後のテンプレ HTML へ、そのファンド・版種の注記マスタ行を適用する。マスタに行が
      // ある `data-part-id` パーツの全出現を span 置換し(同一パーツが複数あればすべて最新化)、
      // 非対象パーツはバイト不変。マスタが空・DB 不達・置換失敗のときは warn だけ残して元の
      // HTML を返す(新規作成をブロックしない)。
      async applyNoteMasterToHtml(html, fundCode, editionType) {
        try {
          const rows = await sproc.callSproc(SP.noteMaster, '取得', [
            p('ファンドコード', fundCode),
            p('版種', editionType),
          ]);
          const masters = new Map<string, string>();
          for (const r of rows) {
            const noteHtml = asStringOrNull(r.注記HTML);
            if (noteHtml !== null) masters.set(asString(r.パーツID), noteHtml);
          }
          if (masters.size === 0) return html;

          const ops = extractSyncParts(html)
            .filter((part) => masters.has(part.partId))
            .map((part, i) => ({
              start: part.start,
              end: part.end,
              // filter 済みなので get は必ず成立するが、型上の undefined は現値で塞ぐ。
              text: masters.get(part.partId) ?? part.html,
              seq: i,
            }));
          return ops.length > 0 ? applyOps(html, ops) : html;
        } catch (e) {
          logger.warn({ err: e }, '注記マスタの生成時適用に失敗しました(未適用のまま生成を続行)');
          return html;
        }
      },
    };
  }
  ```

- [ ] `editor/server/src/sync/pairSyncService.ts` の 25 行目の import を
  `import type { PartRepo } from '../repositories/partRepo.js';` に変え、33-130 行目を
  `createPairSyncService(parts: PartRepo): PairSyncService` の中へ移す。本文の変更は
  67 行目 `listParts({})` → `parts.listParts({})` の 1 箇所のみ(他は無変更)。

  ```ts
  export interface PairSyncService {
    getPairSyncStatus(templateId: string): Promise<PairSyncStatus>;
    syncPairAfterConfirm(sourceTemplateId: string, actor: string): Promise<PairSyncSummary | null>;
  }

  export function createPairSyncService(parts: PartRepo): PairSyncService {
    return {
      async getPairSyncStatus(templateId) {
        /* 33-45 行目の本文をそのまま */
      },
      async syncPairAfterConfirm(sourceTemplateId, actor) {
        /* 51-130 行目の本文。`listParts({})` だけ `parts.listParts({})` へ */
      },
    };
  }
  ```

- [ ] `editor/server/src/repositories/reviewRepo.ts` の 36-37 行目の import を型 import へ変え、
  84-263 行目の 5 関数を `createReviewRepo` の中へ移す。`withReviewLock`(47-60 行目)・
  `currentBaseHash`(62-68)・`canSeeAll`(70-73)・`assertUndecided`(75-81)・
  `finalizeApprovedMeta`(213-244)は module private のまま(承認の直列化はプロセス単位で
  効かせる。インスタンスを分けても同じ確定領域を触るため、ロックはモジュール直下が正しい)。

  ```ts
  import type { NoteMasterService } from '../sync/noteMasterService.js';
  import type { PairSyncService } from '../sync/pairSyncService.js';
  ```

  ```ts
  export interface ReviewRepo {
    submitReview(req: SubmitReviewRequest, actor: ReviewActor): Promise<ReviewRequestMeta>;
    listReviews(
      filter: { status?: ReviewStatus },
      actor: ReviewActor,
    ): Promise<ReviewRequestMeta[]>;
    getReview(reqId: string, actor: ReviewActor): Promise<ReviewRequest>;
    approveReview(
      reqId: string,
      decision: ReviewDecisionRequest,
      actor: ReviewActor,
    ): Promise<ApproveReviewResult>;
    rejectReview(
      reqId: string,
      decision: ReviewDecisionRequest,
      actor: ReviewActor,
    ): Promise<ReviewRequestMeta>;
  }

  export function createReviewRepo({
    noteMaster,
    pairSync,
  }: {
    noteMaster: NoteMasterService;
    pairSync: PairSyncService;
  }): ReviewRepo {
    return {
      async submitReview(req, actor) {
        /* 88-134 行目の本文をそのまま */
      },
      async listReviews(filter, actor) {
        /* 142-146 行目の本文をそのまま */
      },
      async getReview(reqId, actor) {
        /* 155-159 行目の本文をそのまま */
      },
      async approveReview(reqId, decision, actor) {
        return withReviewLock(async () => {
          /* 172-201 行目の本文をそのまま */
          // 承認の完結後に交付版⇄全体版のパーツ自動同期を掛ける(ベストエフォート。失敗しても
          // 承認は成立済みで、結果/理由は summary として UI へ返す)。ペア対象外なら null。
          const sync = await pairSync.syncPairAfterConfirm(review.templateId, actor.username);
          // 続けて `次回反映既定`=`反映` パーツの注記マスタ書き戻し(同じくベストエフォート)。
          // 契機は承認のみ = ペア同期で機械転写された側の版種はここでは書き戻さない
          // (その版種自身の承認時に昇格する)。
          const noteMasterResult = await noteMaster.reflectNoteMasterAfterConfirm(
            review.templateId,
            actor.username,
          );
          return { meta, staleWarning, sync, noteMaster: noteMasterResult };
        });
      },
      async rejectReview(reqId, decision, actor) {
        /* 252-262 行目の本文をそのまま */
      },
    };
  }
  ```

- [ ] `editor/server/src/deps.ts` を新規作成する。

  ```ts
  // =============================================================================
  // deps.ts — ルートへ配る集約の実体(sproc 注入の受け皿)
  // =============================================================================
  // `buildApp` が 1 回だけ組み立て、`register(routes, { prefix, deps })` で各ルートへ渡す。
  // 集約どうしの依存(注記マスタ・ペア同期がパーツカタログを引く/承認が両者を呼ぶ)は
  // ここで結線し、ルートは自分が使う面だけを `Pick` で受け取る。
  import type { SessionStore } from './auth/session.js';
  import type { SprocClient } from './db/sproc.js';
  import { type AuthRepo, createAuthRepo } from './repositories/authRepo.js';
  import { createPartRepo, type PartRepo } from './repositories/partRepo.js';
  import { createReviewRepo, type ReviewRepo } from './repositories/reviewRepo.js';
  import { createTemplateRepo, type TemplateRepo } from './repositories/templateRepo.js';
  import { createUserRepo, type UserRepo } from './repositories/userRepo.js';
  import { createNoteMasterService, type NoteMasterService } from './sync/noteMasterService.js';
  import { createPairSyncService, type PairSyncService } from './sync/pairSyncService.js';

  export interface Deps {
    auth: AuthRepo;
    users: UserRepo;
    templates: TemplateRepo;
    parts: PartRepo;
    reviews: ReviewRepo;
    pairSync: PairSyncService;
    noteMaster: NoteMasterService;
  }

  export function createDeps(sproc: SprocClient, sessionStore: SessionStore): Deps {
    const parts = createPartRepo(sproc);
    const noteMaster = createNoteMasterService({ sproc, parts });
    const pairSync = createPairSyncService(parts);
    return {
      auth: createAuthRepo({ sproc, sessionStore }),
      users: createUserRepo(sproc),
      templates: createTemplateRepo(sproc),
      parts,
      reviews: createReviewRepo({ noteMaster, pairSync }),
      pairSync,
      noteMaster,
    };
  }
  ```

- [ ] 6 本のルートを `deps` 受け取りへ変える。**呼び出し箇所は計 25**(auth 3 / generate 2 /
  parts 2 / reviews 5 / templates 9 / users 4)。

  `auth.routes.ts`: 32 行目 `import * as auth from '../repositories/authRepo.js';` を
  `import type { Deps } from '../deps.js';` に差し替え、34 行目のシグネチャを変える。

  ```ts
  export const authRoutes: FastifyPluginAsync<{ deps: Pick<Deps, 'auth'> }> = async (app, opts) => {
    const { auth } = opts.deps;
  ```

  以降の `auth.login(…)`(75 行目)・`auth.logout(…)`(101 行目)・
  `auth.initPassword(…)`(157 行目)は字面のまま通る。17 行目の
  `import type { FastifyInstance } from 'fastify';` は
  `import type { FastifyPluginAsync } from 'fastify';` へ。ファイル末尾の関数閉じ括弧を
  `};` にする。`settleAfter`(174-187 行目)は module private のまま。

  `generate.routes.ts`: 32-34 行目の
  `import { recordCreate } …` は残し、33-34 行目を
  `import type { Deps } from '../deps.js';` へ差し替える。40 行目を

  ```ts
  export const generateRoutes: FastifyPluginAsync<{
    deps: Pick<Deps, 'templates' | 'noteMaster'>;
  }> = async (app, opts) => {
    const { templates, noteMaster } = opts.deps;
  ```

  72 行目 `applyNoteMasterToHtml(` → `noteMaster.applyNoteMasterToHtml(`、
  97 行目 `registerGenerated(attributes, id)` → `templates.registerGenerated(attributes, id)`。

  `parts.routes.ts`: 11 行目を `import type { Deps } from '../deps.js';` に替え、28 行目を

  ```ts
  export const partsRoutes: FastifyPluginAsync<{ deps: Pick<Deps, 'parts'> }> = async (
    app,
    opts,
  ) => {
    const { parts } = opts.deps;
  ```

  33 行目 `parts.getPartClassificationOptions(…)`・38 行目 `parts.listParts(…)` は字面のまま。
  10 行目の `import * as history from '../repositories/historyRepo.js';` は無変更
  (`history` は sproc 非依存)。

  `reviews.routes.ts`: 19 行目を
  `import type { Deps } from '../deps.js';` +
  `import type { ReviewActor } from '../repositories/reviewRepo.js';` に替え、22-24 行目の
  `actor()` の戻り型を `ReviewActor` へ(`reviews.ReviewActor` の名前空間参照を外す)。
  29 行目を

  ```ts
  export const reviewsRoutes: FastifyPluginAsync<{ deps: Pick<Deps, 'reviews'> }> = async (
    app,
    opts,
  ) => {
    const { reviews } = opts.deps;
  ```

  39 / 56 / 62 / 74 / 93 行目の `reviews.*` は字面のまま。

  `templates.routes.ts`: 14-15 行目を `import type { Deps } from '../deps.js';` に替え、
  32 行目を

  ```ts
  export const templatesRoutes: FastifyPluginAsync<{
    deps: Pick<Deps, 'templates' | 'pairSync'>;
  }> = async (app, opts) => {
    const { templates, pairSync } = opts.deps;
  ```

  81 行目 `getPairSyncStatus(request.params.id)` → `pairSync.getPairSyncStatus(request.params.id)`。
  34 / 42 / 46 / 50 / 64 / 74 / 85 / 92 行目の `templates.*` は字面のまま。

  `users.routes.ts`: 13 行目を `import type { Deps } from '../deps.js';` に替え、15 行目を

  ```ts
  export const usersRoutes: FastifyPluginAsync<{ deps: Pick<Deps, 'users'> }> = async (
    app,
    opts,
  ) => {
    const { users } = opts.deps;
  ```

  25 / 34 / 49 / 59 行目の `users.*` は字面のまま。

- [ ] `editor/server/src/app.ts` の `buildApp` 冒頭(D2 で足した decorate の直後)で
  `deps` を組み、175-184 行目の register 6 本へ渡す。

  ```ts
    const sessionStore = createSessionStore(sproc);
    app.decorate('sessionStore', sessionStore);
    // 集約は 1 回だけ組み、ルートへは `register` の options で配る。プラグインを
    // `fastify-plugin` に通していないので、options はそのルート群の中に閉じる。
    const deps = createDeps(sproc, sessionStore);
  ```

  ```ts
    app.register(openapiRoutes, { prefix: '/api' });
    app.register(authRoutes, { prefix: '/api', deps });
    app.register(vivliostyleRoutes, { prefix: '/api' });
    app.register(templatesRoutes, { prefix: '/api', deps });
    app.register(generateRoutes, { prefix: '/api', deps });
    app.register(partsRoutes, { prefix: '/api', deps });
    app.register(reviewsRoutes, { prefix: '/api', deps });
    app.register(historyRoutes, { prefix: '/api' });
    app.register(notesRoutes, { prefix: '/api' });
    app.register(usersRoutes, { prefix: '/api', deps });
  ```

  import に `import { createDeps } from './deps.js';` を足す。

- [ ] `editor/server/test/helpers/offlineSproc.ts` を新規作成する。

  ```ts
  // =============================================================================
  // offlineSproc.ts — DB 不在を再現する sproc 実行面
  // =============================================================================
  // 承認の後段(注記マスタ書き戻し・ペア同期)はベストエフォートで、DB へ触れなくても承認は
  // 成立する。その姿勢を固定するテストへ「必ず失敗する DB」を渡す。開発機に LocalDB が居ても
  // 実 DB を触らないことがここの主眼で、`createSprocClient` を通すことで本番と同じ
  // `mapSqlError` を経由した種別(`unexpected`)に揃う。
  import { createSprocClient, type SprocClient } from '../../src/db/sproc.js';

  export function createOfflineSproc(): SprocClient {
    return createSprocClient(async () => {
      throw Object.assign(new Error('DB 不在(テストの意図的失敗)'), { number: 40000 });
    });
  }
  ```

- [ ] `editor/server/test/authRepo.test.ts`: 17-25 行目(`db/sproc.js` モック)と 36-39 行目
  (`auth/session.js` モック)を削除し、13-15 行目の spy から repo を組む。素の
  `firstRow` / `p` / `asBool` / `asBuffer` / `asNumberOrNull` が使われるようになるが、
  現行の行(`無効: false|true`・`PWハッシュ: Buffer.alloc(0)`・`PW反復回数: 120_000`)は
  実装をそのまま通り、既存アサーション(`toContainEqual({ name: '除外セッションID', value: 'sid-1' })`)も
  一致する。

  ```ts
  import type { SprocClient } from '../src/db/sproc.js';
  import { createSessionStub } from './helpers/sessionStub.js';

  const callSproc = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>[]> => []);
  const verifyPassword = vi.fn(async (): Promise<boolean> => true);
  const createSession = vi.fn(async () => 'sid');

  const sproc: SprocClient = { callSproc: (...args) => callSproc(...(args as [])) };
  const sessionStore = { ...createSessionStub(), createSession };

  vi.mock('../src/auth/password.js', () => ({
    verifyPassword: (...args: unknown[]) => verifyPassword(...(args as [])),
    hashPassword: vi.fn(async () => ({
      hash: Buffer.alloc(0),
      salt: Buffer.alloc(0),
      iterations: 1,
    })),
  }));
  ```

  各 `it` の先頭にある `const { login } = await import('../src/repositories/authRepo.js');`
  (62-63・122・134・156・168 行目)を次へ置き換える。

  ```ts
  const { createAuthRepo } = await import('../src/repositories/authRepo.js');
  const { login } = createAuthRepo({ sproc, sessionStore });
  ```

  (`initPassword` を使う 3 箇所も同じく `const { initPassword } = createAuthRepo({ sproc, sessionStore });`)

- [ ] `editor/server/test/generate.routes.test.ts`: 17-27 行目のモックを削除し、71-81 行目の
  `beforeAll` で deps を組む。`sprocFails` フラグは実行面(`QueryFn`)側へ移す。

  ```ts
  // 生成器(python)と台帳(sproc)は本テストの対象外。台帳は既定で成功させ、孤児検査の
  // ときだけ失敗へ切り替える。
  let sprocFails = false;
  ```

  ```ts
      const { createSprocClient } = await import('../src/db/sproc.js');
      const { createDeps } = await import('../src/deps.js');
      const sproc = createSprocClient(async () => {
        if (sprocFails) throw new Error('台帳登録に失敗(テストの意図的失敗)');
        return [];
      });
      const store = createSessionStub({
        getSessionUser: () => ({
          id: 'editor',
          username: 'editor',
          displayName: 'editor',
          role: 'editor',
          disabled: false,
          mustChangePassword: false,
        }),
      });
      const deps = createDeps(sproc, store);
      app = Fastify();
      decorateSessionStore(app, store);
      app.setErrorHandler(errorHandler);
      // `requireAuth` は実セッションを引くので、ここでは onRequest で user を注入して
      // 「認証済みの一般利用者」を作る(本テストの関心はロールではなく書込先)。
      app.addHook('onRequest', async (req) => {
        req.user = { username: 'editor', role: 'editor' } as never;
      });
      await app.register(generateRoutes, { deps });
      await app.register(templatesRoutes, { deps });
      await app.ready();
  ```

- [ ] `editor/server/test/noteMasterService.test.ts`: 8-12 行目のモック 2 本を削除し、
  19-30 行目の import と mocked ハンドルを組み立て形へ変える。13-16 行目の
  `templateFiles.js` 部分モックは残す。

  ```ts
  vi.mock('../src/files/templateFiles.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/files/templateFiles.js')>();
    return { ...orig, readTemplateHtml: vi.fn() };
  });

  import type { PartCatalogItem, PartMasterReflectDefault } from '@editor/shared';
  import type { Param, SprocClient } from '../src/db/sproc.js';
  import { SP } from '../src/db/sprocNames.js';
  import { readTemplateHtml } from '../src/files/templateFiles.js';
  import type { PartRepo } from '../src/repositories/partRepo.js';
  import { createNoteMasterService } from '../src/sync/noteMasterService.js';

  const callSprocMock = vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>[]> => []);
  const listPartsMock = vi.fn(async (): Promise<PartCatalogItem[]> => []);
  const readTemplateHtmlMock = vi.mocked(readTemplateHtml);

  const parts: PartRepo = {
    listParts: (...a) => listPartsMock(...(a as [])),
    getPartClassificationOptions: async () => ({
      categories: [],
      majorClasses: [],
      middleClasses: [],
      minorClasses: [],
    }),
  };
  const sproc: SprocClient = { callSproc: (...a) => callSprocMock(...(a as [])) };
  const { reflectNoteMasterAfterConfirm, applyNoteMasterToHtml } = createNoteMasterService({
    sproc,
    parts,
  });
  ```

  既存の `it` 本文は `callSprocMock` / `listPartsMock` の名前をそのまま使うので無変更。

- [ ] `editor/server/test/reviews.test.ts`: 15-23 行目のモックを削除し、43・50-52 行目を
  組み立て形へ変える。

  ```ts
  // DB(sproc)は本テストの対象外。承認直後の注記マスタ書き戻しが実 DB へ触れないよう
  // 決定的に失敗する実行面を渡し、「DB 不在でも承認は成立する」ベストエフォート経路に
  // 固定する(開発機に LocalDB が居ると素通しで実 DB へ書いてしまうため必須)。
  import { createSessionStub } from './helpers/sessionStub.js';
  import { createOfflineSproc } from './helpers/offlineSproc.js';
  ```

  ```ts
    let reviews: import('../src/repositories/reviewRepo.js').ReviewRepo;
  ```

  ```ts
    beforeAll(async () => {
      const { createDeps } = await import('../src/deps.js');
      reviews = createDeps(createOfflineSproc(), createSessionStub()).reviews;
    });
  ```

- [ ] `editor/server/test/reviews.routes.test.ts`: 18-26 行目のモックを削除し、49-65 行目の
  `buildApp` で deps を組んで register へ渡す。

  ```ts
    async function buildApp(): Promise<FastifyInstance> {
      const Fastify = (await import('fastify')).default;
      const { errorHandler } = await import('../src/middleware/errorHandler.js');
      const { reviewsRoutes } = await import('../src/routes/reviews.routes.js');
      const { createDeps } = await import('../src/deps.js');
      const deps = createDeps(createOfflineSproc(), createSessionStub());
      const instance = Fastify();
      instance.setErrorHandler(errorHandler);
      instance.addHook('onRequest', async (req) => {
        const username = req.headers['x-test-user'];
        const role = req.headers['x-test-role'];
        if (typeof username === 'string' && typeof role === 'string') {
          req.user = { username, role } as never;
        }
      });
      await instance.register(reviewsRoutes, { deps });
      await instance.ready();
      return instance;
    }
  ```

- [ ] `editor/server/test/reviews.metaFailure.test.ts`: 25-33 行目のモックを削除し、
  62・69-71 行目を `reviews.test.ts` と同じ組み立て形へ変える(`reviewFiles.js` の
  部分モック 37-51 行目は残す)。

- [ ] `editor/server/test/routeGuards.test.ts`: 47-56 行目の `db/sproc.js` モックを削除し、
  82-105 行目の register ループへ `deps` を渡す。

  ```ts
  // ルートの本体には降りない(降りると DB/python/vivliostyle を叩く)。ガードを通過したか
  // だけを見たいので、DB の実行面は「常に 0 行」を返すフェイクにして「到達したら 500 でなく
  // 素直に返る」形にする。
  const { createSprocClient } = await import('../src/db/sproc.js');
  const { createDeps } = await import('../src/deps.js');
  const deps = createDeps(createSprocClient(async () => []), store);
  ```

  (`store` は D2 で作った `createSessionStub({...})` を変数へ束ねたもの)

  ```ts
      app.register(plugin, { prefix: '/api', deps });
  ```

- [ ] server プロジェクト全件を通す。

  ```
  pnpm exec vitest run --project server
  ```

  期待: 全ファイル緑。`reviews.test.ts` の
  `expect(tplMeta.noteMaster?.error).toBeTruthy()` は、`mapSqlError` が返す `AppError`
  (Error のサブクラスではないプレーンオブジェクト)を `String(e)` で写した文字列になるので
  引き続き truthy。

- [ ] 型検査とビルド。

  ```
  pnpm run typecheck:editor && pnpm run build:editor
  ```

  期待: 両方 exit 0。

- [ ] コミットする。

  ```
  pnpm exec biome check --write editor/server/src editor/server/test
  git add editor/server/src editor/server/test
  git commit -m "$(cat <<'EOF'
  refactor(editor): リポジトリをファクトリ化し、ルートへ deps で配る

  7 つの集約(認証・ユーザー・テンプレート・パーツ・承認・ペア同期・注記マスタ)を
  `create*` のファクトリにし、`deps.ts` の `createDeps(sproc, sessionStore)` が 1 回だけ
  結線する。ルートは `FastifyPluginAsync<{ deps: Pick<Deps, …> }>` で自分が使う面だけを
  受け取り、`buildApp` が `register(routes, { prefix, deps })` で渡す。`history` /
  `notes` は sproc 非依存なので無改修。`applyConfirmedSave` は sproc 非依存のため
  `templateRepo.ts` のモジュール直下 export に残し、承認の直列化ロック
  (`withReviewLock`)も確定領域がプロセス単位で 1 つであることからモジュール直下に残す。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task D4: 監査ログ複写の実行面を `setAuditSink` で差し込む

**Files:**
- `editor/server/src/db/audit.ts`(8-22 行目)
- `editor/server/src/app.ts`(import 追加・`buildApp` 冒頭)
- `editor/server/test/guardCoverage.guard.test.ts`(末尾へ describe を 1 本追加)

**Interfaces:**

Consumes: `SprocClient` / `realSproc`(D1)、`AuditEvent`(`logger.ts:48`)

Produces: `export function setAuditSink(sproc: SprocClient): void;`

**Steps:**

- [ ] 先に guard テストを書く。`editor/server/test/guardCoverage.guard.test.ts` の末尾へ足す。

  ```ts
  describe('監査ログの実行面を差し込むのは buildApp だけ', () => {
    // logger はグローバルで app にも request にも紐付かないため、監査 DB 複写の実行面だけは
    // モジュール変数の setter になる。可変点が 1 つある以上、呼び出し元が増えていないことを
    // 列挙として固定する — 他所から差し替えられると、監査の宛先が実行時に判らなくなる。
    it('setAuditSink の呼び出し元は app.ts だけ', () => {
      const callers = sourceFiles(SERVER_SRC, ['.ts'])
        .filter((f) => path.basename(f) !== 'audit.ts')
        .filter((f) => /setAuditSink\s*\(/.test(read(f)))
        .map((f) => path.relative(SERVER_SRC, f).replaceAll('\\', '/'));
      expect(callers).toEqual(['app.ts']);
    });
  });
  ```

- [ ] 赤を確認する。

  ```
  pnpm exec vitest run --project server test/guardCoverage
  ```

  期待: 新規 it が `expected [] to deeply equal [ 'app.ts' ]` で失敗(他は緑)。

- [ ] `editor/server/src/db/audit.ts` の 8-22 行目を差し替える。

  ```ts
  import type { AuditEvent } from '../logger.js';
  import { p, realSproc, type SprocClient } from './sproc.js';
  import { SP } from './sprocNames.js';

  // 監査ログの複写先。logger はグローバルで app にも request にも紐付かないので、ここだけは
  // モジュール変数の差し替えになる。呼ぶのは `app.ts` の `buildApp` だけで、他所から呼ばない
  // ことは `test/guardCoverage.guard.test.ts` が走査で固定する。
  let sink: SprocClient = realSproc;

  /** 監査ログ複写の実行面を差し込む。 */
  export function setAuditSink(sproc: SprocClient): void {
    sink = sproc;
  }

  export async function auditToDb(ev: AuditEvent): Promise<void> {
    await sink.callSproc(SP.audit, '登録', [
      p('イベント', ev.event),
      p('結果', ev.outcome),
      p('実行者', ev.actor),
      p('IP', ev.ip),
      p('リソースJSON', ev.resource ? JSON.stringify(ev.resource) : null),
      p('詳細JSON', ev.detail ? JSON.stringify(ev.detail) : null),
      p('エラー', ev.error),
    ]);
  }
  ```

- [ ] `editor/server/src/app.ts` に import を足し、`buildApp` の `createDeps` の直前で呼ぶ。

  ```ts
  import { setAuditSink } from './db/audit.js';
  ```

  ```ts
    // 監査ログの DB 複写は logger 経由(グローバル)なので、宛先だけをここで差し込む。
    setAuditSink(sproc);
    const deps = createDeps(sproc, sessionStore);
  ```

- [ ] 緑を確認する。

  ```
  pnpm exec vitest run --project server test/guardCoverage && pnpm run typecheck:editor
  ```

  期待: guardCoverage 全件緑、typecheck exit 0。

- [ ] コミットする。

  ```
  pnpm exec biome check --write editor/server/src/db/audit.ts editor/server/src/app.ts editor/server/test/guardCoverage.guard.test.ts
  git add editor/server/src/db/audit.ts editor/server/src/app.ts editor/server/test/guardCoverage.guard.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(editor): 監査ログ複写の実行面を setAuditSink で差し込む

  監査イベントの DB 複写は logger 経由で、logger は app にも request にも紐付かない
  グローバルなので、ここだけはモジュール変数の setter になる。呼び出すのは `buildApp`
  だけで、他所から呼ばれていないことを `guardCoverage.guard.test.ts` の走査が固定する。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task D5: プロセスのライフサイクルを `serve.ts` へ抽出する

**Files:**
- `editor/server/src/serve.ts`(新規。`index.ts` の 13-146 行目を移す)
- `editor/server/src/index.ts`(全面。3 行のエントリにする)

**Interfaces:**

Consumes: `buildApp` / `BuildAppOptions`(D2・D3)、`config`、`logger`、
`previewManager`、`buildWorkerPool`

Produces:
- `export interface StartServerOptions { sproc?: SprocClient }`
- `export async function startServer(options?: StartServerOptions): Promise<void>`

**Steps:**

- [ ] `editor/server/src/serve.ts` を新規作成し、`index.ts` の 13-146 行目を移す
  (`invalidateSessionsOnBoot` は D2 で `app` 引数化済み)。トップレベルの手続きを
  `startServer` の中へ入れる。

  ```ts
  // =============================================================================
  // serve.ts — サーバのライフサイクル(起動準備・listen・graceful shutdown)
  // =============================================================================
  // アプリの配線は `app.ts` の `buildApp()` が持ち、本ファイルは**プロセスとしての振る舞い**
  // だけを持つ: 置き場の健全性チェック・起動時のセッション失効・listen・シグナル処理・
  // 最後の砦のハンドラ。入口(`index.ts`)と rest e2e の起動スクリプトが同じ手順を共有する
  // ための置き場で、複製すると起動条件が 2 系統へ分かれる。
  import fs from 'node:fs';
  import { buildApp } from './app.js';
  import { config } from './config.js';
  import type { SprocClient } from './db/sproc.js';
  import { logger } from './logger.js';
  import { buildWorkerPool } from './vivliostyle/buildWorkerServer.js';
  import { previewManager } from './vivliostyle/previewServer.js';

  export interface StartServerOptions {
    /** DB 実行面。既定は本番のプール接続で、rest e2e は in-memory フェイクを渡す。 */
    sproc?: SprocClient;
  }

  // ── 置き場の健全性チェック(ネットワークドライブ) ──
  // (`index.ts` の 21-55 行目をそのまま移す: isNetworkPath / warnOnNetworkPlacement)

  // ── 起動時のセッション失効と期限切れの掃除 ──
  // (`index.ts` の 57-82 行目をそのまま移す: invalidateSessionsOnBoot)

  export async function startServer(options: StartServerOptions = {}): Promise<void> {
    // 組み立ての失敗(HTTPS opt-in なのに PFX が無い等)は設定ミスなので、黙って別構成へ
    // 落ちずメッセージを出して異常終了する。
    let app: ReturnType<typeof buildApp>;
    try {
      app = buildApp(options);
    } catch (err) {
      logger.error(`[server] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    warnOnNetworkPlacement();
    await invalidateSessionsOnBoot(app);

    // listen。host は既定 127.0.0.1(同一マシン限定)で、社内 LAN へ公開するときだけ
    // `HOST=0.0.0.0`(start.bat lan が設定)で全 IF にバインドする。preview サーバは loopback の
    // ままここ経由のプロキシでのみ外へ出るため、公開されるのは本ポートだけで認証も効く。
    // listen の失敗(`EADDRINUSE` 等)は reject で届くため、原因を明示してから exit(1) する。
    try {
      await app.listen({ port: config.port, host: config.host });
      const scheme = config.tls.enabled ? 'https' : 'http';
      const lanExposed = config.host !== '127.0.0.1' && config.host !== 'localhost';
      logger.info(
        `[server] listening on ${scheme}://localhost:${config.port}` +
          (lanExposed ? ` (LAN 公開中: ${scheme}://<この端末のIP>:${config.port})` : ''),
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EADDRINUSE') {
        logger.error(
          `[server] ポート ${config.port} は既に使用中です — 旧サーバが残っている可能性があります。` +
            ' 既存プロセスを停止してから再実行してください(start.bat は自動停止を試みます)。',
        );
      } else {
        logger.error({ err }, '[server] listen に失敗しました');
      }
      process.exit(1);
    }

    // Graceful shutdown: プロセス終了前に全 live preview サーバ(各々が Vite サーバ
    // + 一時ディレクトリを保持)を停止し、リーク(leak)を残さない。
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`[server] ${signal} received — closing preview sessions`);
      await Promise.allSettled([previewManager.disposeAll(), buildWorkerPool.disposeAll()]);
      await app.close();
      process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void shutdown(signal));
    }

    // 最後の砦(last resort): 想定外の例外/未処理 Promise は、ログを残さず無言で死ぬと
    // 原因究明ができない。error で記録してから `exit(1)` し、必ず痕跡を残す。
    process.on('uncaughtException', (err) => {
      logger.error({ err }, '[server] 未捕捉の例外で異常終了します');
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      logger.error({ err: reason }, '[server] 未処理の Promise 拒否で異常終了します');
      process.exit(1);
    });
  }
  ```

- [ ] `editor/server/src/index.ts` を全面差し替えする。

  ```ts
  // =============================================================================
  // index.ts — サーバの入口(プロセスの起動点)
  // =============================================================================
  // 起動手順の実体は `serve.ts` の `startServer` が持つ。起動スクリプト
  // (`editor/start.bat`)はこのファイルを実体パスで起動し、そのコマンドラインで
  // 「自分のリポジトリのサーバか」を判定して古いプロセスを片付ける。エントリの綴りを
  // 変えるときは start.bat の判定パターンも併せて直すこと。
  import { startServer } from './serve.js';

  await startServer();
  ```

- [ ] `hostGuard.test.ts` が無改修で通ることを確認する。同ファイルは `app.ts` を import せず
  検査そのもの(`allowedHosts` + `isAllowedHost`)を最小構成で組み直しているため、本タスクの
  影響を受けない。

  ```
  pnpm exec vitest run --project server test/hostGuard
  ```

  期待: `Test Files  1 passed (1)`。

- [ ] server 全件・型検査・ビルドを通す。

  ```
  pnpm exec vitest run --project server && pnpm run typecheck:editor && pnpm run build:editor
  ```

  期待: いずれも exit 0。`editor/server/dist/index.js` と `dist/serve.js` が生成される。

- [ ] 実起動で退行が無いことを見る(local モード)。

  ```
  cd editor/server && node dist/index.js
  ```

  期待: `[server] listening on http://localhost:24680`。Ctrl+C で
  `[server] SIGINT received — closing preview sessions` を出して終了する。

- [ ] コミットする。

  ```
  pnpm exec biome check --write editor/server/src/serve.ts editor/server/src/index.ts
  git add editor/server/src/serve.ts editor/server/src/index.ts
  git commit -m "$(cat <<'EOF'
  refactor(editor): サーバのライフサイクルを serve.ts の startServer へ抽出する

  置き場の健全性チェック・起動時のセッション失効と掃除タイマー・listen・graceful
  shutdown・最後の砦のハンドラを `startServer({ sproc? })` にまとめ、`index.ts` は
  それを呼ぶだけの入口にする。rest e2e の起動スクリプトが同じ手順を共有できるようにする
  ためで、複製すると起動条件が 2 系統へ分かれる。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task D6: in-memory の sproc フェイクと、その semantics のテスト

**Files:**
- `editor/server/test/fakes/sprocFake.ts`(新規)
- `editor/server/test/sprocFake.test.ts`(新規)
- `editor/server/tsconfig.tools.json`(新規)
- `package.json`(20-21 行目の `typecheck` / `typecheck:editor`)

**Interfaces:**

Consumes:
- `QueryFn` / `Row` / `SprocClient` / `createSprocClient`(D1)
- `SP`(`db/sprocNames.ts`)
- `hashPassword`(`auth/password.ts:55`)
- `parseTemplateFileName`(`@editor/shared`)

Produces:
- `export interface FakeUserSeed { username: string; displayName: string; role: UserRole; password: string; }`
- `export interface FakeFundSeed { code: string; name: string; nickname: string; companyCode: string; companyName: string; }`
- `export interface FakeSeed { users?: readonly FakeUserSeed[]; funds?: readonly FakeFundSeed[]; templateIds?: readonly string[]; parts?: readonly FakePartSeed[]; }`
- `export const DEFAULT_USERS: readonly FakeUserSeed[];`
- `export const DEFAULT_FUNDS: readonly FakeFundSeed[];`
- `export const DEFAULT_TEMPLATE_IDS: readonly string[];`
- `export async function createFakeQuery(seed?: FakeSeed): Promise<QueryFn>;`
- `export async function createFakeSproc(seed?: FakeSeed): Promise<SprocClient>;`

**Steps:**

- [ ] `editor/server/test/fakes/sprocFake.ts` を新規作成する。

  ```ts
  // =============================================================================
  // sprocFake.ts — ゲートウェイ sproc 7 本の in-memory 実装
  // =============================================================================
  // `createSprocClient(query)` の `query` として差し込み、rest モードのサーバを DB 無しで
  // 動かす。写すのは SQL ではなく sproc の**不変則**で、外すと rest e2e が偽の挙動を検証する:
  //   - `ユーザー/PW初期化` は除外セッション以外の失効までを 1 操作で行う(パスワードだけ
  //     変わって旧セッションが生きている中間状態を作らない)。
  //   - `ユーザー/PWリセット` はそのユーザーの全セッション失効 + `要パスワード変更`=1。
  //   - `ユーザー/作成` は重複ログインID を 50409 で断り、`要パスワード変更` の既定は 1。
  //   - `ユーザー/更新` は NULL を据え置く(COALESCE)。
  //   - `セッション/取得` は `失効=0` かつ `有効期限 > now` の行だけを返す。
  //   - `テンプレート/生成登録` は冪等。
  // エラーは `AppError` ではなく `number` を持つ生 SQL エラー相当を throw する。種別への
  // 変換は `createSprocClient` の中の `mapSqlError` が 1 回だけ行う。
  import type { UserRole } from '@editor/shared';
  import { parseTemplateFileName } from '@editor/shared';
  import { hashPassword } from '../../src/auth/password.js';
  import { createSprocClient, type QueryFn, type Row, type SprocClient } from '../../src/db/sproc.js';
  import { SP } from '../../src/db/sprocNames.js';

  // ── 1. seed の型と既定値 ──

  /** seed ユーザーの平文パスワード。rest e2e のログインで使う。 */

  export interface FakeUserSeed {
    username: string;
    displayName: string;
    role: UserRole;
    password: string;
  }
  export interface FakeFundSeed {
    code: string;
    name: string;
    nickname: string;
    companyCode: string;
    companyName: string;
  }
  export interface FakePartSeed {
    id: string;
    category: string;
    majorClass: string;
    middleClass: string;
    minorClass: string;
    name: string;
    content: string;
    syncDefault: string | null;
    masterReflectDefault: string | null;
  }
  export interface FakeSeed {
    users?: readonly FakeUserSeed[];
    funds?: readonly FakeFundSeed[];
    /** 台帳へ載せるテンプレートID(ファイル名の stem)。属性はここから解析する。 */
    templateIds?: readonly string[];
    parts?: readonly FakePartSeed[];
  }

  // 自己承認は職務分掌で拒否されるので、申請者と承認者は別人が要る。パスワードはユーザー名と
  // 同じにする: local の fixtures(users.json)と同じ規約なので、e2e の `login(page, user)` が
  // local / rest のどちらでも同じ引数で通る。
  export const DEFAULT_USERS: readonly FakeUserSeed[] = [
    { username: 'editor', displayName: '編集 太郎', role: 'editor', password: 'editor' },
    {
      username: 'approver',
      displayName: '承認 花子',
      role: 'approver',
      password: 'approver',
    },
    { username: 'admin', displayName: '管理 次郎', role: 'admin', password: 'admin' },
  ];

  // ファンドマスタが無いと `parseFundMaster` が undefined を返し、画面のファンド名が空になる。
  // コードは `editor/web/src/api/fixtures/sample/*.json` と一致させる(dataRoot 側の seed が
  // 同じファンドのテンプレートを置くため)。
  export const DEFAULT_FUNDS: readonly FakeFundSeed[] = [
    {
      code: '110024',
      name: '高金利ソブリンオープン',
      nickname: '',
      companyCode: 'AM01',
      companyName: '三井住友トラスト・アセットマネジメント株式会社',
    },
    {
      code: '510003',
      name: 'コア投資戦略ファンド（安定型）',
      nickname: 'コアラップ（安定型）',
      companyCode: 'AM01',
      companyName: '三井住友トラスト・アセットマネジメント株式会社',
    },
    {
      code: '510037',
      name: 'コア投資戦略ファンド（切替型）',
      nickname: 'コアラップ（切替型）',
      companyCode: 'AM01',
      companyName: '三井住友トラスト・アセットマネジメント株式会社',
    },
    {
      code: '510124',
      name: 'ＳＭＴ ＪＰＸ日経中小型株インデックス・オープン',
      nickname: '',
      companyCode: 'AM01',
      companyName: '三井住友トラスト・アセットマネジメント株式会社',
    },
    {
      code: '510155',
      name: 'コア投資戦略ファンド（切替型ワイド）',
      nickname: 'コアラップ（切替型ワイド）',
      companyCode: 'AM01',
      companyName: '三井住友トラスト・アセットマネジメント株式会社',
    },
  ];

  // `editor/web/src/api/fixtures/templates/*.html` と同じ 8 件。候補・系列の値がここから出る。
  export const DEFAULT_TEMPLATE_IDS: readonly string[] = [
    'AM01_110024_20251117_交付版',
    'AM01_110024_20251117_全体版',
    'AM01_510003_20250710_全体版',
    'AM01_510037_20240710_交付版',
    'AM01_510037_20240710_全体版',
    'AM01_510124_20251020_交付版',
    'AM01_510124_20251020_全体版',
    'AM01_510155_20240710_交付版',
  ];

  // 既定は「未判断」= ペア同期も次回反映もしない。承認フローで機械転写が勝手に走らない側へ倒す。
  const DEFAULT_PARTS: readonly FakePartSeed[] = [
    {
      id: 'p-cover-title',
      category: '表紙',
      majorClass: '見出し',
      middleClass: 'タイトル',
      minorClass: '標準',
      name: '表紙タイトル',
      content: '<h1>運用報告書</h1>',
      syncDefault: null,
      masterReflectDefault: null,
    },
    {
      id: 'p-note-tax',
      category: '注記',
      majorClass: '税制',
      middleClass: '個人',
      minorClass: '標準',
      name: '税制の注記',
      content: '<p>税制は変更される場合があります。</p>',
      syncDefault: null,
      masterReflectDefault: null,
    },
  ];

  // ── 2. 行の形と補助 ──

  interface UserRow {
    公開ID: string;
    ログインID: string;
    表示名: string;
    ロール: string;
    無効: number;
    要パスワード変更: number;
    PWハッシュ: Buffer;
    PWソルト: Buffer;
    PW反復回数: number;
    作成順: number;
  }
  interface SessionRow {
    セッションID: string;
    ログインID: string;
    有効期限: Date;
    失効: number;
    最終アクセス: Date;
  }
  interface TemplateRow {
    テンプレートID: string;
    委託会社コード: string;
    ファンドコード: string;
    基準日: string;
    版種: string;
    ファイル名: string;
    状態: string;
    更新日時: string | null;
    更新者: string | null;
  }
  interface NoteRow {
    パーツID: string;
    ファンドコード: string;
    版種: string;
    注記HTML: string | null;
    更新者: string | null;
    順: number;
  }

  type Args = Map<string, unknown>;

  /** `number` を持つ生 SQL エラー相当。`mapSqlError` はこの番号だけで種別を決める。 */
  function sqlError(number: number, message: string): Error {
    return Object.assign(new Error(message), { number });
  }

  const text = (a: Args, k: string): string =>
    typeof a.get(k) === 'string' && a.get(k) !== '' ? (a.get(k) as string) : '';
  const optText = (a: Args, k: string): string | null =>
    typeof a.get(k) === 'string' ? (a.get(k) as string) : null;
  const bit = (v: unknown): number | undefined => (v == null ? undefined : v ? 1 : 0);
  const int = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const bin = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.alloc(0));

  /** `EXEC <proc> @a=?, @b=?` と位置指定の値から、proc 名と 名前→値 の対応を組む。 */
  function parseCall(sql: string, values: unknown[]): { proc: string; args: Args } {
    const m = /^EXEC (\S+)(?: (@.*))?$/.exec(sql);
    if (!m) throw sqlError(50000, `フェイクが解釈できない SQL です: ${sql}`);
    const names = [...(m[2] ?? '').matchAll(/@([^=,\s]+)=\?/g)].map((x) => x[1]);
    const args: Args = new Map();
    names.forEach((name, i) => args.set(name, values[i] ?? null));
    return { proc: m[1], args };
  }

  // ── 3. 実行面 ──

  export async function createFakeQuery(seed: FakeSeed = {}): Promise<QueryFn> {
    const users = new Map<string, UserRow>();
    const sessions = new Map<string, SessionRow>();
    const templates = new Map<string, TemplateRow>();
    const notes = new Map<string, NoteRow>();
    const funds = new Map<string, FakeFundSeed>();
    const parts = [...(seed.parts ?? DEFAULT_PARTS)];
    let order = 0;

    for (const u of seed.users ?? DEFAULT_USERS) {
      const { hash, salt, iterations } = await hashPassword(u.password);
      users.set(u.username, {
        公開ID: `u-${u.username}`,
        ログインID: u.username,
        表示名: u.displayName,
        ロール: u.role,
        無効: 0,
        要パスワード変更: 0,
        PWハッシュ: hash,
        PWソルト: salt,
        PW反復回数: iterations,
        作成順: order++,
      });
    }
    for (const f of seed.funds ?? DEFAULT_FUNDS) funds.set(f.code, f);
    for (const id of seed.templateIds ?? DEFAULT_TEMPLATE_IDS) {
      const attrs = parseTemplateFileName(`${id}.html`);
      if (!attrs) continue;
      templates.set(id, {
        テンプレートID: id,
        委託会社コード: attrs.companyCode,
        ファンドコード: attrs.fundCode,
        基準日: attrs.baseDate,
        版種: attrs.editionType,
        ファイル名: `${id}.html`,
        状態: 'published',
        更新日時: null,
        更新者: null,
      });
    }

    const publicUser = (r: UserRow): Row => ({
      公開ID: r.公開ID,
      ログインID: r.ログインID,
      表示名: r.表示名,
      ロール: r.ロール,
      無効: r.無効,
      要パスワード変更: r.要パスワード変更,
    });
    const byLoginId = (loginId: string): UserRow | undefined =>
      [...users.values()].find((u) => u.ログインID === loginId);

    function userOp(op: string, a: Args): Row[] {
      if (op === '一覧')
        return [...users.values()].sort((x, y) => x.作成順 - y.作成順).map(publicUser);

      if (op === '作成') {
        const 公開ID = text(a, '公開ID');
        const ログインID = text(a, 'ログインID');
        const 表示名 = text(a, '表示名');
        const ロール = text(a, 'ロール');
        if (!公開ID || !ログインID || !表示名 || !ロール)
          throw sqlError(50000, '公開ID・ログインID・表示名・ロール が必要です');
        if (byLoginId(ログインID)) throw sqlError(50409, 'このログインIDは既に使われています');
        const row: UserRow = {
          公開ID,
          ログインID,
          表示名,
          ロール,
          無効: bit(a.get('無効')) ?? 0,
          要パスワード変更: bit(a.get('要パスワード変更')) ?? 1,
          PWハッシュ: bin(a.get('PWハッシュ')),
          PWソルト: bin(a.get('PWソルト')),
          PW反復回数: int(a.get('PW反復回数')) ?? 0,
          作成順: order++,
        };
        users.set(公開ID, row);
        return [publicUser(row)];
      }

      if (op === '更新') {
        const 公開ID = text(a, '公開ID');
        if (!公開ID) throw sqlError(50000, '公開ID が必要です');
        const row = [...users.values()].find((u) => u.公開ID === 公開ID);
        if (!row) throw sqlError(50404, 'ユーザーが見つかりません');
        // COALESCE と同じで、NULL は据え置き。
        row.表示名 = optText(a, '表示名') ?? row.表示名;
        row.ロール = optText(a, 'ロール') ?? row.ロール;
        row.無効 = bit(a.get('無効')) ?? row.無効;
        row.要パスワード変更 = bit(a.get('要パスワード変更')) ?? row.要パスワード変更;
        return [publicUser(row)];
      }

      if (op === 'PWリセット') {
        const 公開ID = text(a, '公開ID');
        if (!公開ID || !Buffer.isBuffer(a.get('PWハッシュ')) || !Buffer.isBuffer(a.get('PWソルト')))
          throw sqlError(50000, '公開ID・仮ハッシュ が必要です');
        const row = [...users.values()].find((u) => u.公開ID === 公開ID);
        if (!row) throw sqlError(50404, 'ユーザーが見つかりません');
        row.PWハッシュ = bin(a.get('PWハッシュ'));
        row.PWソルト = bin(a.get('PWソルト'));
        row.PW反復回数 = int(a.get('PW反復回数')) ?? row.PW反復回数;
        row.要パスワード変更 = 1;
        // 管理者リセットは乗っ取り疑いの経路なので、除外なしで全セッションを失効させる。
        // 資格情報の差し替えと失効は不可分(片方だけが残ると守りが無効になる)。
        for (const s of sessions.values()) if (s.ログインID === row.ログインID) s.失効 = 1;
        return [];
      }

      if (op === '認証情報取得') {
        const ログインID = text(a, 'ログインID');
        if (!ログインID) throw sqlError(50000, 'ログインID が必要です');
        const row = byLoginId(ログインID);
        return row
          ? [
              {
                ...publicUser(row),
                PWハッシュ: row.PWハッシュ,
                PWソルト: row.PWソルト,
                PW反復回数: row.PW反復回数,
              },
            ]
          : [];
      }

      if (op === 'PW初期化') {
        const ログインID = text(a, 'ログインID');
        if (
          !ログインID ||
          !Buffer.isBuffer(a.get('PWハッシュ')) ||
          !Buffer.isBuffer(a.get('PWソルト'))
        )
          throw sqlError(50000, 'ログインID・新ハッシュ が必要です');
        const row = byLoginId(ログインID);
        if (!row) throw sqlError(50404, 'ユーザーが見つかりません');
        row.PWハッシュ = bin(a.get('PWハッシュ'));
        row.PWソルト = bin(a.get('PWソルト'));
        row.PW反復回数 = int(a.get('PW反復回数')) ?? row.PW反復回数;
        row.要パスワード変更 = 0;
        // 操作中の自分だけ残して他端末を蹴る。書き換えと失効は同一操作で行う。
        const except = optText(a, '除外セッションID') ?? '';
        for (const s of sessions.values())
          if (s.ログインID === ログインID && s.失効 === 0 && s.セッションID !== except) s.失効 = 1;
        return [];
      }

      throw sqlError(50000, '未知の @操作 です(ユーザー)');
    }

    function sessionOp(op: string, a: Args): Row[] {
      if (op === '作成') {
        const セッションID = text(a, 'セッションID');
        const ログインID = text(a, 'ログインID');
        const 有効期限 = a.get('有効期限');
        if (!セッションID || !ログインID || !(有効期限 instanceof Date))
          throw sqlError(50000, 'セッションID・ログインID・有効期限 が必要です');
        sessions.set(セッションID, {
          セッションID,
          ログインID,
          有効期限,
          失効: 0,
          最終アクセス: new Date(),
        });
        return [];
      }

      if (op === '取得') {
        const セッションID = text(a, 'セッションID');
        if (!セッションID) throw sqlError(50000, 'セッションID が必要です');
        const s = sessions.get(セッションID);
        if (!s || s.失効 === 1 || s.有効期限.getTime() <= Date.now()) return [];
        s.最終アクセス = new Date();
        const u = byLoginId(s.ログインID);
        return u ? [publicUser(u)] : [];
      }

      if (op === '失効') {
        const セッションID = text(a, 'セッションID');
        if (!セッションID) throw sqlError(50000, 'セッションID が必要です');
        const s = sessions.get(セッションID);
        if (s) s.失効 = 1;
        return [];
      }

      if (op === '全失効') {
        for (const s of sessions.values()) s.失効 = 1;
        return [];
      }

      if (op === '掃除') {
        const 保持日数 = int(a.get('保持日数'));
        if (保持日数 === undefined) throw sqlError(50000, '保持日数 が必要です');
        const border = Date.now() - 保持日数 * 86_400_000;
        for (const [id, s] of sessions) if (s.有効期限.getTime() < border) sessions.delete(id);
        return [];
      }

      throw sqlError(50000, '未知の @操作 です(セッション)');
    }

    function templateOp(op: string, a: Args): Row[] {
      const rows = [...templates.values()];
      if (op === '候補') {
        const company = optText(a, '委託会社コード');
        const fund = optText(a, 'ファンドコード');
        const base = optText(a, '基準日');
        // 各候補は「自分より上位の選択」だけで絞る(自分自身・下位は含めない)。そうしないと
        // 版種を選んだ後にその版種だけへ候補が潰れ、別の版種へ戻せない。
        const out: Row[] = [];
        const push = (区分: string, 値: string) => {
          if (!out.some((r) => r.区分 === 区分 && r.値 === 値)) out.push({ 区分, 値 });
        };
        for (const r of rows) push('会社', r.委託会社コード);
        for (const r of rows) if (!company || r.委託会社コード === company) push('ファンド', r.ファンドコード);
        for (const r of rows)
          if ((!company || r.委託会社コード === company) && (!fund || r.ファンドコード === fund))
            push('基準日', r.基準日);
        for (const r of rows)
          if (
            (!company || r.委託会社コード === company) &&
            (!fund || r.ファンドコード === fund) &&
            (!base || r.基準日 === base)
          )
            push('版種', r.版種);
        return out.sort(
          (x, y) =>
            String(x.区分).localeCompare(String(y.区分)) || String(x.値).localeCompare(String(y.値)),
        );
      }

      if (op === '系列') {
        const company = text(a, '委託会社コード');
        const edition = text(a, '版種');
        if (!company || !edition) throw sqlError(50000, '委託会社コードと版種が必要です');
        return rows
          .filter((r) => r.委託会社コード === company && r.版種 === edition)
          .sort((x, y) => x.ファンドコード.localeCompare(y.ファンドコード) || x.基準日.localeCompare(y.基準日))
          .map((r) => ({ ...r }));
      }

      if (op === '生成登録') {
        const id = text(a, 'テンプレートID');
        const 委託会社コード = text(a, '委託会社コード');
        const ファンドコード = text(a, 'ファンドコード');
        const 基準日 = text(a, '基準日');
        const 版種 = text(a, '版種');
        const ファイル名 = text(a, 'ファイル名');
        if (!id || !委託会社コード || !ファンドコード || !基準日 || !版種 || !ファイル名)
          throw sqlError(50000, '生成登録には属性4とファイル名が必要です');
        // 冪等。既に在る行は触らない。
        if (!templates.has(id))
          templates.set(id, {
            テンプレートID: id,
            委託会社コード,
            ファンドコード,
            基準日,
            版種,
            ファイル名,
            状態: 'draft',
            更新日時: null,
            更新者: null,
          });
        return [];
      }

      throw sqlError(50000, '未知の @操作 です(テンプレート)');
    }

    function partOp(op: string, a: Args): Row[] {
      const category = optText(a, 'カテゴリ');
      const major = optText(a, '大分類');
      const middle = optText(a, '中分類');
      const minor = optText(a, '小分類');
      if (op === '分類候補') {
        const out: Row[] = [];
        const push = (区分: string, 値: string) => {
          if (!out.some((r) => r.区分 === 区分 && r.値 === 値)) out.push({ 区分, 値 });
        };
        for (const p of parts) push('カテゴリ', p.category);
        for (const p of parts) if (!category || p.category === category) push('大分類', p.majorClass);
        for (const p of parts)
          if ((!category || p.category === category) && (!major || p.majorClass === major))
            push('中分類', p.middleClass);
        for (const p of parts)
          if (
            (!category || p.category === category) &&
            (!major || p.majorClass === major) &&
            (!middle || p.middleClass === middle)
          )
            push('小分類', p.minorClass);
        return out;
      }

      if (op === '一覧') {
        return parts
          .filter(
            (p) =>
              (!category || p.category === category) &&
              (!major || p.majorClass === major) &&
              (!middle || p.middleClass === middle) &&
              (!minor || p.minorClass === minor),
          )
          .map((p) => ({
            パーツID: p.id,
            カテゴリ: p.category,
            大分類: p.majorClass,
            中分類: p.middleClass,
            小分類: p.minorClass,
            名称: p.name,
            説明: '',
            使用上の注意: '',
            内容HTML: p.content,
            更新日時: null,
            更新者: null,
            同期既定: p.syncDefault,
            次回反映既定: p.masterReflectDefault,
          }));
      }

      throw sqlError(50000, '未知の @操作 です(パーツ)');
    }

    function sampleOp(op: string, a: Args): Row[] {
      if (op === '取得') {
        const code = text(a, 'ファンドコード');
        if (!code) throw sqlError(50000, 'ファンドコード が必要です');
        const f = funds.get(code);
        // `parseFundMaster` が読む形。欠けるとファンド名が空になる。
        return f
          ? [
              {
                データJSON: JSON.stringify({
                  fund: { name: f.name, nickname: f.nickname },
                  company: { code: f.companyCode, name: f.companyName },
                }),
              },
            ]
          : [];
      }
      throw sqlError(50000, '未知の @操作 です(サンプルデータ)');
    }

    function noteMasterOp(op: string, a: Args): Row[] {
      const key = (パーツID: string, ファンドコード: string, 版種: string) =>
        [パーツID, ファンドコード, 版種].join('\x00');
      if (op === '取得') {
        const ファンドコード = text(a, 'ファンドコード');
        const 版種 = text(a, '版種');
        if (!ファンドコード || !版種) throw sqlError(50000, 'ファンドコードと版種が必要です');
        return [...notes.values()]
          .filter((n) => n.ファンドコード === ファンドコード && n.版種 === 版種)
          .sort((x, y) => x.順 - y.順)
          .map((n) => ({ パーツID: n.パーツID, 注記HTML: n.注記HTML }));
      }
      if (op === '反映') {
        const パーツID = text(a, 'パーツID');
        const ファンドコード = text(a, 'ファンドコード');
        const 版種 = text(a, '版種');
        if (!パーツID || !ファンドコード || !版種)
          throw sqlError(50000, 'パーツID・ファンドコード・版種が必要です');
        const k = key(パーツID, ファンドコード, 版種);
        const prev = notes.get(k);
        notes.set(k, {
          パーツID,
          ファンドコード,
          版種,
          注記HTML: optText(a, '注記HTML'),
          更新者: optText(a, '更新者'),
          順: prev?.順 ?? order++,
        });
        return [];
      }
      throw sqlError(50000, '未知の @操作 です(注記マスタ)');
    }

    const auditRows: Row[] = [];
    function auditOp(op: string, a: Args): Row[] {
      if (op === '登録') {
        const イベント = text(a, 'イベント');
        const 結果 = text(a, '結果');
        const 実行者 = text(a, '実行者');
        if (!イベント || !結果 || !実行者)
          throw sqlError(50000, 'イベント・結果・実行者 が必要です');
        auditRows.push(Object.fromEntries(a));
        return [];
      }
      throw sqlError(50000, '未知の @操作 です(監査ログ)');
    }

    return async (sql, values) => {
      const { proc, args } = parseCall(sql, values);
      const op = String(args.get('操作') ?? '');
      switch (proc) {
        case SP.user:
          return userOp(op, args);
        case SP.session:
          return sessionOp(op, args);
        case SP.template:
          return templateOp(op, args);
        case SP.part:
          return partOp(op, args);
        case SP.sample:
          return sampleOp(op, args);
        case SP.noteMaster:
          return noteMasterOp(op, args);
        case SP.audit:
          return auditOp(op, args);
        default:
          throw sqlError(50000, `フェイクが知らない sproc です: ${proc}`);
      }
    };
  }

  /** フェイクの実行面を本番と同じ `createSprocClient` で包む(変換は `mapSqlError` が 1 回)。 */
  export async function createFakeSproc(seed: FakeSeed = {}): Promise<SprocClient> {
    return createSprocClient(await createFakeQuery(seed));
  }
  ```

- [ ] `editor/server/test/sprocFake.test.ts` を新規作成し、semantics 表の各行を固定する。

  ```ts
  // =============================================================================
  // sprocFake.test.ts — in-memory sproc フェイクが写す不変則
  // =============================================================================
  // フェイクは rest e2e が見る「サーバの挙動」の下敷きなので、sproc の不変則を外すと
  // e2e が偽の挙動を検証したまま緑になる。ここで固定するのはその不変則そのもので、
  // SQL の書き方ではない。
  import { describe, expect, it } from 'vitest';
  import { verifyPassword } from '../src/auth/password.js';
  import { p, type SprocClient } from '../src/db/sproc.js';
  import { SP } from '../src/db/sprocNames.js';
  import { createFakeSproc, DEFAULT_USERS } from './fakes/sprocFake.js';

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
  });

  describe('ユーザー', () => {
    it('認証情報取得 returns a hash that the seed password verifies against', async () => {
      const sproc = await createFakeSproc();
      const row = (
        await sproc.callSproc(SP.user, '認証情報取得', [p('ログインID', 'editor')])
      )[0];
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

    it('PW初期化 revokes every session but the excluded one, in the same operation', async () => {
      const sproc = await createFakeSproc();
      await openSession(sproc, sid(1), 'editor');
      await openSession(sproc, sid(2), 'editor');
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

  describe('テンプレート・パーツ・注記マスタ', () => {
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
  ```

- [ ] テストを走らせる。

  ```
  pnpm exec vitest run --project server test/sprocFake
  ```

  期待: `Test Files  1 passed (1)` / `Tests  12 passed (12)`。

- [ ] `editor/server/tsconfig.tools.json` を新規作成する。`server/tsconfig.json` の
  `include` は `src/**` のまま(dist へ emit するので広げない)。

  ```jsonc
  {
    "extends": "../tsconfig.base.json",
    "compilerOptions": {
      // dist へは出さない。ここは「テスト資産と補助スクリプトの型を検査する」ためだけの
      // プロジェクトで、`server/tsconfig.json` の include を広げると emit 対象が増える。
      "noEmit": true,
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "lib": ["ES2022"],
      "types": ["node"]
    },
    "references": [{ "path": "../shared" }],
    "include": ["test/fakes/**/*.ts", "scripts/**/*.ts"]
  }
  ```

- [ ] ルート `package.json` の 20-21 行目を差し替える。

  ```json
      "typecheck": "tsc -b editor/server && tsc -p editor/server/tsconfig.tools.json && pnpm --filter web --filter pie-chart run typecheck",
      "typecheck:editor": "tsc -b editor/server && tsc -p editor/server/tsconfig.tools.json && pnpm --filter web run typecheck",
  ```

- [ ] 型検査を通す(`tsc -b editor/server` が先に shared/dist を作るので参照が解決する)。

  ```
  pnpm run typecheck:editor
  ```

  期待: exit 0。フェイクの型エラーが 0 件であること。

- [ ] カバレッジ閾値に影響しないことを確認する。`vitest.config.ts` の
  `coverage.include` は src 側のパス列挙で、`test/fakes/**` は含まれない(テスト資産なので
  含めない)。

  ```
  pnpm exec vitest run --project server --coverage.enabled=false
  ```

  期待: server 全件緑。

- [ ] コミットする。

  ```
  pnpm exec biome check --write editor/server/test editor/server/tsconfig.tools.json package.json
  git add editor/server/test/fakes editor/server/test/sprocFake.test.ts editor/server/tsconfig.tools.json package.json
  git commit -m "$(cat <<'EOF'
  test(editor): in-memory の sproc フェイクを足し、sproc の不変則を固定する

  ゲートウェイ 7 本 × 実際に呼ばれる 20 操作を Map で実装し、`createSprocClient` の実行面
  として差し込めるようにする。写すのは SQL ではなく不変則(PW初期化の同一操作内失効、
  PWリセットの全失効と要パスワード変更、作成の重複 50409、更新の NULL 据え置き、
  セッション取得の失効・期限条件、生成登録の冪等性)で、外すと rest e2e が偽の挙動を
  検証する。エラーは `number` 付きの生 SQL エラー相当で throw し、種別への変換は
  `mapSqlError` に任せる。フェイクと補助スクリプトの型は `tsconfig.tools.json`
  (noEmit)で検査し、`typecheck` と `typecheck:editor` の両方へ足す。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task D7: 移行用の別名を落とす

**Files:**
- `editor/server/src/db/sproc.ts`(D1 で足した `export const callSproc`)
- `editor/server/src/auth/session.ts`(D2 で足した `defaultStore` と 2 つの別名)
- `editor/server/test/sprocErrors.test.ts`(15 行目)

**Interfaces:**

Produces: なし(削除のみ)。`db/sproc.ts` の公開面は
`Param` / `Row` / `QueryFn` / `SprocClient` / `p` / `createSprocClient` / `realSproc` /
`firstRow` / 行値変換 7 種になる。`auth/session.ts` は `cookieOptions` / `sessionIdFrom` /
`SessionStore` / `createSessionStore` になる。

**Steps:**

- [ ] 残っている利用者を数える。

  ```
  git grep -n "from '.*db/sproc.js'" -- 'editor/server/src' 'editor/server/test'
  git grep -n "callSproc" -- 'editor/server/src'
  git grep -n "createSession\b\|destroySession\b" -- 'editor/server/src'
  ```

  期待: `src` 側の `callSproc` は `db/sproc.ts` の定義のみ。`createSession` /
  `destroySession` は `auth/session.ts` の `SessionStore` 実装と `authRepo.ts` の
  `sessionStore.*` 呼び出しのみ。`test` 側で `callSproc` を import しているのは
  `sprocErrors.test.ts` の 1 ファイル。

- [ ] `editor/server/test/sprocErrors.test.ts` の 15 行目を `realSproc` 経由へ変える。

  ```ts
    const { realSproc } = await import('../src/db/sproc.js');
    query.mockRejectedValueOnce(err);
    try {
      await realSproc.callSproc('usp_x', '作成');
  ```

- [ ] `editor/server/src/db/sproc.ts` から移行用の別名 1 行を削除する。

  ```ts
  // 削除する:
  // /** 注入をまだ受けていない呼び出し元のための別名。注入面が揃った時点で削除する。 */
  // export const callSproc: SprocClient['callSproc'] = realSproc.callSproc;
  ```

- [ ] `editor/server/src/auth/session.ts` の末尾から既定ストアの 3 行を削除する。

  ```ts
  // 削除する:
  // /** 注入を受けていない呼び出し元(`repositories/authRepo.ts`)のための既定ストア。 */
  // const defaultStore = createSessionStore(realSproc);
  // export const createSession = defaultStore.createSession;
  // export const destroySession = defaultStore.destroySession;
  ```

  併せて 11 行目の import から `realSproc` を落とす。

  ```ts
  import { firstRow, p, type SprocClient } from '../db/sproc.js';
  ```

- [ ] 型検査・server 全件・guard テストを明示的に走らせる。

  ```
  pnpm run typecheck
  pnpm exec vitest run --project server
  pnpm exec vitest run --project server test/guardCoverage test/routeGuards test/mustChangePassword test/config.security test/loginRateLimit test/confirmedWrite.guard test/sprocFake test/sprocClient
  ```

  期待: `typecheck` exit 0。server プロジェクトが全件緑。guard 群も全件緑
  (`config.security.test.ts` の `app.ts` 字面依存 —
  `const gateUrl = preAuthGateUrl(request);` — と `loginRateLimit.test.ts` の
  `trustProxy` 不在、`confirmedWrite.guard.test.ts` の import 集合を壊していないこと)。

- [ ] カバレッジ付きで editor 全体を通し、85% 閾値が維持されていることを見る。

  ```
  pnpm exec vitest run --project shared --project server --project "web-*" --coverage
  ```

  期待: 閾値エラーなし(`middleware/auth.ts` / `routes/routeGuards.ts` /
  `sync/noteMasterService.ts` は include 済みで、いずれも既存テストが被覆を維持する)。

- [ ] ビルドまで通す。

  ```
  pnpm run build:editor
  ```

  期待: exit 0。

- [ ] コミットする。

  ```
  pnpm exec biome check --write editor/server/src/db/sproc.ts editor/server/src/auth/session.ts editor/server/test/sprocErrors.test.ts
  git add editor/server/src/db/sproc.ts editor/server/src/auth/session.ts editor/server/test/sprocErrors.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(editor): 注入面が揃ったので sproc とセッションの移行用別名を落とす

  `db/sproc.ts` のモジュール直下 `callSproc` と `auth/session.ts` の既定ストア経由の
  `createSession` / `destroySession` を削除する。DB へ降りる経路は注入された
  `SprocClient` と `app.sessionStore` だけになり、テストが差し替え忘れた経路から実 DB へ
  届くことがなくなる。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

# 計画 B1 サブタスク E1〜E5 (e2e ヘルパー集約 / waitForTimeout 撤去 / 挙動 spec 追加 / 安定化ゲート)

前提: `docs/superpowers/plans/2026-09-06-ci-optimization-plan-b1.md` の Global Constraints、
`docs/superpowers/specs/2026-09-06-ci-optimization-design.md` 6.2/6.3/9/10 章、
`docs/コメント規約.md` に従う。対象は `editor/e2e/*.spec.ts` と `editor/playwright.config.ts`
のみ(sproc 注入・rest project は別タスク)。

現状の `waitForTimeout` 実測(このタスク着手時点):

| ファイル | 箇所数 | 備考 |
|---|---|---|
| `smoke.spec.ts:47` | 1 | 20 回リサイズ嵐の刺激間隔。**撤去しない**(6.2 の明示例外) |
| `capture_docs.spec.ts` | 15 | `39,66,102,110,118,122,126,132,137,144,152,175,187,193,209` |
| `note_bubble.spec.ts` | 17 | `33,43,54,58,61,67,72,74,78,83,86,93,102,108,112,119,123` |
| `comment_panel.spec.ts` / `review_tab.spec.ts` | 0 | 既に commit `be3f4e9` で状態待ちへ転換済み。**このタスクでは触らない** |

`capture_docs.spec.ts:39`(旧 `login()` 内部の 800ms)と `note_bubble.spec.ts:33`(同)は
E1 でヘルパーの本体ごと置き換わるため、E2/E3 で数える残数はそれぞれ 14 / 16 になる
(内訳は各タスクの表で確認する)。E1+E2+E3 で合計 32 箇所を撤去し、`smoke.spec.ts:47` の
1 箇所だけ残す — 6.2 の「40 箇所のうち 39」から `comment_panel`/`review_tab` 分を除いた残数と一致する。

---

### Task E1: `editor/e2e/helpers.ts` を新設し、8 spec の重複ヘルパーを集約する

**Files:**
- `editor/e2e/helpers.ts` (新規)
- `editor/e2e/canvas.spec.ts`
- `editor/e2e/comment_panel.spec.ts`
- `editor/e2e/review_tab.spec.ts`
- `editor/e2e/capture_docs.spec.ts`
- `editor/e2e/note_bubble.spec.ts`
- `editor/e2e/tabbed_layout.spec.ts`
- `editor/e2e/filter_bar_layout.spec.ts`
- `editor/e2e/header_layout.spec.ts`

**Interfaces (`helpers.ts` が export する 6 関数):**

```ts
export async function login(page: Page, user?: string, opts?: { clearSession?: boolean }): Promise<void>
export async function waitForLoaded(page: Page): Promise<void>
export async function openEditor(page: Page, id: string, query?: string): Promise<FrameLocator>
export async function waitForStableBox(page: Page, locator: Locator, timeout?: number): Promise<{ x: number; y: number; width: number; height: number } | null>
export async function expectSelectedPart(frame: FrameLocator): Promise<void>
export async function submitOnce(page: Page, id: string): Promise<void>
```

`submitOnce` は元の依頼リストに無いが、`review_tab.spec.ts`(既存)と新設の `approve.spec.ts`(E4)
の両方が同一実装を必要とするため、DRY の観点でここへ加える(理由は本タスクの手順内で明示する)。

全 fixture ユーザーは `username === password`(`admin`/`admin`、`approver`/`approver`)なので
`login` は `pass` 引数を持たない(`user` を両方へ渡す)。

#### 手順

- [ ] `editor/e2e/helpers.ts` を新規作成する。

  ```ts
  // =============================================================================
  // helpers.ts — e2e spec 間で重複していたログイン・canvas 初期化待ちの集約
  // =============================================================================
  // ログイン(8 spec に 3 変種)・GrapesJS canvas 初期化待ち・スクリーンショット用の寸法安定待ちは
  // spec ごとにわずかに異なる実装で重複していた。fixtures の運用(ログインID = パスワード)は
  // 全 spec で共通なので、ユーザー名だけ渡せば足りる形にまとめる。
  import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';

  /**
   * ログイン(fixtures はログインID = パスワード運用: `admin`/`admin` 等)。`clearSession` は
   * 同一テスト内で別ユーザーへ入り直す(承認タブの精査等)ときに使う — 認証済みのまま
   * `/login` へ行くと router guard がアプリへ押し戻すため、先にセッションを捨てる。
   * 未認証の初回ログインでも no-op になる(`/` が `/login` へリダイレクトし、
   * `localStorage.removeItem` は何も無くても安全)ため、既定で有効にしておく。
   */
  export async function login(
    page: Page,
    user = 'admin',
    { clearSession = true }: { clearSession?: boolean } = {},
  ): Promise<void> {
    if (clearSession) {
      await page.goto('/', { waitUntil: 'commit' });
      await page.waitForURL(/\/(login|edit|reviews)/);
      await page.evaluate(() => localStorage.removeItem('editor:session'));
    }
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('#u').waitFor();
    await page.locator('#u').fill(user);
    await page.locator('#p').fill(user);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/(edit|reviews)/);
    // `nav` はロール非依存で全ロールに出るアプリヘッダの一部(`MainLayout.vue`)。着地後の
    // レンダリングを待つのに固定待ちより確実。
    await page.locator('header nav a').first().waitFor();
  }

  /**
   * ロード中のスケルトンが消えるまで待つ。`animate-pulse` を持つのは `Skeleton.vue` だけなので、
   * 0 件 = 実データの描画完了。**画面遷移直後にそのまま呼ぶと、スケルトンがまだ 1 度も
   * 描画されていない瞬間を「0 件 = 完了」と誤認しうる**(`useAsyncResult` の `loading` は
   * 参照カウント式で初期値 false、スケルトン表示は `onMounted` の非同期処理が実際に走ってから)。
   * その画面固有の実データ要素を先に待ってから呼ぶこと(呼び出し側の責務)。
   */
  export async function waitForLoaded(page: Page): Promise<void> {
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  }

  /**
   * 編集画面を開き、GrapesJS canvas のページ描画まで待つ。`goto` の完了条件は `'commit'` にする。
   * 既定の `'load'` は全サブリソースの読み込み完了まで待つため、SPA が起動時に出す認証確認や
   * router のリダイレクトが割り込むと `net::ERR_ABORTED` で goto 自体が失敗する(負荷の高い CI で
   * 実際に踏んだ)。本当に待ちたいのは「canvas にページが描かれたか」で、それは下の `waitFor` が
   * 直接見ている。
   */
  export async function openEditor(page: Page, id: string, query = ''): Promise<FrameLocator> {
    await page.goto(`/edit/${encodeURIComponent(id)}${query}`, { waitUntil: 'commit' });
    const frame = page.frameLocator('iframe.gjs-frame');
    await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
    return frame;
  }

  /**
   * 要素の寸法が落ち着くまで待ち、その boundingBox を返す。可視化を待つだけでは足りない:
   * canvas のフォントが載る前は行の高さが確定せず、その寸法で `clip` を取ると内容が途中で
   * 切れた画像になる(CI の並列実行下で実際に起きた。単独実行では再現しない)。連続 2 回
   * 同じ寸法になったところを確定と見なす。ポーリングは `expect.poll` の retry 機構に委ね、
   * 固定間隔の手書きループは持たない。
   */
  export async function waitForStableBox(
    page: Page,
    locator: Locator,
    timeout = 20_000,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    let previousKey = '';
    let lastBox: Awaited<ReturnType<Locator['boundingBox']>> = null;
    await expect
      .poll(
        async () => {
          lastBox = await locator.boundingBox();
          const key = lastBox ? `${Math.round(lastBox.width)}x${Math.round(lastBox.height)}` : '';
          const stable = key !== '' && key === previousKey;
          previousKey = key;
          return stable;
        },
        { timeout, intervals: [300] },
      )
      .toBe(true);
    return lastBox;
  }

  /**
   * canvas 内でパーツが選択状態になったことを待つ。`.gjs-selected` は GrapesJS が選択中の
   * component の DOM 要素へ自動で付与する既定クラス(アプリ側の改修不要)で、固定待ちより
   * 選択の完了を確実に検知できる。
   */
  export async function expectSelectedPart(frame: FrameLocator): Promise<void> {
    await expect(frame.locator('.gjs-selected')).toBeVisible({ timeout: 10_000 });
  }

  /**
   * プレビュー画面から確定保存を申請する(`review_tab.spec.ts` と `capture_docs.spec.ts` の
   * 重複実装を集約)。トースト「確定保存を申請しました」の出現を申請完了の合図にする。
   */
  export async function submitOnce(page: Page, id: string): Promise<void> {
    await page.goto(`/preview/${encodeURIComponent(id)}`);
    await page
      .frameLocator('iframe[title="プレビュー"]')
      .locator('[data-vivliostyle-page-container]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByRole('button', { name: '確定保存を申請' }).click();
    await page.getByRole('button', { name: '申請する' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
    ).toBeVisible();
  }
  ```

- [ ] `editor/e2e/canvas.spec.ts` — ローカル `login`(L14-20)と `openEditor`(L22-36)を削除し
      import へ差し替える。

  old (L1-36 の該当部分):
  ```ts
  import { expect, type Page, test } from '@playwright/test';

  const SEED_ID = 'AM01_510037_20240710_交付版';

  test.use({ viewport: { width: 1440, height: 900 } });

  async function login(page: Page) {
    await page.goto('/login');
    await page.locator('#u').fill('admin');
    await page.locator('#p').fill('admin');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/(edit|reviews)/);
  }

  /**
   * 編集画面を開き、GrapesJS canvas のページ描画まで待つ。
   * ...(docstring)
   */
  async function openEditor(page: Page, query = '') {
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}${query}`, { waitUntil: 'commit' });
    const frame = page.frameLocator('iframe.gjs-frame');
    await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
    return frame;
  }
  ```
  new:
  ```ts
  import { expect, test } from '@playwright/test';
  import { login, openEditor as openEditorAt } from './helpers';

  const SEED_ID = 'AM01_510037_20240710_交付版';

  test.use({ viewport: { width: 1440, height: 900 } });

  /** このファイルは常に seed テンプレを開くので、id を省略できる薄いラッパーに保つ。 */
  const openEditor = (page: Parameters<typeof openEditorAt>[0], query = '') =>
    openEditorAt(page, SEED_ID, query);
  ```
  以降の呼び出し(`login(page)`・`openEditor(page)`・`openEditor(page, '?created=1')`)は無改修。
  `Page` の型 import が不要になった場合は biome の未使用 import 検査に従って外す
  (`appendToParagraph` 等の関数シグネチャで `Page` を使い続けているため、実際には残す —
  ファイル内の他関数の型注釈を確認してから import 文を確定させること)。

- [ ] `editor/e2e/comment_panel.spec.ts` — ローカル `login`(L12-24)を削除し、
      `page.goto` + 手書き frame 待ち(L40-46)を `openEditor` へ集約する。

  old:
  ```ts
  async function login(page: Page): Promise<void> {
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/(login|edit|reviews)/);
    await page.evaluate(() => localStorage.removeItem('editor:session'));
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('#u').waitFor();
    await page.locator('#u').fill('admin');
    await page.locator('#p').fill('admin');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/(edit|reviews)/);
    // 着地後のレンダリングをアプリヘッダの `nav`(全ロールに出る)で待つ。固定待ちより確実。
    await page.locator('header nav a').first().waitFor();
  }
  ```
  ```ts
  test('コメント一覧は検索・状態で絞り込め、行クリックでパーツを選択する', async ({ page }) => {
    await login(page);
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
    // GrapesJS canvas の初期化完了(1 ページ目が描画済み)を待つ。
    await page
      .frameLocator('iframe.gjs-frame')
      .locator('.page')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-pane-tab="comments"]').click();
  ```
  new:
  ```ts
  import { login, openEditor } from './helpers';
  ```
  ```ts
  test('コメント一覧は検索・状態で絞り込め、行クリックでパーツを選択する', async ({ page }) => {
    await login(page);
    await openEditor(page, SEED_ID);
    await page.locator('[data-pane-tab="comments"]').click();
  ```
  (`addComment` 内の `frame = page.frameLocator('iframe.gjs-frame')` は独立実装のままでよい
  — `openEditor` の戻り値を使わず毎回 fresh に取り直しても等価)。

- [ ] `editor/e2e/review_tab.spec.ts` — ローカル `login`(L12-25)・`submitOnce`(L27-41)・
      `waitForCanvasReady`(L43-51)を削除し import へ差し替える。3 箇所の
      `page.goto(...); await waitForCanvasReady(page);` を `await openEditor(page, SEED_ID);`
      へまとめる(L64-65 / L132-133 / L148-149)。

  old (関数定義 3 つ、L12-51 相当) → 削除し:
  ```ts
  import { login, openEditor, submitOnce } from './helpers';
  ```
  呼び出し側 3 箇所、例えば L64-66:
  ```ts
  old:
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
    await waitForCanvasReady(page);
    await page.getByRole('link', { name: '承認' }).click();
  new:
    await openEditor(page, SEED_ID);
    await page.getByRole('link', { name: '承認' }).click();
  ```
  `submitOnce(page)` の呼び出し 2 箇所(L57-58)は `submitOnce(page, SEED_ID)` に引数を追加する。

- [ ] `editor/e2e/capture_docs.spec.ts` — ローカル `login`(L22-40)・`waitForLoaded`(L48-50)・
      `waitForStableBox`(L58-69)を削除し import へ差し替える。`waitForPreviewPage`(L80-86)は
      このファイル固有のまま残す(他 spec と重複していない)。

  old import 行:
  ```ts
  import { expect, type Locator, type Page, test } from '@playwright/test';
  ```
  new:
  ```ts
  import { expect, type Page, test } from '@playwright/test';
  import { login, waitForLoaded, waitForStableBox } from './helpers';
  ```
  呼び出し側の引数を新シグネチャ(`user` 単発)に合わせる: L94 `login(page, 'admin', 'admin')`
  → `login(page, 'admin')`。L182 も同様。L191 `login(page, 'approver', 'approver')` →
  `login(page, 'approver')`。
  (`waitForLoaded`/`waitForStableBox` の呼び出し箇所自体は無改修 — E3 でさらに手を入れる)。

- [ ] `editor/e2e/note_bubble.spec.ts` — ローカル `login`(L18-34)を削除し import へ差し替える。

  old:
  ```ts
  import { expect, type Page, test } from '@playwright/test';

  const SEED_ID = 'AM01_510037_20240710_交付版';

  test.use({ viewport: { width: 1440, height: 900 } });

  async function login(page: Page): Promise<void> {
    // ...(docstring)
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/(login|edit|reviews)/);
    await page.evaluate(() => localStorage.removeItem('editor:session'));
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('#u').waitFor();
    await page.locator('#u').fill('admin');
    await page.locator('#p').fill('admin');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/(edit|reviews)/);
    await page.waitForTimeout(800);
  }
  ```
  new:
  ```ts
  import { expect, test } from '@playwright/test';
  import { login } from './helpers';

  const SEED_ID = 'AM01_510037_20240710_交付版';

  test.use({ viewport: { width: 1440, height: 900 } });
  ```
  呼び出し側 `await login(page);` は無改修(2 箇所)。`openEditor`/`expectSelectedPart` の import
  追加と goto/timeout の置換自体は **E2 の作業**(このタスクではしない)。

- [ ] `editor/e2e/tabbed_layout.spec.ts` — ローカル `login`(L17-27)と `openEditor`(L29-34)を
      削除し import へ差し替える。

  old:
  ```ts
  async function login(page: Page) {
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/(login|edit|reviews)/);
    await page.evaluate(() => localStorage.removeItem('editor:session'));
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('#u').waitFor();
    await page.locator('#u').fill('admin');
    await page.locator('#p').fill('admin');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/(edit|reviews)/);
  }

  async function openEditor(page: Page, query = '') {
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}${query}`, { waitUntil: 'commit' });
    const frame = page.frameLocator('iframe.gjs-frame');
    await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
    return frame;
  }
  ```
  new:
  ```ts
  import { login, openEditor as openEditorAt } from './helpers';

  const openEditor = (page: Page, query = '') => openEditorAt(page, SEED_ID, query);
  ```
  (`Page` 型 import は既存の `page.on('dialog', ...)` 等で使い続けるため残す)。

- [ ] `editor/e2e/filter_bar_layout.spec.ts` — ローカル `login`(L12-22)を削除し import へ
      差し替える。呼び出し側は無改修。

- [ ] `editor/e2e/header_layout.spec.ts` — ローカル `login`(L21-31)を削除して import へ
      差し替え、`openLongNameEditor`(L58-62)の実装を `openEditor` 呼び出しへ簡約する。

  old:
  ```ts
  async function login(page: Page) {
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForURL(/\/(login|edit|reviews)/);
    await page.evaluate(() => localStorage.removeItem('editor:session'));
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('#u').waitFor();
    await page.locator('#u').fill('admin');
    await page.locator('#p').fill('admin');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/(edit|reviews)/);
  }
  ```
  ```ts
  async function openLongNameEditor(page: Page) {
    await login(page);
    await page.goto(`/edit/${encodeURIComponent(LONG_NAME_ID)}`, { waitUntil: 'commit' });
    await page.frameLocator('iframe.gjs-frame').locator('.page').first().waitFor({ timeout: 30_000 });
  }
  ```
  new:
  ```ts
  import { login, openEditor } from './helpers';
  ```
  ```ts
  async function openLongNameEditor(page: Page) {
    await login(page);
    await openEditor(page, LONG_NAME_ID);
  }
  ```

- [ ] `editor/**` を変更したので biome を先行実行する:
      `pnpm exec biome check --write editor/e2e`
- [ ] 型検査: `pnpm run typecheck:editor`
- [ ] 実行して回帰が無いことを確認する:
      `pnpm exec playwright test -c editor/playwright.config.ts --project chromium`
      → 期待値: 35 件全部 passed(内訳は `chromium` project の既存 spec 一式。件数は
      `pnpm run test:e2e` の従来実績 35 件と一致することを確認する。差異が出たら
      import/呼び出し側の取りこぼしを疑う)。
- [ ] commit する。

  ```
  git add editor/e2e/helpers.ts editor/e2e/canvas.spec.ts editor/e2e/comment_panel.spec.ts \
    editor/e2e/review_tab.spec.ts editor/e2e/capture_docs.spec.ts editor/e2e/note_bubble.spec.ts \
    editor/e2e/tabbed_layout.spec.ts editor/e2e/filter_bar_layout.spec.ts editor/e2e/header_layout.spec.ts
  git commit -m "$(cat <<'EOF'
  test(editor): e2e のログイン・canvas 待ちヘルパーを helpers.ts へ集約する

  8 spec に 3 変種で重複していたログイン処理と GrapesJS canvas 初期化待ちを
  editor/e2e/helpers.ts へ一本化する。waitForTimeout の撤去(次コミット以降)に先立ち、
  まず状態待ちの実装そのものを 1 箇所にする。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task E2: `note_bubble.spec.ts` の残り 16 箇所を状態待ちへ置き換える

**Files:** `editor/e2e/note_bubble.spec.ts`

E1 で `login` 内の 800ms(旧 L33)は既に消えている。残る 16 箇所(旧行番号)を次のとおり処理する。

| 旧行 | 処理 |
|---|---|
| 43 | `openEditor` へ集約(goto+timeout+frame 宣言を 1 行に) |
| 54 | `.gjs-selected` 待ち(`expectSelectedPart`) |
| 58, 61 | 次の投稿確認 `toHaveCount` を都度 assert して削除(2 箇所を 1 パターンで解消) |
| 67 | 次の `expect(draft).toHaveValue('')` が既に条件待ち → 削除 |
| 72 | `.gjs-selected` 待ち(`expectSelectedPart`) |
| 74, 78, 83, 86, 93 | 直後の `expect` が既に条件待ち → 削除 |
| 102 | `openEditor` へ集約 |
| 108 | `.gjs-selected` 待ち |
| 112, 119, 123 | 直後の `expect` が既に条件待ち → 削除 |

#### 手順

- [ ] import 行を更新する。

  old: `import { login } from './helpers';`
  new: `import { expectSelectedPart, login, openEditor } from './helpers';`

- [ ] test 1(`メモ吹き出しは閉じる・編集・削除を実際に受け付ける`)冒頭を書き換える(旧 L40-45)。

  old:
  ```ts
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  // GrapesJS の初期化とキャンバス描画を待つ(`capture_docs.spec.ts` と同じ理由)。
  await page.waitForTimeout(3000);

  const frame = page.frameLocator('iframe.gjs-frame');
  const draft = page.getByPlaceholder('このパーツへのコメントを書く');
  ```
  new:
  ```ts
  await login(page);
  const frame = await openEditor(page, SEED_ID);
  const draft = page.getByPlaceholder('このパーツへのコメントを書く');
  ```

- [ ] パーツ A クリック直後(旧 L53-55)。

  old:
  ```ts
  await partA.click();
  await page.waitForTimeout(600);
  await page.locator('[data-pane-tab="comments"]').click();
  ```
  new:
  ```ts
  await partA.click();
  await expectSelectedPart(frame);
  await page.locator('[data-pane-tab="comments"]').click();
  ```

- [ ] 2 件投稿(旧 L56-62)。1 件ごとに件数を確認してから次を書く形にし、末尾の
      `toHaveCount(2)` は既存のまま活かす。

  old:
  ```ts
  await draft.fill('1 件目のメモ。');
  await addButton.click();
  await page.waitForTimeout(800);
  await draft.fill('2 件目のメモ。');
  await addButton.click();
  await page.waitForTimeout(1000);
  await expect(bubble.locator('.note-entry-body')).toHaveCount(2);
  ```
  new:
  ```ts
  await draft.fill('1 件目のメモ。');
  await addButton.click();
  await expect(bubble.locator('.note-entry-body')).toHaveCount(1);
  await draft.fill('2 件目のメモ。');
  await addButton.click();
  await expect(bubble.locator('.note-entry-body')).toHaveCount(2);
  ```

- [ ] 下書き破棄の確認(旧 L64-68)。

  old:
  ```ts
  await draft.fill('書きかけの下書き');
  await frame.locator('.page > *').nth(2).click();
  await page.waitForTimeout(1500);
  await expect(draft).toHaveValue('');
  ```
  new:
  ```ts
  await draft.fill('書きかけの下書き');
  await frame.locator('.page > *').nth(2).click();
  await expect(draft).toHaveValue('');
  ```

- [ ] 閉じた吹き出しの再選択〜再オープン(旧 L70-79)。

  old:
  ```ts
  await partA.click();
  await page.waitForTimeout(1500);
  await bubble.getByRole('button', { name: 'コメントを閉じる' }).click();
  await page.waitForTimeout(400);
  await expect(bubble).toHaveCount(0);
  await draft.fill('閉じた状態で足したメモ。');
  await addButton.click();
  await page.waitForTimeout(1200);
  await expect(bubble).toHaveCount(1);
  ```
  new:
  ```ts
  await partA.click();
  await expectSelectedPart(frame);
  await bubble.getByRole('button', { name: 'コメントを閉じる' }).click();
  await expect(bubble).toHaveCount(0);
  await draft.fill('閉じた状態で足したメモ。');
  await addButton.click();
  await expect(bubble).toHaveCount(1);
  ```

- [ ] 編集(旧 L81-87)。

  old:
  ```ts
  await bubble.getByRole('button', { name: 'このコメントを編集' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.note-entry-input').fill('編集後の本文。');
  await bubble.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(bubble.getByText('編集後の本文。')).toHaveCount(1);
  ```
  new:
  ```ts
  await bubble.getByRole('button', { name: 'このコメントを編集' }).first().click();
  await page.locator('.note-entry-input').fill('編集後の本文。');
  await bubble.getByRole('button', { name: '保存', exact: true }).click();
  await expect(bubble.getByText('編集後の本文。')).toHaveCount(1);
  ```

- [ ] 削除(旧 L89-96)。

  old:
  ```ts
  const before = await bubble.locator('.note-entry-body').count();
  await bubble.getByRole('button', { name: 'このコメントを削除' }).first().click();
  await page.getByRole('button', { name: '削除する' }).click();
  await page.waitForTimeout(1200);
  await expect(bubble.locator('.note-entry-body')).toHaveCount(before - 1);
  ```
  new:
  ```ts
  const before = await bubble.locator('.note-entry-body').count();
  await bubble.getByRole('button', { name: 'このコメントを削除' }).first().click();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(bubble.locator('.note-entry-body')).toHaveCount(before - 1);
  ```

- [ ] test 2(`吹き出しから返信と解決ができ、マーカーが灰色になる`)冒頭(旧 L100-105)。

  old:
  ```ts
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(3000);

  const frame = page.frameLocator('iframe.gjs-frame');
  const part = frame.locator('.page > *').nth(4);
  ```
  new:
  ```ts
  await login(page);
  const frame = await openEditor(page, SEED_ID);
  const part = frame.locator('.page > *').nth(4);
  ```

- [ ] パーツクリック直後(旧 L107-109)。

  old:
  ```ts
  await part.click();
  await page.waitForTimeout(600);
  await page.locator('[data-pane-tab="comments"]').click();
  ```
  new:
  ```ts
  await part.click();
  await expectSelectedPart(frame);
  await page.locator('[data-pane-tab="comments"]').click();
  ```

- [ ] 親コメント投稿後(旧 L110-115)。

  old:
  ```ts
  await page.getByPlaceholder('このパーツへのコメントを書く').fill('親コメント');
  await page.locator('button[data-add-submit]').click();
  await page.waitForTimeout(800);

  const bubble = page.locator('.note-bubble');
  await expect(bubble).toBeVisible();
  ```
  new:
  ```ts
  await page.getByPlaceholder('このパーツへのコメントを書く').fill('親コメント');
  await page.locator('button[data-add-submit]').click();

  const bubble = page.locator('.note-bubble');
  await expect(bubble).toBeVisible();
  ```

- [ ] 返信・解決(旧 L116-125)。

  old:
  ```ts
  await bubble.getByRole('button', { name: '返信する' }).click();
  await bubble.locator('[data-bubble-reply]').fill('返信です');
  await bubble.getByRole('button', { name: '返信', exact: true }).click();
  await page.waitForTimeout(800);
  await expect(bubble.locator('[data-note-reply]')).toHaveCount(1);

  await bubble.getByRole('button', { name: '解決にする' }).click();
  await page.waitForTimeout(800);
  await expect(page.locator('.note-marker.note-marker-resolved')).toHaveCount(1);
  ```
  new:
  ```ts
  await bubble.getByRole('button', { name: '返信する' }).click();
  await bubble.locator('[data-bubble-reply]').fill('返信です');
  await bubble.getByRole('button', { name: '返信', exact: true }).click();
  await expect(bubble.locator('[data-note-reply]')).toHaveCount(1);

  await bubble.getByRole('button', { name: '解決にする' }).click();
  await expect(page.locator('.note-marker.note-marker-resolved')).toHaveCount(1);
  ```

- [ ] `grep -n waitForTimeout editor/e2e/note_bubble.spec.ts` で 0 件になったことを確認する。
- [ ] `pnpm exec biome check --write editor/e2e/note_bubble.spec.ts`
- [ ] `pnpm exec playwright test -c editor/playwright.config.ts --project chromium note_bubble`
      → 期待値: 2 件 passed(単独実行では canvas 描画のタイミングが変わりうるため、
      単発の green だけでは確定させない。E5 の 3 連続緑で最終確認する)。
- [ ] commit する。

  ```
  git add editor/e2e/note_bubble.spec.ts
  git commit -m "$(cat <<'EOF'
  test(editor): note_bubble の固定待ちを状態待ちへ置き換える

  吹き出しの開閉・編集・削除・返信・解決の各操作後、次の操作や assertion が既に
  結果を待つ形になっている固定待ちは削除し、canvas 初期化とパーツ選択は
  helpers.ts の openEditor / expectSelectedPart(GrapesJS 既定クラス .gjs-selected)
  を使う状態待ちへ置き換える。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task E3: `capture_docs.spec.ts` の残り 14 箇所を状態待ちへ置き換える(docs project)

**Files:** `editor/e2e/capture_docs.spec.ts`

E1 で `login` 内の 800ms(旧 L39)は既に消えている。残る 14 箇所を扱う。うち 5 箇所
(旧 L102, 110, 118, 122, 126)は「タブ遷移直後の 600ms」で、`waitForLoaded` 単体では
壊れうる(スケルトンが 1 度も描画されない一瞬を「完了」と誤認しうる — `useAsyncResult`
の `loading` は参照カウント式で初期値 false)。そのタブ固有の実データ要素を先に待つ形にする。

| タブ | 待ち先 |
|---|---|
| 編集タブ(`/edit`) | `page.getByText('委託会社コード')`(`SearchFilters` 描画。`filter_bar_layout.spec.ts` と同じ марker) |
| テンプレート作成タブ | `page.getByText('作成するファンドを指定')`(`CreateTabView` Step1 見出し) |
| 比較タブ | `page.getByText('委託会社コード')` |
| 履歴タブ | `page.getByRole('button', { name: '編集履歴' })`(タブ切替ボタン。この画面は
  `loading` の初期値が `true` なので後続の `waitForLoaded` はそのまま活かす) |
| 管理者画面 | `page.getByText('ユーザー管理')` の見出しに加え、この画面はスケルトンを
  一切描画しないため `waitForLoaded` は無意味 — 実データ(seed の `admin` 行)を直接待つ |

#### 手順

- [ ] import 行に `openEditor` を追加する。

  old: `import { login, waitForLoaded, waitForStableBox } from './helpers';`
  new: `import { login, openEditor, waitForLoaded, waitForStableBox } from './helpers';`

- [ ] 編集タブ(旧 L101-103)。

  old:
  ```ts
  await page.goto('/edit');
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  ```
  new:
  ```ts
  await page.goto('/edit');
  await page.getByText('委託会社コード').first().waitFor();
  await waitForLoaded(page);
  ```

- [ ] テンプレート作成タブ(旧 L109-111)。

  old:
  ```ts
  await page.getByRole('link', { name: 'テンプレート作成' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  ```
  new:
  ```ts
  await page.getByRole('link', { name: 'テンプレート作成' }).click();
  await page.getByText('作成するファンドを指定').first().waitFor();
  await waitForLoaded(page);
  ```

- [ ] 比較タブ(旧 L117-119)。

  old:
  ```ts
  await page.getByRole('link', { name: '比較' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  ```
  new:
  ```ts
  await page.getByRole('link', { name: '比較' }).click();
  await page.getByText('委託会社コード').first().waitFor();
  await waitForLoaded(page);
  ```

- [ ] 履歴タブ(旧 L121-123)。

  old:
  ```ts
  await page.getByRole('link', { name: '履歴' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  ```
  new:
  ```ts
  await page.getByRole('link', { name: '履歴' }).click();
  await page.getByRole('button', { name: '編集履歴' }).waitFor();
  await waitForLoaded(page);
  ```

- [ ] 管理者画面(旧 L125-127)。

  old:
  ```ts
  await page.getByRole('link', { name: '管理者' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  ```
  new:
  ```ts
  await page.getByRole('link', { name: '管理者' }).click();
  await page.getByText('ユーザー管理').first().waitFor();
  // この画面はスケルトンを描画しないため waitForLoaded は無意味(常に 0 件で即完了扱いになる)。
  // seed の実データ(admin 行)が描画されたことを直接待つ。
  await page.getByText('admin', { exact: true }).first().waitFor();
  ```

- [ ] 編集画面 canvas(旧 L130-133)。`openEditor` へ置き換え、以降の `frame` 宣言(旧 L145)を
      戻り値へ差し替える。

  old:
  ```ts
  // ③ 編集画面（seed テンプレを直接開く）
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(2500); // GrapesJS の初期化・キャンバス描画を待つ
  await page.screenshot({ path: IMG('editor.png') });

  // ③b 左パネル: パーツを追加（分類カスケードとカタログが開いた状態）
  await page.getByText('パーツを追加', { exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: IMG('editor-parts.png') });
  await page.getByText('パーツを追加', { exact: true }).click(); // 閉じて戻す

  // ③c 編集を許可 → キャンバス中程のブロックを選択してハンドルを見せる
  // (frame 内要素の boundingBox はページ座標で返るので、そのまま clip に使える)
  await page.getByText('編集を許可', { exact: true }).click();
  await page.waitForTimeout(400);
  const frame = page.frameLocator('iframe.gjs-frame');
  const block = frame.locator('.page > *').nth(2);
  // キャンバスの描画が終わる前に掴むと、ブロックが最終寸法になっておらず clip が
  // 小さく切れる(内容の欠けた画像がそのまま手引きへ載る)。可視化と寸法の確定を待つ。
  await block.waitFor({ state: 'visible', timeout: 30_000 });
  await waitForStableBox(page, block);
  await block.click();
  await page.waitForTimeout(600);
  const box = await waitForStableBox(page, block);
  ```
  new:
  ```ts
  // ③ 編集画面（seed テンプレを直接開く）
  const editorFrame = await openEditor(page, SEED_ID);
  await page.screenshot({ path: IMG('editor.png') });

  // ③b 左パネル: パーツを追加（分類カスケードとカタログが開いた状態）
  await page.getByText('パーツを追加', { exact: true }).click();
  // `PartCatalog` は onMounted でパーツ一覧を取得する。読み込み中は「読み込み中…」を
  // 出すので、その消滅(=一覧確定)を待つ。
  await expect(page.getByText('読み込み中…')).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({ path: IMG('editor-parts.png') });
  await page.getByText('パーツを追加', { exact: true }).click(); // 閉じて戻す

  // ③c 編集を許可 → キャンバス中程のブロックを選択してハンドルを見せる
  // (frame 内要素の boundingBox はページ座標で返るので、そのまま clip に使える)
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  const frame = editorFrame;
  const block = frame.locator('.page > *').nth(2);
  // キャンバスの描画が終わる前に掴むと、ブロックが最終寸法になっておらず clip が
  // 小さく切れる(内容の欠けた画像がそのまま手引きへ載る)。可視化と寸法の確定を待つ。
  await block.waitFor({ state: 'visible', timeout: 30_000 });
  await waitForStableBox(page, block);
  await block.click();
  const box = await waitForStableBox(page, block);
  ```

- [ ] プレビュー画面(旧 L173-176)。組版後の微小な再レイアウトはページ容器の
      `waitForStableBox` で吸収する。

  old:
  ```ts
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await waitForPreviewPage(page);
  await page.waitForTimeout(500); // 組版確定後の微小な再レイアウトを吸収する
  await page.screenshot({ path: IMG('preview.png') });
  ```
  new:
  ```ts
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await waitForPreviewPage(page);
  await waitForStableBox(
    page,
    page.frameLocator('iframe[title="プレビュー"]').locator('[data-vivliostyle-page-container]:visible').first(),
  );
  await page.screenshot({ path: IMG('preview.png') });
  ```

- [ ] 申請直後(旧 L185-187、2 つ目のテスト)。トースト出現を合図にする
      (`review_tab.spec.ts` の `submitOnce` と同じ idiom)。

  old:
  ```ts
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await page.waitForTimeout(1000);
  ```
  new:
  ```ts
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
  ).toBeVisible();
  ```

- [ ] approver 再ログイン直後(旧 L191-193)。次の `waitForLoaded` と `[data-review-item]` 待ちが
      既に実データを待つため、単純削除する。

  old:
  ```ts
  await login(page, 'approver');
  await page.goto(`/reviews?template=${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(800);
  await waitForLoaded(page);
  await page.locator('[data-review-item]').first().waitFor();
  ```
  new:
  ```ts
  await login(page, 'approver');
  await page.goto(`/reviews?template=${encodeURIComponent(SEED_ID)}`);
  await waitForLoaded(page);
  await page.locator('[data-review-item]').first().waitFor();
  ```

- [ ] 見た目比較の組版確定(旧 L196-209)。2 面それぞれに `waitForStableBox` を追加し、
      末尾の固定 500ms を削除する。

  old:
  ```ts
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .first()
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .nth(1)
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: IMG('reviews-list.png') });
  ```
  new:
  ```ts
  const compareFirst = page
    .frameLocator('iframe[title="プレビュー"]')
    .first()
    .locator('[data-vivliostyle-page-container]:visible')
    .first();
  const compareSecond = page
    .frameLocator('iframe[title="プレビュー"]')
    .nth(1)
    .locator('[data-vivliostyle-page-container]:visible')
    .first();
  await compareFirst.waitFor({ state: 'visible', timeout: 60_000 });
  await compareSecond.waitFor({ state: 'visible', timeout: 60_000 });
  await waitForStableBox(page, compareFirst);
  await waitForStableBox(page, compareSecond);
  await page.screenshot({ path: IMG('reviews-list.png') });
  ```

- [ ] `grep -n waitForTimeout editor/e2e/capture_docs.spec.ts` で 0 件になったことを確認する。
- [ ] `pnpm exec biome check --write editor/e2e/capture_docs.spec.ts`
- [ ] 実行して画像が再生成されることを確認する:
      `pnpm exec playwright test -c editor/playwright.config.ts --project docs`
      → 期待値: 2 件 passed。`git status docs/editor/images` で png の差分(再撮影)が出る
      ことを確認する(バイト差分は「再撮影」としてこのタスクの commit に含める)。
- [ ] `py -3.13 docs/_build/build_all.py --project editor` を実行し、再撮影した画像を
      手引き HTML へ反映する(`docs/コメント規約.md` に基づく既存運用。画像が変わった
      HTML は base64 埋め込みのため自動追随しない)。
- [ ] commit する(spec の変更と再撮影画像・再ビルド HTML を同一コミットにする)。

  ```
  git add editor/e2e/capture_docs.spec.ts docs/editor/images docs/editor/*.html
  git commit -m "$(cat <<'EOF'
  test(editor): capture_docs の固定待ちを状態待ちへ置き換え、画面を再撮影する

  タブ遷移直後の固定待ちは、スケルトンが 1 度も描画されない一瞬を「読み込み完了」と
  誤認しうる(useAsyncResult の loading は初期値 false)。各タブ固有の実データ要素
  (絞り込みバーの見出し・タブボタン・一覧行)を先に待つ形へ直し、canvas 初期化と
  組版後の再レイアウトは helpers.ts の openEditor / waitForStableBox を使う状態待ち
  へ置き換える。挙動を変えたため docs/editor/images を再撮影し、手引き HTML を
  作り直す。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task E4: 未到達の画面へ挙動 spec を追加する(結合PDF / 承認 / 作成)

**Files:**
- `editor/e2e/merge.spec.ts` (新規)
- `editor/e2e/approve.spec.ts` (新規)
- `editor/e2e/create.spec.ts` (新規)

いずれも `chromium` project(local モード)で走る。`waitForTimeout` は使わない。

#### E4a. `merge.spec.ts`

結合PDF タブは local モードでも実サーバの `POST /api/build/merge` を叩く
(`mergePdfService.ts` L54-58)ため、`page.route` で止めないと vivliostyle CLI が実走してしまう
(設計正典 6.3)。要求本文の文書の並び順を検証する。

- [ ] `editor/e2e/merge.spec.ts` を新規作成する。

  ```ts
  // =============================================================================
  // merge.spec.ts — 結合PDF タブが選んだ順序で /api/build/merge を呼ぶことの回帰網
  // =============================================================================
  // local モードでも `mergePdfService` は実サーバの `POST /api/build/merge` を叩くため、
  // `page.route` で止めないと vivliostyle CLI が実際に走ってしまう(設計正典 6.3)。
  // ここでは要求本文の文書順序(= 追加順)だけを検証し、PDF の実生成はしない。
  import { expect, test } from '@playwright/test';
  import { login } from './helpers';

  test.use({ viewport: { width: 1440, height: 900 } });

  test('結合PDF: 追加した順に文書が並んで /api/build/merge へ送られる', async ({ page }) => {
    await login(page);

    let requestBody: { documents: { html: string; css: string }[] } | null = null;
    await page.route('**/api/build/merge', async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 fake'),
      });
    });

    await page.goto('/merge', { waitUntil: 'commit' });
    await page.getByText('委託会社コード').first().waitFor();
    await page.getByPlaceholder('委託会社コードを入力/選択').click();
    await page.getByRole('option', { name: 'AM01', exact: true }).click();
    await page.getByRole('button', { name: '検索' }).click();

    // 510155 を先に、510037 を後に追加する(結合順 = 追加順であることを本文の並びで確かめる)。
    const rowLate = page.locator('tbody tr', { hasText: '510155' });
    const rowEarly = page.locator('tbody tr', { hasText: '510037' }).first();
    await expect(rowLate).toBeVisible();

    await rowLate.getByRole('button', { name: '追加' }).click();
    await expect(page.getByText('結合する順序(1件)')).toBeVisible();
    await rowEarly.getByRole('button', { name: '追加' }).click();
    await expect(page.getByText('結合する順序(2件)')).toBeVisible();

    await page.getByRole('button', { name: 'PDF 出力' }).click();
    await expect.poll(() => requestBody?.documents.length ?? 0).toBe(2);
    expect(requestBody?.documents[0].html).toContain('510155');
    expect(requestBody?.documents[1].html).toContain('510037');
  });
  ```

#### E4b. `approve.spec.ts`

`review_tab.spec.ts` は却下しか固定していない。`localReviewRepo.approveReview` は実装済みで
未検証のため、承認による決着を別ファイルで固定する。

- [ ] `editor/e2e/approve.spec.ts` を新規作成する。

  ```ts
  // =============================================================================
  // approve.spec.ts — 承認タブの「承認する」が申請を決着させることの回帰網
  // =============================================================================
  // `review_tab.spec.ts` は却下(差し戻し)のみを固定しているため、承認自体の決着
  // (既定フィルタの承認待ちから外れ、承認済みバッジ + 承認者・日時の表示に変わる)を
  // ここで押さえる。
  import { expect, test } from '@playwright/test';
  import { login, submitOnce } from './helpers';

  const SEED_ID = 'AM01_510037_20240710_交付版';

  test.use({ viewport: { width: 1440, height: 900 } });

  test('承認タブの「承認する」で区画が決着済み表示に変わる', async ({ page }) => {
    await login(page, 'admin');
    await submitOnce(page, SEED_ID);

    await login(page, 'approver');
    await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
    await page
      .frameLocator('iframe.gjs-frame')
      .locator('.page')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('link', { name: '承認' }).click();

    await expect(page.locator('[data-summary="pending"]')).toContainText('1');
    const item = page.locator('[data-review-item]').first();
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: '承認する' }).click();

    // 決着後は既定フィルタ(承認待ち)からこの申請が外れ、要約箱の件数が動く。
    await expect(page.locator('[data-summary="pending"]')).toContainText('0');
    await expect(page.locator('[data-summary="approved"]')).toContainText('1');
    await expect(page.locator('[data-review-item]')).toHaveCount(0);

    // 「承認済み」の箱を押すと決着済み表示(承認済みバッジ + 承認者・日時)で 1 件出る。
    await page.locator('[data-summary="approved"]').click();
    const decided = page.locator('[data-review-item]').first();
    await expect(decided).toContainText('承認済み');
    await expect(decided).toContainText('精査花子'); // approver の displayName(fixtures)
  });
  ```

#### E4c. `create.spec.ts`

作成タブの「属性から新規作成」は `localTemplateRepo.generate` を直接呼び、`/api/generate` を
経由しない(`templateCreationService.ts`)。属性選択 → 即時遷移 → ハイライト表示を固定する。

- [ ] `editor/e2e/create.spec.ts` を新規作成する。

  ```ts
  // =============================================================================
  // create.spec.ts — 作成タブの属性選択から ?created=1 の編集画面へ到達することの回帰網
  // =============================================================================
  // 「属性から新規作成」は localTemplateRepo.generate を直接呼ぶ(/api/generate 不要)ため、
  // ネットワーク待ちが無く即座に編集画面へ遷移する。作成経路(?created=1)= 差し込み値
  // ハイライト有りであることを実画面で固定する(設計正典「編集 2 系統」)。
  import { expect, test } from '@playwright/test';
  import { login } from './helpers';

  test.use({ viewport: { width: 1440, height: 900 } });

  test('作成タブ: 属性を選んで新規作成すると ?created=1 の編集画面が開きハイライトが出る', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/create', { waitUntil: 'commit' });
    await page.getByText('作成するファンドを指定').first().waitFor();

    await page.getByPlaceholder('委託会社コードを入力/選択').click();
    await page.getByRole('option', { name: 'AM01', exact: true }).click();
    await page.getByPlaceholder('ファンドコードを入力/選択').click();
    await page.getByRole('option', { name: /^510037/ }).click();
    await page.getByText('版種を選択').click();
    await page.getByRole('option', { name: '交付版', exact: true }).click();

    await page.getByRole('button', { name: '属性から新規作成' }).click();

    await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
    const url = new URL(page.url());
    expect(decodeURIComponent(url.pathname)).toMatch(/^\/edit\/AM01_510037_\d{8}_交付版$/);

    const frame = page.frameLocator('iframe.gjs-frame');
    await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
    await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
  });
  ```

#### 共通の手順

- [ ] `pnpm exec biome check --write editor/e2e/merge.spec.ts editor/e2e/approve.spec.ts editor/e2e/create.spec.ts`
- [ ] `pnpm run typecheck:editor`
- [ ] 実行する: `pnpm exec playwright test -c editor/playwright.config.ts --project chromium merge approve create`
      → 期待値: 3 件 passed。落ちた場合は次を優先して疑う:
      - `merge.spec.ts`: `page.route` のグロブが実際の fetch URL(`/api/build/merge`)に一致するか、
        `postDataJSON()` が undefined でないか(Content-Type ヘッダの有無)。
      - `approve.spec.ts`: `data-summary="approved"` のクリックで `statusFilter` が
        `toggleFilter('approved')` により `'approved'` へ切り替わっているか(2 回押すと
        `'all'` に戻るので 1 回だけ押す)。
      - `create.spec.ts`: `Combobox`/`Select` の role が `option` でない場合は
        `reka-ui` のバージョン差(`ListboxItem` の role 実装)を疑い、実機で
        アクセシビリティツリーを確認してセレクタを合わせ直す。
- [ ] commit する。

  ```
  git add editor/e2e/merge.spec.ts editor/e2e/approve.spec.ts editor/e2e/create.spec.ts
  git commit -m "$(cat <<'EOF'
  test(editor): 結合PDF・承認・作成タブの挙動 spec を追加する

  chromium project(local モード)に未到達だった 3 画面を固定する: 結合PDFは
  page.route で /api/build/merge を止めて追加順どおりの本文が送られることを、
  承認タブは「承認する」が既存の却下 spec と対で決着済み表示へ変わることを、
  作成タブは属性選択から ?created=1 の編集画面(ハイライト有り)への到達を検証する。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

### Task E5: 安定化ゲート: `CI=1` で 3 回連続緑を確認してから `retries: 0` にする

**Files:** `editor/playwright.config.ts`

6.2 の順序(「撤去 → `CI=1` で 3 回連続緑 → `retries: 0`」)を守る。逆にしない
(`retries` を先に落とすと、E1〜E4 で導入した新しい状態待みの flake が CI 本番で
初めて顕在化する)。

#### 手順

- [ ] 3 回連続で実行する(PowerShell。ローカルは `dev サーバ reuse`、`CI=1` は GH と同じ
      `forbidOnly` + reporter を使うために付ける — `playwright.config.ts` の
      `forbidOnly: !!process.env.CI` / `reporter: process.env.CI ? [...] : 'list'` を見よ)。

  ```powershell
  $env:CI = '1'
  pnpm run test:e2e
  pnpm run test:e2e
  pnpm run test:e2e
  Remove-Item Env:\CI
  ```
  → 期待値: 3 回とも `35 + 5 passed`(既存 35 件 + E4 で追加した 3 件、内訳は
  実行時の総数と一致することを確認する — 具体的な合計値は E4 完了後に
  `pnpm run test:e2e` の 1 回目の出力で確定させ、以降の 2 回もその数と一致することを見る)。
  1 回でも赤くなったら **止めて原因を直してから 3 回を数え直す**(3 回のカウントを
  持ち越さない)。
- [ ] 3 回のログ(各回のテスト数・pass/fail・所要秒)をこのタスクの commit メッセージ本文へ
      記録する(`docs/superpowers/specs/2026-09-06-ci-optimization-design.md` 10 章と同じ形式)。
- [ ] `editor/playwright.config.ts` の `retries` を `0` にする。

  old:
  ```ts
  retries: process.env.CI ? 2 : 0,
  ```
  new:
  ```ts
  // retry は使わない: 状態待ちへ揃えた後の flake は「たまたま通った」で隠さず、
  // CI で毎回顕在化させて直す対象にする(waitForTimeout 撤去のゴール)。
  retries: 0,
  ```
- [ ] `.github/workflows/ci.yml` の e2e ステップ(`pnpm run test:e2e` を呼ぶだけ)を確認し、
      `retries` に関する記述が無いことを確かめる(無ければ変更不要。既存確認: L109
      `run: pnpm run test:e2e` のみで retries を個別指定していない)。
- [ ] `pnpm exec biome check --write editor/playwright.config.ts`
- [ ] `retries: 0` にした状態で最終確認としてもう 1 回実行する: `pnpm run test:e2e`
      → 期待値: 全件 passed(retry 無しでも安定していることの最終確認)。
- [ ] commit する(3 回分のログを本文に残す。値は実測を貼ること — 以下は記入例の枠組み)。

  ```
  git add editor/playwright.config.ts
  git commit -m "$(cat <<'EOF'
  test(editor): waitForTimeout 撤去の完了を確認し、e2e の retries を 0 にする

  CI=1 で pnpm run test:e2e を 3 回連続実行し、いずれも全件緑であることを確認した
  うえで retries を 0 にする。以後の flake は retry で隠さず、状態待みの取りこぼしと
  して直す対象にする。

  1 回目: (実行結果の passed 件数と秒数をそのまま書く)
  2 回目: (同上)
  3 回目: (同上)

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  EOF
  )"
  ```

---

#### E 系列の完了条件の対応(設計 10 章「計画 B1 の完了条件」との対応、このタスク分)

- 「`CI=1` かつ `retries: 0` で e2e が 3 回連続緑」→ E5 で満たす(`retries: 0` は 3 回確認の**後**
  に設定するため、最終コミット時点の状態として満たされる)。
- 「`pnpm typecheck` にフェイクと e2e エントリが含まれる」→ 別タスク(sproc 注入・7 章担当分)の
  範囲。このタスクは `pnpm run typecheck:editor` に既存の e2e ディレクトリが含まれることの
  確認(E1/E4 の手順内)のみを担う。

---

# B1 タスク R1〜R6: rest e2e(project `rest`)

> 本ファイルは計画 B1(`docs/superpowers/plans/2026-09-06-ci-optimization-plan-b1.md`)の一部
> ドラフト。前提: **D 系列**(sproc 注入)が `editor/server/src/db/sproc.ts` の
> `createSprocClient(query: QueryFn): SprocClient`、`editor/server/src/serve.ts` の
> `startServer({ sproc? }: { sproc?: SprocClient } = {})`、`editor/server/test/fakes/sprocFake.ts` の
> `createFakeQuery(seed?: FakeSprocSeed): QueryFn`、`editor/server/tsconfig.tools.json`
> (`noEmit`、include に `scripts/**` と `test/fakes/**`)を提供済みであることを前提にする。
> **E 系列**(`waitForTimeout` 撤去)が `editor/e2e/helpers.ts` に
> `login(page, user, opts?: { clearSession?: boolean })` / `waitForLoaded(page)` /
> `openEditor(page, id)` / `waitForStableBox(page, locator)` を用意する前提で、本タスク群は
> これらを消費する(未着手なら R4/R5 は helpers.ts の完成を待つ)。

### R 系列の前提(seed contract)

`editor/server/test/fakes/sprocFake.ts` の `createFakeQuery()` を**引数無しで**呼ぶ前提で
R2 を書く(rest e2e 専用の既定シードを実装側に持たせる)。この既定シードが満たすべき契約:

- ユーザー 3 名。**ユーザー名とパスワードを同一文字列にする**(`editor/web/src/api/fixtures/users.json`
  の既存規約 — admin/admin・approver/approver と同じ形。`editor/e2e/helpers.ts` の
  `login(page, user)` がこの規約に依存する前提のため、rest 側だけ違う規約にすると helpers.ts が
  両 project で共用できなくなる):
  - `{ username: 'editor', password: 'editor', role: 'editor', mustChangePassword: false }`
  - `{ username: 'approver', password: 'approver', role: 'approver', mustChangePassword: false }`
  - `{ username: 'admin', password: 'admin', role: 'admin', mustChangePassword: false }`
  - (local fixtures の `editor` は `mustChangePassword: true` だが、rest 既定シードは 3 名とも
    `false` にする — R4 の申請フローが password-init 画面へ迂回しないようにするため。
    R5 は「新規作成ユーザーは強制」の経路を別に検証するので、既定シードの 3 名を巻き込まない)
- ファンドマスタ(`sample` `取得` の `データJSON`。無いと `parseFundMaster` が undefined を返し
  ファンド名が空になるだけで実害は無いが、R4 の一覧表示を安定させるため用意する): 少なくとも
  `510037`(交付版 fixture が使うファンド)に `{ fund: { name: '...', nickname: '' }, company:
  { code: 'AM01', name: '...' } }` 形の行を 1 件。
- `template` `候補` / `系列` の行は本タスク群では未使用(一覧はファイル走査、作成タブ導線は
  B1 の対象外)。無くても R4/R5 は通る。

R2(`editor/server/scripts/e2e-rest-server.ts`)側の責務は「`createSprocClient(createFakeQuery())`
を `sproc` として `startServer` へ渡す」ことと「dataRoot(templates/css)をファイルで seed する」
ことだけで、DB 側シードの中身は D 系列に委ねる。

---

### Task R1: `vite.config.ts` の proxy 先を `API_PROXY_TARGET` で差し替え可能にする(設計 6.1)

rest e2e はサーバを 24690 で立てる(24680 は local project や開発中の dev サーバが使うため
分離する。設計 6.1 のポート分離理由)。web dev サーバ(Vite)は `/api` を同一オリジンへ相対
パスで叩く(`web/src/api/rest/http.ts` の `BASE = '/api'`)ため、proxy 先を環境変数で切り替える
のが唯一の変更点。`VITE_` 接頭辞を付けないのは、付けるとクライアントバンドルへ露出し
(Vite の既定挙動)、rest e2e 用の内部アドレスをブラウザ側 JS に埋め込むことになるため
(この値は Vite dev サーバ自身の proxy 設定にしか要らない)。

**Files:**
- 変更: `editor/web/vite.config.ts`

**Interfaces:**
- 新規の環境変数 `API_PROXY_TARGET`(既定 `http://localhost:24680`)。CLI の `--port` は
  Vite が `server.port` より優先して解決する(CLI オプションは resolved config の
  `server` へ後から merge される。今回の変更で `server.port: 24681` はそのまま残し、
  rest 起動側は `vite --port 24691` で上書きする — `vite.config.ts` は変更しない)。

**Steps:**

- [ ] `editor/web/vite.config.ts` の `proxy.target` を書き換える

```diff
   server: {
     // Vite 既定の 5173 は他ツールと被りやすいため、衝突しにくい 24681 に固定
     // (server 側 :24680 と対で予約。選定理由は editor/README.md の「LAN 公開」節)。
     port: 24681,
     proxy: {
       '/api': {
-        target: 'http://localhost:24680',
+        // rest e2e(playwright project `rest`)は 24690 の別サーバを使うため、proxy 先を
+        // `API_PROXY_TARGET` で上書き可能にする。`VITE_` 接頭辞を付けないのは、付けると
+        // Vite がクライアントバンドルへ露出させる値になり、この内部アドレスをブラウザ側
+        // JS に埋め込むことになるため(`import.meta.env` へは載せない)。
+        target: process.env.API_PROXY_TARGET ?? 'http://localhost:24680',
         changeOrigin: true,
       },
     },
   },
```

- [ ] 既定経路(env 未設定)が壊れていないことを確認する

```
pnpm --filter server run dev
```

  別端末で:

```
pnpm --filter web run dev
```

  期待: `http://localhost:24681` を開いてログイン画面が出る(既存の `test:e2e` chromium
  project がこの経路に依存しているため、ここで壊れていれば以降のタスクへ進まない)。
  確認できたら両方 Ctrl+C で止める。

- [ ] CLI `--port` が `server.port` を上書きすることを確認する(R3 の前提)

```
pnpm --filter web exec vite --port 24691
```

  期待: 起動ログの `Local:` 行が `http://localhost:24691/` になる(24681 ではない)。
  Ctrl+C で止める。

- [ ] `pnpm exec biome check --write editor/web/vite.config.ts`

- [ ] コミット

```
git add editor/web/vite.config.ts
git commit -m "$(cat <<'EOF'
chore(editor): rest e2e 用に vite dev サーバの API proxy 先を環境変数で上書き可能にする

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
EOF
)"
```

---

### Task R2: `editor/server/scripts/e2e-rest-server.ts` — rest e2e 用サーバ起動スクリプト(設計 6.1, 7.3)

`config.ts` は import 時に `process.env` を解決する(`config.ts:113` の `loadFileConfig()` 呼び出し
以降がモジュール評価順に走る)ため、`PORT` 等は **`serve.ts` を動的 import する前に** 設定する
必要がある(静的 import では間に合わない)。dataRoot は毎回まっさらにする必要があるため、
`os.tmpdir()` の乱数ディレクトリではなく、リポジトリ内の既存の gitignore 済み場所
(ルート `.gitignore:11` の `.tmp/`)に固定パスを 1 つ持つ。固定パスにする理由は、
テスト側(R4/R5)が同じパスを計算だけで参照でき、`os.tmpdir()` 配下を prefix 走査で
「今回起動した分」を推測する必要が無いため(前回異常終了で残った mkdtemp ディレクトリと
混同する余地が無い)。

**Files:**
- 新規: `editor/server/scripts/e2e-rest-server.ts`

**Interfaces:**
- dataRoot 固定パス: `<repoRoot>/.tmp/e2e-rest-dataroot`(repoRoot = このファイルの 3 階層上)。
  R4/R5 はこのパスを同じ式で再計算して参照する(後述)。
- 起動時の env: `PORT=24690` / `HOST=127.0.0.1` / `AUTH_REQUIRED=true` / `AUDIT_DB=true` /
  `DATA_ROOT=<上記固定パス>`。`HTTPS` / `COOKIE_SECURE` は既定のまま(loopback + 非 production
  なので `assertSafeExposure` は素通しし、`cookieSecure` は既定 false)。
- 標準出力に `[e2e-rest-server] listening` を含む 1 行を出す(playwright の `webServer.url`
  ヘルスチェックは HTTP で行うため必須ではないが、ローカル手動起動時の目視確認用)。

**Steps:**

- [ ] `editor/server/scripts/e2e-rest-server.ts` を書く

```ts
// =============================================================================
// e2e-rest-server.ts — rest e2e(playwright project `rest`)専用のサーバ起動エントリ
// =============================================================================
// `E2E_REST=1` のときだけ playwright.config.ts が webServer として起動する。
// `config.ts` は import 時に `process.env` を解決するため、`PORT` 等は `serve.ts` の
// 動的 import より前に設定する(静的 import では一時 `DATA_ROOT` が効かない)。
// dataRoot はリポジトリ内の gitignore 済み固定パス(`.tmp/e2e-rest-dataroot`)を毎回
// 作り直して使う — `os.tmpdir()` の乱数ディレクトリだと、テスト側が「今回起動した分」を
// prefix 走査で推測する必要が生まれ、前回異常終了の残骸と混同しうるため。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
export const E2E_REST_DATA_ROOT = path.join(repoRoot, '.tmp', 'e2e-rest-dataroot');

process.env.PORT = '24690';
process.env.HOST = '127.0.0.1';
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'true';
process.env.DATA_ROOT = E2E_REST_DATA_ROOT;

/**
 * dataRoot をファイルで seed する。一覧・1 件取得・申請はファイル走査(台帳ではない。
 * `templateRepo.ts` / `reviewRepo.ts` を見よ)なので、確定 template と per-fund CSS を
 * 置くだけで一覧・編集・申請・承認が成立する。`reviews` / `notes` / `drafts` / `pending`
 * ディレクトリは各リポジトリの書込側が `mkdir(..., { recursive: true })` するため
 * 事前作成は不要。git リポジトリ化(`ensureRepo`)も承認時に自動で行われるため不要。
 */
async function seedDataRoot(): Promise<void> {
  await fs.rm(E2E_REST_DATA_ROOT, { recursive: true, force: true });
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  const cssDir = path.join(E2E_REST_DATA_ROOT, 'css');
  await fs.mkdir(templatesDir, { recursive: true });
  await fs.mkdir(cssDir, { recursive: true });

  const fixturesTemplatesDir = path.join(repoRoot, 'editor/web/src/api/fixtures/templates');
  const fixturesCssDir = path.join(repoRoot, 'editor/web/src/api/fixtures/css');
  for (const name of await fs.readdir(fixturesTemplatesDir)) {
    await fs.copyFile(path.join(fixturesTemplatesDir, name), path.join(templatesDir, name));
  }
  for (const name of await fs.readdir(fixturesCssDir)) {
    await fs.copyFile(path.join(fixturesCssDir, name), path.join(cssDir, name));
  }
}

await seedDataRoot();

// `config.ts` が import 時に上記の env を読むため、`serve.ts` は動的 import で遅らせる。
const { createSprocClient } = await import('../src/db/sproc.js');
const { createFakeQuery } = await import('../test/fakes/sprocFake.js');
const { startServer } = await import('../src/serve.js');

await startServer({ sproc: createSprocClient(createFakeQuery()) });
console.log(`[e2e-rest-server] listening on http://127.0.0.1:24690 (dataRoot=${E2E_REST_DATA_ROOT})`);
```

- [ ] 単体起動で確かめる(D 系列の `serve.ts` / `sprocFake.ts` がマージ済みであること前提)

```
pnpm --filter server exec tsx scripts/e2e-rest-server.ts
```

  期待: `[e2e-rest-server] listening on http://127.0.0.1:24690 (dataRoot=...)` が出て
  プロセスが常駐する。

- [ ] 別端末でヘルスチェックとログインをスモーク確認する

```
curl -s http://127.0.0.1:24690/api/health
curl -s -i -c "$TEMP/e2e-rest-cookie.txt" -X POST http://127.0.0.1:24690/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"editor","password":"editor"}'
```

  期待: `/api/health` が 200 で `{"status":"ok"}` 相当の JSON。ログイン応答は 200 で
  `Set-Cookie: editor.sid=...` ヘッダが出る(`config.ts` の `cookieName: 'editor.sid'`)。

- [ ] dataRoot の中身を目視する

```
ls "editor/.tmp/e2e-rest-dataroot/templates"
```

  期待: `AM01_510037_20240710_交付版.html` を含む 8 ファイル(`editor/web/src/api/fixtures/templates`
  と同数)。起動中のプロセスは Ctrl+C で止める。

- [ ] `pnpm exec biome check --write editor/server/scripts/e2e-rest-server.ts`
- [ ] `tsc -p editor/server/tsconfig.tools.json --noEmit`(D 系列が include へ `scripts/**` を
      足している前提。通らない場合は D 系列のマージ待ち)

- [ ] コミット

```
git add editor/server/scripts/e2e-rest-server.ts
git commit -m "$(cat <<'EOF'
chore(editor): sproc フェイクと一時 dataRoot で rest e2e サーバを起動するスクリプトを追加

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
EOF
)"
```

---

### Task R3: `playwright.config.ts` に `rest` project を足し、`E2E_REST=1` で起動を切り替える(設計 6.1)

`E2E_REST=1` の有無は**呼び出し元のシェル環境**から読む。`package.json` の script 文字列内で
`E2E_REST=1 playwright test ...` 形の前置きはしない — Windows の pnpm script は cmd.exe 経由で
走り(`.npmrc` に `shell-emulator` は無い)、`VAR=val cmd` は cmd.exe の構文として無効
(過去タスク C5 が `test:e2e` のポート検査で同じ理由により `cross-env` も見送っている)。
一方 `CI` は本ファイルの `forbidOnly` / `retries` / `reuseExistingServer` が既に同じ方式
(外側の環境変数をそのまま読む。npm script 側では一切セットしない)で扱っているため、
`E2E_REST` もこれに揃えるのが最小差分になる。呼び出しは PowerShell なら
`$env:E2E_REST='1'; pnpm run e2e:rest`、bash なら `E2E_REST=1 pnpm run e2e:rest`。
`--project rest` を `E2E_REST` 未設定のまま実行すると playwright 自身が
`Project(s) "rest" not found` で落ちる(project が配列に無いため)ので、追加のガードは書かない。

サーバ / web の起動コマンドは `webServer[].env` へ渡す(Playwright はプロセスを直接 spawn
するため、ここは cmd.exe の文字列展開を経由せず、`{ [key]: value }` がそのまま子プロセスの
env にマージされる — 上記の cmd.exe 制約と無関係)。

**Files:**
- 変更: `editor/playwright.config.ts`
- 変更: `package.json`(ルート)

**Interfaces:**
- `const REST = process.env.E2E_REST === '1';`
- project `rest`: `testMatch: '**/*.rest.spec.ts'`、`use.baseURL: 'http://localhost:24691'`、
  `workers: 1`(理由: 設計 6.1「同一 IP・同一 ID のログインが並列に集中すると
  `loginRateLimit` に当たる」)。`REST` が false のときは `projects` 配列に含めない。
- `webServer`(`REST` のとき差し替え): サーバは
  `pnpm --filter server exec tsx scripts/e2e-rest-server.ts`(cwd はリポジトリルート。
  既存の `pnpm --filter server run dev` と同じ cwd 規約)、`url:
  'http://localhost:24690/api/health'`。web は `pnpm --filter web exec vite --port 24691`、
  `env: { VITE_API_MODE: 'rest', API_PROXY_TARGET: 'http://localhost:24690' }`、
  `url: 'http://localhost:24691'`。両方 `reuseExistingServer: false`(設計 6.1: 24680 に
  local サーバが残っているとヘルスチェックが通ってしまい rest spec が local 経路で走る
  事故を避けるため、rest は常に自前で起動し直す)。
- 新規スクリプト `e2e:rest`(ルート `package.json`):
  `node scripts/check-ports.mjs 24690 24691 && playwright test -c editor/playwright.config.ts --project rest`
  (24680/24681 用の `check-ports.mjs` をそのまま再利用。ポート引数を変えるだけで新規ファイル不要)。

**Steps:**

- [ ] `editor/playwright.config.ts` を書き換える

```ts
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// `E2E_REST=1` は呼び出し元のシェルで設定する(npm script 内で前置しない理由は本ファイル
// 冒頭のタスクコメントでなく計画書 R3 を見よ — Windows の pnpm script は cmd.exe 経由で
// `VAR=val cmd` 構文が使えないため、`CI` と同じ「外側の env をそのまま読む」方式に揃える)。
const REST = process.env.E2E_REST === '1';

/**
 * E2E 設定。既定(chromium/docs)は web SPA(localApi + localStorage)を local サーバ
 * (24680/24681)相手に走らせる。`E2E_REST=1` のときだけ project `rest` が加わり、
 * 24690/24691 の別サーバ(sproc フェイク + 一時 dataRoot)を自前で起動して走る
 * (ポートを分けるのは、開発中の local サーバが 24680 に居るとヘルスチェックが通って
 * しまい rest spec が local 経路で走るのを防ぐため)。
 *
 * The Fastify server is booted all the same, because the preview screen renders inside an
 * isolated iframe whose page (`/api/preview-host/index.html`) is served by the server —
 * that route needs its own CSP, which only a real HTTP response can carry (see
 * `server/src/vivliostyle/previewHost.ts`). Without it the preview falls back to the plain
 * iframe and the docs screenshot no longer shows a typeset page. Vite proxies `/api` to it.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: REST ? 'http://localhost:24691' : 'http://localhost:24681',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // 挙動を検証する spec 全部。`test:e2e`(`ci` と GitHub Actions)と `e2e:editor` の両方で走る。
      // `capture_docs.spec.ts` を外すのは、あの spec が git 管理下の `docs/editor/images/*.png` を
      // 書き換えるため。フル `ci` / GH の結果としてリポジトリの成果物が変わるのは検査ではない。
      // `*.rest.spec.ts` は SQL Server 相当のフェイクを立てる `rest` project(`E2E_REST=1` の
      // ときだけ `projects` に入る)の担当で、local 経路のサーバ相手に走らせると意味が変わる。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/capture_docs.spec.ts', '**/*.rest.spec.ts'],
    },
    {
      // 操作手引き(docs/editor)のスクリーンショットを撮り直す project。`e2e:editor`(`ci:affected`
      // の editor 領域)だけが `--project docs` で選ぶ。editor に触れた push でだけ再撮影が走り、
      // 差分は「再撮影」としてコミットする。
      name: 'docs',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/capture_docs.spec.ts',
    },
    ...(REST
      ? [
          {
            // sproc フェイク + 一時 dataRoot を相手にする rest 経路の最小回帰網(`e2e:rest`)。
            // `workers: 1` はログイン集中で `loginRateLimit` に当たるのを避けるため
            // (承認フローは editor→approver の 2 名を直列に使う)。
            name: 'rest',
            testMatch: '**/*.rest.spec.ts',
            use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:24691' },
            workers: 1,
          },
        ]
      : []),
  ],
  webServer: REST
    ? [
        {
          command: 'pnpm --filter server exec tsx scripts/e2e-rest-server.ts',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          url: 'http://localhost:24690/api/health',
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: 'pnpm --filter web exec vite --port 24691',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          // `VITE_API_MODE=rest` で web が REST リポジトリ(`api/rest/*`)を選ぶ(`main.ts`)。
          // `API_PROXY_TARGET` は R1 で足した vite.config.ts の proxy 先上書き。
          env: { VITE_API_MODE: 'rest', API_PROXY_TARGET: 'http://localhost:24690' },
          url: 'http://localhost:24691',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]
    : [
        {
          command: 'pnpm --filter server run dev',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          url: 'http://localhost:24680/api/health',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: 'pnpm --filter web run dev',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          url: 'http://localhost:24681',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
```

- [ ] `package.json`(ルート)に `e2e:rest` を追加する

```diff
     "e2e:editor": "playwright test -c editor/playwright.config.ts --project chromium --project docs",
+    "e2e:rest": "node scripts/check-ports.mjs 24690 24691 && playwright test -c editor/playwright.config.ts --project rest",
```

- [ ] `E2E_REST` 未設定のときに `chromium`/`docs` 経路が壊れていないことを確認する

```
pnpm run e2e:editor
```

  期待: 従来どおり 24680/24681 のサーバを自前起動して全 spec 緑(`*.rest.spec.ts` はまだ
  存在しないので `chromium` の `testIgnore` は無害)。

- [ ] `E2E_REST` 未設定で `--project rest` を指定するとエラーになることを確認する(意図した
      フェイルセーフ)

```
pnpm exec playwright test -c editor/playwright.config.ts --project rest --list
```

  期待: `Error: Project(s) "rest" not found. Available projects: "chromium", "docs"`(exit 1)。

- [ ] `pnpm exec biome check --write editor/playwright.config.ts`

- [ ] コミット

```
git add editor/playwright.config.ts package.json
git commit -m "$(cat <<'EOF'
chore(editor): playwright に rest project を足し、E2E_REST=1 で 24690/24691 の別サーバへ切り替える

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
EOF
)"
```

---

### Task R4: `editor/e2e/approval.rest.spec.ts` — 申請→承認→確定ファイル+git の実機検証(設計 6.3)

対象テンプレは既存 e2e が使い回している `AM01_510037_20240710_交付版`(`editor/e2e/review_tab.spec.ts`
と同一 id。R2 の seed が同じ fixtures ディレクトリを丸ごと複写するため、rest 側にも同じ id で
存在する)。ユーザー切替は `login()` を**別の `test()` に分けて呼ぶ**ことで行い、同一テストの
中で cookie を明示的に消す処理は書かない — Playwright は既定で `test()` ごとに新しい
`BrowserContext`(cookie 含めて空)を払い出すため、editor→approver の切替をテスト分割にすれば
cookie の食い違いを気にする必要が無い(`review_tab.spec.ts` の 1 テスト内切替は local
(localStorage ベース)専用の書き方で、cookie セッションの rest には流用しない)。
`test.describe.configure({ mode: 'serial' })` で 2 つ目のテストが 1 つ目の申請結果に依存する
ことを明示する。

**Files:**
- 新規: `editor/e2e/approval.rest.spec.ts`

**Interfaces(依存する既存ロケータ/文言。いずれも実装済み):**
- ログイン: `#u` / `#p` / `getByRole('button', { name: 'ログイン' })`(`LoginView.vue`。
  `helpers.ts` の `login()` がラップする想定)。
- 一覧行: `editor/web/src/features/templates/components/TemplateTable.vue:56-72` の列
  (委託会社コード/ファンド/基準日/版種)。`20240710` と `交付版` を含む行で判定する
  (ファンド名はシード側のファンドマスタ有無に依存するため使わない)。
  「編集」ボタン行(`actionVm.label === '編集'`、`Pencil` アイコン)。
- 編集 canvas: `iframe.gjs-frame` → `.page`(`review_tab.spec.ts` の `waitForCanvasReady` と
  同一ロケータ)。編集許可ボタン: `getByText('編集を許可', { exact: true })`
  (`smoke.spec.ts:78` で実績あり)。編集対象の地の文: `受益者のみなさまへ`
  (`smoke.spec.ts:80`。rest では `filled` が空なので、この文言は `sampleCommon` 差込結果
  ではなくテンプレ本文そのものの文字列 — fixture HTML に埋め込み済みの地の文であることを
  `templateFileName` の由来から確認済み)。
- 申請: `/preview/:id` → `getByRole('button', { name: '確定保存を申請' })` →
  `getByRole('button', { name: '申請する' })` → toast
  `getByRole('status').filter({ hasText: '確定保存を申請しました' })`
  (`review_tab.spec.ts:27-41` の `submitOnce` と同一手順)。
- 承認タブ: `/edit/:id` → `getByRole('link', { name: '承認' })` → 区画
  `[data-review-item]` → `getByRole('button', { name: '承認する' })`
  (`ReviewDetail.vue:537-540`)。決着後の文言: 区画内に「承認済み」を含むテキストが出る
  (`ReviewDetail.vue:549-553` の `DECIDED_STATUS_LABEL`)。
- 承認コミットメッセージの先頭行: `` 確定保存(承認): <templateId> 申請=<submittedBy>
  承認=<approver> ``(`reviewRepo.ts:185-187`)。

**Steps:**

- [ ] `editor/e2e/approval.rest.spec.ts` を書く

```ts
// =============================================================================
// approval.rest.spec.ts — rest 経路(sproc フェイク + 一時 dataRoot)の申請→承認の実機検証
// =============================================================================
// `E2E_REST=1` のときだけ走る project `rest` 専用 spec。ログイン(実 POST /api/auth/login →
// セッション cookie)→ 一覧 → 編集(本文描画のみ確認。rest は `filled` が空で共通 sample の
// 差込表示になるため per-fund 実値のアサーションは書かない)→ 申請 → 承認 → dataRoot の
// 確定ファイルと git コミットを実ディスクで検証する。ユーザー切替は test を分けて行う
// (Playwright は test ごとに新しい cookie 無しの BrowserContext を払い出すため)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { login, openEditor, waitForLoaded } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';
const EDIT_MARK = 'restE2E追記';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// R2(`e2e-rest-server.ts`)が使う固定パスと同じ式(repoRoot からの相対位置)。サーバ側が
// dataRoot を書き替える先を、テスト側が計算だけで参照できるようにするための取り決め。
const DATA_ROOT = path.join(__dirname, '..', '..', '.tmp', 'e2e-rest-dataroot');

test.describe.configure({ mode: 'serial' });

test('editor がログインして一覧・編集画面を確認し、確定保存を申請する', async ({ page }) => {
  await login(page, 'editor');
  await waitForLoaded(page);

  // 一覧にシードしたテンプレの行が出る(ファンド名はシード側のマスタ有無に依存するため
  // 基準日・版種の列だけで判定する)。
  const row = page.locator('table tr', { hasText: '20240710' }).filter({ hasText: '交付版' });
  await expect(row).toBeVisible();

  await openEditor(page, SEED_ID);
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });

  // 地の文を 1 語編集する(承認後に確定ファイルへ反映されたことを確かめる材料)。
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  const para = frame.getByText('受益者のみなさまへ').first();
  await para.click();
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes('受益者のみなさまへ'),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, mark) => {
    el.append(mark);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, EDIT_MARK);
  await frame.locator('.page').first().click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText(EDIT_MARK).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });

  page.on('dialog', (d) => void d.accept());
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`, { waitUntil: 'commit' });
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
  ).toBeVisible();
});

test('approver が承認すると確定ファイルと git コミットへ反映される(自己承認拒否のため別ユーザー)', async ({
  page,
}) => {
  await login(page, 'approver');
  await waitForLoaded(page);

  await openEditor(page, SEED_ID);
  await page.frameLocator('iframe.gjs-frame').locator('.page').first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  await page.getByRole('link', { name: '承認' }).click();

  const item = page.locator('[data-review-item]').first();
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '承認する' }).click();
  await expect(item).toContainText('承認済み', { timeout: 15_000 });

  // dataRoot の確定ファイルへ反映されたことを実ディスクで確認する。
  const html = fs.readFileSync(
    path.join(DATA_ROOT, 'templates', `${SEED_ID}.html`),
    'utf8',
  );
  expect(html).toContain(EDIT_MARK);

  // git コミット(申請者=editor・承認者=approver)を確認する。
  const { execFileSync } = await import('node:child_process');
  const log = execFileSync('git', ['-C', DATA_ROOT, 'log', '--oneline', '-1'], {
    encoding: 'utf8',
  });
  expect(log).toContain(`確定保存(承認): ${SEED_ID} 申請=editor 承認=approver`);
});
```

- [ ] D 系列・E 系列がマージ済みであることを前提に、まず失敗を見る(`editor/e2e/helpers.ts`
      が無ければここで import エラーになる。無い場合は E 系列待ち)

```
$env:E2E_REST='1'; pnpm run e2e:rest
```

  期待(依存未着手時): `Cannot find module './helpers'` 等で即失敗。依存が揃っていれば
  下記の GREEN 期待まで進む。

- [ ] GREEN を確認する

```
$env:E2E_REST='1'; pnpm run e2e:rest
```

  期待: `[check-ports] 空き: 24690, 24691` の後、rest project の 2 テストが緑
  (`2 passed`)。失敗時は `playwright-report/` の trace(`trace: 'on-first-retry'` なので
  1 敗目は trace が無い — 再現しないときは `--retries=1` を一時的に付けて trace を取る)。

- [ ] `pnpm exec biome check --write editor/e2e/approval.rest.spec.ts`
- [ ] `pnpm run check:comments`

- [ ] コミット

```
git add editor/e2e/approval.rest.spec.ts
git commit -m "$(cat <<'EOF'
test(editor): rest 経路の申請→承認→確定ファイル反映を実機の HTTP セッションで検証する

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
EOF
)"
```

---

### Task R5: `editor/e2e/users.rest.spec.ts` — 管理者のユーザー作成と初回パスワード変更(設計 6.3)

R4 と同じ理由でユーザー切替は test を分ける。作成したユーザー名/一時パスワードは
モジュール変数で次の test へ引き渡す(`describe.configure({ mode: 'serial' })` により
実行順序が保証される。Playwright の公式パターン)。

**Files:**
- 新規: `editor/e2e/users.rest.spec.ts`

**Interfaces(依存する既存ロケータ/文言):**
- 管理画面: `/admin`。フォーム `#new-username` / `#new-displayname` /
  `getByRole('button', { name: '追加' })`(`AdminView.vue:174-200`)。
  払い出しカード: `.mono.select-all`(一時パスワード表示要素、`AdminView.vue:155-157`)。
- パスワード変更画面: `/password-init` へ強制遷移(`router/index.ts:138-143` の
  `mustChangePassword` ガード)。フォーム `#c`(現在のパスワード)/ `#n`(新しいパスワード)/
  `#cf`(確認)/ `getByRole('button', { name: '設定する' })`(`PasswordInitView.vue:103-124`)。
  成功後は `/edit` へ遷移する(`PasswordInitView.vue:74`)。

**Steps:**

- [ ] `editor/e2e/users.rest.spec.ts` を書く

```ts
// =============================================================================
// users.rest.spec.ts — rest 経路の管理者ユーザー作成 → 初回パスワード変更の実機検証
// =============================================================================
// 一時パスワードは払い出し直後の 1 回しか画面に出ない(`AdminView.vue`)。新規ユーザーは
// `mustChangePassword: true` で作成されるため、初回ログインは `/password-init` へ強制
// 遷移する(`router/index.ts` の authGuard)。ユーザー切替は test を分けて行う
// (Playwright は test ごとに新しい cookie 無しの BrowserContext を払い出すため)。
import { expect, test } from '@playwright/test';
import { login, waitForLoaded } from './helpers';

const NEW_USERNAME = 'e2erest';
const NEW_DISPLAY_NAME = 'rest e2e 一時ユーザー';
const NEW_PASSWORD = 'RestE2ePass1';

let issuedTempPassword = '';

test.describe.configure({ mode: 'serial' });

test('admin がユーザーを追加すると一時パスワードが 1 回だけ表示される', async ({ page }) => {
  await login(page, 'admin');
  await waitForLoaded(page);
  await page.goto('/admin', { waitUntil: 'commit' });

  await page.locator('#new-username').fill(NEW_USERNAME);
  await page.locator('#new-displayname').fill(NEW_DISPLAY_NAME);
  await page.getByRole('button', { name: '追加' }).click();

  const passwordEl = page.locator('.mono.select-all');
  await expect(passwordEl).toBeVisible();
  issuedTempPassword = (await passwordEl.textContent())?.trim() ?? '';
  expect(issuedTempPassword.length).toBeGreaterThan(0);

  // 再読み込みすると二度と表示されない(サーバは平文を保存しない)。
  await page.reload();
  await expect(page.getByText('一時パスワード')).toHaveCount(0);
});

test('新規ユーザーは初回ログインでパスワード変更を強制され、完了後に編集タブへ進む', async ({
  page,
}) => {
  expect(issuedTempPassword).not.toBe('');
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').fill(NEW_USERNAME);
  await page.locator('#p').fill(issuedTempPassword);
  await page.getByRole('button', { name: 'ログイン' }).click();

  await page.waitForURL(/\/password-init/);
  await page.locator('#c').fill(issuedTempPassword);
  await page.locator('#n').fill(NEW_PASSWORD);
  await page.locator('#cf').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: '設定する' }).click();

  await page.waitForURL(/\/edit/);
  await waitForLoaded(page);
});

test('変更後のパスワードで再ログインでき、旧一時パスワードは使えない', async ({ page }) => {
  await login(page, NEW_USERNAME, { password: NEW_PASSWORD } as never);
  await expect(page).toHaveURL(/\/edit/);
});
```

  ⚠ 3 つ目のテストの `login(page, NEW_USERNAME, { password: NEW_PASSWORD } as never)` は
  `helpers.ts` の `login()` が「ユーザー名=パスワード」規約専用(第 2 引数のみ)であることを
  前提にした暫定形。E 系列の `login()` が任意パスワードを受けない場合は、このテストだけ
  素の `page.goto('/login')` + `#u`/`#p`/クリック に書き直す(下記 Steps の最後で分岐)。

- [ ] `helpers.ts` の `login()` の実引数を確認し、3 つ目のテストを確定させる

```
grep -n "export async function login" editor/e2e/helpers.ts
```

  - 第 2 引数がユーザー名のみで内部的に「ユーザー名=パスワード」を仮定する実装なら、
    3 つ目のテストの `login(...)` 呼び出しを次の素書きへ置き換える:

    ```ts
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('#u').fill(NEW_USERNAME);
    await page.locator('#p').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/edit/);
    ```

  - 第 3 引数でパスワード上書きを受ける実装なら、上記ドラフトの `as never` を外して
    型を合わせる。

- [ ] GREEN を確認する

```
$env:E2E_REST='1'; pnpm run e2e:rest
```

  期待: rest project 全 5 テスト緑(R4 の 2 件 + 本タスクの 3 件)。

- [ ] `pnpm exec biome check --write editor/e2e/users.rest.spec.ts`
- [ ] `pnpm run check:comments`

- [ ] コミット

```
git add editor/e2e/users.rest.spec.ts
git commit -m "$(cat <<'EOF'
test(editor): rest 経路の管理者ユーザー作成と初回パスワード変更を実機の HTTP セッションで検証する

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
EOF
)"
```

---

### Task R6: docs 更新(`editor/README.md` / 設計正典 チェックリスト)

**Files:**
- 変更: `editor/README.md`(e2e 節)
- 変更: `docs/editor/src/設計正典.md`(触る前のチェックリスト 4 項目)

**Steps:**

- [ ] `editor/README.md` の e2e 節に rest project の段落を追記する(既存の `e2e:editor` 節の
      直後。内容: `E2E_REST=1` で opt-in、ポート 24690/24691、sproc は in-memory フェイク
      (実 SQL Server には繋がない)、実 SQL Server 相手の LocalDB 確認は別枠のまま
      (`docs/editor/src/設計正典.md` の LocalDB 検証環境とは独立)であることを明記する)。

- [ ] `docs/editor/src/設計正典.md` の「触る前のチェックリスト」4 番へ 1 文足す:
      「rest e2e(`pnpm run e2e:rest`)は `E2E_REST=1` を呼び出し元シェルで設定し、
      sproc は in-memory フェイク(`server/test/fakes/sprocFake.ts`)を使う」。

- [ ] `pnpm run check:comments`

- [ ] コミット

```
git add editor/README.md docs/editor/src/設計正典.md
git commit -m "$(cat <<'EOF'
docs(editor): rest e2e(E2E_REST=1・sproc フェイク)の使い方を README と設計正典へ足す

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
EOF
)"
```
