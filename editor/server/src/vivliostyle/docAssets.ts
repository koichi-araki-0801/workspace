// =============================================================================
// docAssets.ts — 同梱資産(css / fonts / js / images)を PDF・プレビューの配信ルートへ配置する
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
// よって写すのは「決められた 4 つの置き場」×「決められた拡張子」だけとする。
//
// ── 置き場(利用者決定・変更しないこと) ──
//   css       = `config.cssDir`        (per-fund。`<fund>.css`。直下の `fonts/` は下の別グループ)
//   css/fonts = `config.cssDir/fonts`  (全ファンド共通のフォント。CSS から `url(fonts/…)`)
//   js        = `config.jsDir`         (全ファンド共通のテンプレ JS)
//   images    = `config.imagesDir`     (ファンド別画像。直下だけ。SVG は置く前に `inspectSvg`)
// 配信ルートでの名前は `css/` `css/fonts/` `js/` `images/` に固定する(テンプレ側の相対参照と対)。

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCssUrlCandidates, inspectSvg } from '@editor/shared';
import { config, envPositiveNumber } from '../config.js';
import { logger } from '../logger.js';
import { MAX_ASSET_REF_DEPTH, resolveRefFrom } from './docRefs.js';

/** 配信ルートに作るサブディレクトリと、その中身として許す拡張子(小文字・末尾一致)。 */
interface AssetGroup {
  /** 配信ルート側のディレクトリ(= テンプレの相対参照の先頭。`css/fonts` のように複数段もある)。 */
  readonly mount: string;
  /** 実体の置き場を返す(`config` を毎回読むのはテストで差し替えられるようにするため)。 */
  readonly sourceDir: () => string;
  readonly extensions: ReadonlySet<string>;
  /**
   * 置き場の直下で降りないディレクトリ名(小文字で比較)。css の置き場の `fonts/` は
   * 別グループ(`css/fonts`)の持ち物で、css グループが降りると `css/fonts/x.css` を
   * 片方の判定だけが配る食い違いが生まれる。
   */
  readonly skipTopDirs?: ReadonlySet<string>;
  /**
   * 置き場から降りる深さの上限(0 = 直下のファイルだけ)。走査(`collectGroup`)と 1 本配る解決
   * (`resolveServedAssetSource`)が同じ値を見る — 片方だけ深く見ると、配置されないのに単体配信
   * される形の食い違いが生まれる。
   */
  readonly maxDepth: number;
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
/**
 * 資産ツリーを降りる深さの上限。`css/fonts/noto/JP/x.woff2` 程度を想定した値で、
 * シンボリックリンクの輪や異常に深いツリーで走査が止まらなくなるのを防ぐ。
 */
const MAX_ASSET_DEPTH = 4;

const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.ttf', '.otf', '.woff', '.woff2']);

/** ファンド別画像として配る拡張子。web の `lib/fundImages.ts` の MIME 表と揃える。 */
const FUND_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.svg', '.png', '.jpg', '.jpeg']);

/** 配信ルートでのファンド別画像の置き場(テンプレの相対参照 `images/…` の先頭)。 */
export const FUND_IMAGES_MOUNT = 'images';

const ASSET_GROUPS: readonly AssetGroup[] = [
  {
    mount: 'css/fonts',
    sourceDir: () => path.join(config.cssDir, 'fonts'),
    extensions: FONT_EXTENSIONS,
    maxDepth: MAX_ASSET_DEPTH,
  },
  {
    mount: 'css',
    sourceDir: () => config.cssDir,
    extensions: new Set(['.css']),
    skipTopDirs: new Set(['fonts']),
    maxDepth: MAX_ASSET_DEPTH,
  },
  {
    mount: 'js',
    sourceDir: () => config.jsDir,
    extensions: new Set(['.js', '.mjs']),
    maxDepth: MAX_ASSET_DEPTH,
  },
  {
    mount: FUND_IMAGES_MOUNT,
    sourceDir: () => config.imagesDir,
    extensions: FUND_IMAGE_EXTENSIONS,
    // 直下だけ。ファンドの区別は命名の約束(`<fund>_<名前>`)で持ち、サブフォルダは作らない契約。
    maxDepth: 0,
  },
];

/**
 * 配信ルート相対パスがファンド別画像の置き場を指すか。大小文字を問わないのは、Windows の
 * 置き場では `Images/x.svg` も同じ実体に届くため(配信面を絞る側の判定は広く取る)。
 */
export function isFundImagePath(rel: string): boolean {
  return rel.split('/')[0].toLowerCase() === FUND_IMAGES_MOUNT;
}

/**
 * 配信ルート相対パスを持つグループを引く。`css/fonts/x` が `css` に当たらないよう、
 * mount の段数が多い方を先に照合する(最長一致)。
 */
function groupFor(rel: string): { group: AssetGroup; rest: string[] } | undefined {
  const segments = rel.split('/');
  const byDepth = [...ASSET_GROUPS].sort(
    (a, b) => b.mount.split('/').length - a.mount.split('/').length,
  );
  for (const group of byDepth) {
    const mountSegs = group.mount.split('/');
    if (segments.length <= mountSegs.length) continue;
    if (!mountSegs.every((s, i) => segments[i] === s)) continue;
    const rest = segments.slice(mountSegs.length);
    if (group.skipTopDirs?.has(rest[0].toLowerCase()) && rest.length > 1) return undefined;
    return { group, rest };
  }
  return undefined;
}

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
 * 1 グループ配下の資産を列挙する。ディレクトリが無ければ空(`css/fonts` や `js` の
 * 置き場がまだ無い環境でも壊れないこと、が要件)。
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
    if (depth > group.maxDepth) return;
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
        if (depth === 0 && group.skipTopDirs?.has(entry.name.toLowerCase())) continue;
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
  const hit = groupFor(rel);
  if (hit === undefined) return undefined;
  const { group, rest } = hit;
  if (rest.length > group.maxDepth + 1) return undefined;
  // `\` と NUL は Windows で 1 セグメントのまま下の階層へ降りる / 名前を切るので、先に落とす。
  if (rest.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')))
    return undefined;
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
 * `@font-face { src: url(fonts/a.woff2) }` と書いていれば fonts も要る。1 段では
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
 * SVG を読んで検査し、合格ならそのバイト列を返す。違反・読めないときは `undefined`。
 * 呼び出し側は**このバイト列を書く**(検査後に読み直すと、その間の差し替えを検査せずに通す)。
 */
async function readInspectedSvg(file: AssetFile): Promise<Buffer | undefined> {
  let body: Buffer;
  try {
    body = await fs.readFile(file.source);
  } catch {
    return undefined;
  }
  const violations = inspectSvg(body.toString('utf8'));
  if (violations.length === 0) return body;
  logger.warn(
    { type: 'asset.svg_rejected', file: file.rel, violations },
    'SVG の検査に違反したため配信ルートへ置きません(この画像は表示されません)',
  );
  return undefined;
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
    // SVG は参照されたものだけをここで検査する(目録づくりの段では読まない = 全画像を毎回
    // 読まない)。違反は置かず、参照は `inlineCss` の判断で落ちる。
    let body: Buffer | undefined;
    if (path.extname(file.rel).toLowerCase() === '.svg') {
      body = await readInspectedSvg(file);
      if (body === undefined) continue;
    }
    const dest = path.join(destDir, ...file.rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      // `COPYFILE_EXCL` / `wx` = 既存があれば失敗。配信ルートに先着の実体があればそちらを残す
      // (zip 展開物のように既に同名がある配信ルートを我々の資産で上書きしない)。
      if (body === undefined) await fs.copyFile(file.source, dest, fs.constants.COPYFILE_EXCL);
      else await fs.writeFile(dest, body, { flag: 'wx' });
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
