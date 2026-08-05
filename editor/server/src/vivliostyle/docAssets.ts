// =============================================================================
// docAssets.ts — 同梱資産(css / fonts / js)を PDF・プレビューの配信ルートへ配置する
// =============================================================================
// テンプレは `href="css/{{ fund.code }}.css"` のように、CSS・フォント・JS を**相対パス**で
// 参照する。参照先の実体は `editor-data` にあるが、`@vivliostyle/cli` が配信するのは
// **エントリ HTML と同じディレクトリ**(`vsDevServerPlugin` が `sirv(workspaceDir)` /
// `sirv(entryContextDir)` で配る)なので、そこへ写さないと相対参照は必ず 404 になる。
//
// つまり「相対参照を許す」(`security/externalRefs.ts`)だけでは足りず、**参照先を配信ルートへ
// 置く側**が対になって初めて成立する。この 2 つは同じ 1 つの作業である。
//
// ── 何を写すかは許可リストで決める ──
// `dataRoot` は git 管理下の作業ディレクトリで、テンプレ実体・承認申請・同期状態も同居する。
// ディレクトリを丸ごと写すと、それらが headless ブラウザから読める配信ルートへ載る。
// よって写すのは「決められた 3 つの置き場」×「決められた拡張子」だけとする。
//
// ── 置き場(利用者決定・変更しないこと) ──
//   css   = `config.cssDir`   (per-fund。`<fund>.css`)
//   fonts = `config.assetsDir/fonts` (全ファンド共通)
//   js    = `config.assetsDir/js`    (全ファンド共通)
// 配信ルートでの名前は `css/` `fonts/` `js/` に固定する(テンプレ側の相対参照と対)。

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCssUrlCandidates } from '@editor/shared';
import { config, envPositiveNumber } from '../config.js';
import { MAX_ASSET_REF_DEPTH, resolveRefFrom } from './docRefs.js';

/** 配信ルートに作るサブディレクトリと、その中身として許す拡張子(小文字・末尾一致)。 */
interface AssetGroup {
  /** 配信ルート側のディレクトリ名(= テンプレの相対参照の先頭セグメント)。 */
  readonly mount: string;
  /** 実体の置き場を返す(`config` を毎回読むのはテストで差し替えられるようにするため)。 */
  readonly sourceDir: () => string;
  readonly extensions: ReadonlySet<string>;
}

/**
 * 配信してよい資産の全体。**ここに無いものは配信ルートへ出ない。**
 *
 * `.js` を許すのはテンプレ JS が正当なコンテンツだからで(列幅自動調整など、開発者が
 * 生成時に埋め込み以後変えない = `security/templateScripts.ts` が不変性を強制する)、
 * 「実行面だから落とす」という判断はここでは採らない。代わりに実行の隔離
 * (egress 遮断・作業ディレクトリの封じ込め)で受ける。
 *
 * ⚠ **`js/…` を `<script src>` で参照しても、素のままでは PDF 組版で実行されない**(実測)。
 * ビューアが script 要素を自分の window へ作り直すとき `src` の解決基準がビューアアプリの
 * URL になり、`/__vivliostyle-viewer/js/…` を取りに行って 404 になる(しかもビルドは成功
 * するので「JS が効かない PDF が黙って出る」)。この非対称は
 * `inlineDocScripts.ts` が**組版の直前に配信ルートの実体をインライン展開する**ことで塞ぐ
 * — つまり本ファイルが `.js` を配ることと、その展開はやはり対になっている。
 *
 * `.map`(sourcemap)は入れない。組版に不要で、開発者の作業ツリーの構造を配信ルートへ
 * 持ち出すだけになる。
 */
const ASSET_GROUPS: readonly AssetGroup[] = [
  {
    mount: 'css',
    sourceDir: () => config.cssDir,
    extensions: new Set(['.css']),
  },
  {
    mount: 'fonts',
    sourceDir: () => path.join(config.assetsDir, 'fonts'),
    extensions: new Set(['.ttf', '.otf', '.woff', '.woff2']),
  },
  {
    mount: 'js',
    sourceDir: () => path.join(config.assetsDir, 'js'),
    extensions: new Set(['.js', '.mjs']),
  },
];

