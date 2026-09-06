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

// DB(sproc)は本テストの対象外。承認直後の注記マスタ書き戻しが実 DB へ触れないよう
// `callSproc` を決定的に失敗させ、「DB 不在でも承認は成立する」ベストエフォート経路に
// 固定する(開発機に LocalDB が居ると素通しで実 DB へ書いてしまうため必須)。
vi.mock('../src/db/sproc.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/db/sproc.js')>();
  return {
    ...orig,
    callSproc: async () => {
      throw new Error('DB 不在(テストの意図的失敗)');
    },
  };
});

// config を import する前に一時ディレクトリへ向ける。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-review-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.REVIEWS_DIR = path.join(tmp, 'reviews');
process.env.PENDING_DIR = path.join(tmp, 'pending');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

d('review workflow (reviewRepo)', () => {
  let reviews: typeof import('../src/repositories/reviewRepo.js');
  const submitter = { username: 'editor1', role: 'editor' };
  const approver = { username: 'approver1', role: 'approver' };

  const submit = (templateId: string, fundCode: string, html: string) =>
    reviews.submitReview({ templateId, html, css: '.x{}', fundCode, origin: 'edit' }, submitter);

  beforeAll(async () => {
    reviews = await import('../src/repositories/reviewRepo.js');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('submit creates a pending request and does NOT touch the template file', async () => {
    const tplId = 'AM01_111111_20250101_交付版';
    const meta = await submit(tplId, '111111', '<p>{{ fund.name }} 申請</p>');
    expect(meta.status).toBe('pending');
    expect(meta.submittedBy).toBe('editor1');
    // 実ファイルは未作成、申請だけが data/reviews 配下に在る。
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'reviews', meta.id, 'meta.json'))).toBe(true);
  });

  it('rejects self-approval unless admin (forbidden)', async () => {
    const meta = await submit('AM01_222222_20250101_交付版', '222222', '<p>x</p>');
    await expect(reviews.approveReview(meta.id, {}, submitter)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  // 実際に git コミットまで走らせるので、ルート CI(5 プロジェクト並列 + coverage)では
  // 既定 5s を超えて落ちる(単独なら 1s 未満)。上限を実測へ合わせる。
  it('approve writes the template file, commits, and marks the request approved', {
    timeout: 60_000,
  }, async () => {
    const tplId = 'AM01_333333_20250101_交付版';
    const meta = await submit(tplId, '333333', '<p>{{ fund.name }} 反映済</p>');
    const tplMeta = await reviews.approveReview(meta.id, { comment: 'ok' }, approver);

    expect(tplMeta.meta.id).toBe(tplId);
    // 申請〜承認の間に現行版へ割り込みが無いので並行性警告は立たない。
    expect(tplMeta.staleWarning).toBe(false);
    // 実ファイルが書かれた。
    const written = fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8');
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
    const tplId = 'AM01_888888_20250101_交付版';
    // 同一テンプレへ 2 件申請。両者の baseHash は「まだ現行版が無い」時点の値で揃う。
    const first = await submit(tplId, '888888', '<p>先行</p>');
    const second = await submit(tplId, '888888', '<p>後発</p>');
    // 先行を承認すると現行版(ディスク)が書き換わる。
    await reviews.approveReview(first.id, {}, approver);
    // 後発の baseHash は先行反映前の現行版なので、承認時点の現行版と食い違い警告が立つ。
    const res = await reviews.approveReview(second.id, {}, approver);
    expect(res.staleWarning).toBe(true);
    expect(res.meta.id).toBe(tplId);
  });

  it('approving an already-decided request conflicts (409)', async () => {
    const meta = await submit('AM01_444444_20250101_交付版', '444444', '<p>y</p>');
    await reviews.approveReview(meta.id, {}, approver);
    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('reject marks the request rejected without writing the template file', async () => {
    const tplId = 'AM01_555555_20250101_交付版';
    const meta = await submit(tplId, '555555', '<p>却下対象</p>');
    const rejected = await reviews.rejectReview(meta.id, { comment: '理由' }, approver);

    expect(rejected.status).toBe('rejected');
    expect(rejected.comment).toBe('理由');
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
  });

  it('本体(body.html)欠損の申請は承認できず、実ファイルも書かれない', async () => {
    const tplId = 'AM01_666666_20250101_交付版';
    const meta = await submit(tplId, '666666', '<p>欠損対象</p>');
    // メタだけ残して本体を失う異常(部分削除・隔離など)を再現する。
    fs.rmSync(path.join(tmp, 'reviews', meta.id, 'body.html'));

    await expect(reviews.approveReview(meta.id, {}, approver)).rejects.toMatchObject({
      kind: 'unexpected',
    });
    // 空内容での上書きが起きていない(実ファイル未作成)。
    expect(fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`))).toBe(false);
    // 詳細取得も同様にエラーになるが、一覧(メタのみ)には出続ける。
    await expect(reviews.getReview(meta.id, approver)).rejects.toMatchObject({
      kind: 'unexpected',
    });
    const listed = await reviews.listReviews({}, approver);
    expect(listed.some((m) => m.id === meta.id)).toBe(true);
  });

  it('同一申請への並行 approve は片方だけ成立し、承認コミットは 1 件になる', async () => {
    const tplId = 'AM01_777777_20250101_交付版';
    const meta = await submit(tplId, '777777', '<p>並行承認</p>');
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
    const tplId = 'AM01_999999_20250101_交付版';
    const meta = await submit(tplId, '999999', '<p>競合対象</p>');
    const results = await Promise.allSettled([
      reviews.approveReview(meta.id, {}, approver),
      reviews.rejectReview(meta.id, {}, approver),
    ]);

    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBe(1);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ kind: 'conflict' });
    // 確定した状態と実ファイルの有無が一致する(反映済みなのに rejected、が起きない)。
    const after = await reviews.getReview(meta.id, approver);
    const fileExists = fs.existsSync(path.join(tmp, 'templates', `${tplId}.html`));
    expect(fileExists).toBe(after.status === 'approved');
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
        submit('AM01_121212_20250101_交付版', '121212', '<p>上限テスト</p>'),
      ).rejects.toMatchObject({ kind: 'validation' });
    } finally {
      spy.mockRestore();
    }
  });

  it('決着済みの申請は未処理件数に数えない(承認が進めばまた申請できる)', async () => {
    const files = await import('../src/files/reviewFiles.js');
    const before = await files.countPendingReviews();
    const meta = await submit('AM01_131313_20250101_交付版', '131313', '<p>数え方</p>');
    expect(await files.countPendingReviews()).toBe(before + 1);
    await reviews.rejectReview(meta.id, { comment: '理由' }, approver);
    // 却下しても実体は残るが、行列(= 攻撃者が伸ばせる量)からは外れる。
    expect(await files.countPendingReviews()).toBe(before);
  });
  it('申告 fundCode がテンプレート id と食い違う申請は入口で弾く', async () => {
    // CSS はファンド単位の共有ファイル。承認時の `applyConfirmedWrite` は同じ条件で
    // 拒否するので、通しても承認できない申請がキューに積まれるだけになる。申請時に
    // 読む現行版ハッシュ(`baseHash`)も別ファンドの CSS を混ぜた値になる。
    await expect(
      submit('AM01_444444_20250101_交付版', '999999', '<p>不一致</p>'),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  describe('旧 held 申請の読み取り', () => {
    it('meta.json の status が held なら pending として読み、保留フィールドは落とす', async () => {
      const meta = await submit('AM01_141414_20250101_交付版', '141414', '<p>旧保留</p>');
      const files = await import('../src/files/reviewFiles.js');
      const metaPath = path.join(tmp, 'reviews', meta.id, 'meta.json');
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          ...raw,
          status: 'held',
          heldBy: 'approver1',
          heldAt: '2026-09-01T00:00:00.000Z',
          holdComment: '確認中',
        }),
      );
      const read = await files.readReview(meta.id);
      expect(read?.status).toBe('pending');
      expect(read && 'heldBy' in read).toBe(false);
      expect((await files.listReviewMetas()).find((m) => m.id === meta.id)?.status).toBe('pending');
      expect(await files.countPendingReviews()).toBeGreaterThanOrEqual(1);
    });

    it('旧 held の申請はそのまま承認・却下できる', async () => {
      const meta = await submit('AM01_151515_20250101_交付版', '151515', '<p>旧保留→承認</p>');
      const metaPath = path.join(tmp, 'reviews', meta.id, 'meta.json');
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(metaPath, JSON.stringify({ ...raw, status: 'held' }));
      const result = await reviews.approveReview(meta.id, {}, approver);
      expect(result.meta).toBeTruthy();
    });
  });
});
