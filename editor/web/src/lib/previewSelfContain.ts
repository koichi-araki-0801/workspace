// =============================================================================
// previewSelfContain.ts — プレビュー文書を「子が何も取りに行かない」形へ閉じる
// =============================================================================
// プレビューの組版は opaque オリジンの隔離 iframe(`PreviewPanel.vue`)の中で走る。
// opaque オリジンの子が発するサブリソース要求は site-for-cookies が空 = cross-site 扱いに
// なり、SameSite=Lax のセッション cookie が**付かない**。同梱資産の配信ルート
// (`/api/preview-host/js/…` 等)は認証必須なので、認証オン配備(rest / lan)では子からの
// 取得だけが 401 になり「テンプレ JS が効かないプレビュー」へ黙って劣化する。
//
// 解決は認証や cookie 属性を緩めることではなく、**子のネットワーク要求そのものを無くす**:
// 文書を postMessage で渡す直前に、親(= 認証済み・同一オリジン)が資産を取得して文書へ
// 埋め込む。`SameSite=None` は Secure 必須で平文 LAN 運用と衝突し、資産経路の認証撤廃は
// per-fund CSS・テンプレ JS の未認証露出になるため、どちらも採らない(設計正典)。
//
// ファンド別画像(`<img src="../images/…">` と `<style>` 内の `url(../images/…)`)も同じ理由で埋める。
// 取得先は単体配信ルート `/api/fund-assets/images/:file` と `…/:dir/:file`(SVG 検査と認証を通る
// 経路)で、プレビューホストは `images/` を配らない。会社フォルダの画像は会社コードと照合し、
// 合わないものは埋めない(`lib/fundImages.ts` の `companyFolderMatches`)。`data:image/svg+xml` は
// **ここが作るときだけ**使い、共有の data: 許可リストには足さない(テンプレの著者が未検査の SVG を
// 直接書ける経路を開かない)。
//
// 参照はすべて文書位置基準で解く(文書は論理ルートの `doc/` にあるものとして `resolveDocAssetPath`
// に `'doc'` を渡す)。`<style data-preview-css>` の本文 CSS は組み立て時に `rebaseCssForDoc` で
// 文書基準へ付け替え済みなので、HTML の `<style>` と同じ物差しで解ける。
//
// ── 加工の作法 ──
// 「探す・切る」は必ず **DOM の上**で行う(`sanitizeHtml.ts` 冒頭の不変則)。入力は
// `assemblePreviewDocument` が組んだサニタイズ済み文書だが、ここで再度
// `sanitizePreviewRoot` → DOM 加工 → `serializePreviewRoot` の 1 往復に載せることで
// 「サニタイズが最後に喋る」を保つ。展開できない参照は**原文のまま残す**(fail closed —
// 従来どおり子側で 404/401 になるだけで、文書は壊れない)。判断基準はサーバの
// `vivliostyle/inlineDocScripts.ts` と同一(`resolveDocAssetPath` 1 本 + `<!--` 拒否 +
// サイズ上限 + 属性許可リスト)。片方だけ直すと PDF とプレビューで挙動が割れる。
import {
  collectCssUrlSpans,
  DOC_DIR,
  PREVIEW_HOST_BASE,
  resolveDocAssetPath,
} from '@editor/shared';
import {
  companyFolderMatches,
  type FundImageRef,
  fundImageMime,
  fundImageRefOf,
  fundImageUrl,
  servedFundImageOf,
} from './fundImages';
import { sanitizeStyleContent } from './sanitizeCss';
import { sanitizePreviewRoot, serializePreviewRoot } from './sanitizeHtml';

/** 資産取得の口。テストで差し替えられるよう関数型で受ける(既定は同一オリジン fetch)。 */
type AssetFetcher = (url: string) => Promise<Response>;

/** 自己完結化の文脈。 */
interface SelfContainOptions {
  /** テンプレ ID の会社コード。会社フォルダの画像の照合に使う(不明なら会社フォルダは埋めない)。 */
  companyCode?: string | null;
}

/** 親が取りに行く配信 URL の接頭辞。 */
const ASSET_URL_PREFIX = `/api${PREVIEW_HOST_BASE}/`;

/**
 * 論理ルート相対パス → 親が取りに行く URL(プレビューホストは論理ルートの `css/` `js/` を配る)。
 * `rel` は 1 回復号済みなので、部分ごとに符号化し直す。そのまま繋ぐと `#` `?` で URL が切れ、
 * `%2e%2e` はブラウザの URL 解析で `..` と扱われて、cookie 付きの親が別の API を取りに行く。
 * 符号化後もブラウザが解いたパスが接頭辞の下に収まらなければ取りに行かない(undefined)。
 * 対の無いサロゲートは `encodeURIComponent` が投げるので、その参照だけ諦めて undefined にする
 * (文書全体の自己完結化を止めない)。export はテスト用。
 */
