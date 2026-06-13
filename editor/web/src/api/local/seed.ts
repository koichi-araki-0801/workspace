/**
 * One-time sample data for the 版の比較 (compare) screen.
 *
 * Confirmed-version history (`K.editHist`), frozen snapshots (`K.snapshots`)
 * and the published status (`META_KEY`) are normally produced only at runtime
 * by `confirmSave`. With an empty store there is nothing to compare, so we seed
 * a few templates with multiple confirmed versions. Runs once (guarded) and
 * never clobbers existing user data.
 */
import type { EditHistoryEntry, TemplateMeta, TemplateSnapshot } from '@editor/shared';
import { fixtureCss, fixtureTemplates, K, META_KEY, read, write } from './store';

const SEED_KEY = 'editor:seed:compare';
const SEED_USER = '佐藤花子';

interface SeedVersion {
  historyId: string;
  /** local wall-clock (no Z) so the screen shows it as authored, e.g. 11:42 */
  timestamp: string;
  /** confirm-save author; defaults to SEED_USER */
  user?: string;
  /** small visible change vs. the previous version, for a meaningful diff */
  mark?: string;
  /** raw-template find/replace pairs that give older versions real content diffs */
  edits?: [from: string, to: string][];
}

interface SeedTemplate {
  templateId: string;
  fundCode: string;
  versions: SeedVersion[]; // newest first
}

// メイン: 3版（スクショの「3版」に一致）。サブ: 2版。デモ: 1版（選択不可確認用）。
// 最新版は現行サンプルデータ（基準価額 12,345 / 前日比 +58）で描画し、過去版は
// テンプレート文字列を置換して実際の数値差分（=変更ブロック）を作る。
const SEED: SeedTemplate[] = [
  {
    templateId: 'AM01_510037_20240710_kr',
    fundCode: '510037',
    versions: [
      {
        historyId: 'seed-510037kr-3',
        timestamp: '2024-07-10T11:42:00',
        mark: '第3版（数値更新）',
      },
      {
        historyId: 'seed-510037kr-2',
        timestamp: '2024-07-09T10:05:00',
        mark: '第2版',
        edits: [
          ['{{ fund.nav }}', '12,310'],
          ['+{{ fund.navChange }}', '+35'],
        ],
      },
      {
        historyId: 'seed-510037kr-1',
        timestamp: '2024-07-08T14:30:00',
        user: '編集太郎',
        edits: [
          ['{{ fund.nav }}', '12,180'],
          ['+{{ fund.navChange }}', '+12'],
        ],
      },
    ],
  },
  {
    templateId: 'AM01_510155_20240710_kr',
    fundCode: '510155',
    versions: [
      { historyId: 'seed-510155kr-2', timestamp: '2024-07-09T16:20:00', mark: '第2版' },
      { historyId: 'seed-510155kr-1', timestamp: '2024-07-08T11:10:00' },
    ],
  },
  {
    templateId: 'AM01_510037_20240710_zr',
    fundCode: '510037',
    versions: [{ historyId: 'seed-510037zr-1', timestamp: '2024-07-08T09:00:00' }],
  },
];

/** Apply per-version content edits then inject a small visible version footer. */
function buildVersionHtml(base: string, v: SeedVersion): string {
  let html = base;
  for (const [from, to] of v.edits ?? []) html = html.split(from).join(to);
  if (!v.mark) return html;
  const footer = `<div style="font-size:10px;color:#999;text-align:right;padding:4px 8px;">${v.mark}</div>`;
  return html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : html + footer;
}

export function seedCompareFixtures(): void {
  if (localStorage.getItem(SEED_KEY)) return;

  const editHist = read<EditHistoryEntry[]>(K.editHist, []);
  const snapshots = read<Record<string, TemplateSnapshot>>(K.snapshots, {});
  // 既存データがあれば尊重し、ガードだけ立てて何も書かない。
  if (editHist.length > 0 || Object.keys(snapshots).length > 0) {
    localStorage.setItem(SEED_KEY, '1');
    return;
  }

  const metaStore = read<Record<string, Partial<TemplateMeta>>>(META_KEY, {});

  for (const t of SEED) {
    const baseHtml = fixtureTemplates[`${t.templateId}.html`] ?? '';
    const css = fixtureCss[t.fundCode] ?? '';
    for (const v of t.versions) {
      // newest first → keep editHist newest-first via push (SEED is already ordered)
      editHist.push({
        id: v.historyId,
        templateId: t.templateId,
        user: v.user ?? SEED_USER,
        timestamp: v.timestamp,
        summary: '確定保存',
      });
      snapshots[v.historyId] = {
        historyId: v.historyId,
        templateId: t.templateId,
        html: buildVersionHtml(baseHtml, v),
        css,
        fundCode: t.fundCode,
        timestamp: v.timestamp,
      };
    }
    metaStore[t.templateId] = {
      status: 'published',
      updatedAt: t.versions[0].timestamp,
      updatedBy: t.versions[0].user ?? SEED_USER,
    };
  }

  write(K.editHist, editHist);
  write(K.snapshots, snapshots);
  write(META_KEY, metaStore);
  localStorage.setItem(SEED_KEY, '1');
}
