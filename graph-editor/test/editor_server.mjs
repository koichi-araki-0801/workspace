// =============================================================================
// editor_server.mjs — E2E 用の依存ゼロ静的サーバ (Playwright webServer)
// =============================================================================
// graph-editor ルート配下を配信する依存ゼロの静的サーバ。Playwright の webServer から起動し、
// `ui.html` と `lib/leader_geom.cjs` を同一オリジン (http://127.0.0.1:5179) で取得できるように
// する。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 5179;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent((req.url || "/").split("?")[0]);
    if (rel === "/") rel = "/ui.html";
    // パストラバーサル防止: `ROOT` 配下に正規化されたパスのみ許可
    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(normalize(ROOT))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // Playwright の `webServer` はこの URL の応答を待つ。
  console.log(`editor static server: http://127.0.0.1:${PORT}/`);
});
