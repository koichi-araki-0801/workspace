// =============================================================================
// editor_server.mjs — E2E 用の依存ゼロ静的サーバ (Playwright webServer)
// =============================================================================
// graph-editor/resources/web 配下 (Web 資産集約先) を配信する依存ゼロの静的サーバ。Playwright の
// webServer から起動し、`ui.html` と `lib/leader_geom.cjs` を同一オリジン
// (http://127.0.0.1:5179) で取得できるようにする。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

const ROOT = fileURLToPath(new URL("../resources/web/", import.meta.url));
const PORT = 5179;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 本番 (`app.py` の `SECURITY_HEADERS`) と同じ防御ヘッダを載せる。ここを省くと、CSP が
// 実ブラウザで UI を壊していても E2E が緑のままになる (取り込んだ SVG の inline `<style>` と
// `data:` フォント/画像が実際に効くのはこの CSP 下)。**片方を変えたら必ず両方**。
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent((req.url || "/").split("?")[0]);
    if (rel === "/") rel = "/ui.html";
    // パストラバーサル防止: `ROOT` 配下に正規化されたパスのみ許可
    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(normalize(ROOT))) {
      res.writeHead(403, SECURITY_HEADERS).end("forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      ...SECURITY_HEADERS,
    });
    res.end(body);
  } catch {
    res.writeHead(404, SECURITY_HEADERS).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // Playwright の `webServer` はこの URL の応答を待つ。
  console.log(`editor static server: http://127.0.0.1:${PORT}/`);
});
