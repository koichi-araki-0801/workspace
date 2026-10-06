// =============================================================================
// find-baked-markers.ts — dataRoot の確定テンプレートに往復用の印が焼き付いていないか調べる
// =============================================================================
// 使い方: pnpm --filter server exec tsx scripts/find-baked-markers.ts --root <dataRoot>
//         [--templates <dir>] [--pending <dir>] [--reviews <dir>] [--filled <dir>]
// 読み取りだけを行う。対象は引数だけで決め、環境変数(DATA_ROOT 等)と appconfig.json は
// 読まない — DATA_ROOT が本番データを指している端末があり、検証のつもりで本番を走査する
// 事故を避けるため。`config.ts` も import しない(import 時に環境変数から解決するため)。
// 判定は関所と同じ `findEditingMarkers` を使う(判定が 2 つに分かれるとずれる)。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findEditingMarkers } from '@editor/shared';

export interface ScanDirs {
  templates: string;
  pending: string;
  reviews: string;
  filled: string;
}
export interface ScanFinding {
  file: string;
  marker: string;
  index: number;
  severity: 'error';
}

export function dirsFromArgs(argv: readonly string[]): ScanDirs | null {
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = opt('root');
  if (!root) return null;
  return {
    templates: opt('templates') ?? path.join(root, 'templates'),
    pending: opt('pending') ?? path.join(root, 'pending'),
    reviews: opt('reviews') ?? path.join(root, 'reviews'),
    filled: opt('filled') ?? path.join(root, 'filled'),
  };
}

async function listHtml(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith('.html'))
    .sort()
    .map((n) => path.join(dir, n));
}

async function scanFile(file: string, label: string): Promise<ScanFinding[]> {
  const html = await fs.readFile(file, 'utf8');
  return findEditingMarkers(html).map((h) => ({
    file: label,
    marker: h.marker,
    index: h.index,
    severity: 'error' as const,
  }));
}

// 関所は作成・編集の両経路に掛かるので、値入り HTML(filled/)の印も申請を止める。
export async function scanDataRoot(dirs: ScanDirs): Promise<ScanFinding[]> {
  const out: ScanFinding[] = [];
  for (const key of ['templates', 'pending', 'filled'] as const)
    for (const f of await listHtml(dirs[key]))
      out.push(...(await scanFile(f, path.join(key, path.basename(f)))));
  const reqs = (await fs.readdir(dirs.reviews).catch(() => [] as string[])).sort();
  for (const id of reqs) {
    const meta = await fs
      .readFile(path.join(dirs.reviews, id, 'meta.json'), 'utf8')
      .catch(() => null);
    if (meta === null) continue;
    const m = JSON.parse(meta) as { status?: string };
    if (m.status !== 'pending') continue;
    const body = path.join(dirs.reviews, id, 'body.html');
    out.push(...(await scanFile(body, path.join('reviews', id, 'body.html')).catch(() => [])));
  }
  return out;
}

async function main(): Promise<void> {
  const dirs = dirsFromArgs(process.argv.slice(2));
  if (!dirs) {
    console.error(
      '使い方: find-baked-markers --root <dataRoot> [--templates <dir>] [--pending <dir>] [--reviews <dir>] [--filled <dir>]',
    );
    process.exit(2);
  }
  const found = await scanDataRoot(dirs);
  for (const f of found) console.log(`${f.severity}\t${f.file}\t${f.marker}\t@${f.index}`);
  console.log(`要対応 ${found.length} 件`);
  process.exit(found.length > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
