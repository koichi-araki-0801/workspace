// =============================================================================
// comment-convention-reminder.cjs — コメント規約リマインド (PreToolUse: Write|Edit)
// =============================================================================
// 役割:
//   コード系ファイルの編集直前に、その言語のコメント規約の要点と正典
//   (`docs/コメント規約.md`) への参照を systemMessage で注入する。「コード修正時は
//   既存・新規とも必ず規約に従う」という運用を毎回の編集で意識させるのが目的。
//
// 挙動:
//   - 対象拡張子 (.ts/.tsx/.js/.cjs/.mjs/.vue/.py/.ps1) のときだけリマインドを出す。
//     それ以外は沈黙 (何も出さず exit 0)。
//   - スパム防止: セッション内で言語グループごとに 1 回だけ (os.tmpdir() のマーカー)。
//   - 常に exit 0。編集をブロックしない (graph2-baseline.cjs と同方針)。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── 1. 言語グループ判定 — 拡張子 → グループ key ──
// `.ts/.js` 系は装飾ボックス + `// ── N. ──`、`.py` は docstring、`.ps1` は help block。
function langGroup(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".cjs", ".mjs", ".vue"].includes(ext)) return "tsjs";
  if (ext === ".py") return "py";
  if (ext === ".ps1") return "ps1";
  return null;
}

// ── 2. リマインド文 — グループごとの要点 (詳細は docs/コメント規約.md) ──
const REMINDERS = {
  tsjs:
    "コメント規約 (docs/コメント規約.md): 日本語散文+英語ドメイン用語、識別子は" +
    "バッククォート、ファイル先頭は `=` 罫線の装飾ボックスヘッダ、節区切りは" +
    " `// ── N. ラベル ── `、シンボル説明は JSDoc、1 行 100 桁以内。なぜ/非自明を書く。",
  py:
    "コメント規約 (docs/コメント規約.md): モジュール/関数 docstring 主体 (役割サマリ)、" +
    "節区切りは `# ── ラベル ── `、日本語散文+英語ドメイン用語、識別子はバッククォート。" +
    "BOM 不要。なぜ/非自明を書く。",
  ps1:
    "コメント規約 (docs/コメント規約.md): 先頭は comment-based help" +
    " (.SYNOPSIS/.DESCRIPTION/.PARAMETER/.EXAMPLE)、日本語を含む .ps1 は UTF-8 BOM 必須、" +
    "同名 .bat ランチャ併設。なぜ/非自明を書く。",
};

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let filePath = "";
  let sessionId = "x";
  try {
    const j = JSON.parse(input || "{}");
    filePath = j?.tool_input?.file_path ?? "";
    sessionId = j?.session_id ?? "x";
  } catch {
    process.exit(0);
  }

  const group = langGroup(filePath);
  if (!group) process.exit(0);

  // ── 3. セッション内 言語グループごと 1 回 (再発火を抑止) ──
  const marker = path.join(os.tmpdir(), `comment-convention-${sessionId}-${group}`);
  if (fs.existsSync(marker)) process.exit(0);
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* ignore */
  }

  process.stdout.write(
    JSON.stringify({ systemMessage: REMINDERS[group], suppressOutput: true }),
  );
  process.exit(0);
});
