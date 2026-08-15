// =============================================================================
// projectConfig.ts — アップロード config を「CLI へ渡してよいオブジェクト」へ作り直す
// =============================================================================
// **CLI へ config ファイルのパスを渡さない。** 渡すのはここで許可リストにより組み直した
// プレーンオブジェクト(`configData`)だけである。これが本設計の中心で、効く理由は 4 つ:
//
//   1. CLI 側でファイル探索が起きない。`vivliostyle.config.JS` のような大小文字違いを
//      `locateVivliostyleConfig` が拾って `import()` する経路が、探さないので消える。
//   2. **同じバイト列を 2 つのパーサが読む**構造が消える。パスを渡すと我々が `JSON.parse` し
//      CLI が JSONC で読み直す形になり、検査側だけが脱落する形(コメント入り config で
//      検査を silently skip)が成立する。乖離しうる第 2 のパーサを消すのが正しい直し方で、
//      「CLI と同じ JSONC で読む」は採らない — パーサが 2 つある限り版差でまた割れる。
//   3. 未知フィールドが CLI へ届かない。`server.proxy`(上流 Vite を踏み台にした SSRF)・
//      `pdfPostprocess`(docker / press-ready 起動)・`static`(任意ディレクトリ配信)は
//      「パス系フィールドを検査する」対策では塞げず、受け取るキーを数える方式でしか閉じない。
//   4. `base` を我々が固定できる。文書の配信先が動かないので、プレビュー中継の許可リスト
//      (`previewProxy.allowForwardPath`)と config が対で壊れることが無くなる。
//
// 作り方は**片方向の移し替え**にする。入力オブジェクトを加工して返す方式にすると、消し忘れた
// 1 フィールドがそのまま穴になる。空のオブジェクトへ許可したキーだけを明示代入する。

import fsSync from 'node:fs';
import path from 'node:path';
import { validation } from '@editor/shared';
import { envPositiveNumber } from '../config.js';
import { DEFAULT_DOC_BASE } from './previewProxy.js';
import { safeEntryPath, URI_SCHEME_RE } from './projectInput.js';

/** config テキストの上限(展開後のファイルなので body 上限とは別に要る)。 */
const MAX_CONFIG_BYTES = envPositiveNumber(
  'VIVLIO_MAX_CONFIG_BYTES',
  process.env.VIVLIO_MAX_CONFIG_BYTES,
  256 * 1024,
  { integer: true },
);
/** `entry` / `copyAsset` の要素数上限。 */
const MAX_LIST_ITEMS = envPositiveNumber(
  'VIVLIO_MAX_CONFIG_LIST',
  process.env.VIVLIO_MAX_CONFIG_LIST,
  1000,
  {
    integer: true,
  },
);
/** 自由文字列フィールド(title / author 等)の長さ上限。 */
const MAX_TEXT_LENGTH = 1000;

/** CLI へ渡す entry 要素(オブジェクト形)。 */
interface SafeEntryObject {
  path: string;
  title?: string;
  theme?: string | string[];
  encodingFormat?: string;
  rel?: string | string[];
}

/** CLI の `configData` へ渡してよいと確認済みの config。 */
export interface SafeProjectConfig {
  entry: string | Array<string | SafeEntryObject>;
  entryContext?: string;
  theme?: string | string[];
  cover?: string | { src: string; name?: string; htmlPath?: string };
  toc?: boolean | string | { title?: string; htmlPath?: string; sectionDepth?: number };
  title?: string;
  author?: string;
  language?: string;
  readingProgression?: string;
  size?: string;
  copyAsset?: { includes?: string[]; excludes?: string[] };
  /** 我々が固定する。利用者指定は受け付けない(§`base` の扱い)。 */
  base: string;
}

/** トップレベルで受理するキー。ここに無いキーは**キー名を挙げて 400**。 */
const ACCEPTED_KEYS = new Set([
  'entry',
  'entryContext',
  'theme',
  'cover',
  'toc',
  'title',
  'author',
  'language',
  'readingProgression',
  'size',
  'copyAsset',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function assertText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw validation(`${label} の値が不正です`);
  }
  return value;
}

