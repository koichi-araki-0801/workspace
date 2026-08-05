// =============================================================================
// build.ts — `@vivliostyle/cli` で PDF をビルドする(inline / project / merge)
// =============================================================================
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { assertNoDocumentExternalRefs } from '../security/externalRefs.js';
import { buildWorkerPool } from './buildWorkerServer.js';
import { stageDocAssets } from './docAssets.js';
import { collectDocumentAssetRefs } from './docRefs.js';
import { type BuildOriginReservation, reserveBuildOrigin } from './egressGuard.js';
import { inlineCss } from './inlineCss.js';
import { inlineDocScripts } from './inlineDocScripts.js';
import { type MergeDocument, materializeMergeProject } from './mergeInput.js';
import { sharedInlineConfig } from './options.js';
import type { SafeProjectConfig } from './projectConfig.js';
import { cleanupProject } from './projectInput.js';

/** PDF 生成失敗時に投げる Error の前置き(原因は cause として stderr/timeout を連結する)。 */
const PDF_BUILD_FAILED = 'PDFの生成に失敗しました';

/**
 * `@vivliostyle/cli` の `build()` オプションを隔離プロセスで実行する。
 * 既定は常駐ウォームワーカープール(`buildWorkerPool`)へ委譲し、`@vivliostyle/cli` の import
 * (計測 ~11s)をプロセス使い回しで 1 度きりにする。`config.vivliostyle.build.poolSize <= 0` の
 * ときは従来の「ジョブ毎 spawn」(`runBuildWorkerSpawn`)へフォールバックする(安全弁)。
 */
function runBuildWorker(buildOptions: unknown): Promise<void> {
  if (config.vivliostyle.build.poolSize <= 0) return runBuildWorkerSpawn(buildOptions);
  return buildWorkerPool.run(buildOptions);
}

/**
 * 従来方式: ビルドのたびに worker を spawn する(フォールバック)。in-process 実行はサーバを
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
 * 呼び出し側は戻り値の `release()` を**必ず `finally` で呼ぶ**こと。呼び忘れると許可枠が
 * 開いたまま残り、以後のビルドからそのポートへ到達できてしまう。
 */
async function buildScope(): Promise<{
  options: Record<string, unknown>;
  reservation: BuildOriginReservation;
}> {
  const reservation = await reserveBuildOrigin();
  try {
    return { options: { ...(await sharedInlineConfig()), port: reservation.port }, reservation };
  } catch (e) {
    reservation.release();
    throw e;
  }
}

/** inline(レンダリング済み HTML + 任意の CSS)ビルド入力。 */
interface BuildInlineInput {
  html: string;
  css?: string;
  /** vivliostyle へ渡すページサイズ(既定 'A4')。 */
  size?: string;
  /** 入力を単一ドキュメントとして扱う(ファイル単位のページ分割をしない)。 */
  singleDoc?: boolean;
}

/**
 * レンダリング済み HTML(+ 任意の CSS)から `@vivliostyle/cli` で PDF を生成する。
 * CSS は vivliostyle へ渡す前に HTML へインライン展開する。
 *
 * `{html, css}` のみ(size は 'A4' 既定)の場合、旧 `htmlToPdf` 呼び出しをバイト単位で
 * 再現する。inline 経路はそのドロップイン置換である。
 */