/**
 * 資産ツリーを降りる深さの上限。`fonts/noto/JP/x.woff2` 程度を想定した値で、
 * シンボリックリンクの輪や異常に深いツリーで走査が止まらなくなるのを防ぐ。
 */
const MAX_ASSET_DEPTH = 4;

/** 配置する資産の総ファイル数の上限(超えたら以降を無視する)。 */
const MAX_ASSET_FILES = envPositiveNumber(
  'VIVLIO_MAX_ASSET_FILES',
  process.env.VIVLIO_MAX_ASSET_FILES,
  2000,
  { integer: true },
);

/** 配置する資産の合計バイト数の上限(temp ディスクの枯渇を防ぐ)。 */
const MAX_ASSET_BYTES = envPositiveNumber(
  'VIVLIO_MAX_ASSET_BYTES',
  process.env.VIVLIO_MAX_ASSET_BYTES,
  128 * 1024 * 1024,
  { integer: true },
);

/** 走査で拾った 1 ファイル。`rel` は mount を含む配信ルート相対パス(`css/510037.css`)。 */
interface AssetFile {
  rel: string;
  source: string;
  bytes: number;
}

/**
 * 1 グループ配下の資産を列挙する。ディレクトリが無ければ空(既存環境に `assets/` が
 * 無くても壊れないこと、が要件)。
 *
 * `withFileTypes` の `isFile()` / `isDirectory()` は **lstat 相当**でシンボリックリンクを
 * 展開しない。よってリンクは `isFile()` にも `isDirectory()` にも当たらず、自動的に
 * 対象外になる — 資産ディレクトリに置いたリンクで `dataRoot` の外を配信ルートへ
 * 引き込めないようにするための性質なので、`stat` へ変えないこと。
 */
async function collectGroup(group: AssetGroup): Promise<AssetFile[]> {
  const root = group.sourceDir();
  const out: AssetFile[] = [];
  const walk = async (dir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > MAX_ASSET_DEPTH) return;
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // 置き場が無い / 読めないのは正常系(まだ資産を置いていない環境)。
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!group.extensions.has(ext)) continue;
      let bytes = 0;
      try {
        bytes = (await fs.stat(full)).size;
      } catch {
        continue;
      }
      out.push({ rel, source: full, bytes });
    }
  };
  await walk(root, group.mount, 0);
  return out;
}

/**
 * 配信ルート相対パス(`js/x.js`)から**実体の絶対パス**を引く。見つからない / 許可リストに
 * 載らない / 途中にシンボリックリンクがある場合は `undefined`。
 *
 * 用途は「配信ルートへ写す」のではなく「その場で 1 本配る」経路(画面内プレビューの
 * ビューアホストページ = `previewHost.ts`)。**許可リスト(`ASSET_GROUPS`)と深さ上限を
 * `stageDocAssets` と共有する**のが要点で、別実装の解決器を置くと片方だけが緩む。
 *
 * リンクの扱いも `collectGroup` と揃える: `lstat` を各セグメントに掛け、途中に 1 つでも
 * リンクがあれば拒む(`dataRoot` の外を配信面へ引き込ませない)。`stat` へ変えないこと。
 */