export function assetUrl(rel: string): string | undefined {
  let url: string;
  try {
    url = `${ASSET_URL_PREFIX}${rel.split('/').map(encodeURIComponent).join('/')}`;
  } catch {
    return undefined;
  }
  const resolved = new URL(url, 'http://preview.invalid').pathname;
  return resolved === url ? url : undefined;
}

/**
 * インライン化する 1 スクリプトのサイズ上限。サーバの `inlineDocScripts.ts`
 * (`MAX_INLINE_SCRIPT_BYTES`)と同値に保つ — 超えたものはサーバ経路でも展開されないので、
 * プレビューだけ展開すると PDF と挙動が割れる。
 */
const MAX_INLINE_SCRIPT_BYTES = 2 * 1024 * 1024;

/** data: URI 化する 1 フォントのサイズ上限(base64 で +33% 膨れるぶんを含めた安全域)。 */
const MAX_INLINE_FONT_BYTES = 8 * 1024 * 1024;

/** data: URI 化する 1 画像のサイズ上限(フォントと同じ考え方。超えたものは埋めない)。 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** `</script` の無害化(サーバ `inlineDocScripts.ts` の `SCRIPT_CLOSE_RE` と同一)。 */
const SCRIPT_CLOSE_RE = /<\/(?=script)/gi;

/** インライン化後も意味を保てる `type` 値(サーバ `INLINEABLE_TYPES` と同一)。 */
const INLINEABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

/** フォント拡張子 → data: URI の MIME(`cssExternalRefs.ALLOWED_DATA_PREFIXES` に収まる形)。 */
const FONT_MIME: Readonly<Record<string, string>> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

// 取得結果のキャッシュ(undefined = 取得失敗も含めて記憶し、再描画のたびに叩き直さない)。
// key は論理ルート相対パス。資産は「生成時に確定し以後不変」のテンプレ資産なので、
// セッション中の失効を考えなくてよい。
const scriptCache = new Map<string, Promise<string | undefined>>();
const fontCache = new Map<string, Promise<string | undefined>>();
const imageCache = new Map<string, Promise<string | undefined>>();

/** テスト用: キャッシュを空にする(実運用コードから呼ばない)。 */
export function resetSelfContainCache(): void {
  scriptCache.clear();
  fontCache.clear();
  imageCache.clear();
}

async function fetchScriptBody(rel: string, fetcher: AssetFetcher): Promise<string | undefined> {
  const cached = scriptCache.get(rel);
  if (cached !== undefined) return cached;
  const p = (async () => {
    const url = assetUrl(rel);
    if (url === undefined) return undefined;
    try {
      const res = await fetcher(url);
      if (!res.ok) return undefined;
      const body = await res.text();
      if (body.length > MAX_INLINE_SCRIPT_BYTES) return undefined;
      // script data のエスケープ状態(`<!--`)は `</script>` 終端を無効化しうるので展開しない
      // (サーバ `isUnsafeToInline` と同じ fail closed)。
      if (body.includes('<!--')) return undefined;
      return body;
    } catch {
      return undefined;
    }
  })();
  scriptCache.set(rel, p);
  return p;
}

/** ArrayBuffer → base64。スプレッドは巨大配列でスタックを溢れさせるためチャンクで畳む。 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunks: string[] = [];
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + STEP)));
  }
  return btoa(chunks.join(''));
}

async function fetchFontDataUri(rel: string, fetcher: AssetFetcher): Promise<string | undefined> {
  const cached = fontCache.get(rel);
  if (cached !== undefined) return cached;
  const p = (async () => {
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    const mime = FONT_MIME[ext];
    if (mime === undefined) return undefined;
    const url = assetUrl(rel);
    if (url === undefined) return undefined;
    try {
      const res = await fetcher(url);
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_INLINE_FONT_BYTES) return undefined;
      return `data:${mime};base64,${toBase64(buf)}`;
    } catch {
      return undefined;
    }
  })();
  fontCache.set(rel, p);
  return p;
}

/**
 * 1 画像を data: URI にする。key は `<会社フォルダ>/<名前>`(直下は `/<名前>`)。キャッシュは
 * ページの寿命で、外部ツールが画像を差し替えたときの反映はブラウザの再読み込みに任せる(運用手順書)。
 */
async function fetchImageDataUri(
  ref: FundImageRef,
  fetcher: AssetFetcher,
): Promise<string | undefined> {
  const key = `${ref.dir ?? ''}/${ref.file}`;
  const cached = imageCache.get(key);
  if (cached !== undefined) return cached;
  const p = (async () => {
    const mime = fundImageMime(ref.file);
    if (mime === undefined) return undefined;
    try {
      const res = await fetcher(fundImageUrl(ref));
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) return undefined;
      return `data:${mime};base64,${toBase64(buf)}`;
    } catch {
      return undefined;
    }
  })();
  imageCache.set(key, p);
  return p;
}

