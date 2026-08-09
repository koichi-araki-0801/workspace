// =============================================================================
// options.ts — `@vivliostyle/cli` 呼び出し共通の inline-config を組み立てる
// =============================================================================
import { config } from '../config.js';
import { startEgressGuard } from './egressGuard.js';

/**
 * すべての `@vivliostyle/cli` 呼び出し(build inline / build project / preview)で共有する
 * inline-config フィールド。ブラウザの固定とログ抑制を一元化する唯一の場所で、3 つの
 * コード経路を歩調を揃えて保つ(vivliostyle の利用は `vivliostyle/` 配下に集約)。
 */
interface SharedInlineConfig {
  /** オフライン実行用に固定するシステムブラウザ。省略時は既定を使う。 */
  executableBrowser?: string;
  logLevel: 'silent';
  /**
   * Vite の `vite.config.*` 自動発見を止める。CLI 既定は `viteConfigFile ?? true` で、
   * `mergeInlineConfig` の `pruneObject` が落とすのは `undefined`/`null` だけなので `false` は
   * task まで残り、inline がアップロード config 側に勝つ。**これを外すと展開ツリー内の
   * `vite.config.*` が Vite にバンドル・import される**(vivliostyle の config 許可リストは
   * Vite の探索系統には及ばない)。
   */
  viteConfigFile: false;
  /**
   * 組版ブラウザの全通信を通す中継先(`egressGuard.ts`)。中継するのは**そのビルドが
   * 押さえた loopback オリジンだけ**で、他は宛先が loopback でも 502 で落ちる。
   *
   * ⚠ ここで入るのは**枠を 1 つも持たない共有の中継 = 全遮断**である。ビルド経路は
   * `build.ts` の `buildScope` が `reserveBuildOrigin()` で自分専用の中継を立て、この値を
   * その URL で**上書き**して初めて自分の Vite サーバへ届く(中継をビルドごとに分ける理由は
   * `egressGuard.ts` 冒頭)。プレビュー経路は CLI にブラウザを起こさせない
   * (`openViewer:false`)ので枠を取らない — 利用者のブラウザは `previewProxy` を通る。
   *
   * ⚠ 空文字や `undefined` にすると CLI は `process.env.HTTP_PROXY` へフォールバックし、
   * 遮断ごと消える(`options.proxyServer ?? process.env.HTTP_PROXY`)。値は常に明示する。
   */
  proxyServer: string;
  /**
   * プロキシを迂回してよい宛先。**遮断はここに依存していない**(依存できない: CLI が
   * `<-loopback>` を必ず付けるため、loopback 免除は実測で効かない — `egressGuard.ts` 冒頭)。
   * ここに loopback を並べるのは、Chromium 側の解釈が版で変わって免除が効くようになった
   * 場合でも「loopback は届く / それ以外は届かない」という**同じ実効ポリシー**に落ちる
   * ようにするため。外部ホストやワイルドカードを足さないこと — 足すとそこだけ素通しになる。
   */
  proxyBypass: string;
}

/**
 * プロキシを迂回してよい宛先。組版は loopback の Vite サーバから文書と同梱資産を取るので、
 * ここだけを並べる。CLI の rootUrl は既定で `http://localhost:<port>`。
 */
const EGRESS_BYPASS_HOSTS = '127.0.0.1,localhost,[::1]';

/**
 * `build()` と `preview()` に共通のオプションを組み立てる。
 *
 * 設定済みブラウザ(自動検出したシステム Edge / オフライン)を固定し、実行時に Chromium を
 * ダウンロードしようとしないようにする。puppeteer は Windows のバックスラッシュ区切りの
 * `executableBrowser` パスを解決できないため、スラッシュへ正規化する。
 *
 * egress 遮断の中継(`startEgressGuard`)をここで起動して待つので **async**。起動に失敗
 * したら throw して build ごと落とす — 遮断無しで組版へ進む縮退は作らない(fail closed)。
 */
export async function sharedInlineConfig(): Promise<SharedInlineConfig> {
  const executableBrowser = config.pdf.executableBrowser?.replace(/\\/g, '/');
  return {
    ...(executableBrowser ? { executableBrowser } : {}),
    logLevel: 'silent',
    viteConfigFile: false,
    proxyServer: await startEgressGuard(),
    proxyBypass: EGRESS_BYPASS_HOSTS,
  };
}