export async function resolveServedAssetSource(rel: string): Promise<string | undefined> {
  const segments = rel.split('/');
  if (segments.length < 2 || segments.length > MAX_ASSET_DEPTH + 2) return undefined;
  const group = ASSET_GROUPS.find((g) => g.mount === segments[0]);
  if (group === undefined) return undefined;
  const rest = segments.slice(1);
  if (rest.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  if (!group.extensions.has(path.extname(rest[rest.length - 1]).toLowerCase())) return undefined;
  let current = group.sourceDir();
  for (const [i, seg] of rest.entries()) {
    current = path.join(current, seg);
    try {
      const st = await fs.lstat(current);
      if (i === rest.length - 1 ? !st.isFile() : !st.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  return current;
}

/** `stageDocAssets` の任意設定。 */
export interface StageDocAssetsOptions {
  /**
   * 文書が実際に参照している配信ルート相対パス(`docRefs.collectDocumentAssetRefs` の戻り値)。
   *
   * 与えると**参照されたものだけ**を配置する(参照 CSS がさらに引くフォント等は
   * `expandReferenced` が段階的に足す)。省略すると許可リスト配下を全件配置する —
   * zip 展開物のように文書が事前に判らない配信ルート向けの逃げ道で、通常の経路
   * (inline / merge / preview-inline)では必ず渡すこと。
   */
  referenced?: ReadonlySet<string>;
}

/**
 * 参照集合を「参照された CSS が更に引く資産」まで広げる。
 *
 * `<link href="css/510037.css">` しか書いていない文書でも、その CSS が
 * `@font-face { src: url(../fonts/a.woff2) }` と書いていれば fonts も要る。1 段では
 * 足りない形(CSS が CSS を引く)もあるので `MAX_ASSET_REF_DEPTH` まで繰り返す。
 */
async function expandReferenced(
  catalog: ReadonlyMap<string, AssetFile>,
  referenced: ReadonlySet<string>,
): Promise<AssetFile[]> {
  const chosen = new Map<string, AssetFile>();
  let frontier = [...referenced];
  for (let depth = 0; depth < MAX_ASSET_REF_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of frontier) {
      const file = catalog.get(rel);
      if (file === undefined || chosen.has(rel)) continue;
      chosen.set(rel, file);
      if (path.extname(rel).toLowerCase() !== '.css') continue;
      let text = '';
      try {
        text = await fs.readFile(file.source, 'utf8');
      } catch {
        continue;
      }
      for (const candidate of collectCssUrlCandidates(text)) {
        const child = resolveRefFrom(rel, candidate);
        if (child !== undefined && !chosen.has(child)) next.push(child);
      }
    }
    frontier = next;
  }
  return [...chosen.values()];
}

/**
 * 同梱資産を配信ルート `destDir` へ配置し、**実際に置いた配信ルート相対パスの集合**を返す。
 *
 * 戻り値は `inlineCss` が `<link href>` / `<script src>` を残すかどうかの判断に使う。
 * 実体の無い参照を残すと `@vivliostyle/core` のフェッチャが 404 でページ分割を中断する
 * ため、「相対参照だから残す」ではなく「**配信ルートに実体があるから残す**」で判断する。
 *
 * 上書きはしない(`flags: COPYFILE_EXCL` 相当を `existsSync` ではなく copy の失敗で受ける
 * のではなく、事前に存在を確認する)。zip 展開物のように既に同名ファイルがある配信ルートへ
 * 呼ばれても、アップロードされた実体を我々の資産で置き換えないためである。
 */
export async function stageDocAssets(
  destDir: string,
  opts: StageDocAssetsOptions = {},
): Promise<Set<string>> {
  const catalog = new Map<string, AssetFile>();
  for (const group of ASSET_GROUPS) {
    for (const file of await collectGroup(group)) catalog.set(file.rel, file);
  }
  const wanted =
    opts.referenced === undefined
      ? [...catalog.values()]
      : await expandReferenced(catalog, opts.referenced);

  const served = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const file of wanted) {
    if (files >= MAX_ASSET_FILES || bytes + file.bytes > MAX_ASSET_BYTES) return served;
    const dest = path.join(destDir, ...file.rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      // `COPYFILE_EXCL` = 既存があれば失敗。配信ルートに先着の実体があればそちらを残す
      // (zip 展開物のように既に同名がある配信ルートを我々の資産で上書きしない)。
      await fs.copyFile(file.source, dest, fs.constants.COPYFILE_EXCL);
    } catch {
      // 失敗の原因が「先着があった」なのか「読めなかった」なのかを、例外の種類ではなく
      // **配信ルートの実体**で判定する。集合に載せてよいのは実体が在るときだけ —
      // 無いのに載せると `<link>`/`<script>` を残して 404 を作り、
      // `@vivliostyle/core` のページ分割が中断する。
      const exists = await fs
        .stat(dest)
        .then((s) => s.isFile())
        .catch(() => false);
      if (!exists) continue;
    }
    served.add(file.rel);
    files += 1;
    bytes += file.bytes;
  }
  return served;
}
