// =============================================================================
// previewServer.ts — `@vivliostyle/cli` の `preview()` を裏付けとする実プレビュー起動
// =============================================================================
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import { sharedInlineConfig } from './options.js';
import { PreviewManager, type PreviewServerHandle, type PreviewSpec } from './previewManager.js';

/** cli は出力に色を付ける。URL を照合する前に ANSI エスケープを除去する。 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** (ANSI 除去済みの)捕捉出力から cli の "Preview URL" を照合する。 */
const VIEWER_URL_RE = /https?:\/\/[^\s]*__vivliostyle-viewer[^\s]*/;

/**
 * stdout/stderr へ書かれた全内容を捕捉しながら `fn` を実行し、捕捉テキストを結果と
 * 併せて返す。cli は "Preview URL" のボックスを clack 経由で出力する(`logger` オプションを
 * バイパスする)ため、これがそれを読む唯一の確実な手段。ラップはグローバルなので、
 * 呼び出し側は直列化する(`startChain` を見よ)。
 */
async function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  let output = '';
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown): boolean => {
    output += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

// プレビュー起動を直列化し、`captureStdio` のグローバルな stdout/stderr ラップが
// 同時起動で破壊されないようにする。
let startChain: Promise<unknown> = Promise.resolve();

/**
 * `@vivliostyle/cli` の `preview()` を裏付けとする実プレビュー起動関数。cli を import するのは
 * (`build.ts` を除き)ここだけで、vivliostyle の利用を `vivliostyle/` 配下に集約する。
 *
 * Vite プレビューサーバはループバック(`host`)に bind し、Express がそこへリバースプロキシ
 * するため公開ポート(:24680)のみが公開され認証も効く。アップロード入力はスナップショットで
 * ライブリロードする対象が無いため HMR を無効化し(`vite.server.hmr`)、プロキシを素の
 * HTTP に保つ(WebSocket トンネル不要)。ポートは Vite に委ね、同時プレビューが自動
 * インクリメントするようにする。実際のポートと viewer URL は起動後に読み戻す。
 */
const vivliostylePreviewStarter = (
  spec: PreviewSpec,
  host: string,
): Promise<PreviewServerHandle> => {
  const run = async (): Promise<PreviewServerHandle> => {
    const { preview } = await import('@vivliostyle/cli');
    // どちらの場合も `cwd` を設定し、エントリをプロジェクトディレクトリ基準で解決する。
    const entry = spec.config
      ? { configData: spec.config, cwd: spec.cwd }
      : { cwd: spec.cwd, input: spec.input };
    // `captureStdio` は stdout/stderr をグローバルに差し替えるので、その内側で
    // 非同期の準備(egress guard の起動)をしない — 起動ログを飲み込みうるため先に解く。
    const shared = await sharedInlineConfig();

    const { result: server, output } = await captureStdio(() =>
      preview({
        ...entry,
        ...(spec.size ? { size: spec.size } : {}),
        ...(spec.singleDoc ? { singleDoc: true } : {}),
        openViewer: false,
        host,
        // inline の `vite` は `mergeInlineConfig` がアップロード config の `vite` へ
        // 被せる(`pruneObject` が落とすのは undefined/null だけ)ので、こちらが必ず勝つ。
        // `fs.allow` を作業ディレクトリへ固定するのは多層防御:
        //   ① `/@fs` が万一プロキシの許可リストを抜けても Vite 側で 403 になる、
        //   ② アップロード config の `vite.server.proxy`(上流 Vite を踏み台にした SSRF)や
        //      `cors` / `allowedHosts` の上書きをまとめて無効化する。
        // 主防御は `previewProxy.allowForwardPath` であって、ここではない。
        vite: { server: { hmr: false, fs: { strict: true, allow: [spec.workDir] } } },
        ...shared,
        logLevel: 'info', // 捕捉対象の "Preview URL" を cli に出力させるため
      } as Parameters<typeof preview>[0]),
    );

    const addr = server.httpServer?.address() as AddressInfo | string | null;
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    return {
      port,
      viewerUrl: output.replace(ANSI_RE, '').match(VIEWER_URL_RE)?.[0],
      close: async () => {
        await server.close();
      },
    };
  };

  const result = startChain.then(run, run);
  startChain = result.catch(() => undefined);
  return result;
};

/** プロセス全体のプレビューセッション管理(実 cli starter を配線済み)。 */
export const previewManager = new PreviewManager({
  idleTtlMs: config.vivliostyle.preview.idleTtlMs,
  maxSessions: config.vivliostyle.preview.maxSessions,
  host: config.vivliostyle.preview.host,
  starter: vivliostylePreviewStarter,
});
