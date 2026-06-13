/**
 * Shared state for the local repositories: bundled fixtures plus a localStorage
 * overlay, and the pure helpers that read/derive from them. Every local
 * repository implementation shares one fixture set and one identity ruleset.
 */
import {
  conflict,
  DEFAULT_ERROR_MESSAGE,
  type DropdownQuery,
  type PartCatalogItem,
  parseTemplateFileName,
  type SampleData,
  type TemplateMeta,
  templateIdFromFileName,
  type User,
  unexpected,
} from '@editor/shared';

// --- bundled fixtures -------------------------------------------------------

const templateFiles = import.meta.glob('../fixtures/templates/*.html', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const cssFiles = import.meta.glob('../fixtures/css/*.css', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const sampleFiles = import.meta.glob('../fixtures/sample/*.json', { eager: true }) as Record<
  string,
  { default: SampleData }
>;

export const partCatalog = (
  import.meta.glob('../fixtures/parts.json', { eager: true, import: 'default' }) as Record<
    string,
    PartCatalogItem[]
  >
)['../fixtures/parts.json'];

export interface SeedUser extends User {
  password: string;
}
export const seedUsers = (
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

export const fixtureCss: Record<string, string> = {};
for (const [path, content] of Object.entries(cssFiles)) {
  fixtureCss[baseName(path).replace(/\.css$/, '')] = content;
}

export const fixtureSample: Record<string, SampleData> = {};
for (const [path, mod] of Object.entries(sampleFiles)) {
  fixtureSample[baseName(path).replace(/\.json$/, '')] = mod.default;
}

// --- localStorage overlay ---------------------------------------------------

/**
 * Read & parse a localStorage value. A parse failure now propagates (it is
 * wrapped into an AppError by the calling repository) rather than being
 * silently swallowed — corrupt state is surfaced, not hidden.
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

/** True when a localStorage write failed because the quota was exceeded. */
function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/**
 * Run `fn` as an all-or-nothing localStorage transaction over `keys`. The raw
 * value of each key is snapshotted first; if `fn` throws, every key is restored
 * to its pre-transaction state (removed if it had no value) before re-throwing.
 * Use it to wrap a multi-`write()` sequence so a mid-way failure (e.g. quota)
 * never leaves a partially-updated, inconsistent store.
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

export const K = {
  drafts: 'editor:drafts',
  htmlOverride: 'editor:html',
  cssOverride: 'editor:css',
  editHist: 'editor:hist:edit',
  pdfHist: 'editor:hist:pdf',
  createHist: 'editor:hist:create',
  partHist: 'editor:hist:part',
  snapshots: 'editor:snapshots',
  session: 'editor:session',
  userOverride: 'editor:users',
  passwords: 'editor:pw',
} as const;

export const META_KEY = 'editor:meta';

export const now = () => new Date().toISOString();
export const uid = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
export const delay = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 80));

/** Deduplicate and sort a list of strings (used to build dropdown options). */
export const uniq = (xs: string[]) => [...new Set(xs)].sort();

/** True if a template matches every set field of a dropdown query. */
export const metaMatches = (m: TemplateMeta, q: DropdownQuery): boolean =>
  (!q.companyCode || m.attributes.companyCode === q.companyCode) &&
  (!q.fundCode || m.attributes.fundCode === q.fundCode) &&
  (!q.baseDate || m.attributes.baseDate === q.baseDate) &&
  (!q.editionType || m.attributes.editionType === q.editionType);

// --- derived helpers --------------------------------------------------------

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
      status: saved?.status ?? (htmlOverride[id] ? 'published' : 'draft'),
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
