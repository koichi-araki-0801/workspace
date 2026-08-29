// =============================================================================
// runtime/seaRuntime.ts — SEA(単一 exe)実行時のアセット参照とモジュール解決封鎖
// -----------------------------------------------------------------------------
// 配布物は **exe 1 個**で、実行されるコードとデータ(subset-font の JS 閉包 / harfbuzz
// wasm / 埋込フォント woff2)はすべて Authenticode 署名の内側にある。exe の隣や上位
// ディレクトリの `node_modules` を実行時に解決すると、書き込み可能な場所(既定 ACL の
// `C:\` は Authenticated Users が AppendData を持つ)へ置かれた偽モジュールが署名の
// 外から読み込まれ、別ユーザーが起動した exe の中で攻撃者のコードが走る。ゆえに SEA では
//   1. builtin 以外のモジュール解決をすべて拒否する(`installSeaGuards`)
//   2. 外部ファイル参照は SEA アセットの **固定キー許可リスト**経由のみにする
// の 2 段で閉じる。1 は多層防御で、主防御は「解決が必要なコードが 1 行も無い」こと。
//
// 判定はすべて**集合メンバシップと文字列の完全一致**で書く。`startsWith` / `includes` /
// 拡張子判定のような述語へ緩めると、`basename` 経由の間接指定や末尾空白で許可リストが
// 素通しになる(`test/sea_runtime.test.ts` が迂回入力で固定している)。
//
// 呼び出し側: `cli.ts`(`installSeaGuards`)/ `svg_export/font.ts`(`readSeaAsset`)/
// `runtime/subsetFontFs.ts`(sentinel 経由の wasm 読み出し)/ `input/db.ts`(`isSea`)。
// アセットキーの一覧は `scripts/build-exe.mjs` の sea-config `assets` と一致させること
// (ビルド側のアサートが不一致を検出する)。
// =============================================================================

import Module from 'node:module';

// ── 1. 許可リスト(固定) ────────────────────────────────────────────────────

/** exe へ埋め込む SEA アセットのキー。`build-exe.mjs` の `assets` と 1:1 で対応する。 */
export const SEA_ASSET_KEYS: ReadonlySet<string> = new Set([
  'BIZUDPGothic-Regular.woff2',
  'BIZUDPGothic-Bold.woff2',
  'hb-subset.wasm',
  'OFL-BIZUDPGothic.txt',
]);

/**
 * SEA で `require.resolve` に通す唯一の specifier。`subset-font/index.js` が
 * `require.resolve('harfbuzzjs/hb-subset.wasm')` の 1 箇所だけで外部を参照するため、
 * ここを完全一致で受けれる限り実行時のファイル解決は要らない。
 */
export const HB_WASM_SPECIFIER = 'harfbuzzjs/hb-subset.wasm';

/** harfbuzz wasm の SEA アセットキー(`SEA_ASSET_KEYS` の 1 要素)。 */
export const HB_WASM_ASSET_KEY = 'hb-subset.wasm';

/**
 * `require.resolve(HB_WASM_SPECIFIER)` が返す擬似パス。NUL を含むためファイルパスとして
 * 成立せず、実ファイルと衝突しない(= sentinel を実パスと誤認して読む経路が作れない)。
 * `runtime/subsetFontFs.ts` の `readFile` がこの値だけを SEA アセットへ振り替える。
 */
export const HB_WASM_SENTINEL = '\0pie-chart:hb-subset.wasm';

// ── 2. SEA 判定とアセット読み出し ──────────────────────────────────────────

interface SeaApi {
  isSea?: () => boolean;
  getAsset?: (key: string) => ArrayBuffer;
}

/**
 * `node:sea` を取得する。SEA(esbuild の cjs バンドル)でのみ ambient `require` が在り、
 * dev(tsx/ESM)では `require` が未定義なので null を返す。`process.execPath` は見ない
 * (exe ディレクトリを基点にした解決を一切残さないため)。
 */
function seaApi(): SeaApi | null {
  const req = typeof require === 'function' ? require : null;
  if (!req) return null;
  try {
    return req('node:sea') as SeaApi;
  } catch {
    return null; // node:sea 不在 = 非 SEA。
  }
}

/** SEA(単一 exe)として実行中かどうか。dev(Node/tsx)では常に false。 */
export function isSea(): boolean {
  const sea = seaApi();
  return sea !== null && typeof sea.isSea === 'function' && sea.isSea() === true;
}

