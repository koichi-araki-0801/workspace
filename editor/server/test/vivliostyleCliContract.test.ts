// =============================================================================
// vivliostyleCliContract.test.ts — CLI へ config **ファイル**を渡さないことの機械固定
// =============================================================================
// 本改修の中心は「CLI に config を探させない」ことにある。次に触る人が `configPath` を
// 渡す形へ戻すと、`locateVivliostyleConfig` の大小文字ヒットと JSONC パーサが同時に復活し、
// 我々の許可リストは無関係になる。ここではソースを走査して**その退行を静的に落とす**。
//
// 実 CLI を起動する契約テスト(configData / viteConfigFile:false が本当に効くか)は、
// オフライン CI での chromium 取得と ~11s の import を避けるためここには置かない。
// 代わりに「我々のコードが CLI へ何を渡しているか」を型と静的検査の 2 段で固定する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sharedInlineConfig } from '../src/vivliostyle/options.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vivliostyle');

const read = (name: string): string => fs.readFileSync(path.join(SRC, name), 'utf8');

describe('@vivliostyle/cli への渡し方', () => {
  it.each([
    'build.ts',
    'previewServer.ts',
  ])('%s は configData で渡し、config パスを渡さない', (f) => {
    const text = read(f);
    expect(text).toContain('configData:');
    // `config: <パス>` を CLI へ渡す形が戻っていないこと。`configData:` は別語なので
    // 単語境界で見る。
    expect(/\bconfig:\s*(?:input|spec)\./.test(text)).toBe(false);
  });

  it('sharedInlineConfig は必ず viteConfigFile:false を含む', async () => {
    // CLI 既定は `viteConfigFile ?? true`。ここが落ちると展開ツリーの `vite.config.*` が
    // Vite に読まれる(vivliostyle 側の config 許可リストは Vite の探索に及ばない)。
    expect((await sharedInlineConfig()).viteConfigFile).toBe(false);
  });

  // `sharedInlineConfig` は egress 中継の起動を待つので **async** になった。CLI へ渡す
  // build オプションの型は `unknown` なので、`await` を忘れて Promise をそのまま spread しても
  // **型エラーにならない** — その場合 `proxyServer` が落ちて遮断だけが静かに消える
  // (組版は成功し続けるのでテストでも気づけない)。よって呼び出しの形をソースで固定する。
  it('sharedInlineConfig の呼び出しは必ず await されている', () => {
    for (const f of ['build.ts', 'previewServer.ts', 'options.ts']) {
      const text = read(f);
      for (const m of text.matchAll(/(.{10})sharedInlineConfig\(\)/g)) {
        // 定義そのもの(`export async function sharedInlineConfig()`)は呼び出しではない。
        if (m[1].includes('function ')) continue;
        expect(m[1], `${f}: ${m[0]}`).toContain('await ');
      }
    }
  });

  it('CLI を import するのは previewServer.ts だけ(build は worker 経由)', () => {
    // 駆動点を数え上げておくと、新しい呼び出し元が増えたときに「そこも configData か」を
    // 必ずレビューへ載せられる。build 側は worker プロセス(`buildWorkerServer`)が読む。
    const drivers = fs
      .readdirSync(SRC)
      .filter((n) => n.endsWith('.ts'))
      .filter((n) => /(?:from|import\()\s*'@vivliostyle\/cli'/.test(read(n)));
    expect(drivers.sort()).toEqual(['previewServer.ts']);
  });
});

// ── egress 遮断が CLI の実装に本当に噛み合っているか ──
// `proxyServer` / `proxyBypass` を渡しても、CLI がそれを Chromium の起動引数へ落とさなければ
// 遮断は 1 バイトも効かない。版を上げたときに黙って無効化されるのが最悪なので、
// **インストール済みの CLI 実装そのもの**を読んで契約を固定する。
describe('@vivliostyle/cli の proxy 契約(実装を読んで固定する)', () => {
  /** `--proxy-server=` を組み立てている dist チャンクの中身。 */
  const launcherSource = (): string => {
    const dist = path.dirname(fileURLToPath(import.meta.resolve('@vivliostyle/cli/package.json')));
    const distDir = path.join(dist, 'dist');
    for (const name of fs.readdirSync(distDir)) {
      if (!name.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(distDir, name), 'utf8');
      if (text.includes('--proxy-server=')) return text;
    }
    throw new Error('`--proxy-server=` を組み立てるチャンクが見つかりません');
  };

  it('proxyServer は Chromium の --proxy-server へ落ちる', () => {
    // 照合するのは CLI の**ソース断片**そのもの(テンプレート文字列の字面)。ここは
    // 我々が展開したい式ではないので、biome の placeholder 警告を明示的に落とす。
    // biome-ignore lint/suspicious/noTemplateCurlyInString: CLI 実装の字面を照合するため
    expect(launcherSource()).toContain('`--proxy-server=${proxy.server}`');
  });

  // ⚠ CLI は proxy 指定時に `<-loopback>`(Chromium の暗黙 loopback 免除を打ち消す指定)を
  // **必ず**付ける。実測では `proxyBypass` に `localhost` / `127.0.0.1,localhost,[::1]` /
  // `*` のいずれを渡しても loopback の文書取得が `ERR_PROXY_CONNECTION_FAILED` になった。
  // つまり「行き止まりプロキシ + bypass で loopback だけ通す」構成は**成立しない**。
  // だから遮断は `egressGuard.ts`(loopback にだけ中継する本物のプロキシ)で実装している。
  // ここが消えたら、bypass 方式が使えるようになった可能性があるので実測し直すこと。
  it('CLI は proxy 指定時に <-loopback> を必ず付ける(bypass 方式が成立しない根拠)', () => {
    expect(launcherSource()).toContain('"<-loopback>"');
  });

  // ⚠ 資格情報の受け口(`proxyUser` / `proxyPass`)は実在するが、CLI がそれを適用するのは
  // **ページ単位の** `page.authenticate` で、効くのは中継が 407 を返し、そのページの認証要求に
  // puppeteer が応答したときだけ。だから「1 本の中継 + ビルドごとの資格情報で枠を引く」案は
  // 採らず、「ビルドごとに中継を分ける」案を採った(`egressGuard.ts` 冒頭の比較)。
  // ここが変わったら選択の前提が変わるので読み直すこと。
  it('proxy 資格情報は page.authenticate 経由(= ページ単位の仕組み)', () => {
    const src = launcherSource();
    expect(src).toContain('page.authenticate(');
    expect(src).toContain('username: proxy.username');
  });

  it('proxyServer 未指定なら HTTP_PROXY へフォールバックする(= 常に明示せねばならない)', () => {
    const dist = path.dirname(fileURLToPath(import.meta.resolve('@vivliostyle/cli/package.json')));
    const distDir = path.join(dist, 'dist');
    const found = fs
      .readdirSync(distDir)
      .filter((n) => n.endsWith('.js'))
      .map((n) => fs.readFileSync(path.join(distDir, n), 'utf8'))
      .some((t) => t.includes('options.proxyServer ?? process.env.HTTP_PROXY'));
    expect(found).toBe(true);
  });
});

// ── テンプレ JS が PDF 組版で動く条件(実測。次に触る人への申し送り)──
// `@vivliostyle/core` は文書を `fetch` + `DOMParser` で読み、script 要素を**ビューアの
// window へ作り直して**実行する(`allowScripts` 既定 true)。実 PDF での実測は次のとおり:
//   - body 末尾のインライン `<script>` → **動く**(出力 PDF が変わる)
//   - `<script src="js/x.js">` → 動かない。再作成時の `src` 解決基準がビューアアプリの
//     URL になり `/__vivliostyle-viewer/js/x.js` を取りに行って 404(中継ログで確認)
//   - `<head>` で `DOMContentLoaded` に登録 → 発火しないので動かない
// よってテンプレ JS は **body 末尾のインライン script** に置く。
describe('@vivliostyle/viewer の script 実行(テンプレ JS が動く根拠)', () => {
  /** CLI が配信するビューアバンドル(`vsViewerPlugin` が sirv で返す実体)。 */
  const viewerBundle = (): string => {
    const cliDir = path.dirname(
      fileURLToPath(import.meta.resolve('@vivliostyle/cli/package.json')),
    );
    const viewer = path.resolve(
      cliDir,
      '..',
      '..',
      '@vivliostyle',
      'viewer',
      'lib',
      'js',
      'vivliostyle-viewer.js',
    );
    return fs.readFileSync(viewer, 'utf8');
  };

  it('ビューアは文書を DOMParser で読み、script は作り直して実行する', () => {
    const bundle = viewerBundle();
    expect(bundle).toContain('new DOMParser');
    // 作り直した script に付く印。ここが消えたら実行経路が変わった可能性があるので、
    // 実 PDF を 1 本作って「インライン script の有無で出力が変わるか」を測り直すこと。
    expect(bundle).toContain('data-vivliostyle-scripting');
  });

  it('allowScripts の既定は true(false になったらテンプレ JS が全部死ぬ)', () => {
    expect(viewerBundle()).toContain('allowScripts:!0');
  });
});
