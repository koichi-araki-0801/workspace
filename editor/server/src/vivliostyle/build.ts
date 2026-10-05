// =============================================================================
// build.ts — `@vivliostyle/cli` で PDF をビルドする(inline / project / merge)
// =============================================================================
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DOC_DIR } from '@editor/shared';
import { config } from '../config.js';
import { assertNoDocumentExternalRefs } from '../security/externalRefs.js';
import { BuildAdmissionGate } from './buildAdmission.js';
import { buildWorkerPool } from './buildWorkerServer.js';
import { stageDocAssets } from './docAssets.js';
import { collectDocumentAssetRefs } from './docRefs.js';
import { type BuildOriginReservation, reserveBuildOrigin } from './egressGuard.js';
import { inlineCss } from './inlineCss.js';
import { inlineDocScripts } from './inlineDocScripts.js';
import { type MergeDocument, materializeMergeProject, mergeConfigObject } from './mergeInput.js';
import { sharedInlineConfig } from './options.js';
import type { SafeProjectConfig } from './projectConfig.js';
import { cleanupProject } from './projectInput.js';
import { rebaseRequestCss } from './requestCss.js';

/** PDF 生成失敗時に投げる Error の前置き(原因は cause として stderr/timeout を連結する)。 */
const PDF_BUILD_FAILED = 'PDFの生成に失敗しました';

/**
 * ワーカー枠を確保してから `fn` を走らせる。`fn` は受け取った `runBuild` で 1 回だけ組版する。
 *
 * ⚠ **資源の確保(temp ディレクトリ・配信ルートへの資産配置・egress ポート予約)は必ず
 * `fn` の中で行うこと。** 枠を取る前に確保すると、順番待ちのあいだも
 * 「1 ビルド 4 ポート + 展開済み資産 + temp ディレクトリ」を握り続け、行列に並んで
 * いるだけで資源が枯れる。枠を取ってから確保すれば、握る資源は常に同時実行数ぶんで頭打ちになる。
 *
 * 既定は常駐ウォームワーカープール(`buildWorkerPool`)へ委譲し、`@vivliostyle/cli` の import
 * (計測 ~11s)をプロセス使い回しで 1 度きりにする。`config.vivliostyle.build.poolSize <= 0` の
 * ときは「ジョブ毎 spawn」(`runBuildWorkerSpawn`)へフォールバックする(安全弁)。
 * フォールバックも `SPAWN_FALLBACK_GATE` で受付制御を受ける(`buildAdmission.ts`)。
 */
export function withBuildSlot<T>(
  fn: (runBuild: (buildOptions: unknown) => Promise<void>) => Promise<T>,
): Promise<T> {
  if (config.vivliostyle.build.poolSize <= 0) return withSpawnFallbackSlot(fn);
  return buildWorkerPool.withSlot(fn);
}

/**
 * フォールバック経路(ジョブ毎 spawn)の受付制御。
 *
 * 同時実行を **1 本**に固定するのは、この経路がプールの故障を疑うときの迂回路で、常用を
 * 想定しないため — 1 ジョブが Node + Chromium を丸ごと起こす経路を無制限に並べると、
 * 単一プロセスのサーバがメモリごと落ちる。行列長はプール経路と同じ設定値を使う。
 */
const SPAWN_FALLBACK_GATE = new BuildAdmissionGate({
  maxConcurrent: 1,
  maxQueue: config.vivliostyle.build.maxQueue,
});

/**
 * フォールバック経路で枠を取り `fn` を走らせる。`buildWorkerPool.withSlot` と同契約に
 * するため、1 枠で 2 度目のビルドを始めようとしたら拒否する(枠の二重使用)。
 */
function withSpawnFallbackSlot<T>(
  fn: (runBuild: (buildOptions: unknown) => Promise<void>) => Promise<T>,
): Promise<T> {
  return SPAWN_FALLBACK_GATE.run(() => {
    let started = false;
    return fn((buildOptions) => {
      if (started) return Promise.reject(new Error(`${PDF_BUILD_FAILED}: 枠の二重使用`));
      started = true;
      return runBuildWorkerSpawn(buildOptions);
    });
  });
}

/**
 * フォールバック方式: ビルドのたびに worker を spawn する。in-process 実行はサーバを
 * ハングさせるため(`pdf-build-worker.mjs` 冒頭の解説参照)`child_process` へ分離し、
 * `config.vivliostyle.build.timeoutMs` の timeout を必ず効かせる。timeout(kill)/非 0 exit は
 * Error を reject し、上位(`auditedRethrow`)経由で 5xx を返す。
 */
