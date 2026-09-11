// =============================================================================
// e2e-vite.ts — e2e 用 Vite dev サーバのランチャ(即死時の観測)
// =============================================================================
// Vite 8 が e2e の途中で exit 0xC0000409(ネイティブ側の即死)で落ちる事象があり、Playwright の
// webServer からは終了コードしか見えない。pnpm を挟むと reporter の出力が混ざり終了コードの
// 出所も曖昧になるため、Node で `vite/bin/vite.js` を直接起動する。出力はファイルにも写し、
// 異常終了のときだけ終了コードと直前の出力を残す。Rust 製ネイティブ部品の panic hook を
// 通る失敗は `RUST_BACKTRACE` で stderr に出る。hook を通らない即死はクラッシュダンプでしか
// 追えないので、`E2E_VITE_PROCDUMP` が指すときは procdump 経由で起動する。
// Playwright は Windows で `taskkill /T /F` により終了させるため、シグナル転送は持たない。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const webDir = path.join(repoRoot, 'editor', 'web');
const outDir = path.join(repoRoot, '.tmp', 'vite-e2e');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(outDir, `vite-${stamp}.log`);
const log = fs.createWriteStream(logPath);
const recent: string[] = [];
const keep = (chunk: Buffer): void => {
  const text = chunk.toString('utf8');
  log.write(text);
  for (const line of text.split(/\r?\n/)) {
    recent.push(line);
    if (recent.length > 200) recent.shift();
  }
};

// `vite/bin/vite.js` は package の `exports` に含まれず `resolve` が throw するので、唯一公開されている
// `vite/package.json` を引き、その `bin.vite`(= `bin/vite.js`)からパスを組む。
const req = createRequire(path.join(webDir, 'package.json'));
const vitePkgPath = req.resolve('vite/package.json');
const viteBin = path.join(
  path.dirname(vitePkgPath),
  (req(vitePkgPath) as { bin: { vite: string } }).bin.vite,
);
const nodeOptions = [
  process.env.NODE_OPTIONS,
  '--report-on-fatalerror',
  `--report-directory=${outDir}`,
]
  .filter(Boolean)
  .join(' ');
const env = { ...process.env, RUST_BACKTRACE: 'full', NODE_OPTIONS: nodeOptions };
const viteArgs = [viteBin, ...process.argv.slice(2)];
const procdump = process.env.E2E_VITE_PROCDUMP;
// 配列リテラルの分割代入は tuple に推論されないので型を明示する(`tsc -p tsconfig.e2e.json`)。
const [cmd, args]: [string, string[]] = procdump
  ? [procdump, ['-accepteula', '-e', '-ma', '-x', outDir, process.execPath, ...viteArgs]]
  : [process.execPath, viteArgs];

const child = spawn(cmd, args, { cwd: webDir, env, stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (c: Buffer) => {
  process.stdout.write(c);
  keep(c);
});
child.stderr.on('data', (c: Buffer) => {
  process.stderr.write(c);
  keep(c);
});
child.on('exit', (code, signal) => {
  const hex = code === null ? '-' : `0x${(code >>> 0).toString(16).toUpperCase()}`;
  // procdump 経由のときの `code` は procdump 自身のもので、Vite の即死は伝播しない。実体は
  // `.dmp` の有無と procdump の出力(`Exception: C0000409` / `Dump 1 complete`)で判定するため、
  // procdump 使用時は終了コードに関わらず記録を残す。直前の出力は chunk 境界で行が割れる
  // ことがあり、末尾 200 行は目安。procdump のバナー行も混ざる。
  const head = `[e2e-vite] exit code=${code} (${hex}) signal=${signal} procdump=${Boolean(procdump)} log=${logPath}`;
  process.stderr.write(`${head}\n`);
  if (code !== 0 || procdump) {
    fs.writeFileSync(
      path.join(outDir, `exit-${stamp}.txt`),
      `${head}\n--- last output (目安。chunk 境界で行が割れうる) ---\n${recent.join('\n')}\n`,
      'utf8',
    );
  }
  log.end(() => process.exit(code ?? 1));
});