/**
 * config 内の相対パスを検証する。**返すのは原文**で、絶対化しない — 絶対化すると
 * `entryContext` との二重解決になり、我々の解釈と CLI の解釈が分岐する。
 * 検証は展開ルート基準で行う。`entryContext` が設定されていても CLI の解決先は
 * `root/<entryContext>/<value>` で、ルート基準より必ず深いので、この検査で漏れは出ない。
 */
function assertContainedPath(root: string, value: unknown, label: string): string {
  const text = assertText(value, label);
  if (URI_SCHEME_RE.test(text) || text.includes('\0')) {
    throw validation(`${label} に URI や制御文字は指定できません: ${text}`);
  }
  safeEntryPath(root, text);
  return text;
}

/**
 * `theme` の 1 要素を検証する。CLI の `parseTheme` が **file 分岐**を取ることが確定する形に
 * 揃えるのが目的で、これが「theme 指定子 → npm パッケージ → arborist の postinstall 実行」
 * の経路を閉じる唯一の実効的な防壁である。`NPM_CONFIG_IGNORE_SCRIPTS` は arborist を直接
 * `new` する経路には届かない no-op なので、対策として数えてはならない。
 *
 * `.css` 判定で**大小文字を畳まない**のが罠。CLI 側は `stylePath.endsWith(".css")` と
 * 大小文字を区別するので、`theme:"a.CSS"` を我々が「css だから OK」と通すと CLI は
 * file 分岐に入らず npa → arborist へ落ちる。**畳んでよいのは拒否を広げる方向だけ**で、
 * 受理を広げる方向では畳まない。
 */
function assertThemeValue(root: string, value: unknown, isFile: (p: string) => boolean): string {
  const text = assertContainedPath(root, value, 'theme');
  if (!text.endsWith('.css')) {
    throw validation(`theme は展開した .css ファイルのパスだけを指定できます: ${text}`);
  }
  if (!isFile(safeEntryPath(root, text))) {
    throw validation(`theme のファイルが zip に含まれていません: ${text}`);
  }
  return text;
}

function assertTheme(
  root: string,
  value: unknown,
  isFile: (p: string) => boolean,
): string | string[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) throw validation('theme の要素数が多すぎます');
    // 配列は**全要素**を検証する。1 つでも素通しすると arborist 経路が開く。
    return value.map((v) => assertThemeValue(root, v, isFile));
  }
  // `{specifier, import}` のオブジェクト形は拒否(npm 指定子を運ぶ形なので file 分岐にならない)。
  return assertThemeValue(root, value, isFile);
}

function assertEntry(
  root: string,
  value: unknown,
  isFile: (p: string) => boolean,
): SafeProjectConfig['entry'] {
  if (typeof value === 'string') return assertContainedPath(root, value, 'entry');
  if (!Array.isArray(value)) throw validation('entry は文字列または配列で指定してください');
  if (value.length === 0) throw validation('entry が空です');
  if (value.length > MAX_LIST_ITEMS) throw validation('entry の要素数が多すぎます');
  return value.map((item) => {
    if (typeof item === 'string') return assertContainedPath(root, item, 'entry');
    if (!isPlainObject(item)) throw validation('entry の要素が不正です');
    for (const key of Object.keys(item)) {
      if (!['path', 'title', 'theme', 'encodingFormat', 'rel'].includes(key)) {
        throw validation(`entry の要素に指定できないキーがあります: ${key}`);
      }
    }
    const out: SafeEntryObject = { path: assertContainedPath(root, item.path, 'entry.path') };
    if (item.title !== undefined) out.title = assertText(item.title, 'entry.title');
    // entry ごとの theme を忘れると、トップレベルだけ塞いでも arborist 経路が残る。
    if (item.theme !== undefined) out.theme = assertTheme(root, item.theme, isFile);
    if (item.encodingFormat !== undefined) {
      out.encodingFormat = assertText(item.encodingFormat, 'entry.encodingFormat');
    }
    if (item.rel !== undefined) {
      out.rel = Array.isArray(item.rel)
        ? item.rel.map((r) => assertText(r, 'entry.rel'))
        : assertText(item.rel, 'entry.rel');
    }
    return out;
  });
}

