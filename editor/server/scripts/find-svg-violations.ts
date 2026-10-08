// =============================================================================
// find-svg-violations.ts — images 配下の SVG のうち、配信の検査が弾くものを理由つきで一覧にする
// =============================================================================
// 使い方: pnpm --filter server exec tsx scripts/find-svg-violations.ts --root <dataRoot>
//         [--images <dir>]
// 読み取りだけを行う(何も書かない)。対象は引数だけで決め、環境変数(DATA_ROOT 等)と
// appconfig.json は読まない — DATA_ROOT が本番データを指している端末があり、検証のつもりで
// 本番を走査する事故を避けるため。`config.ts` も import しない(import 時に環境変数から解決するため)。
// 判定は配信側と同じ `inspectSvg` を使う(判定が 2 つに分かれるとずれる)。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSvg } from '@editor/shared';

interface SvgFinding {
  file: string;
  violation: string;
}

export function imagesDirFromArgs(argv: readonly string[]): string | null {
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = opt('root');
  if (!root) return null;
  return opt('images') ?? path.join(root, 'images');
}

const isSvg = (name: string) => name.toLowerCase().endsWith('.svg');

// 配信は直下と 1 段下(会社フォルダ)だけを扱うので、走査もそこまでに揃える。
async function listSvgs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && isSvg(e.name)) out.push(e.name);
    else if (e.isDirectory()) {
      const sub = await fs.readdir(path.join(dir, e.name), { withFileTypes: true }).catch(() => []);
      for (const s of sub) if (s.isFile() && isSvg(s.name)) out.push(`${e.name}/${s.name}`);
    }
  }
  return out.sort();
}

export async function scanImages(imagesDir: string): Promise<SvgFinding[]> {
  const out: SvgFinding[] = [];
  for (const rel of await listSvgs(imagesDir)) {
    const body = await fs.readFile(path.join(imagesDir, rel)).catch(() => null);
    if (body === null) continue;
    const violations = inspectSvg(body.toString('utf8'));
    if (violations.length > 0)
      out.push({ file: `images/${rel}`, violation: violations.join(' / ') });
  }
  return out;
}

async function main(): Promise<void> {
  const dir = imagesDirFromArgs(process.argv.slice(2));
  if (!dir) {
    console.error('使い方: find-svg-violations --root <dataRoot> [--images <dir>]');
    process.exit(2);
  }
  const found = await scanImages(dir);
  for (const f of found) console.log(`${f.file}\t${f.violation}`);
  console.log(`違反 ${found.length} 件`);
  process.exit(found.length > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
