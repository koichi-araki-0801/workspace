// =============================================================================
// vivliostyleCliContract.test.ts — CLI へ config **ファイル**を渡さないことの機械固定
// =============================================================================
// 本改修の中心は「CLI に config を探させない」ことにある。次に触る人が `configPath` を
// 渡す形へ戻すと、`locateVivliostyleConfig` の大小文字ヒットと JSONC パーサが同時に復活し、
// 我々の許可リストは無関係になる。ここではソースを走査して**その退行を静的に落とす**。
//
// CLI へ何を渡しているかは、型と静的検査の 2 段で固定する。実 CLI を起動するのは
// 配信ルートと singleDoc の契約だけ(Task 1 と Task 7 Step 17 が足す分)で、ブラウザは起こさず
// (`preview` の `openViewer:false`)HTTP で直接確かめる。CLI の import に約 11 秒掛かるので、
// 実 CLI を起動する契約はこの 2 種に限り、他の振る舞いは CLI をモックして確かめる。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeConfigObject } from '../src/vivliostyle/mergeInput.js';
import { sharedInlineConfig } from '../src/vivliostyle/options.js';
import { DEFAULT_DOC_BASE } from '../src/vivliostyle/previewProxy.js';

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

// ── 文書を doc/ に置いたときの配信ルート(実 CLI で測る)──
// 文書は `doc/index.html` に置き、`../css/…` `../images/…` で兄弟の資産を引く(論理配置。
// `@editor/shared` の `resolveDocAssetPath`)。CLI の単一入力(`input`)はエントリの親
// (= `doc/`)を配信ルートにするので兄弟へ届かない。entry 配列の config(`configData`)なら
// `cwd`(作業フォルダ)が `entryContextDir` になり、資産の拡張子(css・画像・フォント)は
// そこから配られる。ここが赤くなったら、PDF 経路の作業フォルダの形を設計から見直すこと。
describe('@vivliostyle/cli の配信ルート(doc/ のエントリと兄弟の資産)', () => {
  it('configData で doc/index.html をエントリにすると ../css と ../images と css/fonts が配信される', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vivlio-contract-'));
    const put = async (rel: string, body: string): Promise<void> => {
      const p = path.join(dir, ...rel.split('/'));
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, body, 'utf8');
    };
    await put(
      'doc/index.html',
      '<!doctype html><html><head><meta charset="utf-8">' +
        '<link rel="stylesheet" href="../css/x.css"></head>' +
        '<body><p>doc-marker</p><img src="../images/y.svg" alt=""></body></html>',
    );
    await put(
      'css/x.css',
      '/* css-marker */\n@font-face{font-family:F;src:url(fonts/a.woff2)}\np{color:red}\n',
    );
    await put('css/fonts/a.woff2', 'font-marker');
    await put('images/y.svg', '<svg xmlns="http://www.w3.org/2000/svg"><!-- svg-marker --></svg>');

    const { preview } = await import('@vivliostyle/cli');
    const server = await preview({
      configData: mergeConfigObject(['doc/index.html']),
      cwd: dir,
      openViewer: false,
      host: '127.0.0.1',
      viteConfigFile: false,
      logLevel: 'silent',
      vite: { server: { hmr: false, fs: { strict: true, allow: [dir] } } },
    } as Parameters<typeof preview>[0]);
    try {
      const addr = server.httpServer?.address();
      if (addr === null || addr === undefined || typeof addr !== 'object') {
        throw new Error('プレビューサーバのポートが取れません');
      }
      const docUrl = new URL(`http://127.0.0.1:${addr.port}${DEFAULT_DOC_BASE}/doc/index.html`);
      // ブラウザと同じ Accept を付ける。付けないと Vite が CSS を JS モジュールとして返しうる。
      const get = async (
        url: URL,
        accept: string,
      ): Promise<{ status: number; type: string; body: string }> => {
        const res = await fetch(url, { headers: { accept } });
        return {
          status: res.status,
          type: res.headers.get('content-type') ?? '',
          body: await res.text(),
        };
      };

      const doc = await get(docUrl, 'text/html');
      expect(doc.status).toBe(200);
      expect(doc.body).toContain('doc-marker');

      // 参照の解決はブラウザと同じく文書の URL を基準にする。
      const cssUrl = new URL('../css/x.css', docUrl);
      const css = await get(cssUrl, 'text/css,*/*;q=0.1');
      expect(css.status).toBe(200);
      expect(css.type).toContain('text/css');
      expect(css.body).toContain('css-marker');

      // CSS 内の参照は CSS の URL を基準にする(`url(fonts/a.woff2)` = `css/fonts/a.woff2`)。
      const font = await get(new URL('fonts/a.woff2', cssUrl), '*/*');
      expect(font.status).toBe(200);
      expect(font.body).toBe('font-marker');

      const svg = await get(new URL('../images/y.svg', docUrl), 'image/svg+xml,image/*,*/*;q=0.8');
      expect(svg.status).toBe(200);
      expect(svg.type).toContain('image/svg+xml');
      expect(svg.body).toContain('svg-marker');

      // `.js` は資産の拡張子に入っていないので配られない。テンプレ JS は `inlineDocScripts` が
      // 文書へ埋め込む前提で、配信を当てにしない(ここが 200 になったら前提を見直す)。
      await put('js/z.js', '/* js-marker */');
      const js = await get(new URL('../js/z.js', docUrl), '*/*');
      expect(js.status).toBe(404);
    } finally {
      await server.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