/**
 * glob の 1 セグメントとして受理する形。**危ない形の数え上げではなく、書ける文字を数える**
 * 側で書く — 否定リストは `..`・絶対・ドライブレター・URI の 4 形を塞いでも、ブレース展開
 * `{..,x}`・否定 `!`・extglob `!(x)`・文字クラス `[a-z]` がその外側に残る。これらはどれも
 * 禁じた字面を持たないまま参照先を展開ルートの外や意図しない集合へ広げる。
 *
 * `**` は単独セグメントのときだけ許す(`a**b` のような形は glob 実装ごとに解釈が割れる)。
 * ドットだけのセグメント(`.` / `..`)を拒むのが遡上の遮断で、空セグメントを拒むことで
 * 先頭・末尾の `/` と `a//b` が同時に落ちる。日本語のファイル名は `\p{L}\p{N}` が通す。
 */
const GLOB_SEGMENT_RE = /^(?:\*\*|(?!\.+$)[\p{L}\p{N}_.\-*?]+)$/u;

/** glob は展開ルート相対の相対表現だけを許す(セグメント単位の許可リストで判定する)。 */
function assertGlob(value: unknown, label: string): string {
  const text = assertText(value, label);
  const segments = text.replace(/\\/g, '/').split('/');
  if (!segments.every((segment) => GLOB_SEGMENT_RE.test(segment))) {
    throw validation(`${label} に指定できない値です: ${text}`);
  }
  return text;
}

function assertGlobList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw validation(`${label} は配列で指定してください`);
  if (value.length > MAX_LIST_ITEMS) throw validation(`${label} の要素数が多すぎます`);
  return value.map((v) => assertGlob(v, label));
}