function runBuildWorkerSpawn(buildOptions: unknown): Promise<void> {
  const timeoutMs = config.vivliostyle.build.timeoutMs;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [config.pdf.workerScript, JSON.stringify(buildOptions)],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, _stdout, stderr) => {
        if (err) {
          // `execFile` は timeout 時に子を kill し `err.killed = true` を立てる。
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          const reason = killed ? `タイムアウト(${timeoutMs}ms)で中断` : err.message;
          reject(new Error(`${PDF_BUILD_FAILED}: ${reason}${stderr ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * 1 ビルド分の CLI オプション共通部を、**そのビルド専用の loopback オリジン**込みで組む。
 *
 * `port` を我々が決めるのが要点で、これによって `egressGuard` は「loopback の全ポート」では
 * なく「このビルドが自分の組版に使う 1 オリジン」だけを中継できるようになる
 * (`egressGuard.ts` 冒頭の理由を見よ)。組版ブラウザは `--disable-web-security` 付きで動く
 * ため、他の loopback サービスへ届くこと自体が持ち出し経路になる。
 *
 * ⚠ `proxyServer` は `sharedInlineConfig` の既定(枠を持たない = 全遮断の共有中継)を
 * **予約専用の中継で上書きする**。上書きを外すと全ビルドが同じ中継を共有し、判定が
 * 「実行中の全ビルドの枠の和集合」へ戻る(= 同時実行中の他人の文書を読める)。
 * 展開の順序を入れ替えないこと。
 *
 * 呼び出し側は戻り値の `release()` を**必ず `finally` で呼ぶ**こと。呼び忘れると中継が
 * 開いたまま残り、以後もそのポートへ到達できてしまう。
 */
async function buildScope(): Promise<{
  options: Record<string, unknown>;
  reservation: BuildOriginReservation;
}> {
  const reservation = await reserveBuildOrigin();
  try {
    return {
      options: {
        ...(await sharedInlineConfig()),
        port: reservation.port,
        proxyServer: reservation.proxyServer,
      },
      reservation,
    };
  } catch (e) {
    reservation.release();
    throw e;
  }
}

/**
 * inline 文書の作業フォルダ内のエントリ。CLI へは単一入力(`input`)ではなく entry 配列の
 * config(`configData`)で渡す — 単一入力はエントリの親(`doc/`)を配信ルートにするので、兄弟の
 * `css/` `images/` に届かない。config なら `cwd`(作業フォルダ)から資産が配られる
 * (`test/vivliostyleCliContract.test.ts` の実測)。
 */
const INLINE_ENTRY = `${DOC_DIR}/index.html`;

/** inline(レンダリング済み HTML + 任意の CSS)ビルド入力。 */
interface BuildInlineInput {
  html: string;
  css?: string;
  /** vivliostyle へ渡すページサイズ(既定 'A4')。 */
  size?: string;
  /** inline の build と preview では無視される(CLI へ渡さない。理由は `buildInlinePdf`)。 */
  singleDoc?: boolean;
}

/**
 * レンダリング済み HTML(+ 任意の CSS)から `@vivliostyle/cli` で PDF を生成する。
 * CSS は vivliostyle へ渡す前に HTML へインライン展開する。
 */
export async function buildInlinePdf(input: BuildInlineInput): Promise<Buffer> {
  // リクエスト CSS は入口で 1 回だけ付け替える(`requestCss.ts`)。検査は付け替え後の CSS に
  // 対して行う — 実際に文書へ入る形を見る(fail closed)。
  const doc = { ...input, css: rebaseRequestCss(input.css) };
  // 外部参照の関門は**ここ**(サーバの build 入口)。ブラウザ側の検査だけだと
  // 公開 API へ直接 POST すれば無検査で headless へ届く(`security/externalRefs.ts` 参照)。
  // 枠の確保より前に置くのは、拒否すべき入力を行列へ並ばせないため(同期の文字列検査で、
  // 資源は 1 つも握らない)。
  assertNoDocumentExternalRefs(doc.html, doc.css, 'build.inline');
  return withBuildSlot((runBuild) => buildInlineInSlot(doc, runBuild));
}

/** 枠を確保した状態で inline ビルドを行う(資源の確保はすべてこの中)。 */
async function buildInlineInSlot(
  input: BuildInlineInput,
  runBuild: (buildOptions: unknown) => Promise<void>,
): Promise<Buffer> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  // ⚠ **ビルドごとに専用ディレクトリを作る。** `config.tmpDir` 直下へ書くと、CLI の配信
  // ルートが `.tmp` そのものになり、同時に走る他のプレビューセッションや展開済み zip まで
  // 丸ごと loopback の Vite サーバから配信される。1 文書 = 1 ルートにするのが「作業
  // ディレクトリの外へ出さない」の実体。
  // 文書は `doc/` に書き、資産は `stageDocAssets` が兄弟(`css/` `js/` `images/`)へ置く —
  // 文書の `../css/…` がそのまま実体へ届く形(`docAssets.ts` 冒頭)。
  const dir = path.join(config.tmpDir, `vivlio-inline-${stamp}`);
  await fs.mkdir(path.join(dir, DOC_DIR), { recursive: true });
  const htmlPath = path.join(dir, ...INLINE_ENTRY.split('/'));
  const pdfPath = path.join(dir, 'output.pdf');
  const scope = await buildScope();

  try {
    // 配置するのは**この文書が参照している**資産だけ(`docRefs.ts` の理由を見よ)。
    const served = await stageDocAssets(dir, {
      referenced: collectDocumentAssetRefs(input.html, input.css ?? ''),
    });
    // 外部 JS は `src` の解決基準がビューアページ URL になり 404 で不実行になる(しかも
    // ビルドは成功する)。組版へ渡す直前に配信ルートの実体でインライン化して、テンプレ JS が
    // 「黙って効かない PDF」を作らないようにする(`inlineDocScripts.ts` 冒頭)。
    //
    // ⚠ これは**組版入力の一時的な変形**で、保存物には一切戻らない(このディレクトリは
    // `cleanupProject` で消える)。テンプレ JS の不変性照合(`security/templateScripts.ts`)は
    // 申請・承認・確定反映が扱う**原文 HTML** に対して行われるため、展開が原因で正当な
    // 保存が拒否されることはない。展開結果を保存経路へ回さないこと。
    await fs.writeFile(
      htmlPath,
      await inlineDocScripts(
        inlineCss(input.html, input.css ?? '', { servedAssets: served }),
        dir,
        served,
      ),
      'utf8',
    );

    await runBuild({
      // `cwd` を明示する。省略すると CLI の `entryContextDir` がサーバの作業ディレクトリ
      // (= リポジトリルート)になり、そこが `sirv` で配信対象に載る。
      configData: mergeConfigObject([INLINE_ENTRY], input.size ?? 'A4'),
      cwd: dir,
      output: [{ path: pdfPath, format: 'pdf' }],
      // `singleDoc` は渡さない。entry 1 本の config は文書中のリンクを辿らないので既に単一文書
      // として組まれ、configData 渡しで `bookMode=false` にすると出版物の manifest
      // (`publication.json`)を文書として読み、組版がエラーページ 1 枚に壊れる。
      ...scope.options,
    });

    return await fs.readFile(pdfPath);
  } finally {
    scope.reservation.release();
    await cleanupProject(dir);
  }
}

/** project(展開済みディレクトリ)ビルド入力。`projectInput.ts` を見よ。 */
interface BuildProjectInput {
  /** 展開済み vivliostyle プロジェクトを格納するディレクトリ。 */
  dir: string;
  /**
   * 許可リストで組み直した config(`projectConfig.parseProjectConfig` の出力)。CLI へは
   * **パスではなくこのオブジェクト**を `configData` で渡す。パスを渡すと CLI 側が
   * `locateVivliostyleConfig` でファイルを探し直し、我々のパーサとは別の JSONC パーサで
   * 読むため、検査したバイト列と実際に効く設定が分岐する。
   */
  config?: SafeProjectConfig;
  /** config が無い場合に使う相対エントリファイル。 */
  entry?: string;
  size?: string;
  /** config が無いときだけ CLI へ渡す(config があるときは無視する)。 */
  singleDoc?: boolean;
}

/**
 * 展開済み vivliostyle プロジェクトディレクトリから PDF をビルドする。プロジェクトの
 * `vivliostyle.config.*` があればそれを、無ければ単一エントリファイルを使う。
 *
 * ⚠ **枠は呼び出し側が `withBuildSlot` で取る。** この経路の入力は zip の展開結果で、
 * 展開そのものが temp ディレクトリを握る資源確保だからである(`vivliostyle.routes.ts` の
 * `apiPaths.buildProject`)。ここで枠を取る版だと展開は枠の外に残り、順番待ちのあいだ
 * 展開済みディレクトリを握り続けた。`buildMergedPdf` が枠を自分で取ってからこれを呼ぶのも
 * 同じ理由で、二重に取ると同時実行上限 1 の構成では自分自身を待つデッドロックになる。
 */
export async function buildProjectInSlot(
  input: BuildProjectInput,
  runBuild: (buildOptions: unknown) => Promise<void>,
): Promise<Buffer> {
  const pdfPath = path.join(input.dir, `__out-${Date.now()}.pdf`);
  const scope = await buildScope();

  try {
    // どちらの場合も `cwd` を設定し、vivliostyle がエントリをサーバの作業ディレクトリ
    // ではなく展開済みプロジェクトディレクトリ基準で解決するようにする。
    const entry = input.config
      ? { configData: input.config, cwd: input.dir }
      : { cwd: input.dir, input: input.entry };
    await runBuild({
      ...entry,
      output: [{ path: pdfPath, format: 'pdf' }],
      ...(input.size ? { size: input.size } : {}),
      // config があるときは `singleDoc` を渡さない(inline と同じ理由で、configData と併用すると
      // 組版が XML パースエラーの 1 ページに壊れる)。効くのは config の無い zip だけ。
      ...(input.singleDoc && !input.config ? { singleDoc: true } : {}),
      ...scope.options,
    });

    return await fs.readFile(pdfPath);
  } finally {
    scope.reservation.release();
    await fs.rm(pdfPath, { force: true });
  }
}

/**
 * 複数のレンダリング済み文書を 1 つの PDF へ結合ビルドする。文書群と entry 配列 config の
 * 実体化は `mergeInput.ts` が担い、ビルド自体は既存の `buildProjectPdf`(config 経路)へ
 * 委譲する — worker/daemon は build オプションを無検査で CLI へ渡すため変更不要。
 */
export async function buildMergedPdf(input: {
  documents: MergeDocument[];
  size?: string;
}): Promise<Buffer> {
  // 文書ごとのリクエスト CSS を入口で 1 回だけ付け替える(`requestCss.ts`)。
  const documents = input.documents.map((d) => ({ ...d, css: rebaseRequestCss(d.css) }));
  // 結合は文書毎に実体化されるので、実体化の**前**に全文書を検査する
  // (1 文書でも外部参照を持てば egress は成立する)。枠を取る前に検査するのは inline と
  // 同じ理由(拒否すべき入力を行列へ並ばせない)。
  for (const [i, doc] of documents.entries()) {
    assertNoDocumentExternalRefs(doc.html, doc.css, `build.merge[${i}]`);
  }
  // 実体化(文書数ぶんのファイル書き出し)も枠の内側で行う。外に出すと、順番待ちの
  // あいだ最大 30 文書ぶんの展開済みディレクトリが並んで残る。
  return withBuildSlot(async (runBuild) => {
    const { dir, config: mergeConfig } = await materializeMergeProject(documents, input.size);
    try {
      return await buildProjectInSlot({ dir, config: mergeConfig }, runBuild);
    } finally {
      await cleanupProject(dir);
    }
  });
}

/**
 * inline(HTML + CSS)ドキュメントをライブプレビュー用に新規 temp ディレクトリへ書き出す。
 * `buildInlinePdf` と異なりファイルは残し続ける必要がある(プレビューサーバがライブ配信する)
 * ため、返したディレクトリのクリーンアップは呼び出し側の責務とする。
 * 戻り値の `config` を `cwd: dir` と組で CLI へ渡す(`INLINE_ENTRY` の理由)。
 */
export async function prepareInlineDoc(
  input: BuildInlineInput,
): Promise<{ dir: string; config: SafeProjectConfig }> {
  // リクエスト CSS は入口で 1 回だけ付け替える(`requestCss.ts`)。
  const css = rebaseRequestCss(input.css);
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dir = path.join(config.tmpDir, `vivlio-prev-${stamp}`);
  await fs.mkdir(path.join(dir, DOC_DIR), { recursive: true });
  assertNoDocumentExternalRefs(input.html, css, 'preview.inline');
  // プレビューも作業フォルダは同じ形にする(文書は `doc/`、資産はその兄弟)。
  //
  // ⚠ ここは**外部クライアント向けのライブプレビュー API**(`/api/preview`)の経路で、
  // 画面内プレビュー(`web/src/features/preview/PreviewPanel.vue` + `previewHost.ts`)とは
  // 別物である。こちらの script は `previewProxy.CONTENT_CSP` の `script-src 'none'` で
  // 止まったままで(中継先が我々のオリジンで返るため隔離が効かない)、外部 JS の
  // インライン展開も行わない — 「JS を止める面」であることを CSP と揃えて据え置く。
  const served = await stageDocAssets(dir, {
    referenced: collectDocumentAssetRefs(input.html, css),
  });
  await fs.writeFile(
    path.join(dir, ...INLINE_ENTRY.split('/')),
    inlineCss(input.html, css, { servedAssets: served }),
    'utf8',
  );
  return { dir, config: mergeConfigObject([INLINE_ENTRY], input.size) };
}
