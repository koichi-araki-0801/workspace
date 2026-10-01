// =============================================================================
// check-canon-summary.mjs — 設計正典の要約が抜粋元と同期しているかの検査
// =============================================================================
// `.claude/rules/design-canon-summary.md` は `paths` を持たない常駐ルールで、設計正典から
// 「却下済み設計」と「触る前のチェックリスト」を抜き出したもの。常駐するぶん、古くなったまま
// 放置すると誤った前提で設計判断をすることになる。
//
// 検査は 4 本立て:
//   1. SHA256 — 要約に埋めた `canon-sync` マーカーの sha256 と、抜粋元の節の現在値を比較する。
//      節が変わっていれば落ちる。節の見出しが見つからない・2 つ以上ある場合も落とす(節名の
//      変更・削除・重複の検出)。
//   2. 件数 — 「却下済み設計」系の節について、正典の項目数と要約の列挙数を突き合わせる。
//      項目が増えたのに要約へ反映されていない、という一番ありがちな抜けをここで捕まえる。
//      文面は要約側で言い換えるため、ラベルの一致までは見ない。
//   3. 書式 — `canon-sync` を含む HTML コメントは、すべてマーカーの書式に完全一致しなければ
//      落とす。書式が崩れたマーカーは読み飛ばされ、その節が黙って検査対象から外れるため。
//   4. 網羅 — `docs/*/src/設計正典.md` ごとに「却下」系の節と「触る前のチェックリスト」の
//      マーカーが要約にあることを求める。要約から節がマーカーごと消えても通る、を防ぐ。
//
// `--update` で現在の sha256 を要約へ書き戻す。**本文を直してから**実行すること(直さずに
// 実行すると、古い要約に新しい sha が付いて検査が素通りする)。書き戻したときは警告を出す。
//
// `.claude/` は `.gitignore` 対象で GitHub Actions 上には存在しない。要約が無い環境では
// スキップし、ローカルの pre-push (`ci-affected.mjs` の共有ゲート) が唯一のゲートになる
// (`check-claude-hooks.mjs` と同じ方針)。
//
// python-tools の `scripts/check_canon_summary.py` と同じ仕組みの並行実装で、行の分け方・空白の
// 扱い・判定を揃えてある(片方を変えたらもう片方も変える)。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY = join(ROOT, '.claude', 'rules', 'design-canon-summary.md');
const UPDATE = process.argv.includes('--update');
const TAG = '[check-canon-summary]';
const CHECKLIST = '触る前のチェックリスト';

if (!existsSync(SUMMARY)) {
  console.log(`${TAG} .claude/rules/design-canon-summary.md が無いためスキップします。`);
  process.exit(0);
}

// ── 1. マーカーの抽出 ──
// 形式: <!-- canon-sync src="<相対パス>" section="<## 見出し>" sha256="<64hex|空>" -->
const MARKER_SRC = '<!--\\s*canon-sync\\s+src="([^"]+)"\\s+section="([^"]+)"\\s+sha256="([0-9a-f]*)"\\s*-->';
const MARKER = new RegExp(MARKER_SRC, 'g');
const MARKER_FULL = new RegExp(`^${MARKER_SRC}$`);

const summaryText = readFileSync(SUMMARY, 'utf8');
const markers = [...summaryText.matchAll(MARKER)].map((m) => ({
  raw: m[0],
  index: m.index,
  src: m[1],
  section: m[2],
  sha: m[3],
}));

if (markers.length === 0) {
  console.error(`${TAG} NG: canon-sync マーカーが 1 つもありません。要約が抜粋元と紐づいていません。`);
  process.exit(1);
}

