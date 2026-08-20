// =============================================================================
// store.ts — local リポジトリ共有の状態(fixtures + localStorage)と純粋ヘルパ群
// =============================================================================
// 役割: 同梱 fixtures と localStorage オーバレイ、およびそれらを読む/導出する純粋
// ヘルパを提供する。全 local リポジトリ実装が 1 つの fixtures セットと 1 つの
// identity ルールセットを共有する。
import {
  conflict,
  DEFAULT_ERROR_MESSAGE,
  type DropdownQuery,
  type FundMaster,
  type PartCatalogItem,
  parseTemplateFileName,
  type TemplateMeta,
  templateIdFromFileName,
  type User,
  unexpected,
} from '@editor/shared';
import { currentAppEpoch } from '@/lib/appEpoch';
import { K, LEGACY_UNDO_STACKS_KEY, undoStacksKey } from '@/lib/storageKeys';
import fundMasterJson from '../fixtures/funds.json';

// キー定数の実体は `@/lib/storageKeys`(モード非依存コードが `api/local/**` 一式を import する
// 足がかりを作らないための切り出し先)。既存の `K.xxx` 参照を無改修で通すため re-export する。
export { K };

// ── 1. bundled fixtures — 同梱フィクスチャの読込 ──

const templateFiles = import.meta.glob('../fixtures/templates/*.html', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

// editor canvas に表示する値差込済み(pre-filled)コピー。キーは raw テンプレートと
// 同じファイル名。エントリが無ければ実行時 fill にフォールバックする。
const filledFiles = import.meta.glob('../fixtures/filled/*.html', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const cssFiles = import.meta.glob('../fixtures/css/*.css', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export const partCatalog = (
  import.meta.glob('../fixtures/parts.json', { eager: true, import: 'default' }) as Record<
    string,
    PartCatalogItem[]
  >
)['../fixtures/parts.json'];

interface SeedUser extends User {
  password: string;
}
const seedUsers = (
  import.meta.glob('../fixtures/users.json', { eager: true, import: 'default' }) as Record<
    string,
    SeedUser[]
  >
)['../fixtures/users.json'];

function baseName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export const fixtureTemplates: Record<string, string> = {};
for (const [path, content] of Object.entries(templateFiles)) {
  fixtureTemplates[baseName(path)] = content;
}

export const fixtureFilled: Record<string, string> = {};
for (const [path, content] of Object.entries(filledFiles)) {
  fixtureFilled[baseName(path)] = content;
}

export const fixtureCss: Record<string, string> = {};
for (const [path, content] of Object.entries(cssFiles)) {
  fixtureCss[baseName(path).replace(/\.css$/, '')] = content;
}

// ファンド固有マスタ(コード → 名称/会社)。サンプル本体はパーツ別共通ダミー
// (`sampleCommon`)を使い、ここからは fund.name/nickname・company だけを上書きする。
export const fundMaster: Record<string, FundMaster> = fundMasterJson;

// ── 2. localStorage overlay — 読み書きとトランザクション ──

/**
 * localStorage の値を読んで parse する。parse 失敗は握り潰さず伝播させる(呼び出し元
 * リポジトリが `AppError` に包む)。壊れた状態を隠さず表面化させる方針。
 */
export function read<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}
export function write<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    if (isQuotaError(e)) {
      throw conflict('保存領域が不足しています。不要なデータを削除してください', { cause: e });
    }
    throw unexpected(DEFAULT_ERROR_MESSAGE, { cause: e });
  }
}

/** localStorage 書き込みが quota 超過で失敗したときに真。 */
function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/**
 * `keys` に対する all-or-nothing の localStorage トランザクションとして `fn` を実行する。
 * 各キーの raw 値を先に snapshot し、`fn` が throw したら再 throw 前に全キーを開始前
 * 状態へ復元する(値が無かったキーは削除)。複数 `write()` 列を包み、途中失敗(例:
 * quota)が部分更新の不整合ストアを残さないようにする。
 */
export function tx<T>(keys: readonly string[], fn: () => T): T {
  const snapshot = keys.map((k) => [k, localStorage.getItem(k)] as const);
  try {
    return fn();
  } catch (e) {
    for (const [k, raw] of snapshot) {
      if (raw === null) localStorage.removeItem(k);
      else localStorage.setItem(k, raw);
    }
    throw e;
  }
}

export const META_KEY = 'editor:meta';

/**
 * local store のスキーマ版。古い永続 working-state が新しい fixtures を覆い隠すような
 * 変更(例: 版種リネーム + report 再テーマ)を入れたら bump する。`migrateStore()` が
 * bump ごとに一度 working-state をクリアする。
 */
const SCHEMA_VERSION = '4';
const SCHEMA_KEY = 'editor:schemaVersion';

