// PreToolUse hook (Write|Edit): graph2 のソース(.ts)を初めて編集する直前に、現在の
// SVG 出力を out/_baseline へスナップショットする。後段で `npm run batch` の結果と
// byte-diff することで「リファクタが出力を変えていない」ことを保証するための基準。
//
// 挙動:
//  - 対象は graph2 配下の .ts のみ (out/ 配下は除外)。それ以外の編集では何もしない。
//  - セッション毎に 1 回だけ作成する (os.tmpdir() のマーカーで再実行を抑止)。初回編集の
//    直前に走るため、ベースラインは「そのセッションの編集前 (= 通常はコミット済み) 状態」。
//  - out/_baseline を手動削除すると次の編集で再生成される (リフレッシュ用の手動フック)。
//  - batch は同期実行 (編集と競合させず編集前ソースを確実に捕捉)。失敗は致命にせず exit 0。
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GRAPH2_DIR = path.resolve(__dirname, "..", "..", "graph2");
const SRC_OUT = path.join(GRAPH2_DIR, "out", "svg_js");
const BASELINE = path.join(GRAPH2_DIR, "out", "_baseline");

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

  // graph2 配下の .ts ソースのみ対象 (out/ 配下の生成物は除外)。区切りは / と \ の両対応。
  const norm = filePath.replace(/\\/g, "/");
  const isGraph2Ts = /\/graph2\//.test(norm) && norm.endsWith(".ts");
  const isOutput = /\/graph2\/out\//.test(norm);
  if (!isGraph2Ts || isOutput) process.exit(0);

  // セッション毎 1 回。マーカーが在り、かつ _baseline も在るならスキップ
  // (_baseline を消すと再生成 = 手動リフレッシュ)。
  const marker = path.join(os.tmpdir(), `graph2-baseline-${sessionId}`);
  if (fs.existsSync(marker) && fs.existsSync(BASELINE)) process.exit(0);

  // 先にマーカーを置いて、同時発火の二重実行を防ぐ。
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* ignore */
  }

  try {
    execSync("npm run batch", {
      cwd: GRAPH2_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!fs.existsSync(SRC_OUT)) {
      console.error(`[graph2-baseline] skipped: ${SRC_OUT} が無い`);
      process.exit(0);
    }
    fs.rmSync(BASELINE, { recursive: true, force: true });
    fs.cpSync(SRC_OUT, BASELINE, { recursive: true });
    const n = fs.readdirSync(BASELINE).filter((f) => f.endsWith(".svg")).length;
    process.stdout.write(
      JSON.stringify({
        systemMessage: `graph2 ベースライン作成: out/_baseline (${n} SVG)。編集後 \`npm run batch\` の出力と byte-diff で挙動確認できます。`,
        suppressOutput: true,
      }),
    );
  } catch (e) {
    console.error(`[graph2-baseline] skipped: ${String(e.stderr || e.message).trim()}`);
  }
  process.exit(0);
});