/** `<img src="../images/…">` を data: URI へ置き換える。埋められないものは原文のまま残す。 */
async function inlineImages(
  root: Element,
  fetcher: AssetFetcher,
  companyCode: string | null,
): Promise<void> {
  for (const img of Array.from(root.querySelectorAll('img[src]'))) {
    const ref = servedFundImageOf(img.getAttribute('src') ?? '', DOC_DIR, companyCode);
    if (ref === undefined) continue;
    const dataUri = await fetchImageDataUri(ref, fetcher);
    if (dataUri !== undefined) img.setAttribute('src', dataUri);
  }
}

/**
 * `<script src>` をインライン `<script>` へ展開する。対象はサーバ `rebuildOpenTag` と同じ
 * 「`src` と許可された `type` だけを持つ script」のみで、それ以外(未知属性・データブロック
 * `type`)は原文のまま残す。`src` 付き script の中身は HTML 仕様上実行されないので捨ててよい。
 */
async function inlineScripts(root: Element, fetcher: AssetFetcher): Promise<void> {
  for (const script of Array.from(root.querySelectorAll('script[src]'))) {
    let eligible = true;
    let typeValue = '';
    for (const attr of Array.from(script.attributes)) {
      if (attr.name === 'src') continue;
      if (attr.name === 'type') {
        typeValue = attr.value.trim().toLowerCase();
        if (!INLINEABLE_TYPES.has(typeValue)) eligible = false;
        continue;
      }
      eligible = false;
    }
    if (!eligible) continue;
    const rel = resolveDocAssetPath(script.getAttribute('src') ?? '', DOC_DIR);
    if (rel === undefined) continue;
    const body = await fetchScriptBody(rel, fetcher);
    if (body === undefined) continue;
    script.textContent = body.replace(SCRIPT_CLOSE_RE, '<\\/');
    script.removeAttribute('src');
  }
}

/**
 * `<style>` 内の `url(../css/fonts/…)` と `url(../images/…)` を data: URI へ置き換える。
 *
 * 相対 URL の置換は認証対策であると同時に忠実度の問題でもある: 子の文書は blob URL
 * (非階層)で、inline CSS の相対参照はそもそも解決できない。置換範囲は shared の
 * `collectCssUrlSpans`(検査・staging と同一トークナイザ)が返す `url(…)` 式全体で、
 * 正規表現での再探索はしない。
 */
async function inlineStyleAssets(
  root: Element,
  fetcher: AssetFetcher,
  companyCode: string | null,
): Promise<void> {
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const css = style.textContent ?? '';
    if (css === '') continue;
    const spans = collectCssUrlSpans(css);
    let out = css;
    let changed = false;
    // 後ろから置換して先行 span のオフセットを保つ。
    for (const span of [...spans].reverse()) {
      const rel = resolveDocAssetPath(span.value, DOC_DIR);
      if (rel === undefined) continue;
      let dataUri: string | undefined;
      if (rel.startsWith('css/fonts/')) {
        dataUri = await fetchFontDataUri(rel, fetcher);
      } else {
        const ref = fundImageRefOf(rel);
        if (ref !== undefined && companyFolderMatches(ref, companyCode)) {
          dataUri = await fetchImageDataUri(ref, fetcher);
        }
      }
      if (dataUri === undefined) continue;
      out = `${out.slice(0, span.start)}url(${dataUri})${out.slice(span.end)}`;
      changed = true;
    }
    // 直列化器は raw text をエスケープしないため、書き戻し時の `</style>` 潰しは必須
    // (`appendPreviewStyle` と同じ理由)。
    if (changed) style.textContent = sanitizeStyleContent(out);
  }
}

/**
 * プレビュー文書を自己完結化して返す。失敗はどの段でも**その参照だけ原文のまま**になり、
 * 文書全体が壊れる形には倒れない。呼び出し側(`PreviewPanel.sendDoc`)は例外時に
 * 入力をそのまま使ってよい(= 従来挙動)。
 */
export async function selfContainPreviewDoc(
  doc: string,
  fetcher: AssetFetcher = (url) => fetch(url),
  opts: SelfContainOptions = {},
): Promise<string> {
  if (doc === '') return doc;
  const companyCode = opts.companyCode ?? null;
  const root = sanitizePreviewRoot(doc);
  await inlineScripts(root, fetcher);
  await inlineImages(root, fetcher, companyCode);
  await inlineStyleAssets(root, fetcher, companyCode);
  return serializePreviewRoot(root);
}
