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
