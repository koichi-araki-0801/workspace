// PostToolUse hook: git commit を実行したら、その直後に現在ブランチを upstream へ push する。
// stdin で PostToolUse イベント JSON を受け取り、tool_input.command に git commit が
// 含まれる場合のみ push する。失敗は致命にせず stderr に1行報告して exit 0。
const { execSync } = require("node:child_process");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(input || "{}")?.tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }
  // git commit を含むコマンド以外はスキップ（全 Bash/PowerShell 実行に対し軽量に判定）
  if (!/\bgit\b[^\n|&;]*\bcommit\b/.test(cmd)) process.exit(0);

  const run = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  try {
    let hasUpstream = false;
    try {
      run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
      hasUpstream = true;
    } catch {
      // upstream 未設定（新規ブランチ）→ 下で -u origin HEAD を付けて初回 push する
    }
    const out = hasUpstream ? run("git push") : run("git push -u origin HEAD");
    console.error(`[auto-push] ${out || "done"}`);
  } catch (e) {
    console.error(`[auto-push] skipped: ${String(e.stderr || e.message).trim()}`);
  }
  process.exit(0);
});
