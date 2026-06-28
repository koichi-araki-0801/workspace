// =============================================================================
// editor-two-systems-reminder.cjs — editor 2系統の原則リマインド (PreToolUse: Write|Edit)
// =============================================================================
// 役割:
//   2系統(編集タブ=実値・ハイライト無し / 作成タブ=共通sample・ハイライト有り)に関わる
//   主要ファイルの編集直前に、不変条件と「やってはいけない退行」を systemMessage で注入する。
//   CLAUDE.md「editor 2系統の原則」と同じ運用を、毎回の編集で意識させるのが目的。
//
// 挙動:
//   - 対象ファイル(下記 TARGETS のいずれかを末尾に含む)のときだけリマインドを出す。
//     それ以外は沈黙(何も出さず exit 0)。
//   - スパム防止: セッション内で 1 回だけ(os.tmpdir() のマーカー)。
//   - 常に exit 0。編集をブロックしない(comment-convention-reminder.cjs と同方針)。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── 1. 対象ファイル — 2系統の不変条件に触れうるファイル群(basename 一致) ──
// loadForEdit / ハイライトCSS / setVarsHighlight / 経路判定 / データ源 / 作成経路 query。
const TARGETS = [
  "templateEditorService.ts",
  "jinjaComponents.ts",
  "useGrapes.ts",
  "useTemplateEditor.ts",
  "sampleCommon.ts",
  "sampleData.ts",
  "genFilled.ts",
  "CreateTabView.vue",
];

// ── 2. リマインド文 — 不変条件と退行禁止(詳細は CLAUDE.md「editor 2系統の原則」) ──
const REMINDER =
  "editor 2系統の原則(CLAUDE.md): 編集経路(/edit/:id, query なし)= `tpl.filled`" +
  "(per-fund 実値)+ ハイライト無し / 作成経路(?created=1)= `toFilled`(共通sample)+" +
  " ハイライト有り。経路判定は `route.query.created==='1'`、出し分けは `setVarsHighlight`" +
  "(canvas body の `jinja-vars-highlight`)。⚠退行禁止: ①素の `.jinja-chip.jinja-var` に" +
  " `background` 直書き(編集タブへ漏れる/aa9bd65型) ②filled・サンプルを全ファンド共通ダミーへ" +
  "潰す(編集タブが実値を失う/42938a0型)。コード修正時は必ず本原則に従うこと。";

function isTarget(filePath) {
  const norm = String(filePath).replace(/\\/g, "/");
  // editor 配下のみを対象にする(同名ファイルの誤爆を避ける)。
  if (!norm.includes("/editor/")) return false;
  return TARGETS.some((name) => norm.endsWith(`/${name}`));
}

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

  if (!isTarget(filePath)) process.exit(0);

  // ── 3. セッション内 1 回だけ(再発火を抑止) ──
  const marker = path.join(os.tmpdir(), `editor-two-systems-${sessionId}`);
  if (fs.existsSync(marker)) process.exit(0);
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* ignore */
  }

  process.stdout.write(
    JSON.stringify({ systemMessage: REMINDER, suppressOutput: true }),
  );
  process.exit(0);
});