export async function buildInlinePdf(input: BuildInlineInput): Promise<Buffer> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  // ⚠ **ビルドごとに専用ディレクトリを作る。** `config.tmpDir` 直下へ書いていた頃は、
  // CLI の `workspaceDir`(= エントリ HTML の親)が `.tmp` そのものになり、同時に走る
  // 他のプレビューセッションや展開済み zip まで丸ごと loopback の Vite サーバから
  // 配信されていた。1 文書 = 1 ルートにするのが「作業ディレクトリの外へ出さない」の実体。
  const dir = path.join(config.tmpDir, `vivlio-inline-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  const htmlPath = path.join(dir, 'index.html');
  const pdfPath = path.join(dir, 'output.pdf');
  const scope = await buildScope();

  try {
    // 外部参照の関門は**ここ**(サーバの build 入口)。ブラウザ側の検査だけだと
    // 公開 API へ直接 POST すれば無検査で headless へ届く(`security/externalRefs.ts` 参照)。
    assertNoDocumentExternalRefs(input.html, input.css ?? '', 'build.inline');
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

    await runBuildWorker({
      input: htmlPath,
      // `cwd` を明示する。省略すると CLI の `entryContextDir` がサーバの作業ディレクトリ
      // (= リポジトリルート)になり、そこが `sirv` で配信対象に載る。
      cwd: dir,
      output: [{ path: pdfPath, format: 'pdf' }],
      size: input.size ?? 'A4',
      ...(input.singleDoc ? { singleDoc: true } : {}),
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
  singleDoc?: boolean;
}

/**
 * 展開済み vivliostyle プロジェクトディレクトリから PDF をビルドする。プロジェクトの
 * `vivliostyle.config.*` があればそれを、無ければ単一エントリファイルを使う。
 */
export async function buildProjectPdf(input: BuildProjectInput): Promise<Buffer> {
  const pdfPath = path.join(input.dir, `__out-${Date.now()}.pdf`);
  const scope = await buildScope();

  try {
    // どちらの場合も `cwd` を設定し、vivliostyle がエントリをサーバの作業ディレクトリ
    // ではなく展開済みプロジェクトディレクトリ基準で解決するようにする。
    const entry = input.config
      ? { configData: input.config, cwd: input.dir }
      : { cwd: input.dir, input: input.entry };
    await runBuildWorker({
      ...entry,
      output: [{ path: pdfPath, format: 'pdf' }],
      ...(input.size ? { size: input.size } : {}),
      ...(input.singleDoc ? { singleDoc: true } : {}),
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
  // 結合は文書毎に実体化されるので、実体化の**前**に全文書を検査する
  // (1 文書でも外部参照を持てば egress は成立する)。
  for (const [i, doc] of input.documents.entries()) {
    assertNoDocumentExternalRefs(doc.html, doc.css, `build.merge[${i}]`);
  }
  const { dir, config: mergeConfig } = await materializeMergeProject(input.documents, input.size);
  try {
    return await buildProjectPdf({ dir, config: mergeConfig });
  } finally {
    await cleanupProject(dir);
  }
}

/**
 * inline(HTML + CSS)ドキュメントをライブプレビュー用に新規 temp ディレクトリへ書き出す。
 * `buildInlinePdf` と異なりファイルは残し続ける必要がある(プレビューサーバがライブ配信する)
 * ため、返したディレクトリのクリーンアップは呼び出し側の責務とする。
 */
export async function prepareInlineDoc(
  input: BuildInlineInput,
): Promise<{ dir: string; entry: string }> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dir = path.join(config.tmpDir, `vivlio-prev-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  const entry = path.join(dir, 'index.html');
  assertNoDocumentExternalRefs(input.html, input.css ?? '', 'preview.inline');
  // プレビューも配信ルートは同じ形にする(同梱資産を相対パスで引ける)。
  //
  // ⚠ ここは**外部クライアント向けのライブプレビュー API**(`/api/preview`)の経路で、
  // 画面内プレビュー(`web/src/features/preview/PreviewPanel.vue` + `previewHost.ts`)とは
  // 別物である。こちらの script は `previewProxy.CONTENT_CSP` の `script-src 'none'` で
  // 止まったままで(中継先が我々のオリジンで返るため隔離が効かない)、外部 JS の
  // インライン展開も行わない — 「JS を止める面」であることを CSP と揃えて据え置く。
  const served = await stageDocAssets(dir, {
    referenced: collectDocumentAssetRefs(input.html, input.css ?? ''),
  });
  await fs.writeFile(
    entry,
    inlineCss(input.html, input.css ?? '', { servedAssets: served }),
    'utf8',
  );
  return { dir, entry };
}