/**
 * アセットキーが許可リストに載っていることを検査する。`cfg.embedFontPath` の basename の
 * ような**外部由来の値**がそのままキーになりうるので、ここが唯一の防壁になる。
 */
export function assertSeaAssetKey(key: unknown): void {
  if (typeof key !== 'string' || !SEA_ASSET_KEYS.has(key)) {
    throw new Error(
      `SEA asset "${String(key)}" is not in the allowlist ` +
        `(allowed: ${[...SEA_ASSET_KEYS].join(', ')}).`,
    );
  }
}

/**
 * exe へ埋め込んだアセットのバイト列を返す。`sea.getRawAsset` ではなく `getAsset`
 * (コピーを返す)を使う: raw は exe イメージの読み取り専用メモリを直接指すため、下流
 * (`fontverter.convert` 等)が in-place で書くとクラッシュする。
 */
export function readSeaAsset(key: string): Buffer {
  // 許可リストの検査を SEA 判定より **前**に置く。後ろに置くと、exe の中では任意キーの
  // 読み出しが試みられる形になり、防壁が exe 内で効かなくなる。
  assertSeaAssetKey(key);
  const sea = seaApi();
  // `node:sea` は dev(Node/tsx)でも解決できてしまい、`getAsset` は SEA 外で呼ぶと Node 側の
  // 一般的なメッセージで投げる。呼び出し側が経路を判別できるよう、ここで明示的に落とす。
  if (!sea || typeof sea.getAsset !== 'function' || !isSea()) {
    throw new Error(`SEA asset "${key}" is only available inside the packaged executable.`);
  }
  return Buffer.from(sea.getAsset(key));
}

// ── 3. 解決の封鎖 ──────────────────────────────────────────────────────────

/**
 * SEA での `require.resolve` 実装。許可 specifier は `HB_WASM_SPECIFIER` **1 件のみ**で、
 * 完全一致でなければ投げる。「`.wasm` で終わるなら通す」のような述語へ緩めてはならない
 * (許可リストが実質無効化される)。
 */
export function resolveSeaRequest(request: unknown): string {
  if (request === HB_WASM_SPECIFIER) return HB_WASM_SENTINEL;
  throw new Error(
    `require.resolve is disabled in the packaged executable (requested "${String(request)}"); ` +
      `only "${HB_WASM_SPECIFIER}" is resolvable.`,
  );
}

type ResolveFilename = (this: unknown, request: string, ...rest: unknown[]) => string;

/**
 * `Module._resolveFilename` を builtin 専用へ差し替え、復元関数を返す。`createRequire` は
 * この関数を通るため、exe 隣・上位ディレクトリの `node_modules` への遡りがここで死ぬ。
 * 復元関数はテスト専用(本番は差し替えたまま)。
 */
export function installModuleResolutionBlock(): () => void {
  const internals = Module as unknown as { _resolveFilename?: ResolveFilename };
  const original = internals._resolveFilename;
  if (typeof original !== 'function') {
    throw new Error('Module._resolveFilename is missing; cannot block external module resolution.');
  }
  const blocked: ResolveFilename = function (this: unknown, request, ...rest) {
    if (typeof request === 'string' && Module.isBuiltin(request)) {
      return original.call(this, request, ...rest);
    }
    throw new Error(
      'external module resolution is disabled in the packaged executable ' +
        `(requested "${String(request)}").`,
    );
  };
  internals._resolveFilename = blocked;
  return () => {
    internals._resolveFilename = original;
  };
}

let guardsInstalled = false;

/**
 * SEA 実行時のガードを張る。dev(非 SEA)では**何もしない**。`cli.ts` の `main()` 冒頭
 * (引数パースより前)で 1 回だけ呼ぶ。失敗は握りつぶさず投げる: ガード無しで動くと
 * sidecar 読み込みの経路が開いたまま「動いているように見える」状態になるため。
 */
export function installSeaGuards(): void {
  if (guardsInstalled || !isSea()) return;
  const req = typeof require === 'function' ? require : null;
  if (!req) {
    throw new Error('SEA runtime without an ambient require; cannot install resolution guards.');
  }
  // ambient require は builtin 専用で `resolve` を持たない。許可リスト 1 件の実装を注入する。
  (req as unknown as Record<string, unknown>).resolve = resolveSeaRequest;
  if ((req as unknown as Record<string, unknown>).resolve !== resolveSeaRequest) {
    throw new Error('failed to install the require.resolve allowlist shim.');
  }
  installModuleResolutionBlock();
  guardsInstalled = true;
}