/** 既定の実在判定。symlink 越しにルート外を指せないよう `lstat` で見る。 */
const defaultIsFile = (p: string): boolean => {
  try {
    return fsSync.lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * config テキストを検証済みオブジェクトへ作り直す。失敗はすべて `validation`(400)。
 * `root` は展開ルート(封じ込めの基準)、`isFile` はテストから差し替えるための実在判定。
 */
export function parseProjectConfig(
  text: string,
  root: string,
  isFile: (p: string) => boolean = defaultIsFile,
): SafeProjectConfig {
  if (text.length > MAX_CONFIG_BYTES) {
    throw validation('vivliostyle.config.json が大きすぎます');
  }
  // BOM は 1 個だけ剥ぐ。剥がないと正当な zip が 400 になる(`JSON.parse` は BOM で throw)。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // **fail-closed。** parse 失敗を黙って素通しすると、CLI 側は JSONC で読めて
    // しまうため「検査だけが脱落した config」が CLI へ渡る。
    throw validation(
      'vivliostyle.config.json を JSON として読めません(コメントや末尾カンマは使えません)',
    );
  }
  if (Array.isArray(parsed)) {
    throw validation('vivliostyle.config.json に配列(複数タスク)は指定できません');
  }
  if (!isPlainObject(parsed)) {
    throw validation('vivliostyle.config.json はオブジェクトで記述してください');
  }
  for (const key of Object.keys(parsed)) {
    if (ACCEPTED_KEYS.has(key)) continue;
    if (key === 'base') {
      throw validation('base は指定できません(プレビューの配信経路をサーバ側で固定しているため)');
    }
    // 黙って捨てない。捨てると「設定が効かない」を利用者が無言で踏む。
    throw validation(`vivliostyle.config.json に指定できないキーがあります: ${key}`);
  }

  // 空オブジェクトへ明示代入で移す(spread / Object.assign を使うと `__proto__` 等の
  // 持ち込みと消し忘れの両方が起きる)。
  const out: SafeProjectConfig = {
    entry: assertEntry(root, parsed.entry, isFile),
    base: DEFAULT_DOC_BASE,
  };
  if (parsed.entryContext !== undefined) {
    const ctx = assertText(parsed.entryContext, 'entryContext');
    // `"."` は「ルート自身」を指す正当な入力。`safeEntryPath` は rel === '' を拒否するので
    // ここだけ通す分岐が要る(でないと普通のプロジェクトが 400 になる)。
    out.entryContext =
      ctx === '.' || ctx === './' ? ctx : assertContainedPath(root, ctx, 'entryContext');
  }
  if (parsed.theme !== undefined) out.theme = assertTheme(root, parsed.theme, isFile);
  if (parsed.cover !== undefined) {
    if (typeof parsed.cover === 'string') {
      out.cover = assertContainedPath(root, parsed.cover, 'cover');
    } else if (isPlainObject(parsed.cover)) {
      for (const key of Object.keys(parsed.cover)) {
        if (!['src', 'name', 'htmlPath'].includes(key)) {
          throw validation(`cover に指定できないキーがあります: ${key}`);
        }
      }
      const cover: { src: string; name?: string; htmlPath?: string } = {
        src: assertContainedPath(root, parsed.cover.src, 'cover.src'),
      };
      if (parsed.cover.name !== undefined) cover.name = assertText(parsed.cover.name, 'cover.name');
      if (parsed.cover.htmlPath !== undefined) {
        cover.htmlPath = assertContainedPath(root, parsed.cover.htmlPath, 'cover.htmlPath');
      }
      out.cover = cover;
    } else {
      throw validation('cover の値が不正です');
    }
  }
  if (parsed.toc !== undefined) {
    if (typeof parsed.toc === 'boolean') out.toc = parsed.toc;
    else if (typeof parsed.toc === 'string') out.toc = assertContainedPath(root, parsed.toc, 'toc');
    else if (isPlainObject(parsed.toc)) {
      for (const key of Object.keys(parsed.toc)) {
        // `transformDocumentList` / `transformSectionList` は関数フィールド。JSON には
        // 現れないが、キーがあれば「効くつもりで書かれている」ので 400 にする。
        if (!['title', 'htmlPath', 'sectionDepth'].includes(key)) {
          throw validation(`toc に指定できないキーがあります: ${key}`);
        }
      }
      const toc: { title?: string; htmlPath?: string; sectionDepth?: number } = {};
      if (parsed.toc.title !== undefined) toc.title = assertText(parsed.toc.title, 'toc.title');
      if (parsed.toc.htmlPath !== undefined) {
        toc.htmlPath = assertContainedPath(root, parsed.toc.htmlPath, 'toc.htmlPath');
      }
      if (parsed.toc.sectionDepth !== undefined) {
        const d = parsed.toc.sectionDepth;
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 10) {
          throw validation('toc.sectionDepth の値が不正です');
        }
        toc.sectionDepth = d;
      }
      out.toc = toc;
    } else throw validation('toc の値が不正です');
  }
  for (const key of ['title', 'author', 'language', 'readingProgression', 'size'] as const) {
    if (parsed[key] !== undefined) out[key] = assertText(parsed[key], key);
  }
  if (parsed.copyAsset !== undefined) {
    if (!isPlainObject(parsed.copyAsset)) throw validation('copyAsset の値が不正です');
    for (const key of Object.keys(parsed.copyAsset)) {
      if (!['includes', 'excludes'].includes(key)) {
        throw validation(`copyAsset に指定できないキーがあります: ${key}`);
      }
    }
    const copyAsset: { includes?: string[]; excludes?: string[] } = {};
    if (parsed.copyAsset.includes !== undefined) {
      copyAsset.includes = assertGlobList(parsed.copyAsset.includes, 'copyAsset.includes');
    }
    if (parsed.copyAsset.excludes !== undefined) {
      copyAsset.excludes = assertGlobList(parsed.copyAsset.excludes, 'copyAsset.excludes');
    }
    out.copyAsset = copyAsset;
  }
  return out;
}

/** 展開ルート直下に置く config のファイル名(小文字で照合する)。 */
export const CONFIG_FILE_NAME = 'vivliostyle.config.json';

/** `path.basename` を小文字化して比較するためのヘルパ(探索側は fold して広く拾う)。 */
export const isConfigFileName = (name: string): boolean =>
  path.basename(name).toLowerCase() === CONFIG_FILE_NAME;
