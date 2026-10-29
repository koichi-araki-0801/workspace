// =============================================================================
// reviews.test.ts — 確定保存の精査者承認ワークフロー(reviewRepo)の結合テスト
// =============================================================================
// 一時 dataRoot/git を環境変数で固定し、submit(実ファイル非更新)→ approve(実ファイル書込 +
// git commit + meta=approved)→ reject(非更新)と、自己承認拒否を検証する。git CLI が前提。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionStub } from './helpers/sessionStub.js';

// config を import する前に一時ディレクトリへ向ける。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-'));
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

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('review workflow (reviewRepo)', () => {
  let reviews: import('../src/repositories/reviewRepo.js').ReviewRepo;
  const submitter = { username: 'editor1', role: 'editor' };
  const approver = { username: 'approver1', role: 'approver' };

  /** 編集タブが読む既存の値入り HTML。別ツールが置いた状態を模す。 */
  const SEEDED_FILLED = '<p>既存の値入り</p>';
  const filledFile = (templateId: string) => path.join(tmp, 'filled', `${templateId}.html`);
  const seedFilled = (templateId: string) => {
    fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
    fs.writeFileSync(filledFile(templateId), SEEDED_FILLED, 'utf8');
  };

  // 編集タブの申請は値入り HTML が既に在ることが前提(無い id は作成経路の成果物で、
  // 承認が `filled/` へ Jinja 骨組みを書いてしまう)。既定の origin に合わせて種を撒く。
  const submit = (templateId: string, html: string, origin: 'edit' | 'create' = 'edit') => {
    if (origin === 'edit' && !fs.existsSync(filledFile(templateId))) seedFilled(templateId);
    return reviews.submitReview({ templateId, html, css: '.x{}', origin }, submitter);
  };
  /**
   * edit 申請の変更パーツを全部承認する(判定の揃わない edit 申請は確定できない)。最終確定が
   * 失敗することを確かめるテストは、判定を済ませてから `reviews.approveReview` を直接呼ぶ。
   */
  const decideAll = async (reqId: string) => {
    const review = await reviews.getReview(reqId, approver);
    if (review.origin !== 'edit' || review.baseHtml === undefined) return;
    const { buildHtmlDiff } = await import('@editor/shared');
    const { linkedomParser } = await import('../src/util/linkedomParser.js');
    const diff = buildHtmlDiff(review.baseHtml, review.html, linkedomParser);
    const changed = diff.pages
      .flatMap((page) => page.blocks)
      .filter((block) => block.status !== 'same')
      .map((block) => ({ partKey: block.partKey, status: 'approved' as const }));
    if (changed.length === 0) return;
    const saved = await reviews.updatePartDecisions(reqId, { decisions: changed }, approver);
    expect(saved.map((d) => d.status)).toEqual(changed.map(() => 'approved'));
  };
  /** `decideAll` のあとで最終確定する。判定の失敗は握りつぶさずに投げる。 */
  const approveAll = async (
    reqId: string,
    decision: { comment?: string } = {},
    actor: typeof approver = approver,
  ) => {
    await decideAll(reqId);
    return reviews.approveReview(reqId, decision, actor);
  };
  /**
   * create申請へ値入りHTMLを添付し、単一パーツを承認済みにする。
   * createの最終確定は値入りHTML上の判定をJinja原文へ反映するため、承認テストで使用する。
   */
  const submitApprovedCreate = async (
    templateId: string,
    sourceHtml: string,
    filledHtml: string,
  ) => {
    const meta = await reviews.submitReview(
      {
        templateId,
        html: sourceHtml,
        css: '.x{}',
        origin: 'create',
        filledHtml,
      },
      submitter,
    );
    await reviews.updatePartDecisions(
      meta.id,
      {
        decisions: [
          {
            partKey: 'p#1',
            status: 'approved',
          },
        ],
      },
      approver,
    );
    return meta;
  };

  beforeAll(async () => {
    // DB(sproc)は本テストの対象外。承認直後の注記マスタ書き戻しが実 DB へ触れないよう
    // 決定的に失敗する実行面を渡し、「DB 不在でも承認は成立する」ベストエフォート経路に
    // 固定する(開発機に LocalDB が居ると素通しで実 DB へ書いてしまうため必須)。
    // helper は動的に取る — 静的 import だと冒頭の env 設定より先に `config.js` が読まれる。
    const { createOfflineSproc } = await import('./helpers/offlineSproc.js');
    const { createDeps } = await import('../src/deps.js');
    reviews = createDeps(createOfflineSproc(), createSessionStub()).reviews;
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('submit creates a pending request and does NOT touch the template file', async () => {
    const tplId = 'XX01_111111_20250101_交付版';
    const meta = await submit(tplId, '<p>{{ fund.name }} 申請</p>');
    expect(meta.status).toBe('pending');
    expect(meta.submittedBy).toBe('editor1');
    // 実ファイルは未更新(既存の値入り HTML のまま)、申請だけが <dataRoot>/reviews 配下に在る。
    expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SEEDED_FILLED);
    expect(fs.existsSync(path.join(tmp, 'reviews', meta.id, 'meta.json'))).toBe(true);
  });

  it('rejects self-approval unless admin (forbidden)', async () => {
    const meta = await submit('XX01_222222_20250101_交付版', '<p>x</p>');
    await decideAll(meta.id);
    await expect(reviews.approveReview(meta.id, {}, submitter)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  // 実際に git コミットまで走らせるので、ルート CI(5 プロジェクト並列 + coverage)では
  // 既定 5s を超えて落ちる(単独なら 1s 未満)。上限を実測へ合わせる。
  it('approve writes the template file, commits, and marks the request approved', {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_333333_20250101_交付版';
    const meta = await submit(tplId, '<p>{{ fund.name }} 反映済</p>');
    const tplMeta = await approveAll(meta.id, { comment: 'ok' }, approver);

    expect(tplMeta.meta.id).toBe(tplId);
    // 申請〜承認の間に現行版へ割り込みが無いので並行性警告は立たない。
    expect(tplMeta.staleWarning).toBe(false);
    // 実ファイルが書かれた。
    const written = fs.readFileSync(path.join(tmp, 'filled', `${tplId}.html`), 'utf8');
    expect(written).toContain('反映済');
    // git に承認コミットが積まれた(申請者・承認者の双方を残す)。
    const log = execFileSync('git', ['log', '-1', '--format=%an%x09%s'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    expect(log).toContain('approver1');
    expect(log).toContain('確定保存(承認)');
    // 申請は approved に。
    const after = await reviews.getReview(meta.id, approver);
    expect(after.status).toBe('approved');
    expect(after.reviewedBy).toBe('approver1');
    // 注記マスタ書き戻しはベストエフォート: DB 不在でも承認は成立し error 付き summary が返る。
    expect(tplMeta.noteMaster).toMatchObject({ updated: [] });
    expect(tplMeta.noteMaster?.error).toBeTruthy();
  });

  it('submit 後に現行版が変わっていると承認時に staleWarning=true(ブロックはしない)', async () => {
    const tplId = 'XX01_888888_20250101_交付版';
    // 同一テンプレへ 2 件申請。両者の baseHash は「まだ現行版が無い」時点の値で揃う。
    const first = await submit(tplId, '<p>先行</p>');
    const second = await submit(tplId, '<p>後発</p>');
    // 先行を承認すると現行版(ディスク)が書き換わる。
    await approveAll(first.id, {}, approver);
    // 後発の baseHash は先行反映前の現行版なので、承認時点の現行版と食い違い警告が立つ。
    const res = await approveAll(second.id, {}, approver);
    expect(res.staleWarning).toBe(true);
    expect(res.meta.id).toBe(tplId);
  });

  it('approving an already-decided request conflicts (409)', async () => {
    const meta = await submit('XX01_444444_20250101_交付版', '<p>y</p>');
    await approveAll(meta.id, {}, approver);
    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('reject marks the request rejected without writing the template file', async () => {
    const tplId = 'XX01_555555_20250101_交付版';
    const meta = await submit(tplId, '<p>却下対象</p>');
    const rejected = await reviews.rejectReview(meta.id, { comment: '理由' }, approver);

    expect(rejected.status).toBe('rejected');
    expect(rejected.comment).toBe('理由');
    expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SEEDED_FILLED);
  });

  it('本体(body.html)欠損の申請は承認できず、実ファイルも書かれない', async () => {
    const tplId = 'XX01_666666_20250101_交付版';
    const meta = await submit(tplId, '<p>欠損対象</p>');
    // メタだけ残して本体を失う異常(部分削除・隔離など)を再現する。
    fs.rmSync(path.join(tmp, 'reviews', meta.id, 'body.html'));

    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'unexpected',
    });
    // 空内容での上書きが起きていない(既存の値入り HTML のまま)。
    expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SEEDED_FILLED);
    // 詳細取得も同様にエラーになるが、一覧(メタのみ)には出続ける。
    await expect(reviews.getReview(meta.id, approver)).rejects.toMatchObject({
      kind: 'unexpected',
    });
    const listed = await reviews.listReviews({}, approver);
    expect(listed.some((m) => m.id === meta.id)).toBe(true);
  });

  it('同一申請への並行 approve は片方だけ成立し、承認コミットは 1 件になる', async () => {
    const tplId = 'XX01_777777_20250101_交付版';
    const meta = await submit(tplId, '<p>並行承認</p>');
    await decideAll(meta.id);
    const results = await Promise.allSettled([
      reviews.approveReview(meta.id, {}, approver),
      reviews.approveReview(meta.id, {}, approver),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ kind: 'conflict' });
    // 二重反映が無い = このテンプレの承認コミットは 1 件だけ。
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: tmp, encoding: 'utf8' });
    const commits = log.split('\n').filter((s) => s.includes(`確定保存(承認): ${tplId}`));
    expect(commits).toHaveLength(1);
  });

  it('approve と reject の並行は片方だけ成立し、実ファイルと meta が矛盾しない', async () => {
    const tplId = 'XX01_999999_20250101_交付版';
    const meta = await submit(tplId, '<p>競合対象</p>');
    await decideAll(meta.id);
    const results = await Promise.allSettled([
      reviews.approveReview(meta.id, {}, approver),
      reviews.rejectReview(meta.id, {}, approver),
    ]);

    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBe(1);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ kind: 'conflict' });
    // 確定した状態と実ファイルの内容が一致する(反映済みなのに rejected、が起きない)。
    const after = await reviews.getReview(meta.id, approver);
    const written = fs.readFileSync(filledFile(tplId), 'utf8');
    expect(written !== SEEDED_FILLED).toBe(after.status === 'approved');
    expect(['approved', 'rejected']).toContain(after.status);
  });

  // ── 未処理申請の件数上限 ──
  // 申請の作成は editor 1 ロールで撃て、1 件ごとに dataRoot へ書く。上限が無いと 1 人で
  // 領域を埋められ、`reviewsDir` は templates / `.git` と同じボリュームなので枯渇は
  // `atomicWrite` と `commitAll` の失敗 = 承認フローの停止に直結する。
  it('未処理が上限に達したら新規申請を断る(決着済みは数えない)', async () => {
    const files = await import('../src/files/reviewFiles.js');
    const pending = await files.countPendingReviews();
    // 上限ぶんの pending を作るのは重いので、上限そのものを一時的に現在値まで下げて
    // 「上限に達している状態」を作る(判定の入力は件数だけなので等価)。
    const spy = vi.spyOn(files, 'MAX_PENDING_REVIEWS', 'get').mockReturnValue(pending);
    try {
      await expect(
        submit('XX01_121212_20250101_交付版', '<p>上限テスト</p>'),
      ).rejects.toMatchObject({ kind: 'validation' });
    } finally {
      spy.mockRestore();
    }
  });

  it('上限ちょうどで同じ内容を再送したら、上限ではなく REVIEW_DUPLICATE を返す', async () => {
    const files = await import('../src/files/reviewFiles.js');
    await submit('XX01_141414_20250101_交付版', '<p>上限で二重</p>');
    const pending = await files.countPendingReviews();
    const spy = vi.spyOn(files, 'MAX_PENDING_REVIEWS', 'get').mockReturnValue(pending);
    try {
      await expect(
        submit('XX01_141414_20250101_交付版', '<p>上限で二重</p>'),
      ).rejects.toMatchObject({ kind: 'conflict', code: 'REVIEW_DUPLICATE' });
    } finally {
      spy.mockRestore();
    }
  });

  it('決着済みの申請は未処理件数に数えない(承認が進めばまた申請できる)', async () => {
    const files = await import('../src/files/reviewFiles.js');
    const before = await files.countPendingReviews();
    const meta = await submit('XX01_131313_20250101_交付版', '<p>数え方</p>');
    expect(await files.countPendingReviews()).toBe(before + 1);
    await reviews.rejectReview(meta.id, { comment: '理由' }, approver);
    // 却下しても実体は残るが、行列(= 攻撃者が伸ばせる量)からは外れる。
    expect(await files.countPendingReviews()).toBe(before);
  });
  describe('現行の 3 状態の外にある申請', () => {
    /** 申請の meta.json の status だけを書き換える(旧い保留の申請が残った状態を作る)。 */
    const markHeld = (id: string) => {
      const metaPath = path.join(tmp, 'reviews', id, 'meta.json');
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(metaPath, JSON.stringify({ ...raw, status: 'held', heldBy: 'approver1' }));
    };

    it('status が held の申請は 1 件ずつ読み飛ばし、他の申請の一覧は落とさない', async () => {
      const held = await submit('XX01_141414_20250101_交付版', '<p>旧保留</p>');
      const kept = await submit('XX01_232323_20250101_交付版', '<p>残る</p>');
      markHeld(held.id);
      const files = await import('../src/files/reviewFiles.js');
      const ids = (await files.listReviewMetas()).map((m) => m.id);
      expect(ids).toContain(kept.id);
      expect(ids).not.toContain(held.id);
      expect(await files.readReview(held.id)).toBeNull();
    });

    it('読み飛ばしの警告は申請ごとに 1 回だけ出す(一覧を開くたびにログを埋めない)', async () => {
      const held = await submit('XX01_242424_20250101_交付版', '<p>旧保留</p>');
      markHeld(held.id);
      const files = await import('../src/files/reviewFiles.js');
      const { logger } = await import('../src/logger.js');
      const spy = vi.spyOn(logger, 'warn');
      try {
        await files.listReviewMetas();
        await files.listReviewMetas();
        const forHeld = spy.mock.calls.filter(
          (c) => (c[0] as { reqId?: string } | undefined)?.reqId === held.id,
        );
        expect(forHeld).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('status が held の申請は承認できず、見つからない扱いになる', async () => {
      const meta = await submit('XX01_151515_20250101_交付版', '<p>旧保留→承認</p>');
      markHeld(meta.id);
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'not_found',
      });
    });
  });

  // ── 編集経路は値入り HTML の存在が前提 ──
  it("filled 不在 + origin='edit' の申請は拒否される", async () => {
    const tplId = 'XX01_202020_20250101_交付版';
    expect(fs.existsSync(filledFile(tplId))).toBe(false);
    await expect(
      reviews.submitReview(
        {
          templateId: tplId,
          html: '<p>骨組み</p>',
          css: '.x{}',
          origin: 'edit',
        },
        submitter,
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    // 拒否は申請の作成前に起きる(未処理の申請が増えない)。申請ディレクトリ名は
    // reqId で templateId を含まないため、一覧に対象 templateId の行が無いことで主張する。
    const listed = await reviews.listReviews({}, approver);
    expect(listed.some((m) => m.templateId === tplId)).toBe(false);
  });

  it("filled 不在でも origin='create' の申請は通る", async () => {
    const tplId = 'XX01_212121_交付版';
    const meta = await submit(tplId, '<p>{{ fund.name }}</p>', 'create');

    expect(meta.status).toBe('pending');
    expect(fs.existsSync(filledFile(tplId))).toBe(false);
  });

  it("origin='create' は値入り HTML がなければ最終確定できない", async () => {
    const tplId = 'XX01_212122_交付版';
    const meta = await submit(tplId, '<p>{{ fund.name }}</p>', 'create');

    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'validation',
      message: '作成タブの最終確定には値入りHTMLが必要です',
    });

    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);

    const pending = await reviews.getReview(meta.id, approver);
    expect(pending.status).toBe('pending');
  });

  // ── 承認の書込先は申請の `origin` で決まる ──
  // 編集タブ(edit)は値入り HTML、テンプレート作成タブ(create)は Jinja スケルトンを
  // 確定させる。取り違えると編集タブの実値が Jinja を上書きする(またはその逆)。
  it('作成タブの申請(origin=create)は値入り HTML の id(4 つ区切り)を 400 で拒む', async () => {
    await expect(
      submit('XX01_232323_20250101_交付版', '<p>{{ x }}</p>', 'create'),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('編集タブの申請(origin=edit)はテンプレートの id(3 つ区切り)を 400 で拒む', async () => {
    await expect(
      reviews.submitReview(
        {
          templateId: 'XX01_242424_交付版',
          html: '<p>x</p>',
          css: '',
          origin: 'edit',
        },
        submitter,
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it("origin='edit' の承認は filled/ に書き、templates/ には触れない", {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_161616_20250101_交付版';
    const meta = await submit(tplId, '<p>値入り本文</p>', 'edit');
    await approveAll(meta.id, {}, approver);
    expect(fs.readFileSync(path.join(tmp, 'filled', `${tplId}.html`), 'utf8')).toBe(
      '<p>値入り本文</p>',
    );
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
  });

  it("origin='create' の承認は templates/ に書き、filled/ には触れない", {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_171717_交付版';
    const meta = await submitApprovedCreate(
      tplId,
      '<p>{{ fund.name }}</p>',
      '<p>ダミー高利回り債券オープン</p>',
    );

    await approveAll(meta.id, {}, approver);
    expect(fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8')).toBe(
      '<p>{{ fund.name }}</p>',
    );
    expect(fs.existsSync(path.join(tmp, 'filled', `${tplId}.html`))).toBe(false);
  });

  it('create申請の最終確定は承認済みパーツだけをJinja原文でtemplates/へ保存する', {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_171718_交付版';
    const sourceHtml =
      '<body>' +
      '<section data-part-id="approved">{{ fund.name }}</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="rejected">費用 {{ fund.cost }}</section>' +
      '</body>';
    const filledHtml =
      '<body>' +
      '<section data-part-id="approved">ダミー高利回り債券オープン</section>' +
      '<div class="pagebreak"></div>' +
      '<section data-part-id="rejected">費用 1.25%</section>' +
      '</body>';

    const meta = await reviews.submitReview(
      {
        templateId: tplId,
        html: sourceHtml,
        css: '.x{}',
        origin: 'create',
        filledHtml,
      },
      submitter,
    );

    await reviews.updatePartDecisions(
      meta.id,
      {
        decisions: [
          {
            partKey: 'approved#1',
            status: 'approved',
          },
        ],
      },
      approver,
    );

    await reviews.updatePartDecisions(
      meta.id,
      {
        decisions: [
          {
            partKey: 'rejected#1',
            status: 'rejected',
            comment: '確定対象外',
          },
        ],
      },
      approver,
    );

    await approveAll(meta.id, {}, approver);

    const written = fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8');

    expect(written).toContain('<section data-part-id="approved">{{ fund.name }}</section>');
    expect(written).not.toContain('data-part-id="rejected"');
    expect(written).toContain('<div class="pagebreak"></div>');

    const approved = await reviews.getReview(meta.id, approver);
    expect(approved.status).toBe('approved');
  });

  // ── pending(生成直後の Jinja スケルトン)の後始末も書込先で分かれる ──
  // 編集タブの一覧は確定分と pending を合成して出す。値入り HTML の承認で pending を
  // 捨てると、まだ `templates/` へ昇格していない骨組みごと一覧から消える。
  it("origin='edit' の承認は pending を残す", { timeout: 60_000 }, async () => {
    const tplId = 'XX01_181818_20250101_交付版';
    const pendingFiles = await import('../src/files/pendingFiles.js');
    await pendingFiles.writePending(tplId, '<p>{{ fund.name }} 骨組み</p>', '.p{}');
    const meta = await submit(tplId, '<p>値入り本文</p>', 'edit');
    await approveAll(meta.id, {}, approver);

    expect(fs.existsSync(path.join(tmp, 'filled', `${tplId}.html`))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'pending', `${tplId}.html`))).toBe(true);
  });

  it("origin='create' の承認は pending を捨てる", { timeout: 60_000 }, async () => {
    const tplId = 'XX01_191919_交付版';
    const pendingFiles = await import('../src/files/pendingFiles.js');
    await pendingFiles.writePending(tplId, '<p>{{ fund.name }} 骨組み</p>', '.p{}');
    const meta = await submitApprovedCreate(
      tplId,
      '<p>{{ fund.name }} 確定</p>',
      '<p>ダミー高利回り債券オープン 確定</p>',
    );

    await approveAll(meta.id, {}, approver);

    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'pending', `${tplId}.html`))).toBe(false);
  });

  it("origin='create' のテンプレート(3 つ区切り)の承認は templates/<id>.html に書き、pending を捨てる", {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_222333_交付版';
    const pendingFiles = await import('../src/files/pendingFiles.js');
    await pendingFiles.writePending(tplId, '<p>{{ fund.name }} 骨組み</p>', '.p{}');
    const meta = await submitApprovedCreate(
      tplId,
      '<p>{{ fund.name }} 確定</p>',
      '<p>ダミー高利回り債券オープン 確定</p>',
    );

    expect(meta.attributes).toEqual({
      companyCode: 'XX01',
      fundCode: '222333',
      editionType: '交付版',
    });
    await approveAll(meta.id, {}, approver);
    expect(fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8')).toBe(
      '<p>{{ fund.name }} 確定</p>',
    );
    expect(fs.existsSync(path.join(tmp, 'pending', `${tplId}.html`))).toBe(false);
  });

  it('承認した CSS は同じテンプレの他の基準日にも効く(CSS はテンプレ単位)', {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_515151_20250101_交付版';
    seedFilled(tplId);
    const meta = await reviews.submitReview(
      { templateId: tplId, html: '<p>x</p>', css: '.shared{}', origin: 'edit' },
      submitter,
    );
    await approveAll(meta.id, {}, approver);
    const { readTemplateCss } = await import('../src/files/templateFiles.js');
    expect(fs.readFileSync(path.join(tmp, 'css', 'XX01_515151_交付版.css'), 'utf8')).toBe(
      '.shared{}',
    );
    expect(await readTemplateCss('XX01_515151_20250201_交付版')).toBe('.shared{}');
    expect(await readTemplateCss('XX01_515151_20250101_全体版')).toBe('');
  });

  it('申請の baseHash はテンプレの CSS を含む(CSS だけ変わっても staleWarning)', {
    timeout: 60_000,
  }, async () => {
    const tplId = 'XX01_525252_20250101_交付版';
    seedFilled(tplId);
    const meta = await reviews.submitReview(
      { templateId: tplId, html: '<p>x</p>', css: '.a{}', origin: 'edit' },
      submitter,
    );
    // 申請後に別の基準日の承認などで CSS が変わった状態を作る。
    fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'css', 'XX01_525252_交付版.css'), '.changed{}', 'utf8');
    const r = await approveAll(meta.id, {}, approver);
    expect(r.staleWarning).toBe(true);
  });

  it('基準日 A の申請中に基準日 B の承認で CSS が変わると、A の承認は止まらず staleWarning を返す', {
    timeout: 60_000,
  }, async () => {
    // CSS はテンプレ単位。A の下書きを開いたまま B の承認が同じ CSS を書き換えうる。
    const tplA = 'XX01_535353_20250101_交付版';
    const tplB = 'XX01_535353_20250201_交付版';
    seedFilled(tplA);
    seedFilled(tplB);
    const a = await reviews.submitReview(
      { templateId: tplA, html: '<p>a</p>', css: '.from-a{}', origin: 'edit' },
      submitter,
    );
    const b = await reviews.submitReview(
      { templateId: tplB, html: '<p>b</p>', css: '.from-b{}', origin: 'edit' },
      submitter,
    );
    const rb = await approveAll(b.id, {}, approver);
    expect(rb.staleWarning).toBe(false);
    // B の承認で css/XX01_535353_交付版.css が変わった。A の申請時点の基準と食い違う。
    const ra = await approveAll(a.id, {}, approver);
    expect(ra.staleWarning).toBe(true);
    // ブロックはしない(承認は成立し、A の CSS が反映される。警告で利用者に知らせる)。
    expect(fs.readFileSync(path.join(tmp, 'css', 'XX01_535353_交付版.css'), 'utf8')).toBe(
      '.from-a{}',
    );
  });

  // ── 同じ内容の重ね申請 ──
  // 二重クリック・再送で同じ申請が精査者のキューに並ぶと、承認者は同じ差分を 2 回見ることになる。
  // 同じ人・同じテンプレ・同じ経路・同じ HTML と CSS の承認待ちがあれば、新しい申請は作らない。
  describe('同じ内容の重ね申請', () => {
    const other = { username: 'editor2', role: 'editor' };
    const submitAs = (
      actor: { username: string; role: string },
      templateId: string,
      html: string,
      css = '.x{}',
    ) => {
      if (!fs.existsSync(filledFile(templateId))) seedFilled(templateId);
      return reviews.submitReview({ templateId, html, css, origin: 'edit' }, actor);
    };
    const pendingOf = async (templateId: string) =>
      (await reviews.listReviews({ status: 'pending' }, approver)).filter(
        (m) => m.templateId.toLowerCase() === templateId.toLowerCase(),
      );

    it('同じ人の同じ内容の 2 回目は 409 REVIEW_DUPLICATE で、申請は 1 件のまま', async () => {
      const tplId = 'XX01_610001_20250101_交付版';
      const first = await submitAs(submitter, tplId, '<p>重複</p>');
      await expect(submitAs(submitter, tplId, '<p>重複</p>')).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_DUPLICATE',
        message: expect.stringContaining('同じ内容の確定保存申請が既に承認待ちです'),
      });
      const pending = await pendingOf(tplId);
      expect(pending.map((m) => m.id)).toEqual([first.id]);
    });

    it('HTML か CSS が 1 文字でも違えば受け付ける', async () => {
      const tplId = 'XX01_610002_20250101_交付版';
      await submitAs(submitter, tplId, '<p>a</p>', '.x{}');
      await submitAs(submitter, tplId, '<p>b</p>', '.x{}');
      await submitAs(submitter, tplId, '<p>a</p>', '.y{}');
      expect(await pendingOf(tplId)).toHaveLength(3);
    });

    it('別の人の同じ内容は受け付ける', async () => {
      const tplId = 'XX01_610003_20250101_交付版';
      await submitAs(submitter, tplId, '<p>同じ</p>');
      await submitAs(other, tplId, '<p>同じ</p>');
      expect(await pendingOf(tplId)).toHaveLength(2);
    });

    it('1 件目が却下済みなら同じ内容でも受け付ける', async () => {
      const tplId = 'XX01_610004_20250101_交付版';
      const first = await submitAs(submitter, tplId, '<p>再申請</p>');
      await reviews.rejectReview(first.id, { comment: '理由' }, approver);
      const again = await submitAs(submitter, tplId, '<p>再申請</p>');
      expect(again.status).toBe('pending');
    });

    it('1 件目が承認済みなら同じ内容でも受け付ける', { timeout: 60_000 }, async () => {
      const tplId = 'XX01_610005_20250101_交付版';
      const first = await submitAs(submitter, tplId, '<p>承認後</p>');
      await approveAll(first.id, {}, approver);
      const again = await submitAs(submitter, tplId, '<p>承認後</p>');
      expect(again.status).toBe('pending');
    });

    it('同じ内容を同時に 2 回出すと 1 件だけ作られ、もう一方は 409', async () => {
      const tplId = 'XX01_610006_20250101_交付版';
      seedFilled(tplId);
      const results = await Promise.allSettled([
        submitAs(submitter, tplId, '<p>同時</p>'),
        submitAs(submitter, tplId, '<p>同時</p>'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_DUPLICATE',
      });
      expect(await pendingOf(tplId)).toHaveLength(1);
    });

    it('409 の文言に先の申請の日時(YYYY/MM/DD HH:mm)を載せる', async () => {
      const tplId = 'XX01_610008_20250101_交付版';
      await submitAs(submitter, tplId, '<p>日時</p>');
      await expect(submitAs(submitter, tplId, '<p>日時</p>')).rejects.toMatchObject({
        message: expect.stringMatching(
          /（\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}に申請）。新しい申請は作りませんでした。$/,
        ),
      });
    });

    it('本文の読めない承認待ちは重複の判定から外す(壊れた 1 件で申請を止めない)', async () => {
      const tplId = 'XX01_610009_20250101_交付版';
      const first = await submitAs(submitter, tplId, '<p>壊れ</p>');
      fs.rmSync(path.join(tmp, 'reviews', first.id, 'body.css'));
      const again = await submitAs(submitter, tplId, '<p>壊れ</p>');
      expect(again.status).toBe('pending');
    });

    it('templateId の大文字小文字だけが違うものは重複とみなす', async () => {
      const tplId = 'XX01_610007_20250101_交付版';
      await submitAs(submitter, tplId, '<p>大小</p>');
      await expect(submitAs(submitter, tplId.toLowerCase(), '<p>大小</p>')).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_DUPLICATE',
      });
      expect(await pendingOf(tplId)).toHaveLength(1);
    });
  });

  // ── edit 申請の最終確定: 画面と同じ差分で検査し、却下したパーツだけを現行版へ戻す ──
  describe('パーツ判定をまとめて保存する(updatePartDecisions)', () => {
    // 既存の値入り(`<p>`)に対し、`p#1` を変え、`div#1`・`section#1` を足した申請。判定できる
    // キーはこの 3 つ(差分に無いキーの判定は保存の段で拒む)。
    const fresh = async (tplId: string) =>
      (await submit(tplId, `<p>${tplId} 判定</p><div>二</div><section>三</section>`)).id;
    const decisionsOf = async (reqId: string) =>
      (await reviews.getReview(reqId, approver)).partDecisions ?? [];

    it('承認・却下を 1 回で保存し、履歴に pending → 判定を残す', async () => {
      const id = await fresh('XX01_720001_20250101_交付版');
      const saved = await reviews.updatePartDecisions(
        id,
        {
          decisions: [
            { partKey: 'p#1', status: 'approved' },
            { partKey: 'div#1', status: 'rejected', comment: '数字が違う' },
          ],
        },
        approver,
      );
      // 入力の順に、更新後の判定を返す。
      expect(saved.map((d) => [d.partKey, d.status])).toEqual([
        ['p#1', 'approved'],
        ['div#1', 'rejected'],
      ]);
      const stored = await decisionsOf(id);
      expect(stored).toHaveLength(2);
      expect(stored.find((d) => d.partKey === 'p#1')).toMatchObject({
        status: 'approved',
        decidedBy: 'approver1',
        comment: null,
        history: [{ from: 'pending', to: 'approved', changedBy: 'approver1', comment: null }],
      });
      expect(stored.find((d) => d.partKey === 'div#1')).toMatchObject({
        status: 'rejected',
        comment: '数字が違う',
        history: [{ from: 'pending', to: 'rejected', comment: '数字が違う' }],
      });
    });

    it('取り消しは pending に戻し、decidedBy/decidedAt/comment を null、履歴に from: rejected, to: pending', async () => {
      const id = await fresh('XX01_720002_20250101_交付版');
      await reviews.updatePartDecisions(
        id,
        { decisions: [{ partKey: 'p#1', status: 'rejected', comment: '戻す' }] },
        approver,
      );
      const [undone] = await reviews.updatePartDecisions(
        id,
        { decisions: [{ partKey: 'p#1', status: 'pending' }] },
        approver,
      );
      expect(undone).toMatchObject({
        partKey: 'p#1',
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        comment: null,
      });
      expect(undone?.history.map((h) => [h.from, h.to])).toEqual([
        ['pending', 'rejected'],
        ['rejected', 'pending'],
      ]);
      expect(await decisionsOf(id)).toEqual([undone]);
      // 取り消したあとは、もう一度判定できる。
      const [again] = await reviews.updatePartDecisions(
        id,
        { decisions: [{ partKey: 'p#1', status: 'approved' }] },
        approver,
      );
      expect(again?.history).toHaveLength(3);
    });

    it('申請の差分に無いパーツの承認・却下は 400 で、何も保存しない', async () => {
      const id = await fresh('XX01_720010_20250101_交付版');
      const input = {
        decisions: [
          { partKey: 'p#1', status: 'approved' as const },
          { partKey: 'nope#1', status: 'rejected' as const, comment: '無いパーツ' },
        ],
      };
      await expect(reviews.updatePartDecisions(id, input, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: '申請の差分に無いパーツの判定があります: nope#1。画面を読み直してください。',
      });
      expect(await decisionsOf(id)).toEqual([]);
    });

    it('作成経路で Jinja 原文のパーツを読めないときは、照合を飛ばさずにその 400 を返す', async () => {
      const tplId = 'XX01_720013_交付版';
      const meta = await reviews.submitReview(
        {
          templateId: tplId,
          html: '<body><section data-part-id="{{ fund.code }}">{{ fund.name }}</section></body>',
          css: '.x{}',
          origin: 'create',
          filledHtml: '<body><section data-part-id="s">ダミー</section></body>',
        },
        submitter,
      );
      for (let i = 0; i < 2; i++) {
        // 2 回目も同じ 400(読めなかったことを「照合しない」として覚えない)。
        await expect(
          reviews.updatePartDecisions(
            meta.id,
            { decisions: [{ partKey: 'other#1', status: 'approved' }] },
            approver,
          ),
        ).rejects.toMatchObject({
          kind: 'validation',
          message: 'パーツ識別子にJinjaを使用できません',
        });
      }
      expect(await decisionsOf(meta.id)).toEqual([]);
      // 取り消しだけの保存は照合しない(差分を計算しない)ので、原文を読めなくても遷移の検査へ進む。
      await expect(
        reviews.updatePartDecisions(
          meta.id,
          { decisions: [{ partKey: 's#1', status: 'pending' }] },
          approver,
        ),
      ).rejects.toMatchObject({ kind: 'conflict', code: 'REVIEW_PART_DECISION_TRANSITION' });
    });

    it('400・409 の文言に並べるキーは先頭 20 件までで、残りは件数だけ', async () => {
      const id = await fresh('XX01_720012_20250101_交付版');
      const keys = Array.from({ length: 25 }, (_, i) => `nope#${i + 1}`);
      const err = await reviews
        .updatePartDecisions(
          id,
          { decisions: keys.map((partKey) => ({ partKey, status: 'approved' as const })) },
          approver,
        )
        .catch((e: { message: string }) => e);
      const message = (err as { message: string }).message;
      expect(message).toBe(
        `申請の差分に無いパーツの判定があります: ${keys.slice(0, 20).join(', ')} ほか5件。` +
          '画面を読み直してください。',
      );
      expect(message).not.toContain('nope#21');
    });

    it('作成経路も、申請の本文に無いパーツの判定は 400', async () => {
      const tplId = 'XX01_720011_交付版';
      const meta = await reviews.submitReview(
        {
          templateId: tplId,
          html: '<body><section data-part-id="s">{{ fund.name }}</section></body>',
          css: '.x{}',
          origin: 'create',
          filledHtml: '<body><section data-part-id="s">ダミー</section></body>',
        },
        submitter,
      );
      await expect(
        reviews.updatePartDecisions(
          meta.id,
          { decisions: [{ partKey: 'other#1', status: 'approved' }] },
          approver,
        ),
      ).rejects.toMatchObject({ kind: 'validation' });
      const [saved] = await reviews.updatePartDecisions(
        meta.id,
        { decisions: [{ partKey: 's#1', status: 'approved' }] },
        approver,
      );
      expect(saved?.status).toBe('approved');
    });

    it('同じ partKey が 2 回あれば、schema を通らない呼び手からでも 400 相当で何も保存しない', async () => {
      const id = await fresh('XX01_720009_20250101_交付版');
      const input = {
        decisions: [
          { partKey: 'p#1', status: 'approved' as const },
          { partKey: 'div#1', status: 'approved' as const },
          { partKey: 'p#1', status: 'rejected' as const, comment: '二重' },
        ],
      };
      await expect(reviews.updatePartDecisions(id, input, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: '同じパーツの判定が 1 回の保存に複数あります: p#1',
      });
      expect(await decisionsOf(id)).toEqual([]);
    });

    it('許さない遷移が 1 件でもあれば何も保存しない', async () => {
      const id = await fresh('XX01_720003_20250101_交付版');
      await reviews.updatePartDecisions(
        id,
        { decisions: [{ partKey: 'p#1', status: 'approved' }] },
        approver,
      );
      const input = {
        decisions: [
          { partKey: 'div#1', status: 'approved' as const },
          { partKey: 'p#1', status: 'rejected' as const, comment: '承認済みを直接却下' },
        ],
      };
      await expect(reviews.updatePartDecisions(id, input, approver)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_PART_DECISION_TRANSITION',
        message: '許されていない判定の変更があります: p#1。画面を読み直してください。',
      });
      const stored = await decisionsOf(id);
      expect(stored.find((d) => d.partKey === 'div#1')).toBeUndefined();
      expect(stored.find((d) => d.partKey === 'p#1')?.status).toBe('approved');
    });

    it('未判定の取り消しと同じ判定の再送は許さない遷移', async () => {
      const id = await fresh('XX01_720004_20250101_交付版');
      await reviews.updatePartDecisions(
        id,
        { decisions: [{ partKey: 'p#1', status: 'approved' }] },
        approver,
      );
      await expect(
        reviews.updatePartDecisions(
          id,
          {
            decisions: [
              { partKey: 'section#1', status: 'pending' },
              { partKey: 'p#1', status: 'approved' },
            ],
          },
          approver,
        ),
      ).rejects.toMatchObject({
        code: 'REVIEW_PART_DECISION_TRANSITION',
        message: '許されていない判定の変更があります: section#1, p#1。画面を読み直してください。',
      });
      expect(await decisionsOf(id)).toHaveLength(1);
    });

    it('決着済みの申請への判定は code REVIEW_ALREADY_DECIDED の 409', async () => {
      const id = await fresh('XX01_720005_20250101_交付版');
      await reviews.rejectReview(id, { comment: '申請ごと却下' }, approver);
      await expect(
        reviews.updatePartDecisions(
          id,
          { decisions: [{ partKey: 'p#1', status: 'approved' }] },
          approver,
        ),
      ).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_ALREADY_DECIDED',
        message: 'この申請は既に却下済みです',
      });
      // 最終確定・申請ごと却下の 409 も同じ code(文言は今のまま)。
      await expect(reviews.rejectReview(id, { comment: '再却下' }, approver)).rejects.toMatchObject(
        { kind: 'conflict', code: 'REVIEW_ALREADY_DECIDED' },
      );
      await expect(reviews.approveReview(id, {}, approver)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_ALREADY_DECIDED',
      });
    });

    it('権限と職務分掌は今どおり(editor は 403、自分の申請は 403)', async () => {
      const id = await fresh('XX01_720006_20250101_交付版');
      const one = { decisions: [{ partKey: 'p#1', status: 'approved' as const }] };
      await expect(reviews.updatePartDecisions(id, one, submitter)).rejects.toMatchObject({
        kind: 'forbidden',
      });
      await expect(
        reviews.updatePartDecisions(id, one, { username: 'editor1', role: 'approver' }),
      ).rejects.toMatchObject({ kind: 'forbidden' });
      await expect(reviews.updatePartDecisions('nope', one, approver)).rejects.toMatchObject({
        kind: 'not_found',
      });
    });
  });

  describe('edit 申請の最終確定(パーツ判定)', () => {
    /** 申請時点の現行版。区切り・コメント・空白・head を持つ完全な文書。 */
    const BASE =
      '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><title>t</title></head>\n' +
      '<body>\n' +
      '<section data-part-id="cover"><h1>表紙 2025年</h1></section>\n' +
      '<div class="pagebreak"></div>\n' +
      "<section data-part-id='cost'>費用 1.00%</section>\n" +
      '<p class=note>注記<br/>そのまま</p>\n' +
      '<!-- 区切りの前のコメント -->\n' +
      '<div class="pagebreak"></div>\n' +
      '<section data-part-id="gone">削除される</section>\n' +
      '</body>\n</html>\n';
    /** 申請。cover と cost を変え、added を足し、gone を消した(最後の区切りは残る)。 */
    const SUBMITTED =
      '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><title>t</title></head>\n' +
      '<body>\n' +
      '<section data-part-id="cover"><h1>表紙 2026年</h1></section>\n' +
      '<div class="pagebreak"></div>\n' +
      "<section data-part-id='cost'>費用 1.25%</section>\n" +
      '<p class=note>注記<br/>そのまま</p>\n' +
      '<section data-part-id="added">追加</section>\n' +
      '<!-- 区切りの前のコメント -->\n' +
      '<div class="pagebreak"></div>\n' +
      '</body>\n</html>\n';

    const submitEdit = async (tplId: string, base: string, html: string) => {
      fs.mkdirSync(path.join(tmp, 'filled'), { recursive: true });
      fs.writeFileSync(filledFile(tplId), base, 'utf8');
      return reviews.submitReview(
        { templateId: tplId, html, css: '.x{}', origin: 'edit' },
        submitter,
      );
    };
    const decide = async (reqId: string, decisions: Record<string, 'approved' | 'rejected'>) => {
      await reviews.updatePartDecisions(
        reqId,
        {
          decisions: Object.entries(decisions).map(([partKey, status]) =>
            status === 'approved' ? { partKey, status } : { partKey, status, comment: '戻す' },
          ),
        },
        approver,
      );
    };

    it('却下したパーツは申請時点の現行版、承認したパーツとパーツの外は申請のバイトのまま書く', {
      timeout: 60_000,
    }, async () => {
      const tplId = 'XX01_710001_20250101_交付版';
      const meta = await submitEdit(tplId, BASE, SUBMITTED);
      await decide(meta.id, {
        'cover#1': 'approved',
        'cost#1': 'rejected',
        'added#1': 'rejected',
        'gone#1': 'rejected',
      });
      await reviews.approveReview(meta.id, {}, approver);

      expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(
        '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><title>t</title></head>\n' +
          '<body>\n' +
          '<section data-part-id="cover"><h1>表紙 2026年</h1></section>\n' +
          '<div class="pagebreak"></div>\n' +
          "<section data-part-id='cost'>費用 1.00%</section>\n" +
          '<p class=note>注記<br/>そのまま</p>\n' +
          '\n' +
          '<!-- 区切りの前のコメント -->\n' +
          '<div class="pagebreak"></div>\n' +
          '<section data-part-id="gone">削除される</section>\n' +
          '</body>\n</html>\n',
      );
    });

    it('却下が無ければ申請の本文をそのまま書く', { timeout: 60_000 }, async () => {
      const tplId = 'XX01_710002_20250101_交付版';
      const meta = await submitEdit(tplId, BASE, SUBMITTED);
      await decide(meta.id, {
        'cover#1': 'approved',
        'cost#1': 'approved',
        'added#1': 'approved',
        'gone#1': 'approved',
      });
      await reviews.approveReview(meta.id, {}, approver);
      expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SUBMITTED);
    });

    it('未判定・本文に無い判定・判定の重複が残ると 400 で、該当キーを出す', async () => {
      const tplId = 'XX01_710003_20250101_交付版';
      const meta = await submitEdit(tplId, BASE, SUBMITTED);
      await decide(meta.id, { 'cover#1': 'approved', 'cost#1': 'approved' });
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: expect.stringMatching(/未判定の変更が 2 件.*added#1, gone#1.*画面を再読み込み/),
      });

      await decide(meta.id, { 'added#1': 'approved', 'gone#1': 'approved' });
      // 差分に無いキーの判定は保存の段で拒むので、申請のファイルへ直接書いて最終確定の検査を見る
      // (照合の入る前に保存された申請を模す)。
      const { updateReviewMeta, readReview } = await import('../src/files/reviewFiles.js');
      const decided = (await readReview(meta.id))?.partDecisions ?? [];
      const added = decided.find((p) => p.partKey === 'added#1');
      if (added === undefined) throw new Error('added#1 not saved');
      await updateReviewMeta(meta.id, {
        partDecisions: [...decided, { ...added, partKey: 'nope#1' }],
      });
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: expect.stringContaining(
          '一致しない保存済み判定が 1 件あるため最終確定できません: nope#1',
        ),
      });

      const stored = await readReview(meta.id);
      const cover = stored?.partDecisions?.find((p) => p.partKey === 'cover#1');
      await updateReviewMeta(meta.id, {
        partDecisions: [
          ...(stored?.partDecisions ?? []).filter((p) => p.partKey !== 'nope#1'),
          ...(cover ? [cover] : []),
        ],
      });
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: expect.stringContaining(
          '同じパーツの判定が複数あるため最終確定できません: cover#1',
        ),
      });
      expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(BASE);
      expect((await reviews.getReview(meta.id, approver)).status).toBe('pending');
    });

    it('保存済みの pending は未判定として 400', async () => {
      const tplId = 'XX01_710004_20250101_交付版';
      const meta = await submitEdit(tplId, '<body><p>a</p></body>', '<body><p>b</p></body>');
      const { updateReviewMeta } = await import('../src/files/reviewFiles.js');
      await updateReviewMeta(meta.id, {
        partDecisions: [
          {
            partKey: 'p#1',
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            comment: null,
            history: [],
          },
        ],
      });
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: expect.stringContaining('未判定の変更が 1 件あるため最終確定できません: p#1'),
      });
    });

    it('差分が打ち切られた申請(本文直下の単位が上限超え)は 400', async () => {
      const tplId = 'XX01_710005_20250101_交付版';
      const many = (last: string) => `<body>${'<p>x</p>'.repeat(5_000)}<p>${last}</p></body>`;
      const meta = await submitEdit(tplId, many('旧'), many('新'));
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'validation',
        message: expect.stringContaining('差分の上限を超えて'),
      });
    });

    it('却下があり、申請後に現行版の HTML が変わっていれば 409(CSS だけの変化は通す)', {
      timeout: 60_000,
    }, async () => {
      const tplId = 'XX01_710006_20250101_交付版';
      const meta = await submitEdit(tplId, BASE, SUBMITTED);
      await decide(meta.id, {
        'cover#1': 'approved',
        'cost#1': 'rejected',
        'added#1': 'approved',
        'gone#1': 'approved',
      });
      fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'css', 'XX01_710006_交付版.css'), '.later{}', 'utf8');
      fs.writeFileSync(filledFile(tplId), `${BASE}<!-- 後から入った確定 -->`, 'utf8');
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_BASE_CHANGED',
      });

      fs.writeFileSync(filledFile(tplId), BASE, 'utf8');
      const res = await reviews.approveReview(meta.id, {}, approver);
      expect(res.staleWarning).toBe(true);
      expect(fs.readFileSync(filledFile(tplId), 'utf8')).toContain('費用 1.00%');
    });

    it('切り貼りの対応が取れない本文(DOM の並びと原文の範囲が違う)は 409 で、書かない', async () => {
      const tplId = 'XX01_710007_20250101_交付版';
      // `<p>` の中の `<div>` はパーサが `<p>` を閉じ、閉じ忘れの `</p>` から空の `<p>` を作る。
      const meta = await submitEdit(
        tplId,
        '<body><p class="x">旧</p><p>a<div>b</div></p></body>',
        '<body><p class="x">新</p><p>a<div>b</div></p></body>',
      );
      await decide(meta.id, { '.x#1': 'rejected' });
      await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'REVIEW_SPLICE_MISMATCH',
      });
      expect(fs.readFileSync(filledFile(tplId), 'utf8')).toContain('旧');
    });

    it('削除と、それに代わる追加の両方を却下すると、追加を消して削除したパーツを戻す', {
      timeout: 60_000,
    }, async () => {
      const tplId = 'XX01_710010_20250101_交付版';
      const head = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n';
      const meta = await submitEdit(
        tplId,
        `${head}<p>1</p>\n<div class="pagebreak"></div>\n<p id="z">Z</p>\n</body>\n</html>\n`,
        `${head}<p>1</p>\n<div class="pagebreak"></div>\n<p id="n">N</p>\n</body>\n</html>\n`,
      );
      await decide(meta.id, { 'z#1': 'rejected', 'n#1': 'rejected' });
      await reviews.approveReview(meta.id, {}, approver);
      expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(
        `${head}<p>1</p>\n<div class="pagebreak"></div>\n<p id="z">Z</p>\n\n</body>\n</html>\n`,
      );
    });

    describe('比較元(baseHtml / baseCss)を持たない古い申請', () => {
      const dropBase = (reqId: string) => {
        fs.rmSync(path.join(tmp, 'reviews', reqId, 'base.html'));
        fs.rmSync(path.join(tmp, 'reviews', reqId, 'base.css'));
      };

      it('判定が無ければ申請の本文をそのまま書く', { timeout: 60_000 }, async () => {
        const tplId = 'XX01_710008_20250101_交付版';
        const meta = await submitEdit(tplId, BASE, SUBMITTED);
        dropBase(meta.id);
        await reviews.approveReview(meta.id, {}, approver);
        expect(fs.readFileSync(filledFile(tplId), 'utf8')).toBe(SUBMITTED);
      });

      it('判定があれば 409 で申請し直しを求める', async () => {
        const tplId = 'XX01_710009_20250101_交付版';
        const meta = await submitEdit(tplId, BASE, SUBMITTED);
        await decide(meta.id, { 'cost#1': 'rejected' });
        dropBase(meta.id);
        await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
          kind: 'conflict',
          code: 'REVIEW_BASE_MISSING',
          message: expect.stringContaining('申請し直してください'),
        });
      });
    });
  });
});