/** fixtures 由来の working-state キー群。スキーマ版 bump 時にクリアする。 */
const WORKING_KEYS = [
  K.drafts,
  K.htmlOverride,
  K.cssOverride,
  META_KEY,
  K.snapshots,
  K.instances,
  K.editHist,
  K.pdfHist,
  K.createHist,
  K.partHist,
  K.notes, // メモ単位を fundCode→templateId へ変更。旧形式は非可逆なので bump で一掃する
  LEGACY_UNDO_STACKS_KEY,
  undoStacksKey(),
  K.reviews,
  'editor:seed:compare', // compare-seed ガード。現行 id で再 seed させるため
] as const;

/**
 * 一度きりのマイグレーション: 保存スキーマ版が同梱版と異なるとき、fixtures 由来の
 * working-state(drafts, html/css override, meta, snapshots, history, compare-seed
 * ガード)を全て破棄し、アプリを現行 fixtures に追従させる。Auth(session/users/
 * passwords)は保持しユーザーをログイン状態に保つ。版 bump ごとに一度実行する(版
 * スタンプが再実行をガード)。
 */
export function migrateStore(): void {
  if (localStorage.getItem(SCHEMA_KEY) === SCHEMA_VERSION) return;
  for (const key of WORKING_KEYS) localStorage.removeItem(key);
  localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION);
}

export const now = () => new Date().toISOString();
export const uid = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
export const delay = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 80));

/** 文字列リストを重複排除してソートする(dropdown 候補の構築に使う)。 */
export const uniq = (xs: string[]) => [...new Set(xs)].sort();

// 重複排除のみで出現順を保つ。分類候補を fixtures(`parts.json`)の記載＝使用順
// (表紙から)で出すために使い、五十音ソートの `uniq` とは別物として置く。
export const uniqStable = (xs: string[]) => [...new Set(xs)];

/** テンプレートが dropdown query の設定済み全フィールドに一致すれば真。 */
export const metaMatches = (m: TemplateMeta, q: DropdownQuery): boolean =>
  (!q.companyCode || m.attributes.companyCode === q.companyCode) &&
  (!q.fundCode || m.attributes.fundCode === q.fundCode) &&
  (!q.baseDate || m.attributes.baseDate === q.baseDate) &&
  (!q.editionType || m.attributes.editionType === q.editionType);

// ── 3. derived helpers — fixtures + overlay からの導出 ──

export function allMetas(): TemplateMeta[] {
  const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
  const ids = new Set([
    ...Object.keys(fixtureTemplates).map(templateIdFromFileName),
    ...Object.keys(htmlOverride),
  ]);
  const metaStore = read<Record<string, Partial<TemplateMeta>>>(META_KEY, {});
  const metas: TemplateMeta[] = [];
  for (const id of ids) {
    const fileName = `${id}.html`;
    const attrs = parseTemplateFileName(fileName);
    if (!attrs) continue;
    const saved = metaStore[id];
    metas.push({
      id,
      attributes: attrs,
      fileName,
      // `status` の意味は rest 実装と揃える: 配信済みテンプレ(= fixture が在る)が
      // `published`、fixture が無く override だけで存在する = 作成タブが生成しただけの
      // 未確定テンプレが `draft`(rest の pending 相当)。
      //
      // 「override が在れば published」と逆向きに読み違えないこと(未編集の fixture が
      // 全部 draft になる)。比較タブ・結合 PDF は `status === 'published'` で承認前を
      // 除くため、ここが逆だと local モードで候補が 1 件も出ない。
      status: saved?.status ?? (fixtureTemplates[fileName] ? 'published' : 'draft'),
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
    });
  }
  return metas;
}

export function listUsersSync(): User[] {
  const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
  const base = seedUsers.map(({ password: _pw, ...u }) => u);
  const merged = new Map<string, User>(base.map((u) => [u.id, u]));
  for (const [id, patch] of Object.entries(overrides)) {
    const existing = merged.get(id);
    if (existing) merged.set(id, { ...existing, ...patch });
    else if (patch.username)
      merged.set(id, {
        id,
        disabled: false,
        mustChangePassword: false,
        role: 'viewer',
        displayName: patch.username,
        username: patch.username,
        ...patch,
      } as User);
  }
  return [...merged.values()];
}

export function currentUser(): User | null {
  const id = read<string | null>(K.session, null);
  if (!id) return null;
  // 配信側の起動 epoch とログイン時の epoch が食い違う = サーバ/dev 再起動。旧セッション
  // を破棄して未ログイン扱いにし、再ログインを強制する(REST の起動時失効と等価の挙動)。
  if (read<string | null>(K.sessionEpoch, null) !== currentAppEpoch()) {
    localStorage.removeItem(K.session);
    localStorage.removeItem(K.sessionEpoch);
    return null;
  }
  return listUsersSync().find((u) => u.id === id) ?? null;
}

export function passwordFor(username: string): string | undefined {
  const pw = read<Record<string, string>>(K.passwords, {});
  if (pw[username] !== undefined) return pw[username];
  return seedUsers.find((u) => u.username === username)?.password;
}

export function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function defaultSkeleton(): string {
  return `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><title>{{ fund.name }}</title></head>
  <body>
    <header class="report-header"><h1 class="report-title">{{ fund.name }}</h1></header>
    <section><p>基準日: {{ report.baseDate }}</p></section>
  </body>
</html>`;
}
