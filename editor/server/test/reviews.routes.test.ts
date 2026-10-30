// =============================================================================
// reviews.routes.test.ts — 承認ワークフローの HTTP 結合テスト(ルート + repo + validate)
// =============================================================================
// `reviews.test.ts` は repo を直接叩くが、ここでは最小の Fastify に `reviewsRoutes` を載せ、
// `app.inject()` で HTTP 経路(パラメータ抽出 → validate → repo → errorHandler の HTTP 変換)を
// 検証する。認可ゲート(`requireApprover`)は `config.requireAuth=false` では no-op のため、
// `actor()` が読む `request.user` を onRequest フックでヘッダから注入し、ロール依存の挙動
// (一覧の可視範囲・自己承認拒否)を駆動する。実ファイル反映を伴う approve は git 前提。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filledDoc } from './helpers/filledDoc.js';
import { createSessionStub } from './helpers/sessionStub.js';

// config を import する前に一時ディレクトリへ向ける(reviews.test.ts と同方針)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-routes-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');
process.env.PENDING_DIR = path.join(tmp, 'pending');
// 監査ログの DB 複写は setAuditSink を呼ぶ buildApp を通らないと realSproc のままなので、
// env が立っていると実 DB へ出る。
process.env.AUDIT_DB = 'false';
// 認可ゲート(requireApprover 等)を no-op にし、下の buildApp が注入する x-test-user/
// x-test-role ヘッダだけでロール依存の挙動を駆動する(冒頭コメント参照)。
process.env.AUTH_REQUIRED = 'false';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('review workflow (HTTP routes)', () => {
  let app: FastifyInstance;

  /** ヘッダ x-test-user / x-test-role から `request.user` を注入して actor を駆動する。 */
  async function buildApp(): Promise<FastifyInstance> {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { reviewsRoutes } = await import('../src/routes/reviews.routes.js');
    // DB(sproc)は本テストの対象外。承認直後の注記マスタ書き戻しが実 DB へ触れない
    // (接続待ちでタイムアウトしない)よう、決定的に失敗する実行面を渡す
    // (reviews.test.ts と同じ理由)。helper は動的に取る — 静的 import だと冒頭の env
    // 設定より先に `config.js` が読まれる。
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
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

  const asUser = (username: string, role: string) => ({
    'x-test-user': username,
    'x-test-role': role,
  });

  /** 編集タブが読む既存の値入り HTML。別ツールが置いた状態を模す。 */
  const SEEDED_FILLED = filledDoc('<p>既存の値入り</p>');
  const filledFile = (templateId: string) => path.join(tmp, 'filled', `${templateId}.html`);

  // 編集経路(`origin:'edit'`)の申請は値入り HTML が既に在ることが前提なので先に置く。
  const submit = (headers: Record<string, string>, templateId: string, html: string) => {
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    if (!fs.existsSync(filledFile(templateId)))
      fs.writeFileSync(filledFile(templateId), SEEDED_FILLED, 'utf8');
    return app.inject({
      method: 'POST',
      url: '/review-requests',
      headers,
      payload: {
        templateId,
        html: filledDoc(html),
        css: '.x{}',
        origin: 'edit',
      },
    });
  };

  /**
   * 変わったパーツ(既存の値入りとの差分は `p#1` の 1 つ)を承認する。判定が揃わない edit 申請は
   * 最終確定できない。
   */
  const approvePart = (reqId: string, partKey = 'p#1') =>
    decide(reqId, asUser('approver1', 'approver'), [{ partKey, status: 'approved' }]);

  /** パーツ判定をまとめて送る(`POST /review-requests/:reqId/part-decisions`)。 */
  const decide = (reqId: string, headers: Record<string, string>, decisions: unknown[]) =>
    app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/part-decisions`,
      headers,
      payload: { decisions },
    });

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('POST /review-requests: 申請を積むが実ファイルは書かない', async () => {
    const tplId = 'XX01_611111_20250101_交付版';
    const res = await submit(asUser('editor1', 'editor'), tplId, '<p>{{ fund.name }} 申請</p>');
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.status).toBe('pending');
    expect(meta.submittedBy).toBe('editor1');
    expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SEEDED_FILLED);
  });

  it('POST /review-requests: 不正ボディ(templateId 欠落)は 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/review-requests',
      headers: asUser('editor1', 'editor'),
      payload: { html: '<p>x</p>', css: '', origin: 'edit' },
    });
    expect(res.statusCode).toBe(400);
  });

  // 契約の段(`SubmitReviewBody.templateId`)を素の文字列にすると、トークン内部に
  // 空白を持つ id が承認経路へ通る。SQL Server の `=` は末尾空白を無視するので、
  // 「ファイルは 2 つ・台帳は 1 行」の食い違いを作れる。
  it.each([
    'XX01 _611111_20250101_交付版',
    'XX01_611111_20250101_交付版 ',
    'XX01._611111_20250101_交付版',
    '../etc/passwd',
  ])('POST /review-requests: 規約外の templateId(%j)は 400', async (templateId) => {
    const res = await app.inject({
      method: 'POST',
      url: '/review-requests',
      headers: asUser('editor1', 'editor'),
      payload: { templateId, html: '<p>x</p>', css: '', origin: 'edit' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /review-requests: editor は自分の申請のみ、approver は全件', async () => {
    await submit(asUser('editor2', 'editor'), 'XX01_622222_20250101_交付版', '<p>e2</p>');

    const mine = await app.inject({
      method: 'GET',
      url: '/review-requests',
      headers: asUser('editor2', 'editor'),
    });
    const mineList = mine.json() as Array<{ submittedBy: string }>;
    expect(mineList.length).toBeGreaterThan(0);
    expect(mineList.every((r) => r.submittedBy === 'editor2')).toBe(true);

    const all = await app.inject({
      method: 'GET',
      url: '/review-requests',
      headers: asUser('approver1', 'approver'),
    });
    const allList = all.json() as Array<{ submittedBy: string }>;
    expect(allList.some((r) => r.submittedBy === 'editor1')).toBe(true);
    expect(allList.some((r) => r.submittedBy === 'editor2')).toBe(true);
  });

  it('GET /review-requests?status: 正しい状態で絞り込め、不正値は 400', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/review-requests?status=pending',
      headers: asUser('approver1', 'approver'),
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Array<{ status: string }>).every((r) => r.status === 'pending')).toBe(
      true,
    );

    const bad = await app.inject({
      method: 'GET',
      url: '/review-requests?status=bogus',
      headers: asUser('approver1', 'approver'),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('POST approve: approver が承認すると実ファイルへ反映し approved になる', async () => {
    const tplId = 'XX01_633333_20250101_交付版';
    const sub = await submit(asUser('editor1', 'editor'), tplId, '<p>{{ fund.name }} 反映済</p>');
    const reqId = sub.json().id;
    await approvePart(reqId);

    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: { comment: 'ok' },
    });
    expect(res.statusCode).toBe(200);
    const written = fs.readFileSync(path.join(tmp, 'filled', `${tplId}.html`), 'utf8');
    expect(written).toContain('反映済');

    const got = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(got.json().status).toBe('approved');
  });
  it('POST part-decisions: roleと自己申請の制約を強制する', async () => {
    const otherRequest = await submit(
      asUser('editor1', 'editor'),
      'XX01_688881_20250101_交付版',
      '<p>他者申請のパーツ判定</p>',
    );
    expect(otherRequest.statusCode).toBe(200);
    const otherReqId = otherRequest.json().id as string;

    const approvedByApprover = await decide(otherReqId, asUser('approver1', 'approver'), [
      { partKey: 'p#1', status: 'approved' },
    ]);
    expect(approvedByApprover.statusCode).toBe(200);
    expect(approvedByApprover.json()).toMatchObject([
      {
        partKey: 'p#1',
        status: 'approved',
        decidedBy: 'approver1',
        comment: null,
      },
    ]);

    for (const role of ['editor', 'viewer']) {
      const forbidden = await decide(otherReqId, asUser(`${role}1`, role), [
        { partKey: 'p#1', status: 'approved' },
      ]);
      expect(forbidden.statusCode).toBe(403);
    }

    const approverRequest = await submit(
      asUser('approver1', 'approver'),
      'XX01_688882_20250101_交付版',
      '<p>approver自己申請</p>',
    );
    expect(approverRequest.statusCode).toBe(200);

    const approverSelf = await decide(approverRequest.json().id, asUser('approver1', 'approver'), [
      { partKey: 'p#1', status: 'approved' },
    ]);
    expect(approverSelf.statusCode).toBe(403);

    const adminRequest = await submit(
      asUser('admin1', 'admin'),
      'XX01_688883_20250101_交付版',
      '<p>admin自己申請</p>',
    );
    expect(adminRequest.statusCode).toBe(200);

    const adminSelf = await decide(adminRequest.json().id, asUser('admin1', 'admin'), [
      { partKey: 'p#1', status: 'approved' },
    ]);
    expect(adminSelf.statusCode).toBe(200);
    expect(adminSelf.json()).toMatchObject([{ status: 'approved', decidedBy: 'admin1' }]);
  });

  it('GET /review-requests/:reqId: 他人の申請は editor から 403、本人/approver は 200', async () => {
    const sub = await submit(
      asUser('editor1', 'editor'),
      'XX01_677777_20250101_交付版',
      '<p>秘</p>',
    );
    const reqId = sub.json().id;

    const other = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('editor2', 'editor'),
    });
    expect(other.statusCode).toBe(403);

    const owner = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('editor1', 'editor'),
    });
    expect(owner.statusCode).toBe(200);

    const approver = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(approver.statusCode).toBe(200);
  });

  it('GET /review-requests/:reqId は cssBaseline を返さない(承認画面は使わない。保存はする)', async () => {
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    const templateId = 'XX01_678888_20250101_交付版';
    fs.writeFileSync(filledFile(templateId), SEEDED_FILLED, 'utf8');
    const sub = await app.inject({
      method: 'POST',
      url: '/review-requests',
      headers: asUser('editor1', 'editor'),
      payload: {
        templateId,
        html: filledDoc('<p>x</p>'),
        css: '.x{}',
        cssBaseline: '.x{}',
        origin: 'edit',
      },
    });
    expect(sub.statusCode).toBe(200);
    const reqId = sub.json().id;
    expect(fs.readFileSync(path.join(tmp, 'reviews', reqId, 'baseline.css'), 'utf8')).toBe('.x{}');
    const got = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).not.toHaveProperty('cssBaseline');
    expect(got.json().css).toBe('.x{}');
  });

  it('POST: 同じ人の同じ内容の 2 回目は 409 で、body.code は REVIEW_DUPLICATE', async () => {
    const tplId = 'XX01_633333_20250101_交付版';
    const first = await submit(asUser('editor1', 'editor'), tplId, '<p>重複 HTTP</p>');
    expect(first.statusCode).toBe(200);
    const second = await submit(asUser('editor1', 'editor'), tplId, '<p>重複 HTTP</p>');
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('REVIEW_DUPLICATE');
  });

  it('POST approve: 決定済みの申請は 409', async () => {
    const sub = await submit(
      asUser('editor1', 'editor'),
      'XX01_644444_20250101_交付版',
      '<p>y</p>',
    );
    const reqId = sub.json().id;
    await approvePart(reqId);
    await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: {},
    });
    const again = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });
  it('POST part-decisions: 処理済み申請の判定変更は409(code REVIEW_ALREADY_DECIDED)', async () => {
    const submitted = await submit(
      asUser('editor1', 'editor'),
      'XX01_688884_20250101_交付版',
      '<p>処理済み申請</p>',
    );
    expect(submitted.statusCode).toBe(200);
    const reqId = submitted.json().id as string;
    await approvePart(reqId);

    const approved = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);

    const changed = await decide(reqId, asUser('approver1', 'approver'), [
      { partKey: 'p#1', status: 'approved' },
    ]);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('REVIEW_ALREADY_DECIDED');
  });
  it('POST part-decisions: 並行した2パーツの判定を両方保持する', async () => {
    const submitted = await submit(
      asUser('editor1', 'editor'),
      'XX01_688885_20250101_交付版',
      '<p>並行更新対象</p><div>2件目</div>',
    );
    expect(submitted.statusCode).toBe(200);
    const reqId = submitted.json().id as string;

    const [approved, rejected] = await Promise.all([
      decide(reqId, asUser('approver1', 'approver'), [{ partKey: 'p#1', status: 'approved' }]),
      decide(reqId, asUser('approver1', 'approver'), [
        { partKey: 'div#1', status: 'rejected', comment: '2件目は修正が必要' },
      ]),
    ]);

    expect(approved.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(200);

    const reread = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(reread.statusCode).toBe(200);

    const decisions = reread.json().partDecisions as Array<{
      partKey: string;
      status: string;
      comment: string | null;
    }>;

    expect(decisions).toHaveLength(2);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          partKey: 'p#1',
          status: 'approved',
          comment: null,
        }),
        expect.objectContaining({
          partKey: 'div#1',
          status: 'rejected',
          comment: '2件目は修正が必要',
        }),
      ]),
    );
  });
  it('POST part-decisions: 判定履歴と申請時点の比較元を再読込みできる', async () => {
    const submitted = await submit(
      asUser('editor1', 'editor'),
      'XX01_688886_20250101_交付版',
      '<p>判定履歴と比較元の保存確認</p>',
    );
    expect(submitted.statusCode).toBe(200);
    const reqId = submitted.json().id as string;

    const approver = asUser('approver1', 'approver');
    const approved = await decide(reqId, approver, [{ partKey: 'p#1', status: 'approved' }]);
    expect(approved.statusCode).toBe(200);
    // 承認済みから直接は却下できない。取り消して(pending)から却下する。
    const direct = await decide(reqId, approver, [
      { partKey: 'p#1', status: 'rejected', comment: '判定変更後の却下理由' },
    ]);
    expect(direct.statusCode).toBe(409);
    expect(direct.json()).toMatchObject({
      code: 'REVIEW_PART_DECISION_TRANSITION',
      message: '許されていない判定の変更があります: p#1。画面を読み直してください。',
    });
    const undone = await decide(reqId, approver, [{ partKey: 'p#1', status: 'pending' }]);
    expect(undone.statusCode).toBe(200);
    const rejected = await decide(reqId, approver, [
      { partKey: 'p#1', status: 'rejected', comment: '判定変更後の却下理由' },
    ]);
    expect(rejected.statusCode).toBe(200);

    const reread = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(reread.statusCode).toBe(200);

    const review = reread.json() as {
      baseHtml?: string;
      baseCss?: string;
      partDecisions?: Array<{
        partKey: string;
        status: string;
        comment: string | null;
        history: Array<{
          from: string;
          to: string;
          changedBy: string;
          comment: string | null;
        }>;
      }>;
    };

    expect(review.partDecisions).toHaveLength(1);
    expect(review.partDecisions?.[0]).toMatchObject({
      partKey: 'p#1',
      status: 'rejected',
      comment: '判定変更後の却下理由',
      history: [
        { from: 'pending', to: 'approved', changedBy: 'approver1', comment: null },
        { from: 'approved', to: 'pending', changedBy: 'approver1', comment: null },
        {
          from: 'pending',
          to: 'rejected',
          changedBy: 'approver1',
          comment: '判定変更後の却下理由',
        },
      ],
    });

    const reviewDir = path.join(tmp, 'reviews', reqId);
    const baseHtmlPath = path.join(reviewDir, 'base.html');
    const baseCssPath = path.join(reviewDir, 'base.css');

    expect(fs.existsSync(baseHtmlPath)).toBe(true);
    expect(fs.existsSync(baseCssPath)).toBe(true);
    expect(review.baseHtml).toBe(fs.readFileSync(baseHtmlPath, 'utf8'));
    expect(review.baseCss).toBe(fs.readFileSync(baseCssPath, 'utf8'));
  });

  it('POST part-decisions: 重複キーは 400', async () => {
    const submitted = await submit(
      asUser('editor1', 'editor'),
      'XX01_688887_20250101_交付版',
      '<p>重複キー</p>',
    );
    const reqId = submitted.json().id as string;
    const res = await decide(reqId, asUser('approver1', 'approver'), [
      { partKey: 'p#1', status: 'approved' },
      { partKey: 'p#1', status: 'rejected', comment: '同じキー' },
    ]);
    expect(res.statusCode).toBe(400);
    const reread = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(reread.json().partDecisions ?? []).toEqual([]);
  });

  it('POST part-decisions: 旧パス /part-decision は 404', async () => {
    const submitted = await submit(
      asUser('editor1', 'editor'),
      'XX01_688888_20250101_交付版',
      '<p>旧パス</p>',
    );
    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${submitted.json().id}/part-decision`,
      headers: asUser('approver1', 'approver'),
      payload: { partKey: 'p#1', status: 'approved' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST approve: 自己承認(申請者==承認者・非admin)は 403', async () => {
    const sub = await submit(
      asUser('editor1', 'editor'),
      'XX01_655555_20250101_交付版',
      '<p>z</p>',
    );
    const reqId = sub.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/approve`,
      headers: asUser('editor1', 'editor'),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST reject: 実ファイルを書かず rejected になる', async () => {
    const tplId = 'XX01_666666_20250101_交付版';
    const sub = await submit(asUser('editor1', 'editor'), tplId, '<p>却下対象</p>');
    const reqId = sub.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${reqId}/reject`,
      headers: asUser('approver1', 'approver'),
      payload: { comment: '理由' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
    expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SEEDED_FILLED);
  });

  // 却下だけは理由を要求する。却下された申請者に何を直せばよいか伝わらないと
  // 申請のやり直しが当てずっぽうになり、監査ログにも判断の根拠が残らない。
  // 画面側で入力を必須にするだけでは、API を直接叩く経路が素通りする。
  it('POST reject: 理由が無ければ 400 で拒否し、申請を未決のまま残す', async () => {
    const tplId = 'XX01_667777_20250101_交付版';
    const sub = await submit(asUser('editor1', 'editor'), tplId, '<p>理由なしの却下</p>');
    const reqId = sub.json().id;
    // 空ボディ・空文字・空白のみは、いずれも「理由を書いた」ことにならない。2,000 単位を超える
    // 理由も拒む(申請のファイルと監査ログに残るため)。
    for (const payload of [
      {},
      { comment: '' },
      { comment: '   ' },
      { comment: 'あ'.repeat(2001) },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/review-requests/${reqId}/reject`,
        headers: asUser('approver1', 'approver'),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    const after = await app.inject({
      method: 'GET',
      url: `/review-requests/${reqId}`,
      headers: asUser('approver1', 'approver'),
    });
    expect(after.json().status).toBe('pending');
  });

  // 必須にするのは却下理由だけ。承認メモまで必須にすると、通すだけの承認で
  // 意味のない文字列を書かせることになる。
  it('POST approve: メモが無くても通る', async () => {
    const tplId = 'XX01_668888_20250101_交付版';
    const sub = await submit(asUser('editor1', 'editor'), tplId, '<p>メモなしの承認</p>');
    await approvePart(sub.json().id);
    const res = await app.inject({
      method: 'POST',
      url: `/review-requests/${sub.json().id}/approve`,
      headers: asUser('approver1', 'approver'),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  // `actor()` は `req.user?.username ?? 'system'` / `req.user?.role ?? 'admin'` で local
  // モード(user 未設定)を全件可視の admin 扱いにする。onRequest フックは `x-test-user` が
  // 無ければ `req.user` を注入しない(上の各テストと同じ buildApp を使う)ので、ヘッダを
  // 送らないリクエストがそのままこの分岐を踏む。
  it('user 無し(無認証モード)の一覧は全件可視の admin 扱い', async () => {
    const res = await app.inject({ method: 'GET', url: '/review-requests' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
  });

  // `auditedRethrow` の failure 分岐(`review.reject` 監査イベントを outcome=failure で記録)を
  // 通す。`rejectReview` が投げる `notFound` はここで初めて中央 errorHandler へ渡る前に
  // 監査ログを書く経路を踏むので、500 に化けないことが本命の主張。
  it('存在しない申請の却下は 404 で、監査の failure 経路を通る(500 にならない)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/review-requests/rv-none/reject',
      headers: asUser('approver1', 'approver'),
      payload: { comment: '理由' },
    });
    expect(res.statusCode).toBe(404);
  });

  // `review.submit` 監査イベントの failure 分岐。作成タブの申請に値入り HTML の id(4 つ区切り)を
  // 渡すと入口で 400 になる。
  it('経路と id の形が合わない申請は 400 で、監査の failure 経路を通る', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/review-requests',
      headers: asUser('editor1', 'editor'),
      payload: {
        templateId: 'XX01_611111_20250101_交付版',
        html: '<p>x</p>',
        css: '',
        origin: 'create',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// 判定の一括変更は 5,000 件まで受けるので、監査ログの 1 行に全キーを載せない。件数と先頭だけ。
describe('partKeysAudit(判定の一括変更の監査ログに載せるキー)', () => {
  it('件数と先頭 20 件だけを返す', async () => {
    const { partKeysAudit } = await import('../src/routes/reviews.routes.js');
    const keys = Array.from({ length: 25 }, (_, i) => `k#${i + 1}`);
    expect(partKeysAudit(keys.map((partKey) => ({ partKey })))).toEqual({
      partKeyCount: 25,
      partKeys: keys.slice(0, 20),
    });
    expect(partKeysAudit([{ partKey: 'a#1' }])).toEqual({ partKeyCount: 1, partKeys: ['a#1'] });
  });
});