// ── 2. 抜粋元から節を切り出す ──
// `## <見出し>` から次の `## ` の直前まで。見出し自身は含めない。見出しが 2 つ以上あれば
// どれを抜粋したか決まらないので落とす。
function extractSection(srcPath, heading) {
  const abs = join(ROOT, srcPath);
  if (!existsSync(abs)) return { error: `抜粋元が見つかりません: ${srcPath}` };
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const hits = lines.flatMap((l, i) => (l.trim() === `## ${heading}` ? [i] : []));
  if (hits.length === 0) return { error: `節が見つかりません: ${srcPath} の "## ${heading}"` };
  if (hits.length > 1) {
    return {
      error: `節の見出しが ${hits.length} 個あります: ${srcPath} の "## ${heading}"(どれを抜粋したか決まらない)`,
    };
  }
  const start = hits[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return { body: lines.slice(start + 1, end) };
}

// 改行コードと行末空白、末尾の空行を揃えてから hash する(整形差分で落ちないように)。
function digest(bodyLines) {
  const normalized = bodyLines
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ── 3. 「却下済み設計」系の件数照合 ──
// 正典側は `- **ラベル**:` の箇条書き、要約側は `1. ` 形式の番号付き列挙。
const REJECTED_HINT = /却下|してはならない/;
const FENCE = /^\s*(```|~~~)/;

function countSourceItems(bodyLines) {
  return bodyLines.filter((l) => /^- \*\*/.test(l)).length;
}

// マーカー直後から、次の見出し(`###` 以上)かマーカーか `---` までを要約側の該当ブロックとみなす。
// コードブロックの中の `1. ` は列挙ではないので数えない。
function countSummaryItems(text, markerEnd) {
  const rest = text.slice(markerEnd).split(/\r?\n/);
  let count = 0;
  let inFence = false;
  for (const line of rest) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,3} /.test(line) || /^---\s*$/.test(line) || line.includes('canon-sync')) break;
    if (/^\d+\.\s/.test(line)) count += 1;
  }
  return count;
}

// ── 4. 書式の崩れと網羅 ──
function malformedMarkers(text) {
  return [...text.matchAll(/<!--[\s\S]*?-->/g)]
    .map((m) => m[0])
    .filter((c) => c.includes('canon-sync') && !MARKER_FULL.test(c));
}

function missingCoverage() {
  const docs = join(ROOT, 'docs');
  if (!existsSync(docs)) return [];
  const missing = [];
  const projects = readdirSync(docs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of projects) {
    if (!existsSync(join(docs, name, 'src', '設計正典.md'))) continue;
    const src = `docs/${name}/src/設計正典.md`;
    const sections = markers.filter((m) => m.src === src).map((m) => m.section);
    if (!sections.some((s) => REJECTED_HINT.test(s))) missing.push(`${src} の「却下」系の節`);
    if (!sections.includes(CHECKLIST)) missing.push(`${src} の「${CHECKLIST}」`);
  }
  return missing;
}

// ── 5. 検査本体 ──
let failed = false;
let updated = summaryText;

for (const bad of malformedMarkers(summaryText)) {
  failed = true;
  console.error(`${TAG} NG: マーカーの書式が崩れています(この節は検査されません): ${bad}`);
}
for (const gap of missingCoverage()) {
  failed = true;
  console.error(`${TAG} NG: 要約に ${gap} のマーカーがありません。`);
}

for (const m of markers) {
  const label = `${m.src} "${m.section}"`;
  const { body, error } = extractSection(m.src, m.section);
  if (error) {
    failed = true;
    console.error(`${TAG} NG: ${error}`);
    continue;
  }

  const actual = digest(body);
  let markerFailed = false;

  if (REJECTED_HINT.test(m.section)) {
    const srcCount = countSourceItems(body);
    const sumCount = countSummaryItems(summaryText, m.index + m.raw.length);
    if (srcCount !== sumCount) {
      failed = true;
      markerFailed = true;
      console.error(
        `${TAG} NG: ${label} の項目数が一致しません(正典 ${srcCount} 件 / 要約 ${sumCount} 件)。` +
          ' 増減を要約へ反映してください。',
      );
    }
  }

  if (m.sha === actual) {
    // 件数で落ちた節に OK を併記すると紛らわしいので、両方通ったときだけ OK を出す。
    if (!markerFailed) console.log(`${TAG} OK: ${label}`);
    continue;
  }

  if (UPDATE) {
    updated = updated.replace(m.raw, m.raw.replace(`sha256="${m.sha}"`, `sha256="${actual}"`));
    console.log(`${TAG} 更新: ${label} → ${actual.slice(0, 12)}…`);
    continue;
  }

  failed = true;
  console.error(
    `${TAG} NG: ${label} が変更されています(記録 ${m.sha ? `${m.sha.slice(0, 12)}…` : '未設定'} /` +
      ` 現在 ${actual.slice(0, 12)}…)。design-canon-summary.md の該当節を直してから` +
      ' `pnpm run check:canon-summary -- --update` を実行してください。',
  );
}

if (UPDATE && updated !== summaryText) {
  writeFileSync(SUMMARY, updated, 'utf8');
  console.warn(
    `${TAG} 注意: sha を貼り直しました。要約の本文も直したか確認してください` +
      '(本文を直さずに --update すると、古い要約のまま検査が素通りします)。',
  );
}

// 見出しや抜粋元が見つからない節・書式の崩れ・網羅の欠けは sha を貼り直しても直らない。
// --update でも 0 を返すと、節の改名・削除を黙って通してしまう。
process.exit(failed ? 1 : 0);
