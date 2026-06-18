import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Resolve a usable browser executable for offline PDF generation.
 * Prefer the system Microsoft Edge (present on Windows) so vivliostyle never
 * tries to download Chromium from the internet (air-gapped operation).
 * Returns undefined when none is found, so online dev falls back to the
 * playwright-bundled browser.
 */
function resolveDefaultBrowser(): string | undefined {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * appconfig.json schema. Every field is optional so a partial file (or no file
 * at all) is valid; missing keys fall back to built-in defaults. `.strict()`
 * rejects unknown keys to catch typos early.
 */
const appConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
    paths: z
      .object({
        templatesDir: z.string().optional(),
        cssDir: z.string().optional(),
        draftsDir: z.string().optional(),
        snapshotsDir: z.string().optional(),
        tmpDir: z.string().optional(),
        logDir: z.string().optional(),
        webDist: z.string().optional(),
      })
      .strict()
      .optional(),
    python: z
      .object({
        bin: z.string().optional(),
        script: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    pdf: z
      .object({
        executableBrowser: z.string().optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: z.string().optional(),
        pretty: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type AppConfigFile = z.infer<typeof appConfigSchema>;

/** Load and validate appconfig.json. Returns {} when the file is absent. */
function loadFileConfig(): AppConfigFile {
  const file = process.env.APP_CONFIG ?? path.join(repoRoot, 'appconfig.json');
  if (!fs.existsSync(file)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`appconfig.json の読み込み/parse に失敗しました: ${file}: ${msg}`);
  }

  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`appconfig.json の内容が不正です: ${file}\n${issues}`);
  }
  return parsed.data;
}

const file = loadFileConfig();

// --- Resolution helpers: precedence is default < appconfig.json < env ---------
const toPath = (p: string) => path.resolve(repoRoot, p);

/** Resolve a path setting (env wins, then file, then default), repoRoot-relative. */
function resolvePath(envVal: string | undefined, fileVal: string | undefined, def: string): string {
  return toPath(envVal ?? fileVal ?? def);
}

/** Parse a boolean env var ('true'/'false'); undefined when unset. */
function envBool(envVal: string | undefined): boolean | undefined {
  if (envVal === undefined) return undefined;
  return envVal.toLowerCase() === 'true';
}

const executableBrowser =
  process.env.VIVLIOSTYLE_EXECUTABLE_BROWSER ||
  file.pdf?.executableBrowser ||
  resolveDefaultBrowser();

export const config = {
  port: Number(process.env.PORT ?? file.port ?? 3001),

  /** Directory holding the Jinja2 template files (filename convention). */
  templatesDir: resolvePath(process.env.TEMPLATES_DIR, file.paths?.templatesDir, 'data/templates'),
  /** Directory holding per-fund shared CSS files. */
  cssDir: resolvePath(process.env.CSS_DIR, file.paths?.cssDir, 'data/css'),
  /** Autosave draft working copies (phase 2: html/css per template). */
  draftsDir: resolvePath(process.env.DRAFTS_DIR, file.paths?.draftsDir, 'data/drafts'),
  /** Frozen confirm-save snapshots (phase 2: html/css per history id). */
  snapshotsDir: resolvePath(process.env.SNAPSHOTS_DIR, file.paths?.snapshotsDir, 'data/snapshots'),

  /** Built web SPA to serve in production. */
  webDist: resolvePath(process.env.WEB_DIR, file.paths?.webDist, 'web/dist'),

  /** Existing Python template generator. */
  python: {
    bin: process.env.PYTHON_BIN ?? file.python?.bin ?? 'python',
    script: resolvePath(
      process.env.PY_GENERATE_SCRIPT,
      file.python?.script,
      'server/scripts/generate_template.py',
    ),
    timeoutMs: Number(process.env.PY_TIMEOUT_MS ?? file.python?.timeoutMs ?? 30000),
  },

  /** Temp dir for vivliostyle PDF generation. */
  tmpDir: resolvePath(process.env.TMP_DIR, file.paths?.tmpDir, '.tmp'),

  /** PDF generation (vivliostyle) settings. */
  pdf: {
    /**
     * Browser executable handed to vivliostyle's build().
     * env wins; then appconfig.json; then auto-detected system Edge; otherwise
     * undefined (= playwright default, used in online development).
     */
    executableBrowser: executableBrowser || undefined,
  },

  /**
   * vivliostyle build / preview API settings. Defaults are tuned for the
   * single-machine offline deployment; override via env when needed.
   */
  vivliostyle: {
    /** Live-preview server lifecycle (see `vivliostyle/previewManager.ts`). */
    preview: {
      /** Loopback bind for the Vite preview server; Express proxies to it. */
      host: process.env.VIVLIO_PREVIEW_HOST ?? '127.0.0.1',
      /** Auto-close a preview session after this many ms of no proxy traffic. */
      idleTtlMs: Number(process.env.VIVLIO_PREVIEW_IDLE_MS ?? 30 * 60_000),
      /** Cap concurrent preview servers (each holds a Vite server in memory). */
      maxSessions: Number(process.env.VIVLIO_PREVIEW_MAX ?? 3),
    },
    /** project build upload limits (see `vivliostyle/projectInput.ts`). */
    build: {
      /** Max accepted project zip size in bytes (413 above this). */
      maxProjectBytes: Number(process.env.VIVLIO_MAX_PROJECT_BYTES ?? 64 * 1024 * 1024),
    },
  },

  /**
   * SQL Server connection (phase 2 REST mode). Windows Integrated auth — no
   * credentials are stored. ODBC Driver 17 targets SQL Server 2012; after the
   * planned upgrade, override DB_ODBC_DRIVER / DB_CONN_EXTRA (e.g. Encrypt).
   * The connection string is consumed by `db/pool.ts` (msnodesqlv8).
   */
  db: {
    server: process.env.DB_SERVER ?? 'localhost',
    name: process.env.DB_NAME ?? 'usrap',
    driver: process.env.DB_ODBC_DRIVER ?? 'ODBC Driver 17 for SQL Server',
    poolMax: Number(process.env.DB_POOL_MAX ?? 4),
    get connectionString(): string {
      const extra = process.env.DB_CONN_EXTRA ?? '';
      return (
        `Driver={${this.driver}};Server=${this.server};Database=${this.name};` +
        `Trusted_Connection=yes;${extra}`
      );
    },
  },

  /** Editor's own authentication (phase 2). Secrets stay out of appconfig.json. */
  auth: {
    // 初期パスワードは ログインID(ユーザID) と同一(`userRepo.ts` 参照)。固定値の設定は持たない。
    sessionTtlHours: Number(process.env.AUTH_SESSION_TTL_HOURS ?? 12),
    cookieName: 'editor.sid',
    cookieSecure: process.env.NODE_ENV === 'production',
  },

  /**
   * Mirror audit events into the SQL Server audit table (in addition to the
   * durable file log). Off by default so `local` mode never touches the DB;
   * set AUDIT_DB=true alongside the REST backend.
   */
  auditToDb: envBool(process.env.AUDIT_DB) ?? false,

  /**
   * Enforce session auth on the REST data routes. Off by default so `local`
   * mode (no DB / no login) leaves them open and PDF/generate keep working; set
   * AUTH_REQUIRED=true with the REST backend (start.bat rest sets it).
   */
  requireAuth: envBool(process.env.AUTH_REQUIRED) ?? false,

  /** Structured logging / audit trail. */
  logging: {
    level: process.env.LOG_LEVEL ?? file.logging?.level ?? 'info',
    /** Directory holding the persisted audit log (logs/audit.log). */
    dir: resolvePath(process.env.LOG_DIR, file.paths?.logDir, 'logs'),
    /** Pretty-print stdout; defaults to "outside production" when unspecified. */
    pretty:
      envBool(process.env.LOG_PRETTY) ??
      file.logging?.pretty ??
      process.env.NODE_ENV !== 'production',
  },
};
